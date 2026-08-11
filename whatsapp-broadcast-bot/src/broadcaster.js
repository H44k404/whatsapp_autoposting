const fs = require("fs");
const path = require("path");
const { downloadMediaMessage } = require("baileys");
const logger = require("./utils/logger");
const bus = require("./events");

const GROUPS_PATH = path.join(__dirname, "..", "config", "groups.json");

function loadGroups() {
  return JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const groups = loadGroups();
  const targetGroups = options.customGroups || groups.targetGroups || [];
  
  // Default to 8 seconds if not set in .env, or use custom delay
  const delayMs = options.delayMs !== undefined ? options.delayMs : (parseInt(process.env.BROADCAST_DELAY_MS, 10) || 8000);
  const sent = [];
  const failed = [];

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
    return { sent: [], failed: targetGroups.map(jid => ({ jid, error: "Media download failed" })) };
  }

  logger.info("Media downloaded successfully, starting broadcast loop...");
  bus.emit("broadcast:start", { count: targetGroups.filter(Boolean).length });

    for (const jid of targetGroups) {
    if (!jid) continue;
    try {
      // Build send params and prefer using original message metadata when available
      const sendParams = { caption };
      if (mediaType === "image") {
        sendParams.image = buffer;
      } else {
        sendParams.video = buffer;
        const vmsg = originalMsg?.message?.videoMessage || {};
        sendParams.fileName = vmsg.fileName || "video.mp4";
        if (vmsg.jpegThumbnail) sendParams.jpegThumbnail = vmsg.jpegThumbnail;
        // Provide a sensible default mimetype so Baileys treats this as a video upload
        sendParams.mimetype = vmsg.mimetype || "video/mp4";
      }

      await sock.sendMessage(jid, sendParams);
      logger.info(`✅ Sent to ${jid}`);
      sent.push(jid);
      bus.emit("broadcast:sent", { jid });
    } catch (e) {
      logger.error({ err: e.message, jid }, `❌ Failed to send to ${jid}`);
      failed.push({ jid, error: e.message });
      bus.emit("broadcast:failed", { jid, error: e.message });
    }
    await delay(delayMs);
  }

  logger.info({ sent: sent.length, failed: failed.length }, "Broadcast complete");
  bus.emit("broadcast:complete", { sent: sent.length, failed: failed.length });
  return { sent, failed };
}

/**
 * Broadcasts a raw media buffer directly to all target groups.
 * Used for media uploaded directly from the dashboard.
 */
async function broadcastRawMedia(sock, buffer, mediaType, caption, options = {}) {
  const groups = loadGroups();
  const targetGroups = options.customGroups || groups.targetGroups || [];
  const delayMs = options.delayMs !== undefined ? options.delayMs : (parseInt(process.env.BROADCAST_DELAY_MS, 10) || 8000);
  const sent = [];
  const failed = [];

  logger.info({ groupCount: targetGroups.filter(Boolean).length }, "Starting raw media broadcast...");
  bus.emit("broadcast:start", { count: targetGroups.filter(Boolean).length });

  for (const jid of targetGroups) {
    if (!jid) continue;
    try {
      const sendParams = { caption };
      if (mediaType === "image") {
        sendParams.image = buffer;
      } else {
        sendParams.video = buffer;
        // Raw media from dashboard: provide defaults so WA treats it as a proper video
        sendParams.fileName = options.fileName || "video.mp4";
        sendParams.mimetype = options.mimetype || "video/mp4";
      }

      await sock.sendMessage(jid, sendParams);
      logger.info(`✅ Sent to ${jid}`);
      sent.push(jid);
      bus.emit("broadcast:sent", { jid });
    } catch (e) {
      logger.error({ err: e.message, jid }, `❌ Failed to send to ${jid}`);
      failed.push({ jid, error: e.message });
      bus.emit("broadcast:failed", { jid, error: e.message });
    }
    await delay(delayMs);
  }

  logger.info({ sent: sent.length, failed: failed.length }, "Broadcast complete");
  bus.emit("broadcast:complete", { sent: sent.length, failed: failed.length });
  return { sent, failed };
}

module.exports = { broadcastToGroups, broadcastRawMedia, loadGroups };
