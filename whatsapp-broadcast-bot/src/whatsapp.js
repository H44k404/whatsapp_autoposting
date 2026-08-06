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

/**
 * Starts (or reconnects) the Baileys WhatsApp Web socket.
 * @param {(sock: import("baileys").WASocket) => void} onReady
 */
async function startBot(onReady) {
  bus.emit("bot:connecting");
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
  });

  // ── Capture incoming messages into our store ────────────────────────────────
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message) continue;
      const jid = m.key.remoteJid;
      if (!jid || !jid.endsWith("@g.us")) continue; // only store group messages
      upsertMessages(jid, [m], type);
    }
  });

  sock.ev.on("connection.update", (update) => {
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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode, shouldReconnect }, "Connection closed.");
      if (shouldReconnect) {
        startBot(onReady);
      } else {
        logger.error("Logged out from WhatsApp. Delete the ./auth folder and re-scan the QR code to reconnect.");
        bus.emit("bot:logged_out");
      }
    } else if (connection === "open") {
      logger.info("✅ Connected to WhatsApp");
      bus.emit("bot:connected");
      onReady(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

module.exports = { startBot, messageStore };
