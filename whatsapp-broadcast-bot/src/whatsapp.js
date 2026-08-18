const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("baileys");
const qrcode = require("qrcode-terminal");
const qrcodeLib = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const logger = require("./utils/logger");
const bus = require("./events");

const STORE_PATH = path.join(__dirname, "..", "data", "message-store.json");
const silentLogger = pino({ level: "silent" });

// ── Simple message store ─────────────────────────────────────────────────────
// Maps jid → Array of message objects (most-recent last, capped at 200 per chat)
const messageStore = {};

// Load persisted store from disk if it exists
if (fs.existsSync(STORE_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    Object.assign(messageStore, raw);
    logger.info("Message store loaded from disk");
  } catch (e) {
    logger.warn({ err: e.message }, "Could not load message store — starting fresh");
  }
}

function persistStore() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(messageStore));
  } catch (e) {
    logger.warn({ err: e.message }, "Could not persist message store to disk");
  }
}

// Save every 30 seconds and on clean exit
setInterval(persistStore, 30_000);
process.on("exit", persistStore);
process.on("SIGINT", () => { persistStore(); process.exit(); });
process.on("SIGTERM", () => { persistStore(); process.exit(); });

/**
 * Upsert messages into the store (add new / replace by key.id).
 * Messages are stored as plain objects — media content is NOT stored (too large);
 * only the message envelope is kept so the key can be used later for on-demand download.
 */
function upsertMessages(jid, msgs, type) {
  if (!jid) return;
  if (!messageStore[jid]) messageStore[jid] = [];
  const arr = messageStore[jid];

  for (const m of msgs) {
    // Strip the actual media payload — store only the message envelope (key + metadata)
    // so it can be passed back to downloadMediaMessage when needed.
    const lean = {
      key: m.key,
      message: m.message,
      messageTimestamp: typeof m.messageTimestamp?.toNumber === "function"
        ? m.messageTimestamp.toNumber()
        : (m.messageTimestamp || 0),
      pushName: m.pushName,
    };
    const idx = arr.findIndex((x) => x.key.id === m.key.id);
    if (idx >= 0) {
      arr[idx] = lean; // update existing
    } else {
      arr.push(lean);
    }
  }

  // Keep newest 200 per chat, sorted by timestamp
  arr.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}

// ── Connection state management ──────────────────────────────────────────
let currentSocket = null;
let reconnectAttempts = 0;
let botStartInProgress = false;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 3000;

// Exponential backoff: 3s, 6s, 12s, 24s, 48s
function getReconnectDelay() {
  return BASE_RECONNECT_DELAY * Math.pow(2, Math.min(reconnectAttempts, 4));
}

// Properly cleanup socket and listeners
async function cleanupSocket(sock) {
  if (!sock) return;
  try {
    // Remove all event listeners to prevent memory leaks
    sock.ev.removeAllListeners();
    // Close the socket connection
    sock.end();
  } catch (e) {
    logger.debug({ err: e.message }, "Error during socket cleanup");
  }
}

/**
 * Starts (or reconnects) the Baileys WhatsApp Web socket.
 * @param {(sock: import("baileys").WASocket) => void} onReady
 */
async function startBot(onReady) {
  if (botStartInProgress) {
    logger.debug("Bot startup already in progress; skipping duplicate start request.");
    return currentSocket;
  }

  if (currentSocket && currentSocket.user) {
    logger.debug("Bot already connected; skipping duplicate start request.");
    return currentSocket;
  }

  botStartInProgress = true;
  bus.emit("bot:connecting");

  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      logger.info({ version }, "Using WA Web version");
    } catch (e) {
      logger.warn({ err: e.message }, "fetchLatestBaileysVersion failed, using bundled version");
      version = undefined;
    }

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: silentLogger,
      printQRInTerminal: false,
      // Improve connection stability
      retryRequestDelayMs: 100,
      maxMsgsInInterval: 10,
      msgIntervalMs: 1000,
      keepAliveIntervalMs: 10000,
      emitOwnEventsFlag: true,
    });

    // Store reference to current socket
    currentSocket = sock;

    // ── Capture incoming messages into our store ────────────────────────────────
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages) {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid || !jid.endsWith("@g.us")) continue; // only store group messages
        upsertMessages(jid, [m], type);
      }
    });

    sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      logger.info("Scan this QR code with the BOT's WhatsApp number (Linked Devices → Link a Device):");
      qrcode.generate(qr, { small: true });
      bus.emit("bot:qr", { qr });
      qrcodeLib.toDataURL(qr, (err, url) => {
        if (!err) bus.emit("bot:qr_dataurl", url);
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isConnectionReplaced;

      logger.warn(
        { statusCode, shouldReconnect, reconnectAttempts, isConnectionReplaced },
        isConnectionReplaced
          ? "Connection replaced by another WhatsApp session. Stopping auto-reconnect to avoid a loop."
          : "Connection closed. Attempting recovery..."
      );

      // Cleanup the failed socket
      await cleanupSocket(sock);
      currentSocket = null;

      if (isConnectionReplaced) {
        logger.error("Another active WhatsApp session was detected. Please log out from other devices and re-run the QR link process.");
        bus.emit("bot:disconnected");
        reconnectAttempts = 0;
        return;
      }

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = getReconnectDelay();
        logger.info(
          { attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs: delay },
          `Reconnecting in ${delay}ms...`
        );

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBot(onReady).catch((err) => {
            logger.error({ err: err.message, stack: err.stack }, "Failed to reconnect WhatsApp socket");
            bus.emit("bot:disconnected");
          });
        }, delay);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error("Max reconnection attempts reached. Please restart the bot.");
        bus.emit("bot:disconnected");
        reconnectAttempts = 0;
      } else {
        logger.error("Logged out from WhatsApp. Delete the ./auth folder and re-scan the QR code to reconnect.");
        bus.emit("bot:logged_out");
        reconnectAttempts = 0;
      }
    } else if (connection === "open") {
      reconnectAttempts = 0; // Reset on successful connection
      logger.info("✅ Connected to WhatsApp");
      bus.emit("bot:connected");
      Promise.resolve(onReady(sock)).catch((err) => {
        logger.error({ err: err.message, stack: err.stack }, "WhatsApp onReady handler failed");
      });
    }
  });

    sock.ev.on("creds.update", saveCreds);

    return sock;
  } finally {
    botStartInProgress = false;
  }
}

module.exports = { startBot, messageStore, cleanupSocket };
