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

const { startBot, cancelReconnect, cleanupSocket } = require("./whatsapp");
const { requestApproval, handleControlReply } = require("./approval");
const { createServer } = require("./server");
const { loadGroups, getGroupName } = require("./broadcaster");
const { autoDeleteExpiredBroadcasts } = require("./broadcastHistory");
const { extractLinkPreview, isSelfPostedLink } = require("./utils/linkPreview");
const logger = require("./utils/logger");
const bus = require("./events");

function getGroupSettings(workspaceId) {
  try {
    const groups = loadGroups(workspaceId);
    const MAIN_GROUP = groups.mainGroup || process.env.MAIN_GROUP_JID;
    const CONTROL_CHAT = groups.controlChatJid || process.env.CONTROL_CHAT_JID;

    if (MAIN_GROUP && CONTROL_CHAT && MAIN_GROUP === CONTROL_CHAT) {
      logger.warn(
        { MAIN_GROUP, CONTROL_CHAT },
        "MAIN_GROUP and CONTROL_CHAT are the same JID. Approval notices will be posted in the source group."
      );
    }

    return { MAIN_GROUP, CONTROL_CHAT };
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
  const linkPreview = hasMedia ? null : extractLinkPreview({ message: raw });
  return { raw, imageMsg, videoMsg, documentMsg, hasMedia, mediaType: mediaType || (linkPreview ? "link" : null), caption, linkPreview };
}

const fs = require("fs");

// Hold a reference to the active socket so the dashboard API can use it.
const sockets = new Map();
const attached = new WeakSet();
const broadcastCleanupTimers = new Map();
const broadcastCleanupRunning = new Set();
const getSock = (workspaceId) => sockets.get(workspaceId || "admin") || null;

async function cleanExpiredBroadcasts(workspaceId) {
  if (broadcastCleanupRunning.has(workspaceId)) return;
  const sock = getSock(workspaceId);
  if (!sock) return;

  broadcastCleanupRunning.add(workspaceId);
  try {
    const groups = loadGroups(workspaceId);
    const results = await autoDeleteExpiredBroadcasts(sock, workspaceId, groups.mainGroup);
    const deleted = results.reduce((count, result) => count + result.deleted, 0);
    const failed = results.reduce((count, result) => count + result.failed, 0);
    if (deleted || failed) {
      logger.info({ workspaceId, deleted, failed }, "Automatic cleanup of expired broadcast copies finished");
    }
    if (deleted) bus.emit("broadcast:auto_deleted", { workspaceId, deleted, failed });
  } catch (error) {
    logger.error({ err: error.message, workspaceId }, "Automatic broadcast-copy cleanup failed");
  } finally {
    broadcastCleanupRunning.delete(workspaceId);
  }
}

function startBroadcastCleanup(workspaceId) {
  if (broadcastCleanupTimers.has(workspaceId)) return;
  const timer = setInterval(() => cleanExpiredBroadcasts(workspaceId), 10 * 60 * 1000);
  timer.unref();
  broadcastCleanupTimers.set(workspaceId, timer);
}

bus.on("bot:connecting", ({ workspaceId = "admin" } = {}) => {
  sockets.delete(workspaceId);
});
bus.on("bot:relink_required", ({ workspaceId = "admin" } = {}) => {
  sockets.delete(workspaceId);
});

// Start WhatsApp only after this process has successfully claimed the dashboard port.
const dashboardServer = createServer(handleControlReply, getSock, connectWorkspace);

function connectWorkspace(workspaceId = "admin") {
  return startBot(workspaceId, async (sock) => {
    sockets.set(workspaceId, sock);
    startBroadcastCleanup(workspaceId);
    void cleanExpiredBroadcasts(workspaceId);

    if (!attached.has(sock)) {
      attached.add(sock);
      
      sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) continue;
            const from = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;

            const { MAIN_GROUP, CONTROL_CHAT } = getGroupSettings(workspaceId);
            const { raw, imageMsg, videoMsg, documentMsg, hasMedia, mediaType, caption } = extractMediaInfo(msg);
            // The connected WhatsApp account may be the account posting media
            // into the source group, so source matching must not reject fromMe.
            const isSourceGroup = MAIN_GROUP && from === MAIN_GROUP;
            const isControlChat = CONTROL_CHAT && (from === CONTROL_CHAT || from === `${CONTROL_CHAT.split("@")[0]}@s.whatsapp.net`);

            if (isSourceGroup && mediaType === "link" && isSelfPostedLink(msg, CONTROL_CHAT)) {
              logger.info({ from, messageId: msg.key.id }, "Ignoring the bot's own link in the source/approval chat");
              continue;
            }

            // Get group name for logging
            const groupName = await getGroupName(sock, from);

            logger.info(
              {
                from,
                groupName,
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
            // Only media in the configured source group creates an approval.
            if (isSourceGroup && mediaType && (hasMedia || mediaType === "link")) {
              try {
                const id = await requestApproval(sock, msg, mediaType, caption);
                if (!id) continue;
                logger.info({ id, mediaType, groupName, captionLength: caption?.length }, "✅ Approval request created and sent to control chat");
                bus.emit("approval:request", { id, mediaType, groupName, from });
              } catch (e) {
                logger.error({ err: e.message, mediaType, groupName }, "❌ Failed to create approval request");
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
                  workspaceId,
                  jid: from,
                  groupName,
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
              logger.info({ from, groupName, replyText }, "Control chat reply received");
              await handleControlReply(sock, replyText);
            }
          } catch (e) {
            logger.error({ err: e.message, stack: e.stack }, "Error handling incoming message");
          }
        }
      });
    }
  }).catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, "Failed to start WhatsApp bot");
    sockets.delete(workspaceId);
  });
}

// Start the initial connection only after the dashboard is listening. This prevents
// a second npm start process from sharing auth state when port 3000 is occupied.
dashboardServer.ready.then(() => connectWorkspace("admin")).catch((err) => {
  logger.error({ err: err.message, port: process.env.DASHBOARD_PORT || 3000 }, "Dashboard failed to start; WhatsApp startup aborted");
  process.exit(1);
});

// Listen to reset requests from server
bus.on("bot:reset_session", async ({ workspaceId = "admin" } = {}) => {
  logger.info({ workspaceId }, "Reset session triggered. Logging out...");
  cancelReconnect(workspaceId);
  const currentSock = sockets.get(workspaceId);
  
  if (currentSock) {
    const origLog = console.log;
    console.log = () => {};  // silence Signal Protocol session dumps during logout
    try {
      await currentSock.logout();
    } catch (e) {
      logger.debug({ err: e.message }, "Logout error (expected)");
    } finally {
      console.log = origLog;
      await cleanupSocket(currentSock);
      sockets.delete(workspaceId);
    }
  }
  
  // Wait a second for close event to propagate
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  try {
    const { ensureWorkspace } = require("./workspace");
    const workspaceAuth = ensureWorkspace(workspaceId).auth;
    fs.rmSync(workspaceAuth, { recursive: true, force: true });
    fs.mkdirSync(workspaceAuth, { recursive: true, mode: 0o700 });

    if (workspaceId === "admin") {
      const legacyAuth = path.join(__dirname, "..", "auth");
      fs.rmSync(legacyAuth, { recursive: true, force: true });
      fs.mkdirSync(legacyAuth, { recursive: true, mode: 0o700 });
    }
    logger.info({ workspaceId }, "Credentials cleared successfully.");
  } catch (err) {
    logger.warn({ err: err.message, workspaceId }, "Auth folder delete failed or did not exist.");
  }

  connectWorkspace(workspaceId);
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});
