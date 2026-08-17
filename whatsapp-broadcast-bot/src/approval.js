const { v4: uuidv4 } = require("uuid");
const { downloadMediaMessage } = require("baileys");
const { savePending, getPending, deletePending, readAll, saveMediaBuffer } = require("./store");
const { classifyReply, describeMedia } = require("./ollama");
const { broadcastToGroups, broadcastRawMedia, loadGroups, getGroupName } = require("./broadcaster");
const logger = require("./utils/logger");
const bus = require("./events");

// parseFloat (not parseInt) so fractional-minute timeouts work correctly too
const TIMEOUT_MS = (parseFloat(process.env.APPROVAL_TIMEOUT_MINUTES) || 30) * 60000;

function getControlChat() {
  try {
    const groups = loadGroups();
    return groups.controlChatJid || process.env.CONTROL_CHAT_JID;
  } catch (err) {
    return process.env.CONTROL_CHAT_JID;
  }
}

// setTimeout handles for pending expirations, keyed by request id.
const timeoutHandles = new Map();

/**
 * Download media with retry logic
 * @param {WAMessage} originalMsg 
 * @param {*} sock 
 * @param {number} maxRetries 
 * @returns {Promise<Buffer|null>}
 */
async function downloadMediaWithRetry(originalMsg, sock, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug({ attempt, maxRetries }, "Downloading media...");
      const buf = await downloadMediaMessage(originalMsg, "buffer", {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      });
      if (buf && buf.length > 0) {
        logger.info({ bufferSize: buf.length }, "Media downloaded successfully");
        return buf;
      }
    } catch (e) {
      logger.warn(
        { err: e.message, attempt, maxRetries },
        attempt < maxRetries ? "Media download failed, retrying..." : "Media download failed after all retries"
      );
      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }
  return null;
}

/**
 * Extract thumbnail from message object
 * @param {WAMessage} msg 
 * @returns {Buffer|null}
 */
function extractThumbnailFromMessage(msg) {
  try {
    const raw = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.message || {};
    const imageMsg = raw.imageMessage;
    const videoMsg = raw.videoMessage;
    const documentMsg = raw.documentMessage;
    
    const thumbnail = imageMsg?.jpegThumbnail || videoMsg?.jpegThumbnail || documentMsg?.jpegThumbnail;
    if (thumbnail) {
      if (Buffer.isBuffer(thumbnail)) return thumbnail;
      if (typeof thumbnail === "string") return Buffer.from(thumbnail, "base64");
      if (Array.isArray(thumbnail)) return Buffer.from(thumbnail);
      if (thumbnail?.data && Array.isArray(thumbnail.data)) return Buffer.from(thumbnail.data);
    }
  } catch (e) {
    logger.debug({ err: e.message }, "Failed to extract thumbnail from message");
  }
  return null;
}

/**
 * Sends an approval-request DM to the control chat and stores the pending entry.
 * Also downloads a media preview for the dashboard and emits approval:new.
 */
async function requestApproval(sock, originalMsg, mediaType, caption) {
  const CONTROL_CHAT = getControlChat();
  
  if (!CONTROL_CHAT) {
    throw new Error("CONTROL_CHAT_JID is not set in .env or config/groups.json — cannot send approval requests.");
  }

  const id = uuidv4().slice(0, 8);
  let description = caption || "";
  
  // Get the source group name for better logging/display
  const sourceGroupJid = originalMsg.key.remoteJid;
  const sourceGroupName = await getGroupName(sock, sourceGroupJid);

  if (process.env.USE_OLLAMA === "true") {
    try {
      description = await describeMedia(caption);
    } catch (e) {
      logger.warn({ err: e.message }, "Ollama describe failed, using raw caption");
    }
  }

  savePending(id, {
    mediaMessage: originalMsg,
    mediaType,
    caption: caption || "",
    createdAt: Date.now(),
    status: "pending",
    isDashboardUpload: false,
    sourceGroupJid,
    sourceGroupName,
  });

  // Download media with retry logic
  let mediaBuffer = null;
  let thumbnailBuffer = null;
  let previewBase64 = null;

  // Try to download full media first
  logger.info({ id, mediaType, attempt: 1 }, "Starting media download with retry logic...");
  mediaBuffer = await downloadMediaWithRetry(originalMsg, sock, 3);
  
  if (mediaBuffer) {
    // Full media download succeeded
    saveMediaBuffer(id, mediaBuffer, mediaType);
    previewBase64 = mediaBuffer.toString("base64");
    logger.info({ id, mediaType, size: mediaBuffer.length }, "✅ Media saved successfully (full download)");
  } else {
    // Full media download failed, try to extract thumbnail
    logger.warn({ id }, "⚠️  Could not download full media, attempting to extract thumbnail from message...");
    thumbnailBuffer = extractThumbnailFromMessage(originalMsg);
    
    if (thumbnailBuffer && thumbnailBuffer.length > 0) {
      // Save thumbnail as preview
      saveMediaBuffer(id, thumbnailBuffer, "image"); // Store as image since it's JPEG
      previewBase64 = thumbnailBuffer.toString("base64");
      logger.info({ id, size: thumbnailBuffer.length }, "✅ Thumbnail extracted and saved as fallback preview");
    } else {
      logger.error({ id }, "❌ Could not download media or extract thumbnail — dashboard preview will be unavailable");
    }
  }

  await sock.sendMessage(CONTROL_CHAT, {
    text:
      `🆕 New ${mediaType} received from *${sourceGroupName}*.\n` +
      `ID: *${id}*\n` +
      `${description}\n\n` +
      `Reply "YES ${id}" or "NO ${id}" to confirm.\n` +
      `(Or just reply YES/NO if this is the only pending item.)`,
  });

  // Emit to dashboard with group name
  logger.info({ id, hasPreview: !!previewBase64 }, "✅ Emitting approval:new event to dashboard");
  bus.emit("approval:new", { id, mediaType, caption: description, previewBase64, createdAt: Date.now(), sourceGroupName });

  // Auto-expire after APPROVAL_TIMEOUT_MINUTES if nobody responds.
  const handle = setTimeout(async () => {
    const p = getPending(id);
    if (p && p.status === "pending") {
      deletePending(id);
      bus.emit("approval:expired", { id });
      try {
        await sock.sendMessage(CONTROL_CHAT, { text: ` Request ${id} expired (no response). Discarded.` });
      } catch (e) {
        logger.error({ err: e.message }, "Failed to send expiry notice");
      }
    }
    timeoutHandles.delete(id);
  }, TIMEOUT_MS);
  timeoutHandles.set(id, handle);

  return id;
}

/**
 * Handles a text reply sent in the control chat: figures out which pending
 * request it refers to, classifies it as yes/no, and either broadcasts or discards.
 */
async function handleControlReply(sock, text) {
  const CONTROL_CHAT = getControlChat();
  const cleaned = (text || "").trim();
  if (!cleaned) return;

  const match = cleaned.match(/([a-f0-9]{8})/i);
  let id = match ? match[1].toLowerCase() : null;

  const allPending = readAll();
  if (!id) {
    const pendingIds = Object.keys(allPending).filter((k) => allPending[k].status === "pending");
    if (pendingIds.length === 1) {
      id = pendingIds[0];
    } else if (pendingIds.length > 1) {
      await sock.sendMessage(CONTROL_CHAT, {
        text: `⚠️ Multiple pending requests (${pendingIds.join(", ")}). Please include the ID, e.g. "YES ${pendingIds[0]}".`,
      });
      return;
    }
  }

  if (!id || !allPending[id] || allPending[id].status !== "pending") {
    return;
  }

  let decision = /^(yes|y)\b/i.test(cleaned) ? "yes" : /^(no|n)\b/i.test(cleaned) ? "no" : null;

  if (!decision && process.env.USE_OLLAMA === "true") {
    decision = await classifyReply(cleaned);
    if (decision === "unclear") {
      await sock.sendMessage(CONTROL_CHAT, {
        text: `❓ Couldn't tell if that's a YES or NO for ${id}. Please reply clearly (e.g. "YES ${id}" / "NO ${id}").`,
      });
      return;
    }
  }
  if (!decision) return;
  await resolveApproval(sock, id, decision);
}

async function resolveApproval(sock, id, decision, options = {}) {
  const CONTROL_CHAT = getControlChat();
  const handle = timeoutHandles.get(id);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(id);
  }

  const entry = getPending(id);
  if (!entry) return;

  bus.emit("approval:resolved", { id, decision });

  if (decision === "yes") {
    const groupText = options.customGroups ? `${options.customGroups.length} selected group(s)` : `all target groups`;
    await sock.sendMessage(CONTROL_CHAT, { text: `✅ Broadcasting ${id} to ${groupText}...` });
    let sent, failed;
    if (entry.isDashboardUpload) {
      // Dashboard upload: buffer already saved in store, use broadcastRawMedia
      const { getMediaBuffer } = require("./store");
      const buf = getMediaBuffer(id);
      if (!buf) {
        await sock.sendMessage(CONTROL_CHAT, { text: `❌ Buffer for ${id} not found. Upload may have expired.` });
        deletePending(id);
        return;
      }
      ({ sent, failed } = await broadcastRawMedia(sock, buf, entry.mediaType, entry.caption, options));
    } else {
      ({ sent, failed } = await broadcastToGroups(sock, entry.mediaMessage, options));
    }
    const summary =
      failed.length === 0
        ? `✅ Done. Sent ${id} to ${sent.length} group(s).`
        : `⚠️ Sent ${id} to ${sent.length} group(s), failed for ${failed.length}: ${failed.map((f) => f.jid).join(", ")}`;
    await sock.sendMessage(CONTROL_CHAT, { text: summary });
  } else {
    await sock.sendMessage(CONTROL_CHAT, { text: `🚫 Discarded ${id}.` });
  }

  deletePending(id);
}

module.exports = { requestApproval, handleControlReply, resolveApproval };
