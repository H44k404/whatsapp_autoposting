/**
 * Web dashboard server — Express HTTP + Socket.IO.
 * Serves the static dashboard and exposes REST API endpoints.
 * All real-time events are forwarded from the internal event bus to connected browsers via Socket.IO.
 */
require("dotenv").config({ quiet: true });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const helmet = require("helmet");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const bus = require("./events");
const { readAll, getMediaBuffer } = require("./store");
const { messageStore } = require("./whatsapp");
const { downloadMediaMessage } = require("baileys");

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;
const GROUPS_PATH = path.join(__dirname, "..", "config", "groups.json");
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN;
const AUTH_USERNAME = process.env.DASHBOARD_USERNAME?.trim();
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in .env to secure dashboard sessions.");
}
if (!AUTH_USERNAME || !AUTH_PASSWORD) {
  throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be set in .env.");
}
if (AUTH_USERNAME === "admin" || AUTH_PASSWORD === "admin123") {
  throw new Error("Default dashboard credentials are not permitted.");
}

const ALLOWED_CORS_ORIGINS = DASHBOARD_ORIGIN
  ? DASHBOARD_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean)
  : false;

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_DURATION_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function getLoginState(ip) {
  return loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  if (success) {
    loginAttempts.delete(ip);
    return;
  }

  const state = getLoginState(ip);
  const count = state.blockedUntil > now ? state.count : state.count + 1;
  const blockedUntil = count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_BLOCK_DURATION_MS : 0;
  loginAttempts.set(ip, { count, blockedUntil });
}

// In-memory activity log (last 200 entries)
const activityLog = [];
function addLog(type, data) {
  activityLog.unshift({ type, data, ts: Date.now() });
  if (activityLog.length > 200) activityLog.pop();
}

// Stats counters (reset on restart)
const stats = { sentToday: 0, failed: 0 };

// Group name cache to avoid spamming the WhatsApp API
const groupNameCache = new Map();
let cachedParticipatingGroups = null;
let groupCacheTime = 0;

async function refreshGroupCache(sock) {
  if (!sock) return;
  try {
    const participating = await sock.groupFetchAllParticipating();
    cachedParticipatingGroups = participating;
    groupCacheTime = Date.now();
  } catch (e) {
    // ignore
  }
}
async function getGroupName(sock, jid) {
  if (!jid) return "";
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  if (!sock) return jid; // fallback if disconnected
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta && meta.subject) {
      groupNameCache.set(jid, meta.subject);
      return meta.subject;
    }
  } catch (e) {
    // likely not a group, or we left it
  }
  return jid;
}

let _io = null;
let botStatus = "disconnected";
let currentQr = null;

// Track which group chat the dashboard has open (for real-time forwarding)
let activeChatJid = null;

function createServer(handleControlReplyFn, getSock) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: ALLOWED_CORS_ORIGINS
      ? { origin: ALLOWED_CORS_ORIGINS, credentials: true }
      : false,
    allowEIO3: true,
  });
  _io = io;

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.disable("x-powered-by");
  // Use stricter defaults in production; allow inline scripts/styles during
  // local development so the existing static HTML (which contains small
  // inline scripts) continues to work without a nonce-based CSP.
  if (process.env.NODE_ENV === "production") {
    app.use(helmet());
  } else {
    // During local development we disable Helmet's CSP to avoid blocking
    // the small inline handlers in the static `login.html`. Keep other
    // Helmet protections enabled (HSTS, XSS filters, etc.).
    app.use(helmet({ contentSecurityPolicy: false }));
  }
  app.use(compression());
  app.use(express.json({ limit: "10kb" }));

  const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  });
  app.use(sessionMiddleware);

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
      if (err) return next(err);
      if (!socket.request.session || !socket.request.session.authenticated) {
        return next(new Error("Unauthorized"));
      }
      next();
    });
  });

  // ── Auth middleware ───────────────────────────────────────────────────────
  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    res.redirect("/login.html");
  }

  // ── Auth routes (public — no auth required) ───────────────────────────────
  app.post("/auth/login", (req, res) => {
    const username = (req.body?.username || "").trim();
    const password = (req.body?.password || "").trim();
    const clientIp = getClientIp(req);
    const attempt = getLoginState(clientIp);

    if (attempt.blockedUntil > Date.now()) {
      return res.status(429).json({ error: "Too many login attempts. Try again later." });
    }

    if (username === AUTH_USERNAME && password === AUTH_PASSWORD) {
      recordLoginAttempt(clientIp, true);
      req.session.authenticated = true;
      req.session.username = username;
      return res.json({ ok: true });
    }

    recordLoginAttempt(clientIp, false);
    return res.status(401).json({ error: "Invalid username or password." });
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // Gate root and index.html before serving other static files
  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.get("/index.html", requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.use(express.static(path.join(__dirname, "..", "public"), {
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    immutable: process.env.NODE_ENV === "production",
  }));

  // Protect all API routes
  app.use("/api", requireAuth);

  // Bot status + stats
  app.get("/api/status", (req, res) => {
    const all = readAll();
    const pending = Object.values(all).filter((v) => v.status === "pending").length;
    const groups = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
    res.json({
      status: botStatus,
      pending,
      sentToday: stats.sentToday,
      failed: stats.failed,
      targetGroupCount: (groups.targetGroups || []).length,
      qr: currentQr,
    });
  });

  // Extract the embedded JPEG thumbnail from a stored pending entry
  function normalizeThumbnail(thumbnail) {
    if (!thumbnail) return null;
    if (typeof thumbnail === "string") return thumbnail;
    if (Buffer.isBuffer(thumbnail)) return thumbnail.toString("base64");
    if (Array.isArray(thumbnail)) return Buffer.from(thumbnail).toString("base64");
    if (thumbnail && typeof thumbnail === "object" && Array.isArray(thumbnail.data)) {
      return Buffer.from(thumbnail.data).toString("base64");
    }
    return null;
  }

  function extractThumbnail(v) {
    try {
      const msg = v.mediaMessage && v.mediaMessage.message;
      if (!msg) return null;
      const inner = msg.imageMessage || msg.videoMessage || msg.documentMessage || null;
      return normalizeThumbnail(inner && inner.jpegThumbnail ? inner.jpegThumbnail : null);
    } catch (_) { return null; }
  }

  // All pending approvals (without the raw message object — too large)
  app.get("/api/pending", (req, res) => {
    const all = readAll();
    const result = Object.entries(all)
      .filter(([, v]) => v.status === "pending")
      .map(([id, v]) => ({
        id,
        mediaType: v.mediaType,
        caption: v.caption,
        createdAt: v.createdAt,
        hasPreview: !!getMediaBuffer(id),
        thumbnail: extractThumbnail(v),
      }));
    res.json(result);
  });

  // Serve media preview buffer
  app.get("/api/media/:id", (req, res) => {
    const buf = getMediaBuffer(req.params.id);
    const all = readAll();
    const entry = all[req.params.id];
    if (!buf) {
      const thumb = entry ? extractThumbnail(entry) : null;
      if (thumb) {
        res.setHeader("Content-Type", "image/jpeg");
        return res.send(Buffer.from(thumb, "base64"));
      }
      return res.status(404).json({ error: "No preview available" });
    }
    const mime = entry && entry.mediaType === "video" ? "video/mp4" : "image/jpeg";
    res.setHeader("Content-Type", mime);
    res.send(buf);
  });

  // Approve from dashboard
  app.post("/api/approve/:id", async (req, res) => {
    const id = req.params.id;
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      const { resolveApproval } = require("./approval");
      const { targetGroups, delayMs } = req.body || {};
      
      const options = {};
      if (Array.isArray(targetGroups) && targetGroups.length > 0) {
        options.customGroups = targetGroups;
      }
      if (typeof delayMs === "number" && delayMs >= 0) {
        options.delayMs = delayMs * 1000; // convert seconds to ms
      }

      await resolveApproval(sock, id, "yes", options);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Reject from dashboard
  app.post("/api/reject/:id", async (req, res) => {
    const id = req.params.id;
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      await handleControlReplyFn(sock, `NO ${id}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get groups config with resolved names
  app.get("/api/groups", async (req, res) => {
    try {
      const groups = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
      const sock = getSock();
      
      const resolvedTargetGroups = await Promise.all(
        (groups.targetGroups || []).map(async (jid) => {
          const name = await getGroupName(sock, jid);
          return { jid, name };
        })
      );
      
      const mainGroupName = await getGroupName(sock, groups.mainGroup);

      res.json({
        mainGroup: { jid: groups.mainGroup, name: mainGroupName },
        targetGroups: resolvedTargetGroups
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save groups config (expects just an array of targetGroup JIDs)
  app.post("/api/groups", async (req, res) => {
    try {
      const data = req.body;
      if (!data.targetGroups || !Array.isArray(data.targetGroups)) {
        return res.status(400).json({ error: "targetGroups must be an array" });
      }
      // Read existing to keep mainGroup intact
      const existing = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
      existing.targetGroups = data.targetGroups;
      fs.writeFileSync(GROUPS_PATH, JSON.stringify(existing, null, 2));
      
      // Resolve names for the socket emission
      const sock = getSock();
      const resolvedTargetGroups = await Promise.all(
        existing.targetGroups.map(async (jid) => ({ jid, name: await getGroupName(sock, jid) }))
      );
      const mainGroupName = await getGroupName(sock, existing.mainGroup);
      
      const enriched = {
        mainGroup: { jid: existing.mainGroup, name: mainGroupName },
        targetGroups: resolvedTargetGroups
      };
      
      res.json({ ok: true });
      io.emit("groups:updated", enriched);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Activity log
  app.get("/api/logs", (req, res) => {
    res.json(activityLog.slice(0, 100));
  });

  // All groups the bot is participating in (for the groups picker)
  app.get("/api/groups/all", async (req, res) => {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      const now = Date.now();
      // If cache is empty or older than 2 minutes, fetch fresh
      if (!cachedParticipatingGroups || (now - groupCacheTime > 2 * 60 * 1000)) {
        const participating = await sock.groupFetchAllParticipating();
        cachedParticipatingGroups = participating;
        groupCacheTime = now;
      }
      
      const config = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
      const targetSet = new Set(config.targetGroups || []);
      const groups = Object.values(cachedParticipatingGroups).map((g) => ({
        jid: g.id,
        name: g.subject || g.id,
        participantCount: (g.participants || []).length,
        isTarget: targetSet.has(g.id),
        isMain: g.id === config.mainGroup,
      }));
      groups.sort((a, b) => {
        if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
        if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
      res.json(groups);
    } catch (e) {
      if (cachedParticipatingGroups) {
        const config = JSON.parse(fs.readFileSync(GROUPS_PATH, "utf-8"));
        const targetSet = new Set(config.targetGroups || []);
        const groups = Object.values(cachedParticipatingGroups).map((g) => ({
          jid: g.id,
          name: g.subject || g.id,
          participantCount: (g.participants || []).length,
          isTarget: targetSet.has(g.id),
          isMain: g.id === config.mainGroup,
        }));
        groups.sort((a, b) => {
          if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
          if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
          return (a.name || "").localeCompare(b.name || "");
        });
        return res.json(groups);
      }
      res.status(500).json({ error: e.message });
    }
  });

  // Set the active chat JID so the server knows which chat to forward live messages to
  app.post("/api/chat/watch", (req, res) => {
    activeChatJid = req.body.jid || null;
    res.json({ ok: true });
  });

  // Load recent messages from a group (from in-memory store if available)
  app.get("/api/chat/:jid", async (req, res) => {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    const jid = decodeURIComponent(req.params.jid);
    try {
      // Use the shared in-memory store (persisted to disk) — falls back to empty
      const msgs = (messageStore[jid] || []).slice(-50);
      const me = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
      const result = (msgs || []).map((m) => {
        const imageMsg = m.message?.imageMessage;
        const videoMsg = m.message?.videoMessage;
        const mediaType = imageMsg ? "image" : videoMsg ? "video" : null;
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          imageMsg?.caption ||
          videoMsg?.caption ||
          (imageMsg ? "" : null) ||
          (videoMsg ? "" : null) ||
          (m.message?.stickerMessage ? "[Sticker]" : null) ||
          (m.message?.audioMessage ? "[Audio]" : null) ||
          null;
        if (text === null && !mediaType) return null;
        return {
          id: m.key.id,
          fromMe: m.key.fromMe,
          sender: m.key.participant || m.key.remoteJid,
          text: text || "",
          mediaType,
          ts: (m.messageTimestamp?.toNumber?.() || m.messageTimestamp || 0) * 1000,
        };
      }).filter(Boolean);
      res.json({ messages: result, me });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download & stream media for a specific chat message
  app.get("/api/chat/:jid/media/:msgId", async (req, res) => {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    const jid = decodeURIComponent(req.params.jid);
    const msgId = req.params.msgId;
    try {
      const msgs = (messageStore[jid] || []);
      const m = msgs.find((msg) => msg.key.id === msgId);
      if (!m || !m.message) return res.status(404).json({ error: "Message not found" });
      const isVideo = !!m.message.videoMessage;
      const isImage = !!m.message.imageMessage;
      if (!isVideo && !isImage) return res.status(400).json({ error: "Not a media message" });
      const buf = await downloadMediaMessage(m, "buffer", {}, {
        logger: { level: "silent", info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }) },
        reuploadRequest: sock.updateMediaMessage,
      });
      res.setHeader("Content-Type", isVideo ? "video/mp4" : "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Send a message to a group
  app.post("/api/chat/:jid/send", async (req, res) => {
    const sock = getSock();
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    const jid = decodeURIComponent(req.params.jid);
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "text required" });
    try {
      await sock.sendMessage(jid, { text: text.trim() });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Reset/Relink session
  app.post("/api/session/reset", (req, res) => {
    bus.emit("bot:reset_session");
    res.json({ ok: true });
  });

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    // Send current state immediately on connect
    const all = readAll();
    const pending = Object.entries(all)
      .filter(([, v]) => v.status === "pending")
      .map(([id, v]) => ({
        id,
        mediaType: v.mediaType,
        caption: v.caption,
        createdAt: v.createdAt,
        hasPreview: !!getMediaBuffer(id),
        thumbnail: extractThumbnail(v),
      }));
    socket.emit("init", { status: botStatus, pending, logs: activityLog.slice(0, 50), stats, qr: currentQr });
  });

  // ── Forward internal bus events → Socket.IO ──────────────────────────────
  bus.on("bot:connected", () => {
    botStatus = "connected";
    currentQr = null;
    addLog("bot:connected", {});
    io.emit("bot:connected");
    io.emit("status:update", { status: "connected", qr: null });
    // Pre-fetch in background immediately upon connection
    setTimeout(() => refreshGroupCache(getSock()), 500);
  });

  bus.on("bot:disconnected", () => {
    botStatus = "disconnected";
    currentQr = null;
    addLog("bot:disconnected", {});
    io.emit("bot:disconnected");
    io.emit("status:update", { status: "disconnected", qr: null });
  });

  bus.on("bot:connecting", () => {
    botStatus = "connecting";
    currentQr = null;
    io.emit("status:update", { status: "connecting", qr: null });
  });

  bus.on("bot:qr", (data) => {
    currentQr = data.qr;
    io.emit("status:update", { status: "disconnected", qr: currentQr });
  });

  bus.on("approval:new", (data) => {
    addLog("approval:new", data);
    // Get thumbnail from stored pending entry (it's already in the message metadata)
    const stored = readAll()[data.id];
    const thumbnail = stored ? extractThumbnail(stored) : null;
    // Don't forward the full base64 buffer — use thumbnail instead
    io.emit("approval:new", { ...data, previewBase64: undefined, hasPreview: !!data.previewBase64, thumbnail });
  });

  bus.on("approval:resolved", (data) => {
    addLog("approval:resolved", data);
    io.emit("approval:resolved", data);
  });

  bus.on("approval:expired", (data) => {
    addLog("approval:expired", data);
    io.emit("approval:expired", data);
  });

  bus.on("broadcast:start", (data) => {
    addLog("broadcast:start", data);
    io.emit("broadcast:start", data);
  });

  bus.on("broadcast:sent", (data) => {
    stats.sentToday++;
    addLog("broadcast:sent", data);
    io.emit("broadcast:sent", data);
    io.emit("stats:update", { ...stats });
  });

  bus.on("broadcast:failed", (data) => {
    stats.failed++;
    addLog("broadcast:failed", data);
    io.emit("broadcast:failed", data);
    io.emit("stats:update", { ...stats });
  });

  bus.on("broadcast:complete", (data) => {
    addLog("broadcast:complete", data);
    io.emit("broadcast:complete", data);
  });

  bus.on("bot:qr_dataurl", (url) => {
    io.emit("system:qr", url);
  });

  bus.on("bot:connected", () => {
    io.emit("system:connected");
  });

  // Forward ALL live chat messages to dashboard (frontend filters by group)
  bus.on("chat:message", (data) => {
    io.emit("chat:message", data);
  });

  // ── Watch public/ for file changes and hot-reload connected browsers ──────
  const PUBLIC_DIR = path.join(__dirname, "..", "public");
  let reloadDebounce = null;
  try {
    fs.watch(PUBLIC_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        io.emit("reload");
      }, 150);
    });
  } catch (e) {
    // fs.watch not available on all platforms — non-fatal
  }

  httpServer.listen(PORT, () => {
    console.log(`\n🖥️  Dashboard running at → http://localhost:${PORT}\n`);
  });

  return httpServer;
}

module.exports = { createServer };
