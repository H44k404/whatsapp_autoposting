const { v4: uuidv4 } = require("uuid");
const { downloadMediaMessage } = require("baileys");
const {
  savePending,
  getPending,
  deletePending,
  readAll,
  saveMediaBuffer,
  claimSourceMessage,
  completeSourceMessage,
  releaseSourceMessage,
} = require("./store");
const { classifyReply, describeMedia } = require("./ollama");
const { broadcastToGroups, broadcastRawMedia, loadGroups, getGroupName } = require("./broadcaster");
const { extractLinkPreview, restoreMessageBuffers } = require("./utils/linkPreview");
const logger = require("./utils/logger");
const bus = require("./events");

// parseFloat (not parseInt) so fractional-minute timeouts work correctly too
const TIMEOUT_MS = (parseFloat(process.env.APPROVAL_TIMEOUT_MINUTES) || 30) * 60000;

function getControlChat(workspaceId) {
  try {
    const groups = loadGroups(workspaceId);
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
 * Downloads media previews or preserves a WhatsApp link preview for the dashboard.
 */
async function createApproval(sock, originalMsg, mediaType, caption) {
  const workspaceId = sock.workspaceId;
  const CONTROL_CHAT = getControlChat(workspaceId);
  
  if (!CONTROL_CHAT) {
    throw new Error("CONTROL_CHAT_JID is not set in .env or config/groups.json — cannot send approval requests.");
  }

  const id = uuidv4().slice(0, 8);
  let description = caption || "";
  const linkPreview = mediaType === "link" ? extractLinkPreview(originalMsg) : null;
  
  // Get the source group name for better logging/display
  const sourceGroupJid = originalMsg.key.remoteJid;
  const sourceGroupName = await getGroupName(sock, sourceGroupJid);
  const approvalChatIsSource = sourceGroupJid === CONTROL_CHAT;

  if (mediaType !== "link" && process.env.USE_OLLAMA === "true") {
    try {
      description = await describeMedia(caption);
    } catch (e) {
      logger.warn({ err: e.message }, "Ollama describe failed, using raw caption");
    }
  }

  savePending(id, {
    mediaMessage: originalMsg,
    sourceMessageId: originalMsg.key.id,
    mediaType,
    caption: caption || "",
    linkPreview,
    createdAt: Date.now(),
    status: "pending",
    isDashboardUpload: false,
    sourceGroupJid,
    sourceGroupName,
  }, workspaceId);

  // Forward the original message so Facebook video previews stay intact.
  let mediaBuffer = null;
  let thumbnailBuffer = null;
  let previewBase64 = null;

  if (mediaType === "link") {
    if (approvalChatIsSource) {
      logger.info({ id, sourceGroupJid }, "Link preview is already in the approval chat; skipping duplicate forward");
    } else {
      try {
        await sock.sendMessage(CONTROL_CHAT, {
          forward: restoreMessageBuffers(originalMsg),
          force: true,
        });
      } catch (e) {
        deletePending(id, workspaceId);
        logger.error({ err: e.message, id }, "Failed to forward original link message");
        throw e;
      }
    }
  } else {
    // Try to download full media first
    logger.info({ id, mediaType, attempt: 1 }, "Starting media download with retry logic...");
    mediaBuffer = await downloadMediaWithRetry(originalMsg, sock, 3);

    if (mediaBuffer) {
      // Full media download succeeded
      saveMediaBuffer(id, mediaBuffer, mediaType, workspaceId);
      previewBase64 = mediaBuffer.toString("base64");
      logger.info({ id, mediaType, size: mediaBuffer.length }, "✅ Media saved successfully (full download)");
    } else {
      // Full media download failed, try to extract thumbnail
      logger.warn({ id }, "⚠️  Could not download media, attempting to extract thumbnail from message...");
      thumbnailBuffer = extractThumbnailFromMessage(originalMsg);

      if (thumbnailBuffer && thumbnailBuffer.length > 0) {
        // Save thumbnail as preview
        saveMediaBuffer(id, thumbnailBuffer, "image", workspaceId);
        previewBase64 = thumbnailBuffer.toString("base64");
        logger.info({ id, size: thumbnailBuffer.length }, "✅ Thumbnail extracted and saved as fallback preview");
      } else {
        logger.error({ id }, "❌ Could not download media or extract thumbnail — dashboard preview will be unavailable");
      }
    }
  }

  await sock.sendMessage(CONTROL_CHAT, {
    text:
      `🆕 New ${mediaType} received from *${sourceGroupName}*.\n` +
      `ID: *${id}*\n` +
      (linkPreview?.title ? `Title: ${linkPreview.title}\n` : "") +
      (linkPreview?.url && !approvalChatIsSource ? `Link: ${linkPreview.url}\n` : "") +
      (mediaType === "link" && approvalChatIsSource
        ? "The original link preview is already visible in this group.\n\n"
        : `${description}\n\n`) +
      `Reply "YES ${id}" or "NO ${id}" to confirm.\n` +
      `(Or just reply YES/NO if this is the only pending item.)`,
  });

  // Emit to dashboard with group name
  logger.info({ id, hasPreview: !!previewBase64 }, "✅ Emitting approval:new event to dashboard");
  bus.emit("approval:new", { workspaceId, id, mediaType, caption: description, linkPreview, previewBase64, createdAt: Date.now(), sourceGroupName });

  // Auto-expire after APPROVAL_TIMEOUT_MINUTES if nobody responds.
  const handle = setTimeout(async () => {
    const p = getPending(id, workspaceId);
    if (p && p.status === "pending") {
      deletePending(id, workspaceId);
      bus.emit("approval:expired", { workspaceId, id });
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

async function requestApproval(sock, originalMsg, mediaType, caption) {
  const sourceGroupJid = originalMsg.key.remoteJid;
  const sourceMessageId = originalMsg.key.id;
  if (!claimSourceMessage(sourceMessageId, sourceGroupJid, sock.workspaceId)) {
    logger.info({ sourceGroupJid, sourceMessageId }, "Skipping duplicate source message approval");
    return null;
  }

  try {
    const id = await createApproval(sock, originalMsg, mediaType, caption);
    completeSourceMessage(sourceMessageId, sourceGroupJid, sock.workspaceId);
    return id;
  } catch (e) {
    releaseSourceMessage(sourceMessageId, sourceGroupJid, sock.workspaceId);
    throw e;
  }
}

/**
 * Handles a text reply sent in the control chat: figures out which pending
 * request it refers to, classifies it as yes/no, and either broadcasts or discards.
 */
async function handleControlReply(sock, text) {
  const workspaceId = sock.workspaceId;
  const CONTROL_CHAT = getControlChat(workspaceId);
  const cleaned = (text || "").trim();
  if (!cleaned) return;

  const match = cleaned.match(/([a-f0-9]{8})/i);
  let id = match ? match[1].toLowerCase() : null;

  const allPending = readAll(workspaceId);
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
  const workspaceId = sock.workspaceId;
  const CONTROL_CHAT = getControlChat(workspaceId);
  const handle = timeoutHandles.get(id);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(id);
  }

  const entry = getPending(id, workspaceId);
  if (!entry) return;

  bus.emit("approval:resolved", { workspaceId, id, decision });

  if (decision === "yes") {
    const groupText = options.customGroups ? `${options.customGroups.length} selected group(s)` : `all target groups`;
    await sock.sendMessage(CONTROL_CHAT, { text: `✅ Broadcasting ${id} to ${groupText}...` });
    const broadcastOptions = { ...options, broadcastId: uuidv4(), approvalId: id };
    let sent, failed;
    if (entry.isDashboardUpload) {
      // Dashboard upload: buffer already saved in store, use broadcastRawMedia
      const { getMediaBuffer } = require("./store");
      const buf = getMediaBuffer(id, workspaceId);
      if (!buf) {
        await sock.sendMessage(CONTROL_CHAT, { text: `❌ Buffer for ${id} not found. Upload may have expired.` });
        deletePending(id, workspaceId);
        return;
      }
      ({ sent, failed } = await broadcastRawMedia(sock, buf, entry.mediaType, entry.caption, broadcastOptions));
    } else {
      ({ sent, failed } = await broadcastToGroups(sock, entry.mediaMessage, {
        ...broadcastOptions,
        mediaType: entry.mediaType,
        caption: entry.caption,
      }));
    }
    const summary =
      failed.length === 0
        ? `✅ Done. Sent ${id} to ${sent.length} group(s).`
        : `⚠️ Sent ${id} to ${sent.length} group(s), failed for ${failed.length}: ${failed.map((f) => f.jid).join(", ")}`;
    await sock.sendMessage(CONTROL_CHAT, { text: summary });
  } else {
    await sock.sendMessage(CONTROL_CHAT, { text: `🚫 Discarded ${id}.` });
  }

  deletePending(id, workspaceId);
}

module.exports = { requestApproval, handleControlReply, resolveApproval };
