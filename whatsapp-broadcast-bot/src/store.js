/**
 * Simple JSON-file-based persistence for pending approval requests.
 * Swap this module out for a SQLite-backed version later if volume grows
 * (see roadmap Section 8) — the read/write function signatures can stay the same.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "pending_approvals.json");

// In-memory store for media preview buffers (not persisted to disk).
const mediaBuffers = new Map();

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) fs.writeFileSync(FILE_PATH, "{}");
}

function readAll() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch (e) {
    // Corrupt file — don't crash the bot, just start fresh (and don't silently
    // overwrite in place without a warning, since that could destroy real data).
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
  // Also clean up the in-memory media buffer
  mediaBuffers.delete(id);
}

function saveMediaBuffer(id, buffer) {
  mediaBuffers.set(id, buffer);
}

function getMediaBuffer(id) {
  return mediaBuffers.get(id) || null;
}

module.exports = { savePending, getPending, deletePending, readAll, saveMediaBuffer, getMediaBuffer };

