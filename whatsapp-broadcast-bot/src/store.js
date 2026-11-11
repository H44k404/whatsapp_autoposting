/**
 * Simple JSON-file-based persistence for pending approval requests.
 * Media buffers are written to data/media/<id>.<ext> so they survive restarts.
 */
const fs = require("fs");
const path = require("path");
const { ensureWorkspace } = require("./workspace");

// In-memory cache: id → Buffer (write-through to disk)
const mediaCache = new Map();
const processedSourceMessageCache = new Map();
const inFlightSourceMessages = new Map();
const SOURCE_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROCESSED_SOURCE_MESSAGES = 5000;

function paths(workspaceId) {
  return ensureWorkspace(workspaceId);
}

function getProcessedSourceMessages(workspaceId) {
  const workspace = paths(workspaceId);
  if (processedSourceMessageCache.has(workspace.id)) {
    return processedSourceMessageCache.get(workspace.id);
  }

  let processed = {};
  if (fs.existsSync(workspace.processedSourceMessages)) {
    try {
      processed = JSON.parse(fs.readFileSync(workspace.processedSourceMessages, "utf-8"));
    } catch (e) {
      console.error("processed_source_messages.json is corrupt, ignoring it:", e.message);
    }
  }
  if (!processed || typeof processed !== "object" || Array.isArray(processed)) processed = {};
  processedSourceMessageCache.set(workspace.id, processed);
  return processed;
}

function claimSourceMessage(messageId, sourceJid, workspaceId) {
  if (!messageId || !sourceJid) return true;

  const workspace = paths(workspaceId);
  const key = `${sourceJid}:${messageId}`;
  const processed = getProcessedSourceMessages(workspace.id);
  let inFlight = inFlightSourceMessages.get(workspace.id);
  if (!inFlight) {
    inFlight = new Set();
    inFlightSourceMessages.set(workspace.id, inFlight);
  }

  if (processed[key] || inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

function completeSourceMessage(messageId, sourceJid, workspaceId) {
  if (!messageId || !sourceJid) return;

  const workspace = paths(workspaceId);
  const key = `${sourceJid}:${messageId}`;
  const processed = getProcessedSourceMessages(workspace.id);
  const cutoff = Date.now() - SOURCE_MESSAGE_TTL_MS;
  for (const [processedKey, timestamp] of Object.entries(processed)) {
    if (typeof timestamp !== "number" || timestamp < cutoff) delete processed[processedKey];
  }

  processed[key] = Date.now();
  const entries = Object.entries(processed).sort((a, b) => a[1] - b[1]);
  for (const [processedKey] of entries.slice(0, Math.max(0, entries.length - MAX_PROCESSED_SOURCE_MESSAGES))) {
    delete processed[processedKey];
  }

  fs.writeFileSync(workspace.processedSourceMessages, JSON.stringify(processed));
  inFlightSourceMessages.get(workspace.id)?.delete(key);
}

function releaseSourceMessage(messageId, sourceJid, workspaceId) {
  if (!messageId || !sourceJid) return;
  const workspaceIdValue = paths(workspaceId).id;
  inFlightSourceMessages.get(workspaceIdValue)?.delete(`${sourceJid}:${messageId}`);
}

function readAll(workspaceId) {
  const { pending } = paths(workspaceId);
  try {
    return JSON.parse(fs.readFileSync(pending, "utf-8"));
  } catch (e) {
    console.error("pending_approvals.json is corrupt, ignoring it:", e.message);
    return {};
  }
}

function writeAll(data, workspaceId) {
  fs.writeFileSync(paths(workspaceId).pending, JSON.stringify(data, null, 2));
}

function savePending(id, entry, workspaceId) {
  const all = readAll(workspaceId);
  all[id] = entry;
  writeAll(all, workspaceId);
}

function getPending(id, workspaceId) {
  return readAll(workspaceId)[id];
}

function deletePending(id, workspaceId) {
  const all = readAll(workspaceId);
  delete all[id];
  writeAll(all, workspaceId);
  // Remove from cache
  mediaCache.delete(id);
  // Remove from disk
  for (const ext of ["jpg", "mp4"]) {
    const filePath = path.join(paths(workspaceId).media, `${id}.${ext}`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
}

function saveMediaBuffer(id, buffer, mediaType, workspaceId) {
  const { media } = paths(workspaceId);
  const ext = mediaType === "video" ? "mp4" : "jpg";
  const filePath = path.join(media, `${id}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  mediaCache.set(id, buffer);
}

function getMediaBuffer(id, workspaceId) {
  // Check in-memory cache first
  if (mediaCache.has(id)) return mediaCache.get(id);
  // Try to load from disk (both possible extensions)
  for (const ext of ["jpg", "mp4"]) {
    const filePath = path.join(paths(workspaceId).media, `${id}.${ext}`);
    if (fs.existsSync(filePath)) {
      try {
        const buf = fs.readFileSync(filePath);
        mediaCache.set(id, buf);
        return buf;
      } catch (_) {}
    }
  }
  return null;
}

module.exports = {
  savePending,
  getPending,
  deletePending,
  readAll,
  saveMediaBuffer,
  getMediaBuffer,
  claimSourceMessage,
  completeSourceMessage,
  releaseSourceMessage,
};
