/**
 * Simple JSON-file-based persistence for pending approval requests.
 * Media buffers are written to data/media/<id>.<ext> so they survive restarts.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "pending_approvals.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");

// In-memory cache: id → Buffer (write-through to disk)
const mediaCache = new Map();

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) fs.writeFileSync(FILE_PATH, "{}");
}

function readAll() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch (e) {
    console.error("pending_approvals.json is corrupt, ignoring it:", e.message);
    return {};
  }
}

function writeAll(data) {
  ensureDataFile();
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

function savePending(id, entry) {
  const all = readAll();
  all[id] = entry;
  writeAll(all);
}

function getPending(id) {
  return readAll()[id];
}

function deletePending(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
  // Remove from cache
  mediaCache.delete(id);
  // Remove from disk
  for (const ext of ["jpg", "mp4"]) {
    const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
}

function saveMediaBuffer(id, buffer, mediaType) {
  ensureDataFile();
  const ext = mediaType === "video" ? "mp4" : "jpg";
  const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  mediaCache.set(id, buffer);
}

function getMediaBuffer(id) {
  // Check in-memory cache first
  if (mediaCache.has(id)) return mediaCache.get(id);
  // Try to load from disk (both possible extensions)
  for (const ext of ["jpg", "mp4"]) {
    const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
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
