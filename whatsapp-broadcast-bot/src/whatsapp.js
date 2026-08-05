const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const logger = require("./utils/logger");
const bus = require("./events");

/**
 * Starts (or reconnects) the Baileys WhatsApp Web socket.
 * @param {(sock: import("baileys").WASocket) => void} onReady called every time the socket reaches "open" state
 * @returns {Promise<import("baileys").WASocket>}
 */
async function startBot(onReady) {
  bus.emit("bot:connecting");
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  // fetchLatestBaileysVersion makes a network request to check the latest WA Web version.
  // Fall back to the bundled version if that call fails (offline / rate-limited).
  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    logger.info({ version }, "Using WA Web version");
  } catch (e) {
    logger.warn({ err: e.message }, "fetchLatestBaileysVersion failed, using bundled version");
    version = undefined; // Baileys will use its own bundled default
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: "silent" }), // Baileys' own internal logger (separate from our app logger)
    printQRInTerminal: false, // we render the QR manually below
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      logger.info("Scan this QR code with the BOT's WhatsApp number (Linked Devices → Link a Device):");
      qrcode.generate(qr, { small: true });
      bus.emit("bot:qr", { qr });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(
        { statusCode, shouldReconnect },
        "Connection closed."
      );
      if (shouldReconnect) {
        startBot(onReady);
      } else {
        logger.error("Logged out from WhatsApp. Delete the ./auth folder and re-scan the QR code to reconnect.");
        bus.emit("bot:logged_out");
      }
    } else if (connection === "open") {
      logger.info("✅ Connected to WhatsApp");
      onReady(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

module.exports = { startBot };
