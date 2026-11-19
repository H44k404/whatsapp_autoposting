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
const { extractLinkPreview, createLinkPreviewMessage, extractMessageThumbnail } = require("./utils/linkPreview");
const { getBroadcastHistory, deleteBroadcast } = require("./broadcastHistory");
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
const pendingDeleteConfirmations = new Map();

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
async function createApproval(sock, originalMsg, mediaType, caption) {
  const workspaceId = sock.workspaceId;
  const CONTROL_CHAT = getControlChat(workspaceId);
  
  if (!CONTROL_CHAT) {
    throw new Error("CONTROL_CHAT_JID is not set in .env or config/groups.json — cannot send approval requests.");
  }

  const id = uuidv4().slice(0, 8);
  let description = caption || "";
  
  // Get the source group name for better logging/display
  const sourceGroupJid = originalMsg.key.remoteJid;
  const sourceGroupName = await getGroupName(sock, sourceGroupJid);
  const linkPreview = mediaType === "link" ? extractLinkPreview(originalMsg) : null;
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

  // Links already contain their preview metadata; media needs a local preview buffer.
  let mediaBuffer = null;
  let thumbnailBuffer = null;
  let previewBase64 = null;

  if (mediaType === "link") {
    thumbnailBuffer = extractMessageThumbnail(originalMsg);
    if (thumbnailBuffer) {
      saveMediaBuffer(id, thumbnailBuffer, "image", workspaceId);
      previewBase64 = thumbnailBuffer.toString("base64");
    }
    if (!approvalChatIsSource) {
      try {
        await sock.sendMessage(CONTROL_CHAT, createLinkPreviewMessage(originalMsg));
      } catch (error) {
        deletePending(id, workspaceId);
        throw error;
      }
    }
  } else {
    logger.info({ id, mediaType, attempt: 1 }, "Starting media download with retry logic...");
    mediaBuffer = await downloadMediaWithRetry(originalMsg, sock, 3);

    if (mediaBuffer) {
      saveMediaBuffer(id, mediaBuffer, mediaType, workspaceId);
      previewBase64 = mediaBuffer.toString("base64");
      logger.info({ id, mediaType, size: mediaBuffer.length }, "Media saved successfully (full download)");
    } else {
      logger.warn({ id }, "Could not download media, attempting to extract thumbnail...");
      thumbnailBuffer = extractThumbnailFromMessage(originalMsg);
      if (thumbnailBuffer && thumbnailBuffer.length > 0) {
        saveMediaBuffer(id, thumbnailBuffer, "image", workspaceId);
        previewBase64 = thumbnailBuffer.toString("base64");
        logger.info({ id, size: thumbnailBuffer.length }, "Thumbnail extracted and saved as fallback preview");
      } else {
        logger.error({ id }, "Could not download media or extract thumbnail; dashboard preview is unavailable");
      }
    }
  }

  const approvalDescription = linkPreview?.title
    ? `Title: ${linkPreview.title}\n${linkPreview.url}`
    : description;
  await sock.sendMessage(CONTROL_CHAT, {
    text:
      `🆕 New ${mediaType} received from *${sourceGroupName}*.\n` +
      `ID: *${id}*\n` +
      (mediaType === "link" && approvalChatIsSource
        ? "The original link preview is already visible in this group.\n\n"
        : `${approvalDescription}\n\n`) +
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
  } catch (error) {
    releaseSourceMessage(sourceMessageId, sourceGroupJid, sock.workspaceId);
    throw error;
  }
}

function isWhatsAppManagementCommand(text) {
  return /^\/(?:help|groups|approve|sent|delete|confirm-delete)(?:\s|$)/i.test(String(text || "").trim());
}

function isPrivateControlChat(chatJid, controlChatJid) {
  return chatJid === controlChatJid && typeof chatJid === "string" && chatJid.endsWith("@s.whatsapp.net");
}

function isAuthorizedControlChatSender(chatJid, controlChatJid, senderJid, ownerJid) {
  if (chatJid !== controlChatJid) return false;
  if (isPrivateControlChat(chatJid, controlChatJid)) return true;
  if (!String(chatJid || "").endsWith("@g.us") || !ownerJid) return false;
  const senders = Array.isArray(senderJid) ? senderJid : [senderJid];
  return senders.includes(ownerJid);
}

function parseApprovalCommand(text, targetGroups) {
  const parts = String(text || "").trim().split(/\s+/);
  const id = (parts[1] || "").toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(id)) return { id, options: {}, error: "Usage: /approve <id> groups=1,3 [compress=auto|on|off] [delay=8-300]" };

  const values = {};
  for (const part of parts.slice(2)) {
    const match = part.match(/^([a-z]+)=(.+)$/i);
    if (!match) return { id, options: {}, error: `Invalid option: ${part}` };
    const key = match[1].toLowerCase();
    if (!["groups", "compress", "delay"].includes(key)) return { id, options: {}, error: `Unknown option: ${key}` };
    if (Object.prototype.hasOwnProperty.call(values, key)) return { id, options: {}, error: `Duplicate option: ${key}` };
    values[key] = match[2].toLowerCase();
  }

  if (!values.groups) return { id, options: {}, error: "Choose destinations with groups=1,3 or groups=all." };
  const configuredGroups = (targetGroups || []).filter(Boolean);
  let customGroups;
  if (values.groups === "all") {
    customGroups = configuredGroups;
  } else {
    const indexes = values.groups.split(",");
    if (!indexes.every((value) => /^\d+$/.test(value))) return { id, options: {}, error: "Group indexes must be comma-separated numbers." };
    const uniqueIndexes = [...new Set(indexes.map(Number))];
    if (uniqueIndexes.some((index) => index < 1 || index > configuredGroups.length)) {
      return { id, options: {}, error: "One or more group indexes are out of range." };
    }
    customGroups = uniqueIndexes.map((index) => configuredGroups[index - 1]);
  }
  if (!customGroups.length) return { id, options: {}, error: "No destination groups are configured." };

  const options = { customGroups, delayMs: 8000 };
  if (values.compress && values.compress !== "auto") {
    if (!["on", "off"].includes(values.compress)) return { id, options: {}, error: "compress must be auto, on, or off." };
    options.compressVideo = values.compress === "on";
  }
  if (values.delay !== undefined) {
    const delaySeconds = Number(values.delay);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 8 || delaySeconds > 300) {
      return { id, options: {}, error: "Delay must be between 8 and 300 seconds." };
    }
    options.delayMs = delaySeconds * 1000;
  }
  return { id, options };
}

async function handleManagementCommand(sock, cleaned, workspaceId, controlChat) {
  if (/^\/help$/i.test(cleaned)) {
    await sock.sendMessage(controlChat, { text: "/groups — list destinations\n/approve <id> groups=1,3 [compress=auto|on|off] [delay=8-300]\n/sent — show recent broadcasts\n/delete <broadcast-id> — request deletion\n/confirm-delete <broadcast-id> — confirm deletion" });
    return true;
  }
  if (/^\/groups$/i.test(cleaned)) {
    const groups = loadGroups(workspaceId);
    const targets = (groups.targetGroups || []).filter(Boolean);
    const text = targets.length
      ? `Destination groups:\n${targets.map((jid, index) => `${index + 1}. ${jid}`).join("\n")}`
      : "No destination groups are configured.";
    await sock.sendMessage(controlChat, { text });
    return true;
  }
  if (/^\/approve(?:\s|$)/i.test(cleaned)) {
    const groups = loadGroups(workspaceId);
    const parsed = parseApprovalCommand(cleaned, groups.targetGroups || []);
    if (parsed.error) {
      await sock.sendMessage(controlChat, { text: parsed.error });
      return true;
    }
    const entry = getPending(parsed.id, workspaceId);
    if (!entry || entry.status !== "pending") {
      await sock.sendMessage(controlChat, { text: `Pending approval ${parsed.id} was not found.` });
      return true;
    }
    await resolveApproval(sock, parsed.id, "yes", { ...parsed.options, workspaceId });
    return true;
  }
  if (/^\/sent$/i.test(cleaned)) {
    const broadcasts = getBroadcastHistory(workspaceId).slice(0, 5);
    const text = broadcasts.length
      ? `Recent broadcasts:\n${broadcasts.map((item) => `${item.id} — ${item.mediaType} — ${new Date(item.createdAt).toLocaleString()}`).join("\n")}`
      : "No tracked broadcasts yet.";
    await sock.sendMessage(controlChat, { text });
    return true;
  }
  const deleteMatch = cleaned.match(/^\/delete\s+([a-f0-9-]+)$/i);
  if (deleteMatch) {
    const broadcastId = deleteMatch[1];
    const found = getBroadcastHistory(workspaceId).some((item) => item.id === broadcastId);
    if (!found) {
      await sock.sendMessage(controlChat, { text: "Broadcast not found." });
      return true;
    }
    pendingDeleteConfirmations.set(`${workspaceId}:${broadcastId}`, Date.now() + 2 * 60 * 1000);
    await sock.sendMessage(controlChat, { text: `This will remove tracked copies only, not the source group. Confirm with /confirm-delete ${broadcastId} within 2 minutes.` });
    return true;
  }
  const confirmMatch = cleaned.match(/^\/confirm-delete\s+([a-f0-9-]+)$/i);
  if (confirmMatch) {
    const broadcastId = confirmMatch[1];
    const confirmationKey = `${workspaceId}:${broadcastId}`;
    const expiresAt = pendingDeleteConfirmations.get(confirmationKey);
    pendingDeleteConfirmations.delete(confirmationKey);
    if (!expiresAt || expiresAt < Date.now()) {
      await sock.sendMessage(controlChat, { text: "Deletion confirmation is missing or expired. Use /delete first." });
      return true;
    }
    const groups = loadGroups(workspaceId);
    const result = await deleteBroadcast(sock, broadcastId, workspaceId, groups.mainGroup);
    if (!result) {
      await sock.sendMessage(controlChat, { text: "Broadcast not found." });
      return true;
    }
    await sock.sendMessage(controlChat, { text: `Deletion finished: removed from ${result.deleted} group(s); ${result.failed} failed; ${result.skipped} source group(s) skipped.` });
    return true;
  }
  return false;
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
  if (isWhatsAppManagementCommand(cleaned)) {
    await handleManagementCommand(sock, cleaned, workspaceId, CONTROL_CHAT);
    return;
  }

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

module.exports = {
  requestApproval,
  handleControlReply,
  resolveApproval,
  isWhatsAppManagementCommand,
  isPrivateControlChat,
  isAuthorizedControlChatSender,
  parseApprovalCommand,
};
