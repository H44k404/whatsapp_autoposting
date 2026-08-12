require("dotenv").config({ quiet: true });
const path = require("path");

// ── Suppress verbose Signal Protocol dumps from Baileys internals ────────
const origLog = console.log;
console.log = function (...args) {
  if (typeof args[0] === 'string' && (args[0].includes('Closing session:') || args[0].includes('SessionEntry'))) return;
  origLog.apply(console, args);
};
const origStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
  if (typeof chunk === 'string' && (chunk.includes('SessionEntry') || chunk.includes('registrationId'))) {
    if (callback) callback();
    return true;
  }
  return origStdoutWrite.apply(process.stdout, arguments);
};
// ─────────────────────────────────────────────────────────────────────────

const { startBot } = require("./whatsapp");
const { requestApproval, handleControlReply } = require("./approval");
const { createServer } = require("./server");
const { loadGroups } = require("./broadcaster");
const logger = require("./utils/logger");
const bus = require("./events");

function getGroupSettings() {
  try {
    const groups = loadGroups();
    return {
      MAIN_GROUP: groups.mainGroup || process.env.MAIN_GROUP_JID,
      CONTROL_CHAT: groups.controlChatJid || process.env.CONTROL_CHAT_JID,
    };
  } catch (err) {
    return {
      MAIN_GROUP: process.env.MAIN_GROUP_JID,
      CONTROL_CHAT: process.env.CONTROL_CHAT_JID,
    };
  }
}

function unwrapMessagePayload(message) {
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message
  );
}

function extractMediaInfo(msg) {
  const raw = unwrapMessagePayload(msg.message);
  const imageMsg = raw.imageMessage;
  const videoMsg = raw.videoMessage;
  const documentMsg = raw.documentMessage;
  const isDocumentImage = !!(documentMsg?.mimetype?.startsWith("image/"));
  const isDocumentVideo = !!(documentMsg?.mimetype?.startsWith("video/"));
  const hasMedia = !!(imageMsg || videoMsg || isDocumentImage || isDocumentVideo);
  const mediaType = imageMsg || isDocumentImage ? "image" : videoMsg || isDocumentVideo ? "video" : null;
  const caption = imageMsg?.caption || videoMsg?.caption || documentMsg?.caption || raw.extendedTextMessage?.text || raw.conversation || "";
  return { raw, imageMsg, videoMsg, documentMsg, hasMedia, mediaType, caption };
}

const fs = require("fs");

// Hold a reference to the active socket so the dashboard API can use it.
let currentSock = null;
const getSock = () => currentSock;

// Start the web dashboard server before the bot connects.
createServer(handleControlReply, getSock);

function connectBot() {
  return startBot(async (sock) => {
    currentSock = sock;
    bus.emit("bot:connected");

    sock.ev.on("connection.update", ({ connection }) => {
      if (connection === "close") {
        currentSock = null;
        bus.emit("bot:disconnected");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const from = msg.key.remoteJid;
          const isFromMe = msg.key.fromMe;

          const { MAIN_GROUP, CONTROL_CHAT } = getGroupSettings();
          const { raw, imageMsg, videoMsg, documentMsg, hasMedia, mediaType, caption } = extractMediaInfo(msg);
          const isSourceGroup = MAIN_GROUP && from === MAIN_GROUP && !isFromMe;
          const isControlChat = CONTROL_CHAT && (from === CONTROL_CHAT || from === `${CONTROL_CHAT.split("@")[0]}@s.whatsapp.net`);

          logger.info(
            {
              from,
              MAIN_GROUP,
              CONTROL_CHAT,
              isSourceGroup,
              isControlChat,
              hasMedia,
              mediaType,
              messageKeys: Object.keys(msg.message || {}),
              rawKeys: Object.keys(raw || {}),
              documentMimetype: documentMsg?.mimetype,
            },
            "Incoming message evaluation"
          );

          // Case 1: media posted in the main (source) group
          // Skip own messages in the group (the bot shouldn't react to its own sends)
          if (isSourceGroup && hasMedia && mediaType) {
            const id = await requestApproval(sock, msg, mediaType, caption);
            logger.info({ id, mediaType }, "Approval request sent to control chat");
            continue;
          }

          // Forward all group messages to the dashboard chat panel in real-time
          if (from.endsWith("@g.us") && !isFromMe) {
            const text =
              msg.message.conversation ||
              msg.message.extendedTextMessage?.text ||
              msg.message.imageMessage?.caption ||
              msg.message.videoMessage?.caption ||
              (msg.message.imageMessage ? "[Image]" : null) ||
              (msg.message.videoMessage ? "[Video]" : null) ||
              (msg.message.stickerMessage ? "[Sticker]" : null) ||
              (msg.message.audioMessage ? "[Audio]" : null);
            if (text) {
              bus.emit("chat:message", {
                jid: from,
                id: msg.key.id,
                fromMe: false,
                sender: msg.key.participant || from,
                text,
                ts: Date.now(),
              });
            }
          }

          // Case 2: reply in the configured control chat (private chat or control group).
          // Only the configured control chat JID may approve/reject requests.
          const replyText =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

          if (!isFromMe && isControlChat && replyText) {
            logger.info({ from, replyText }, "Control chat reply received");
            await handleControlReply(sock, replyText);
          }
        } catch (e) {
          logger.error({ err: e.message, stack: e.stack }, "Error handling incoming message");
        }
      }
    });
  }).catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, "Failed to start WhatsApp bot");
    bus.emit("bot:disconnected");
  });
}

// Start initial connection
connectBot();

// Listen to reset requests from server
bus.on("bot:reset_session", async () => {
  logger.info("Reset session triggered. Logging out...");
  if (currentSock) {
    const origLog = console.log;
    console.log = () => {};  // silence Signal Protocol session dumps during logout
    try {
      await currentSock.logout();
    } catch (e) {
      try { currentSock.end(); } catch (_) {}
    } finally {
      console.log = origLog;
    }
    currentSock = null;
  }
  
  // Wait a second for close event to propagate
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  try {
    fs.rmSync(path.join(__dirname, "..", "auth"), { recursive: true, force: true });
    logger.info("Credentials cleared successfully.");
  } catch (err) {
    logger.warn({ err: err.message }, "Auth folder delete failed or did not exist.");
  }
  
  connectBot();
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});
