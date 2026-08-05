/**
 * Web dashboard server — Express HTTP + Socket.IO.
 * Serves the static dashboard and exposes REST API endpoints.
 * All real-time events are forwarded from the internal event bus to connected browsers via Socket.IO.
 */
require("dotenv").config({ quiet: true });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bus = require("./events");
const { readAll, getMediaBuffer } = require("./store");

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;
const GROUPS_PATH = path.join(__dirname, "..", "config", "groups.json");

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

function createServer(handleControlReplyFn, getSock) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: "*" } });
  _io = io;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ── REST API ──────────────────────────────────────────────────────────────

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
      }));
    res.json(result);
  });

  // Serve media preview buffer
  app.get("/api/media/:id", (req, res) => {
    const buf = getMediaBuffer(req.params.id);
    if (!buf) return res.status(404).json({ error: "No preview available" });
    // Detect if it's a video or image by checking the pending store
    const all = readAll();
    const entry = all[req.params.id];
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
      await handleControlReplyFn(sock, `YES ${id}`);
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
    // Don't forward the full base64 in the socket event (too large for broadcast)
    io.emit("approval:new", { ...data, previewBase64: undefined, hasPreview: !!data.previewBase64 });
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

  httpServer.listen(PORT, () => {
    console.log(`\n🖥️  Dashboard running at → http://localhost:${PORT}\n`);
  });

  return httpServer;
}

module.exports = { createServer };
