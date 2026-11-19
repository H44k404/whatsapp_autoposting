const fs = require("fs");
const path = require("path");

const BOT_ROOT = path.join(__dirname, "..");
const LEGACY_AUTH_DIR = process.env.LEGACY_AUTH_DIR || path.join(BOT_ROOT, "auth");
const LEGACY_CONFIG_PATH = path.join(BOT_ROOT, "config", "groups.json");
const LEGACY_DATA_DIR = path.join(BOT_ROOT, "data");
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || path.join(LEGACY_DATA_DIR, "workspaces");
const ADMIN_WORKSPACE_ID = "admin";

function safeWorkspaceId(workspaceId) {
  const value = String(workspaceId || ADMIN_WORKSPACE_ID);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid workspace id.");
  return value;
}

function copyDirectoryIfNeeded(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.cpSync(source, target, { recursive: true, errorOnExist: false });
}

function ensureWorkspace(workspaceId) {
  const id = safeWorkspaceId(workspaceId);
  const root = path.join(WORKSPACES_DIR, id);
  const paths = {
    id,
    root,
    auth: path.join(root, "auth"),
    data: path.join(root, "data"),
    media: path.join(root, "media"),
    pending: path.join(root, "pending_approvals.json"),
    processedSourceMessages: path.join(root, "processed_source_messages.json"),
    messages: path.join(root, "message-store.json"),
    broadcastHistory: path.join(root, "broadcast-history.json"),
    groups: path.join(root, "groups.json"),
  };

  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.media, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.pending)) {
    const legacyPending = path.join(LEGACY_DATA_DIR, "pending_approvals.json");
    if (id === ADMIN_WORKSPACE_ID && fs.existsSync(legacyPending)) fs.copyFileSync(legacyPending, paths.pending);
    else fs.writeFileSync(paths.pending, "{}", { mode: 0o600 });
  }
  if (!fs.existsSync(paths.groups)) {
    if (fs.existsSync(LEGACY_CONFIG_PATH)) fs.copyFileSync(LEGACY_CONFIG_PATH, paths.groups);
    else fs.writeFileSync(paths.groups, JSON.stringify({ targetGroups: [] }, null, 2));
  }

  // Never silently restore a stale legacy WhatsApp auth state. The app should use only
  // the workspace-scoped auth folder, and a reset should happen only when explicitly requested.
  if (id === ADMIN_WORKSPACE_ID && !fs.existsSync(paths.auth)) {
    fs.mkdirSync(paths.auth, { recursive: true, mode: 0o700 });
  }

  if (id === ADMIN_WORKSPACE_ID && !fs.existsSync(paths.messages) && fs.existsSync(path.join(LEGACY_DATA_DIR, "message-store.json"))) {
    copyDirectoryIfNeeded(path.join(LEGACY_DATA_DIR, "message-store.json"), paths.messages);
  }
  return paths;
}

function removeWorkspaceData(workspaceId) {
  const id = safeWorkspaceId(workspaceId);
  if (id === ADMIN_WORKSPACE_ID) throw new Error("The admin workspace cannot be deleted.");

  const workspaceRoot = path.resolve(WORKSPACES_DIR, id);
  const workspacesRoot = path.resolve(WORKSPACES_DIR);
  if (path.dirname(workspaceRoot) !== workspacesRoot) {
    throw new Error("Workspace path is outside the workspace storage directory.");
  }
  if (fs.existsSync(workspaceRoot)) fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function workspaceForUser(userId, workspace) {
  return workspace?.id || (userId ? String(userId) : ADMIN_WORKSPACE_ID);
}

module.exports = { ADMIN_WORKSPACE_ID, WORKSPACES_DIR, safeWorkspaceId, ensureWorkspace, removeWorkspaceData, workspaceForUser };