require("dotenv").config({ quiet: true });
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

// Hold a reference to the active socket so the dashboard API can use it.
let currentSock = null;
const getSock = () => currentSock;

// Start the web dashboard server before the bot connects.
createServer(handleControlReply, getSock);

startBot(async (sock) => {
  currentSock = sock;
  bus.emit("bot:connected");

  // Pre-warm the Signal Protocol session with the control chat immediately on
  // connect. This ensures the encrypted session is freshly negotiated BEFORE
  // the first approval message is sent, preventing "Bad MAC" errors on the
  // owner's first YES/NO reply after a bot restart.
  if (CONTROL_CHAT) {
    try {
      await sock.sendMessage(CONTROL_CHAT, { text: "🤖 Bot connected and ready." });
      logger.info("Session warmup ping sent to control chat");
    } catch (e) {
      logger.warn({ err: e.message }, "Session warmup ping failed (non-fatal)");
    }
  }

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

        // Case 2: reply in the private control chat.
        // WhatsApp multi-device sometimes sends private replies from a Linked Device ID (@lid)
        // instead of the standard phone number JID (@s.whatsapp.net).
        // To fix this, we will accept any private message (not from a group) as a control reply.
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        const isPrivateChat = !from.endsWith('@g.us');

        if (isPrivateChat && !isFromMe && text) {
          logger.info({ from, text }, "Control chat reply received (via private chat)");
          await handleControlReply(sock, text);
        }
      } catch (e) {
        logger.error({ err: e.message, stack: e.stack }, "Error handling incoming message");
      }
    }
  });
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});
