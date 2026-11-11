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
const { ADMIN_WORKSPACE_ID, ensureWorkspace } = require("./workspace");

const silentLogger = pino({ level: "silent" });

// ── Simple message store ─────────────────────────────────────────────────────
// Maps jid → Array of message objects (most-recent last, capped at 200 per chat)
const messageStores = new Map();
function getMessageStore(workspaceId = ADMIN_WORKSPACE_ID) {
  if (!messageStores.has(workspaceId)) {
    const store = {};
    const storePath = ensureWorkspace(workspaceId).messages;
    if (fs.existsSync(storePath)) {
      try { Object.assign(store, JSON.parse(fs.readFileSync(storePath, "utf-8"))); } catch (e) {
        logger.warn({ err: e.message, workspaceId }, "Could not load workspace message store");
      }
    }
    messageStores.set(workspaceId, store);
  }
  return messageStores.get(workspaceId);
}

function persistStore(workspaceId) {
  try {
    const storePath = ensureWorkspace(workspaceId).messages;
    fs.writeFileSync(storePath, JSON.stringify(getMessageStore(workspaceId)));
  } catch (e) {
    logger.warn({ err: e.message }, "Could not persist message store to disk");
  }
}

// Save every 30 seconds and on clean exit
const storePersistenceTimer = setInterval(() => {
  for (const workspaceId of messageStores.keys()) persistStore(workspaceId);
}, 30_000);
storePersistenceTimer.unref();
process.on("exit", () => { for (const workspaceId of messageStores.keys()) persistStore(workspaceId); });
process.on("SIGINT", () => { for (const workspaceId of messageStores.keys()) persistStore(workspaceId); process.exit(); });
process.on("SIGTERM", () => { for (const workspaceId of messageStores.keys()) persistStore(workspaceId); process.exit(); });

/**
 * Upsert messages into the store (add new / replace by key.id).
 * Messages are stored as plain objects — media content is NOT stored (too large);
 * only the message envelope is kept so the key can be used later for on-demand download.
 */
function upsertMessages(store, jid, msgs, type) {
  if (!jid) return;
  if (!store[jid]) store[jid] = [];
  const arr = store[jid];

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
const runtimes = new Map();
const BASE_RECONNECT_DELAY = 3000;
const MAX_RECONNECT_DELAY = 60_000;

function getReconnectDelay(attempt) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 5);
  return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, exponent), MAX_RECONNECT_DELAY);
}

function shouldAttemptReconnect(statusCode, isConnectionReplaced) {
  if (isConnectionReplaced) return false;
  if (statusCode === DisconnectReason.loggedOut) return false;
  if (statusCode === DisconnectReason.connectionReplaced) return false;
  if (statusCode === DisconnectReason.forbidden) return false;
  return true;
}

function scheduleReconnect(workspaceId, onReady, runtime, generation) {
  if (runtime.generation !== generation) return;

  runtime.attempts++;
  const delay = getReconnectDelay(runtime.attempts);
  logger.info(
    { attempt: runtime.attempts, delayMs: delay, workspaceId },
    `Reconnecting in ${delay}ms...`
  );
  bus.emit("bot:connecting", { workspaceId });

  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (runtime.generation !== generation) return;
    startBot(workspaceId, onReady).catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, "Failed to reconnect WhatsApp socket; another retry is scheduled");
    });
  }, delay);
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
async function startBot(workspaceIdOrOnReady, onReadyArg) {
  const workspaceId = typeof workspaceIdOrOnReady === "function" ? ADMIN_WORKSPACE_ID : workspaceIdOrOnReady;
  const onReady = typeof workspaceIdOrOnReady === "function" ? workspaceIdOrOnReady : onReadyArg;
  const runtime = runtimes.get(workspaceId) || { socket: null, attempts: 0, starting: false, timer: null };
  runtimes.set(workspaceId, runtime);
  if (runtime.starting) {
    logger.debug("Bot startup already in progress; skipping duplicate start request.");
    return runtime.socket;
  }

  if (runtime.socket && runtime.socket.user) {
    logger.debug("Bot already connected; skipping duplicate start request.");
    return runtime.socket;
  }

  runtime.starting = true;
  runtime.generation = (runtime.generation || 0) + 1;
  const generation = runtime.generation;
  bus.emit("bot:connecting", { workspaceId });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(ensureWorkspace(workspaceId).auth);

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
    sock.workspaceId = workspaceId;
    runtime.socket = sock;
    const messageStore = getMessageStore(workspaceId);

    // ── Capture incoming messages into our store ────────────────────────────────
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages) {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid || !jid.endsWith("@g.us")) continue; // only store group messages
        upsertMessages(messageStore, jid, [m], type);
      }
    });

    sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (runtime.generation !== generation) {
      await cleanupSocket(sock);
      return;
    }

    if (qr) {
      logger.info("Scan this QR code with the BOT's WhatsApp number (Linked Devices → Link a Device):");
      qrcode.generate(qr, { small: true });
      bus.emit("bot:qr", { workspaceId, qr });
      qrcodeLib.toDataURL(qr, (err, url) => {
        if (!err) bus.emit("bot:qr_dataurl", { workspaceId, url });
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced;
      const shouldReconnect = shouldAttemptReconnect(statusCode, isConnectionReplaced);
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden;

      logger.warn(
        { statusCode, shouldReconnect, reconnectAttempts: runtime.attempts, isConnectionReplaced, workspaceId },
        isConnectionReplaced
          ? "Connection replaced by another WhatsApp session. Stopping auto-reconnect."
          : shouldReconnect
            ? "Connection closed. Attempting recovery..."
            : "WhatsApp session is no longer authorized. Manual relinking is required."
      );

      // Cleanup the failed socket
      await cleanupSocket(sock);
      if (runtime.generation !== generation) return;
      runtime.socket = null;

      if (isConnectionReplaced) {
        const reason = "Another WhatsApp Web session replaced this connection. Close the other session, then reconnect from the dashboard.";
        logger.error(reason);
        bus.emit("bot:relink_required", { workspaceId, reason });
        runtime.attempts = 0;
        return;
      }

      if (shouldReconnect) {
        scheduleReconnect(workspaceId, onReady, runtime, generation);
      } else {
        const reason = isLoggedOut
          ? "WhatsApp logged out or rejected this linked session. Credentials were kept; reconnect from the dashboard and scan a new QR code if prompted."
          : "WhatsApp session is no longer valid. Reconnect from the dashboard and scan a new QR code if prompted.";
        logger.error(reason);
        bus.emit("bot:relink_required", { workspaceId, reason });
        runtime.attempts = 0;
      }
    } else if (connection === "open") {
      runtime.attempts = 0; // Reset on successful connection
      logger.info("✅ Connected to WhatsApp");
      bus.emit("bot:connected", { workspaceId });
      Promise.resolve(onReady(sock)).catch((err) => {
        logger.error({ err: err.message, stack: err.stack }, "WhatsApp onReady handler failed");
      });
    }
  });

    sock.ev.on("creds.update", saveCreds);

    return sock;
  } catch (err) {
    if (runtime.generation === generation) {
      runtime.socket = null;
      logger.error({ err: err.message, stack: err.stack, workspaceId }, "WhatsApp socket startup failed; scheduling a retry");
      scheduleReconnect(workspaceId, onReady, runtime, generation);
    }
    throw err;
  } finally {
    runtime.starting = false;
  }
}

function cancelReconnect(workspaceId = ADMIN_WORKSPACE_ID) {
  const runtime = runtimes.get(workspaceId);
  if (!runtime) return;
  runtime.generation = (runtime.generation || 0) + 1;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
  runtime.attempts = 0;
  runtime.socket = null;
}

async function stopWorkspace(workspaceId) {
  const runtime = runtimes.get(workspaceId);
  const sock = runtime?.socket;
  cancelReconnect(workspaceId);
  if (sock) await cleanupSocket(sock);
  runtimes.delete(workspaceId);
  messageStores.delete(workspaceId);
}

module.exports = {
  startBot,
  cancelReconnect,
  stopWorkspace,
  messageStore: getMessageStore(ADMIN_WORKSPACE_ID),
  getMessageStore,
  cleanupSocket,
  shouldAttemptReconnect,
  getReconnectDelay,
  getSocket: (workspaceId) => runtimes.get(workspaceId)?.socket || null,
};
