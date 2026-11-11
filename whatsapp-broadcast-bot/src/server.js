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
const connectPgSimple = require("connect-pg-simple");
const helmet = require("helmet");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bus = require("./events");
const { readAll, getMediaBuffer } = require("./store");
const { getBroadcastHistory, deleteBroadcast } = require("./broadcastHistory");
const { getMessageStore, getSocket, startBot, stopWorkspace } = require("./whatsapp");
const { ensureWorkspace, removeWorkspaceData, ADMIN_WORKSPACE_ID } = require("./workspace");
const { downloadMediaMessage } = require("baileys");
const { pool } = require("./db");
const logger = require("./utils/logger");
const {
  createUser,
  findActiveUser,
  getWorkspaceForUser,
  listUsers,
  recordAudit,
  setUserActive,
  deleteWorkerAccount,
  verifyPassword,
} = require("./auth");

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;
const GROUPS_PATH = path.join(__dirname, "..", "config", "groups.json");
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN;
const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in .env to secure dashboard sessions.");
}
const PgSessionStore = connectPgSimple(session);

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

function createCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

// In-memory activity log (last 200 entries)
const activityLog = [];
function addLog(type, data) {
  activityLog.unshift({ type, data, ts: Date.now() });
  if (activityLog.length > 200) activityLog.pop();
}

// Stats counters (reset on restart)
const workspaceStats = new Map();
function getStats(workspaceId) {
  if (!workspaceStats.has(workspaceId)) workspaceStats.set(workspaceId, { sentToday: 0, failed: 0 });
  return workspaceStats.get(workspaceId);
}

// Group name cache to avoid spamming the WhatsApp API
const groupNameCache = new Map();
const participatingGroupsCache = new Map();

async function refreshGroupCache(sock) {
  if (!sock) return null;
  const workspaceId = sock.workspaceId || ADMIN_WORKSPACE_ID;
  try {
    const participating = await sock.groupFetchAllParticipating();
    participatingGroupsCache.set(workspaceId, { groups: participating, fetchedAt: Date.now() });
    return participating;
  } catch (e) {
    return null;
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
const workspaceQr = new Map();
const workspaceStatus = new Map();

// Track which group chat the dashboard has open (for real-time forwarding)
let activeChatJid = null;

function createServer(handleControlReplyFn, getSock, startWorkspaceFn = null) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: ALLOWED_CORS_ORIGINS
      ? { origin: ALLOWED_CORS_ORIGINS, credentials: true }
      : false,
    allowEIO3: true,
  });
  _io = io;

  function workspaceIdForSocket(socket) {
    return socket.request.session.workspaceId || (socket.request.session.role === "admin" ? ADMIN_WORKSPACE_ID : null);
  }

  function emitToWorkspace(workspaceId, event, payload) {
    for (const socket of io.sockets.sockets.values()) {
      if (workspaceIdForSocket(socket) === workspaceId) socket.emit(event, payload);
    }
  }

  function disconnectWorkspace(workspaceId) {
    for (const socket of io.sockets.sockets.values()) {
      if (workspaceIdForSocket(socket) === workspaceId) socket.disconnect(true);
    }
  }

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.disable("x-powered-by");
  // Use stricter defaults in production; allow inline scripts/styles during
  // local development so the existing static HTML continues to work.
  const helmetOptions = {
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: false,
  };
  app.use(helmet(helmetOptions));

  // Explicitly remove headers that break plain HTTP dashboard usage.
  app.use((req, res, next) => {
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("Strict-Transport-Security");
    res.removeHeader("Cross-Origin-Opener-Policy");
    res.removeHeader("Cross-Origin-Embedder-Policy");
    res.removeHeader("Cross-Origin-Resource-Policy");
    res.removeHeader("Origin-Agent-Cluster");
    next();
  });

  app.use(compression());
  app.use(express.json({ limit: "10kb" }));

  const sessionMiddleware = session({
    secret: SESSION_SECRET,
    store: new PgSessionStore({ pool, createTableIfMissing: false }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  });
  app.use(sessionMiddleware);

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
      if (err) return next(err);
      if (!socket.request.session || !socket.request.session.authenticated || !socket.request.session.userId) {
        return next(new Error("Unauthorized"));
      }
      next();
    });
  });

  // ── Auth middleware ───────────────────────────────────────────────────────
  function requireAuth(req, res, next) {
    if (req.session?.authenticated && req.session.userId) return next();
    if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    res.redirect("/login.html");
  }

  function requireAdmin(req, res, next) {
    if (req.session?.role === "admin") return next();
    return res.status(403).json({ error: "Admin access required." });
  }

  function getWorkspaceId(req) {
    return req.session.workspaceId || (req.session.role === "admin" ? ADMIN_WORKSPACE_ID : null);
  }

  function getRequestSock(req) {
    return getSock(getWorkspaceId(req)) || getSocket(getWorkspaceId(req));
  }

  function requireCsrf(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const supplied = req.get("x-csrf-token");
    const expected = req.session?.csrfToken;
    if (!supplied || !expected) return res.status(403).json({ error: "CSRF validation failed." });
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      return res.status(403).json({ error: "CSRF validation failed." });
    }
    next();
  }

  // ── Auth routes (public — no auth required) ───────────────────────────────
  app.post("/auth/login", async (req, res) => {
    const username = (req.body?.username || "").trim();
    const password = (req.body?.password || "").trim();
    const clientIp = getClientIp(req);
    const attempt = getLoginState(clientIp);

    if (attempt.blockedUntil > Date.now()) {
      return res.status(429).json({ error: "Too many login attempts. Try again later." });
    }

    const user = await findActiveUser(username.toLowerCase());
    if (user && await verifyPassword(user, password)) {
      recordLoginAttempt(clientIp, true);
      return req.session.regenerate(async (err) => {
        if (err) return res.status(500).json({ error: "Unable to create session." });
        req.session.authenticated = true;
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        const workspace = await getWorkspaceForUser(user.id);
        req.session.workspaceId = user.role === "admin" ? ADMIN_WORKSPACE_ID : (workspace?.id || null);
        req.session.csrfToken = createCsrfToken();
        await recordAudit({ userId: user.id, action: "login", ipAddress: clientIp });
        return res.json({ ok: true });
      });
    }

    recordLoginAttempt(clientIp, false);
    await recordAudit({ action: "login_failed", ipAddress: clientIp, metadata: { username: username.slice(0, 64) } });
    return res.status(401).json({ error: "Invalid username or password." });
  });

  app.post("/auth/logout", requireCsrf, (req, res) => {
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
  app.use("/api", requireCsrf);

  app.get("/api/csrf", (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = createCsrfToken();
    res.json({ token: req.session.csrfToken });
  });

  app.get("/api/me", (req, res) => {
    res.json({ username: req.session.username, role: req.session.role, workspaceId: getWorkspaceId(req) });
  });

  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    res.json(await listUsers());
  });

  app.post("/api/admin/users", requireAdmin, async (req, res) => {
    try {
      const { username, password, workspaceName } = req.body || {};
      const user = await createUser({ username, password, role: "worker", workspaceName });
      await recordAudit({ userId: req.session.userId, action: "worker_created", metadata: { username: user.username } });
      res.status(201).json(user);
    } catch (error) {
      const duplicate = error.code === "23505";
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? "Username already exists." : error.message });
    }
  });

  app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const isActive = req.body?.isActive;
      if (typeof isActive !== "boolean") return res.status(400).json({ error: "isActive must be boolean." });
      const user = await setUserActive(req.params.id, isActive);
      if (!user) return res.status(404).json({ error: "User not found." });
      await recordAudit({ userId: req.session.userId, action: isActive ? "worker_enabled" : "worker_disabled", metadata: { userId: user.id } });
      res.json(user);
    } catch (error) {
      res.status(400).json({ error: "Unable to update user." });
    }
  });

  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const userId = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return res.status(400).json({ error: "Invalid team member ID." });
    }
    if (userId === req.session.userId) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    try {
      const deletedUser = await deleteWorkerAccount(userId, req.session.userId);
      if (!deletedUser) return res.status(404).json({ error: "Team member not found." });

      disconnectWorkspace(deletedUser.workspaceId);
      await stopWorkspace(deletedUser.workspaceId);
      try {
        removeWorkspaceData(deletedUser.workspaceId);
      } catch (error) {
        logger.error({ err: error.message, userId, workspaceId: deletedUser.workspaceId }, "Worker account was deleted but workspace data cleanup failed");
        return res.status(500).json({ error: "Account deleted, but workspace data cleanup failed. Contact an administrator." });
      }

      res.json({ ok: true, username: deletedUser.username });
    } catch (error) {
      if (error.code === "NOT_WORKER") return res.status(403).json({ error: error.message });
      logger.error({ err: error.message, userId }, "Unable to delete team member");
      res.status(500).json({ error: "Unable to delete team member." });
    }
  });

  // Bot status + stats
  app.get("/api/status", (req, res) => {
    const workspaceId = getWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: "No workspace found" });
    const stats = getStats(workspaceId);

    const all = readAll(workspaceId);
    const pending = Object.values(all).filter((v) => v.status === "pending").length;

    const groups = JSON.parse(fs.readFileSync(ensureWorkspace(workspaceId).groups, "utf-8"));
    const sock = getRequestSock(req);
    res.json({
      status: sock?.user ? "connected" : (workspaceStatus.get(workspaceId) || "disconnected"),
      pending,
      sentToday: stats.sentToday,
      failed: stats.failed,
      targetGroupCount: (groups.targetGroups || []).length,
      qr: workspaceQr.get(workspaceId) || null,
      role: req.session.role,
      workspace: workspaceId
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
      let msg = v.mediaMessage && v.mediaMessage.message;
      if (!msg) return null;
      while (msg.ephemeralMessage?.message || msg.viewOnceMessage?.message) {
        msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message;
      }
      const inner = msg.imageMessage || msg.videoMessage || msg.documentMessage || msg.extendedTextMessage || null;
      const externalPreview = inner?.contextInfo?.externalAdReply;
      return normalizeThumbnail(inner?.jpegThumbnail || externalPreview?.thumbnail || null);
    } catch (_) { return null; }
  }

  // All pending approvals (without the raw message object — too large)
  app.get("/api/pending", (req, res) => {
    const all = readAll(getWorkspaceId(req));
    const result = Object.entries(all)
      .filter(([, v]) => v.status === "pending")
      .map(([id, v]) => ({
        id,
        mediaType: v.mediaType,
        caption: v.caption,
        linkPreview: v.linkPreview || null,
        createdAt: v.createdAt,
        hasPreview: !!getMediaBuffer(id, getWorkspaceId(req)),
        thumbnail: extractThumbnail(v),
      }));
    res.json(result);
  });

  app.get("/api/broadcasts", async (req, res) => {
    try {
      const sock = getRequestSock(req);
      const broadcasts = getBroadcastHistory(getWorkspaceId(req));
      const groupNames = new Map();
      const result = await Promise.all(broadcasts.map(async (broadcast) => ({
        ...broadcast,
        groups: await Promise.all((broadcast.groups || []).map(async (group) => {
          let name = groupNames.get(group.jid);
          if (!name) {
            name = group.name;
            if (sock) {
              try {
                const metadata = await sock.groupMetadata(group.jid);
                if (metadata?.subject) name = metadata.subject;
              } catch (error) {
                logger.debug({ err: error.message, jid: group.jid }, "Could not refresh a broadcast group name");
              }
            }
            if (!name || /@(g\.us|s\.whatsapp\.net)$/.test(name)) name = "Group name unavailable";
            groupNames.set(group.jid, name);
          }
          return {
            name,
            status: group.status,
            isSourceGroup: Boolean(group.isSourceGroup || group.status === "source"),
          };
        })),
      })));
      res.json(result);
    } catch (error) {
      logger.error({ err: error.message, workspaceId: getWorkspaceId(req) }, "Unable to load broadcast history");
      res.status(500).json({ error: "Unable to load broadcast history." });
    }
  });

  app.post("/api/broadcasts/:id/delete", async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const sock = getRequestSock(req);
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      const groups = JSON.parse(fs.readFileSync(ensureWorkspace(workspaceId).groups, "utf-8"));
      const result = await deleteBroadcast(sock, req.params.id, workspaceId, groups.mainGroup);
      if (!result) return res.status(404).json({ error: "Broadcast not found." });
      res.json({
        ok: true,
        deleted: result.deleted,
        failed: result.failed,
        skipped: result.skipped,
        broadcast: result.broadcast,
      });
    } catch (error) {
      logger.error({ err: error.message, broadcastId: req.params.id, workspaceId }, "Unable to delete broadcast");
      res.status(500).json({ error: "Unable to delete this broadcast." });
    }
  });

  // Serve media preview buffer
  app.get("/api/media/:id", (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const buf = getMediaBuffer(req.params.id, workspaceId);
    const all = readAll(workspaceId);
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
    const sock = getRequestSock(req);
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      const { resolveApproval } = require("./approval");
      const { targetGroups, delayMs } = req.body || {};
      
      const options = { workspaceId: getWorkspaceId(req) };
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
    const sock = getRequestSock(req);
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
      const workspaceId = getWorkspaceId(req);
      const groups = JSON.parse(fs.readFileSync(ensureWorkspace(workspaceId).groups, "utf-8"));
      const sock = getRequestSock(req);
      
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
      const groupsPath = ensureWorkspace(getWorkspaceId(req)).groups;
      const existing = JSON.parse(fs.readFileSync(groupsPath, "utf-8"));
      existing.targetGroups = data.targetGroups;
      fs.writeFileSync(groupsPath, JSON.stringify(existing, null, 2));
      
      // Resolve names for the socket emission
      const sock = getRequestSock(req);
      const resolvedTargetGroups = await Promise.all(
        existing.targetGroups.map(async (jid) => ({ jid, name: await getGroupName(sock, jid) }))
      );
      const mainGroupName = await getGroupName(sock, existing.mainGroup);
      
      const enriched = {
        mainGroup: { jid: existing.mainGroup, name: mainGroupName },
        targetGroups: resolvedTargetGroups
      };
      
      res.json({ ok: true });
      emitToWorkspace(getWorkspaceId(req), "groups:updated", enriched);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update group settings (mainGroup or controlChatJid)
  app.post("/api/groups/settings", async (req, res) => {
    try {
      const { mainGroup, controlChatJid } = req.body;
      
      if (!mainGroup && !controlChatJid) {
        return res.status(400).json({ error: "Must provide mainGroup or controlChatJid" });
      }

      // Read existing config
      const groupsPath = ensureWorkspace(getWorkspaceId(req)).groups;
      const existing = JSON.parse(fs.readFileSync(groupsPath, "utf-8"));
      
      // Update fields if provided
      if (mainGroup) existing.mainGroup = mainGroup;
      if (controlChatJid) existing.controlChatJid = controlChatJid;
      
      // Write updated config
      fs.writeFileSync(groupsPath, JSON.stringify(existing, null, 2));
      
      // Emit update to connected clients
      const sock = getRequestSock(req);
      if (sock) {
        const mainGroupName = await getGroupName(sock, existing.mainGroup);
        const resolvedTargetGroups = await Promise.all(
          (existing.targetGroups || []).map(async (jid) => ({ jid, name: await getGroupName(sock, jid) }))
        );
        emitToWorkspace(getWorkspaceId(req), "groups:updated", {
          mainGroup: { jid: existing.mainGroup, name: mainGroupName },
          controlChatJid: existing.controlChatJid,
          targetGroups: resolvedTargetGroups
        });
      }
      
      res.json({ ok: true });
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
    const sock = getRequestSock(req);
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    try {
      const now = Date.now();
      const workspaceId = getWorkspaceId(req);
      const cached = participatingGroupsCache.get(workspaceId);
      // If cache is empty or older than 2 minutes, fetch fresh
      if (!cached || (now - cached.fetchedAt > 2 * 60 * 1000)) {
        const participating = await sock.groupFetchAllParticipating();
        participatingGroupsCache.set(workspaceId, { groups: participating, fetchedAt: now });
      }
      const cachedParticipatingGroups = participatingGroupsCache.get(workspaceId)?.groups;
      
      const config = JSON.parse(fs.readFileSync(ensureWorkspace(getWorkspaceId(req)).groups, "utf-8"));
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
      const cachedParticipatingGroups = participatingGroupsCache.get(getWorkspaceId(req))?.groups;
      if (cachedParticipatingGroups) {
        const config = JSON.parse(fs.readFileSync(ensureWorkspace(getWorkspaceId(req)).groups, "utf-8"));
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
    activeChatJid = { workspaceId: getWorkspaceId(req), jid: req.body.jid || null };
    res.json({ ok: true });
  });

  // Load recent messages from a group (from in-memory store if available)
  app.get("/api/chat/:jid", async (req, res) => {
    const sock = getRequestSock(req);
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    const jid = decodeURIComponent(req.params.jid);
    try {
      // Use the shared in-memory store (persisted to disk) — falls back to empty
      const msgs = (getMessageStore(getWorkspaceId(req))[jid] || []).slice(-50);
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
    const sock = getRequestSock(req);
    if (!sock) return res.status(503).json({ error: "Bot not connected" });
    const jid = decodeURIComponent(req.params.jid);
    const msgId = req.params.msgId;
    try {
      const msgs = (getMessageStore(getWorkspaceId(req))[jid] || []);
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
    const sock = getRequestSock(req);
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
    bus.emit("bot:reset_session", { workspaceId: getWorkspaceId(req) });
    res.json({ ok: true });
  });

  app.post("/api/whatsapp/connect", requireAuth, async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: "No workspace found" });
    try {
      if (startWorkspaceFn) await startWorkspaceFn(workspaceId);
      else await startBot(workspaceId, () => {});
      await recordAudit({ userId: req.session.userId, action: "whatsapp_connect_requested", metadata: { workspaceId } });
      res.json({ ok: true, workspaceId });
    } catch (error) {
      res.status(500).json({ error: "Unable to start WhatsApp connection." });
    }
  });

  app.get("/api/whatsapp/status", requireAuth, (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const sock = getRequestSock(req);
    res.json({ workspaceId, status: sock?.user ? "connected" : (workspaceStatus.get(workspaceId) || "disconnected"), hasQr: workspaceQr.has(workspaceId), qr: workspaceQr.get(workspaceId) || null });
  });

  app.post("/api/whatsapp/sync", requireAuth, async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const sock = getRequestSock(req);
    if (!sock?.user) return res.status(503).json({ error: "Bot not connected" });
    const groups = await refreshGroupCache(sock);
    if (!groups) return res.status(502).json({ error: "WhatsApp sync failed. Try again shortly." });
    res.json({ ok: true, workspaceId, groupCount: Object.keys(groups).length, syncedAt: new Date().toISOString() });
  });

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    const workspaceId = workspaceIdForSocket(socket);
    // Send current state immediately on connect
    const all = readAll(socket.request.session.workspaceId || ADMIN_WORKSPACE_ID);
    const pending = Object.entries(all)
      .filter(([, v]) => v.status === "pending")
      .map(([id, v]) => ({
        id,
        mediaType: v.mediaType,
        caption: v.caption,
        linkPreview: v.linkPreview || null,
        createdAt: v.createdAt,
        hasPreview: !!getMediaBuffer(id, socket.request.session.workspaceId || ADMIN_WORKSPACE_ID),
        thumbnail: extractThumbnail(v),
      }));
    socket.emit("init", { status: workspaceStatus.get(workspaceId) || "disconnected", pending, logs: activityLog.filter((entry) => entry.data?.workspaceId === workspaceId).slice(0, 50), stats: getStats(workspaceId), qr: workspaceQr.get(workspaceId) || null });
  });

  // ── Forward internal bus events → Socket.IO ──────────────────────────────
  bus.on("bot:connected", ({ workspaceId = ADMIN_WORKSPACE_ID } = {}) => {
    workspaceStatus.set(workspaceId, "connected");
    workspaceQr.delete(workspaceId);
    addLog("bot:connected", {});
    emitToWorkspace(workspaceId, "bot:connected", { workspaceId });
    emitToWorkspace(workspaceId, "status:update", { status: "connected", qr: null, workspaceId });
    // Pre-fetch in background immediately upon connection
    setTimeout(() => refreshGroupCache(getSocket(workspaceId)), 500);
  });

  bus.on("bot:disconnected", ({ workspaceId = ADMIN_WORKSPACE_ID } = {}) => {
    workspaceStatus.set(workspaceId, "disconnected");
    addLog("bot:disconnected", {});
    emitToWorkspace(workspaceId, "bot:disconnected", { workspaceId });
    emitToWorkspace(workspaceId, "status:update", { status: "disconnected", qr: null, workspaceId });
  });

  bus.on("bot:relink_required", ({ workspaceId = ADMIN_WORKSPACE_ID, reason } = {}) => {
    workspaceStatus.set(workspaceId, "disconnected");
    workspaceQr.delete(workspaceId);
    addLog("bot:disconnected", { workspaceId, reason });
    emitToWorkspace(workspaceId, "bot:disconnected", { workspaceId, reason });
    emitToWorkspace(workspaceId, "status:update", { status: "disconnected", qr: null, workspaceId });
    emitToWorkspace(workspaceId, "bot:relink_required", { workspaceId, reason });
  });

  bus.on("bot:connecting", ({ workspaceId = ADMIN_WORKSPACE_ID } = {}) => {
    workspaceStatus.set(workspaceId, "connecting");
    emitToWorkspace(workspaceId, "status:update", { status: "connecting", qr: null, workspaceId });
  });

  bus.on("bot:qr", (data) => {
    const workspaceId = data.workspaceId || ADMIN_WORKSPACE_ID;
    workspaceStatus.set(workspaceId, "disconnected");
    workspaceQr.set(workspaceId, data.qr);
    emitToWorkspace(workspaceId, "status:update", { status: "disconnected", qr: data.qr, workspaceId });
  });

  bus.on("approval:new", (data) => {
    addLog("approval:new", data);
    // Get thumbnail from stored pending entry (it's already in the message metadata)
    const stored = readAll(data.workspaceId || ADMIN_WORKSPACE_ID)[data.id];
    const thumbnail = stored ? extractThumbnail(stored) : null;
    // Don't forward the full base64 buffer — use thumbnail instead
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "approval:new", { ...data, previewBase64: undefined, hasPreview: !!data.previewBase64, thumbnail });
  });

  bus.on("approval:resolved", (data) => {
    addLog("approval:resolved", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "approval:resolved", data);
  });

  bus.on("approval:expired", (data) => {
    addLog("approval:expired", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "approval:expired", data);
  });

  bus.on("broadcast:start", (data) => {
    addLog("broadcast:start", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "broadcast:start", data);
  });

  bus.on("broadcast:sent", (data) => {
    const stats = getStats(data.workspaceId || ADMIN_WORKSPACE_ID);
    stats.sentToday++;
    addLog("broadcast:sent", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "broadcast:sent", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "stats:update", { ...stats });
  });

  bus.on("broadcast:failed", (data) => {
    const stats = getStats(data.workspaceId || ADMIN_WORKSPACE_ID);
    stats.failed++;
    addLog("broadcast:failed", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "broadcast:failed", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "stats:update", { ...stats });
  });

  bus.on("broadcast:complete", (data) => {
    addLog("broadcast:complete", data);
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "broadcast:complete", data);
  });

  bus.on("broadcast:auto_deleted", (data) => {
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "broadcast:auto_deleted", data);
  });

  bus.on("bot:qr_dataurl", ({ workspaceId = ADMIN_WORKSPACE_ID, url }) => {
    workspaceQr.set(workspaceId, url);
    emitToWorkspace(workspaceId, "system:qr", { workspaceId, url });
  });

  bus.on("bot:connected", ({ workspaceId = ADMIN_WORKSPACE_ID } = {}) => {
    emitToWorkspace(workspaceId, "system:connected", { workspaceId });
  });

  // Forward ALL live chat messages to dashboard (frontend filters by group)
  bus.on("chat:message", (data) => {
    emitToWorkspace(data.workspaceId || ADMIN_WORKSPACE_ID, "chat:message", data);
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

  let resolveReady;
  let rejectReady;
  httpServer.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  httpServer.on("error", (error) => {
    rejectReady(error);
    console.error(`Dashboard server could not start on port ${PORT}: ${error.message}`);
  });

  httpServer.listen(PORT, () => {
    resolveReady();
    console.log(`\n🖥️  Dashboard running at → http://localhost:${PORT}\n`);
  });

  return httpServer;
}

module.exports = { createServer };
