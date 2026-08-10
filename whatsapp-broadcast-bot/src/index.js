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
const logger = require("./utils/logger");
const bus = require("./events");

const MAIN_GROUP = process.env.MAIN_GROUP_JID;
const CONTROL_CHAT = process.env.CONTROL_CHAT_JID;

if (!MAIN_GROUP || !CONTROL_CHAT) {
  logger.warn(
    "MAIN_GROUP_JID and/or CONTROL_CHAT_JID are not set in .env. " +
      "Run `npm run discover-groups` first to find the correct JIDs, then fill in .env and config/groups.json."
  );
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

    sock.ev.on("connection.update", ({ connection }) => {
      if (connection === "close") {
        currentSock = null;
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const from = msg.key.remoteJid;
          const isFromMe = msg.key.fromMe;

          // Case 1: media posted in the main (source) group
          // Skip own messages in the group (the bot shouldn't react to its own sends)
          if (MAIN_GROUP && from === MAIN_GROUP && !isFromMe) {
            const imageMsg = msg.message.imageMessage;
            const videoMsg = msg.message.videoMessage;

            if (imageMsg || videoMsg) {
              const mediaType = imageMsg ? "image" : "video";
              const caption = (imageMsg || videoMsg).caption || "";
              const id = await requestApproval(sock, msg, mediaType, caption);
              logger.info({ id, mediaType }, "Approval request sent to control chat");
            }
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

          // Case 2: reply in the private control chat.
          // Only the configured control chat JID may approve/reject requests.
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

          const isPrivateChat = !from.endsWith('@g.us');
          const isControlChat = from === CONTROL_CHAT || from === `${CONTROL_CHAT.split('@')[0]}@s.whatsapp.net`;

          if (isPrivateChat && !isFromMe && isControlChat && text) {
            logger.info({ from, text }, "Control chat reply received");
            await handleControlReply(sock, text);
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
