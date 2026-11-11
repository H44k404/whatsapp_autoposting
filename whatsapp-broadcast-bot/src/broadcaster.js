const fs = require("fs");
const path = require("path");
const { downloadMediaMessage } = require("baileys");
const logger = require("./utils/logger");
const bus = require("./events");
const { getGroupName } = require("./utils/groupCache");
const { compressVideo, resolveVideoThumbnail } = require("./utils/videoCompressor");
const { extractLinkPreview, restoreMessageBuffers } = require("./utils/linkPreview");
const { v4: uuidv4 } = require("uuid");
const { recordBroadcastMessage } = require("./broadcastHistory");

const { ensureWorkspace } = require("./workspace");
const MIN_COMPRESSION_SIZE_BYTES = Number(process.env.VIDEO_MIN_COMPRESS_BYTES || 8 * 1024 * 1024);

function loadGroups(workspaceId) {
  return JSON.parse(fs.readFileSync(ensureWorkspace(workspaceId).groups, "utf-8"));
}

function shouldCompressVideoForBroadcast(mediaType, buffer, options = {}) {
  if (mediaType !== "video") return false;

  if (Object.prototype.hasOwnProperty.call(options, "compressVideo")) {
    return Boolean(options.compressVideo);
  }

  const autoCompressEnabled = process.env.ENABLE_VIDEO_COMPRESSION !== "false";
  if (!autoCompressEnabled) return false;

  if (!buffer || buffer.length <= 0) return false;

  return buffer.length > MIN_COMPRESSION_SIZE_BYTES;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordSentMessage(broadcastId, jid, groupName, sentMessage, metadata, workspaceId) {
  try {
    recordBroadcastMessage(broadcastId, jid, groupName, sentMessage, metadata, workspaceId);
  } catch (error) {
    logger.error(
      { err: error.message, broadcastId, jid, workspaceId },
      "Message was sent but its broadcast history could not be saved"
    );
  }
}

/**
 * Downloads the media from the original message and re-uploads it as a fresh
 * message to each target group. This entirely removes the "Forwarded" tag.
 * We also use a longer delay (8 seconds by default) to prevent spam detection.
 *
 * @param {import("@whiskeysockets/baileys").WASocket} sock
 * @param {object} originalMsg the raw message object as received from messages.upsert
 * @returns {Promise<{sent: string[], failed: {jid: string, error: string}[]}>}
 */
async function broadcastToGroups(sock, originalMsg, options = {}) {
  const groups = loadGroups(options.workspaceId || sock.workspaceId);
  const targetGroups = options.customGroups || groups.targetGroups || [];
  const broadcastId = options.broadcastId || uuidv4();
  const metadata = {
    mediaType: options.mediaType || (extractLinkPreview(originalMsg) ? "link" : "media"),
    caption: options.caption || "",
    approvalId: options.approvalId || null,
    sourceGroupJid: groups.mainGroup,
  };
  
  // Default to 8 seconds if not set in .env, or use custom delay
  const delayMs = options.delayMs !== undefined ? options.delayMs : (parseInt(process.env.BROADCAST_DELAY_MS, 10) || 8000);
  const sent = [];
  const failed = [];

  if (extractLinkPreview(originalMsg)) {
    const forwardedMessage = {
      forward: restoreMessageBuffers(originalMsg),
      force: true,
    };
    logger.info({ groupCount: targetGroups.filter(Boolean).length }, "Forwarding approved link with its original WhatsApp preview...");
    bus.emit("broadcast:start", { workspaceId: options.workspaceId || sock.workspaceId, count: targetGroups.filter(Boolean).length });

    for (const jid of targetGroups) {
      if (!jid) continue;
      try {
        const groupName = await getGroupName(sock, jid);
        const sentMessage = await sock.sendMessage(jid, forwardedMessage);
        recordSentMessage(broadcastId, jid, groupName, sentMessage, metadata, options.workspaceId || sock.workspaceId);
        logger.info(`✅ Sent link to ${groupName} (${jid})`);
        sent.push(jid);
        bus.emit("broadcast:sent", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName });
      } catch (e) {
        const groupName = await getGroupName(sock, jid);
        logger.error({ err: e.message, jid }, `❌ Failed to forward link to ${groupName} (${jid})`);
        failed.push({ jid, error: e.message });
        bus.emit("broadcast:failed", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName, error: e.message });
      }
      await delay(delayMs);
    }

    logger.info({ sent: sent.length, failed: failed.length }, "Link broadcast complete");
    bus.emit("broadcast:complete", { workspaceId: options.workspaceId || sock.workspaceId, sent: sent.length, failed: failed.length });
    return { sent, failed };
  }

  logger.info({ groupCount: targetGroups.filter(Boolean).length }, "Downloading media for broadcast (no-forward tag)...");

  let buffer;
  let caption = "";
  let mediaType = "image";

  try {
    const imageMsg = originalMsg.message?.imageMessage;
    const videoMsg = originalMsg.message?.videoMessage;

    if (imageMsg) {
      mediaType = "image";
      caption = imageMsg.caption || "";
    } else if (videoMsg) {
      mediaType = "video";
      caption = videoMsg.caption || "";
    }

    buffer = await downloadMediaMessage(
      originalMsg,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }
    );
  } catch (err) {
    logger.error({ err: err.message }, "Failed to download media for broadcasting");
    // Keep the original forwarding behavior as a safe fallback for messages
    // whose media cannot be re-uploaded (and for non-media test doubles).
    for (const jid of targetGroups) {
      if (!jid) continue;
      try {
        const sentMessage = await sock.sendMessage(jid, { forward: originalMsg, force: true });
        recordSentMessage(broadcastId, jid, await getGroupName(sock, jid), sentMessage, metadata, options.workspaceId || sock.workspaceId);
        sent.push(jid);
      } catch (forwardError) {
        failed.push({ jid, error: forwardError.message });
      }
      await delay(delayMs);
    }
    return { sent, failed };
  }

  logger.info("Media downloaded successfully, starting broadcast loop...");
  
  let videoThumbnail = null;

  if (shouldCompressVideoForBroadcast(mediaType, buffer, options)) {
    logger.info({ inputSizeBytes: buffer.length, minCompressBytes: MIN_COMPRESSION_SIZE_BYTES }, "Compressing video before broadcast");
    buffer = await compressVideo(buffer, "mp4");
    videoThumbnail = await resolveVideoThumbnail(originalMsg, buffer);
  } else if (mediaType === "video") {
    logger.info({ inputSizeBytes: buffer.length }, "Skipping video compression for this send");
  }
  
  bus.emit("broadcast:start", { workspaceId: options.workspaceId || sock.workspaceId, count: targetGroups.filter(Boolean).length });

  for (const jid of targetGroups) {
    if (!jid) continue;
    try {
      // Get group name for logging
      const groupName = await getGroupName(sock, jid);
      
      // Build send params and prefer using original message metadata when available
      const sendParams = { caption };
      if (mediaType === "image") {
        sendParams.image = buffer;
        if (videoThumbnail) sendParams.jpegThumbnail = videoThumbnail;
      } else {
        sendParams.video = buffer;
        if (videoThumbnail) sendParams.jpegThumbnail = videoThumbnail;
        const vmsg = originalMsg?.message?.videoMessage || {};
        if (vmsg.fileName) sendParams.fileName = vmsg.fileName;
        // Provide a sensible default mimetype so Baileys treats this as a video upload
        sendParams.mimetype = vmsg.mimetype || "video/mp4";
      }

      const sentMessage = await sock.sendMessage(jid, sendParams);
      recordSentMessage(broadcastId, jid, groupName, sentMessage, metadata, options.workspaceId || sock.workspaceId);
      logger.info(`✅ Sent to ${groupName} (${jid})`);
      sent.push(jid);
      bus.emit("broadcast:sent", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName });
    } catch (e) {
      const groupName = await getGroupName(sock, jid);
      logger.error({ err: e.message, jid }, `❌ Failed to send to ${groupName} (${jid})`);
      failed.push({ jid, error: e.message });
      bus.emit("broadcast:failed", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName, error: e.message });
    }
    await delay(delayMs);
  }

  logger.info({ sent: sent.length, failed: failed.length }, "Broadcast complete");
  bus.emit("broadcast:complete", { workspaceId: options.workspaceId || sock.workspaceId, sent: sent.length, failed: failed.length });
  return { sent, failed };
}

/**
 * Broadcasts a raw media buffer directly to all target groups.
 * Used for media uploaded directly from the dashboard.
 */
async function broadcastRawMedia(sock, buffer, mediaType, caption, options = {}) {
  const groups = loadGroups(options.workspaceId || sock.workspaceId);
  const targetGroups = options.customGroups || groups.targetGroups || [];
  const broadcastId = options.broadcastId || uuidv4();
  const metadata = { mediaType, caption: caption || "", approvalId: options.approvalId || null, sourceGroupJid: groups.mainGroup };
  const delayMs = options.delayMs !== undefined ? options.delayMs : (parseInt(process.env.BROADCAST_DELAY_MS, 10) || 8000);
  const sent = [];
  const failed = [];

  logger.info({ groupCount: targetGroups.filter(Boolean).length }, "Starting raw media broadcast...");
  
  let videoThumbnail = null;

  if (shouldCompressVideoForBroadcast(mediaType, buffer, options)) {
    logger.info({ inputSizeBytes: buffer.length, minCompressBytes: MIN_COMPRESSION_SIZE_BYTES }, "Compressing video before raw broadcast");
    buffer = await compressVideo(buffer, "mp4");
    videoThumbnail = await resolveVideoThumbnail(null, buffer);
  } else if (mediaType === "video") {
    logger.info({ inputSizeBytes: buffer.length }, "Skipping video compression for this raw send");
  }
  
  bus.emit("broadcast:start", { workspaceId: options.workspaceId || sock.workspaceId, count: targetGroups.filter(Boolean).length });

  for (const jid of targetGroups) {
    if (!jid) continue;
    try {
      // Get group name for logging
      const groupName = await getGroupName(sock, jid);
      
      const sendParams = { caption };
      if (mediaType === "image") {
        sendParams.image = buffer;
        if (videoThumbnail) sendParams.jpegThumbnail = videoThumbnail;
      } else {
        sendParams.video = buffer;
        if (videoThumbnail) sendParams.jpegThumbnail = videoThumbnail;
        // Raw media from dashboard: provide defaults so WA treats it as a proper video
        sendParams.fileName = options.fileName || "video.mp4";
        sendParams.mimetype = options.mimetype || "video/mp4";
      }

      const sentMessage = await sock.sendMessage(jid, sendParams);
      recordSentMessage(broadcastId, jid, groupName, sentMessage, metadata, options.workspaceId || sock.workspaceId);
      logger.info(`✅ Sent to ${groupName} (${jid})`);
      sent.push(jid);
      bus.emit("broadcast:sent", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName });
    } catch (e) {
      const groupName = await getGroupName(sock, jid);
      logger.error({ err: e.message, jid }, `❌ Failed to send to ${groupName} (${jid})`);
      failed.push({ jid, error: e.message });
      bus.emit("broadcast:failed", { workspaceId: options.workspaceId || sock.workspaceId, jid, groupName, error: e.message });
    }
    await delay(delayMs);
  }

  logger.info({ sent: sent.length, failed: failed.length }, "Broadcast complete");
  bus.emit("broadcast:complete", { workspaceId: options.workspaceId || sock.workspaceId, sent: sent.length, failed: failed.length });
  return { sent, failed };
}

module.exports = { broadcastToGroups, broadcastRawMedia, loadGroups, getGroupName };
