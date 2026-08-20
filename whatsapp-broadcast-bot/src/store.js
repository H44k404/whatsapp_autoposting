/**
 * Simple JSON-file-based persistence for pending approval requests.
 * Media buffers are written to data/media/<id>.<ext> so they survive restarts.
 */
const fs = require("fs");
const path = require("path");
const { ensureWorkspace } = require("./workspace");

// In-memory cache: id → Buffer (write-through to disk)
const mediaCache = new Map();

function paths(workspaceId) {
  return ensureWorkspace(workspaceId);
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

module.exports = { savePending, getPending, deletePending, readAll, saveMediaBuffer, getMediaBuffer };
