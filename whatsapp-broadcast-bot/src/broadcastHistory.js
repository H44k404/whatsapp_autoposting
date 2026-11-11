const fs = require("fs");
const { ensureWorkspace } = require("./workspace");

const HOUR_MS = 60 * 60 * 1000;
const COPY_RETENTION_MS = 48 * HOUR_MS;
const WHATSAPP_DELETE_WINDOW_MS = 60 * HOUR_MS;

function readHistory(workspaceId) {
  const file = ensureWorkspace(workspaceId).broadcastHistory;
  if (!fs.existsSync(file)) return [];

  const history = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!Array.isArray(history)) throw new Error("Broadcast history has an invalid format.");
  return history;
}

function writeHistory(history, workspaceId) {
  fs.writeFileSync(
    ensureWorkspace(workspaceId).broadcastHistory,
    JSON.stringify(history, null, 2),
    { mode: 0o600 }
  );
}

function getBroadcastHistory(workspaceId) {
  return readHistory(workspaceId).sort((a, b) => b.createdAt - a.createdAt);
}

function recordBroadcastMessage(broadcastId, jid, groupName, sentMessage, metadata, workspaceId) {
  const history = readHistory(workspaceId);
  let broadcast = history.find((item) => item.id === broadcastId);

  if (!broadcast) {
    broadcast = {
      id: broadcastId,
      mediaType: metadata.mediaType,
      caption: metadata.caption || "",
      approvalId: metadata.approvalId || null,
      createdAt: Date.now(),
      groups: [],
    };
    history.push(broadcast);
  }

  const key = sentMessage?.key || {};
  const previous = broadcast.groups.find((item) => item.jid === jid);
  const group = {
    jid,
    name: groupName || jid,
    messageId: key.id || null,
    fromMe: key.fromMe !== false,
    sentAt: Date.now(),
    isSourceGroup: Boolean(metadata.sourceGroupJid && jid === metadata.sourceGroupJid),
    status: metadata.sourceGroupJid && jid === metadata.sourceGroupJid
      ? "source"
      : key.id
        ? "sent"
        : "untracked",
    deletedAt: null,
    deleteError: null,
  };

  if (previous) Object.assign(previous, group);
  else broadcast.groups.push(group);
  writeHistory(history, workspaceId);
}

async function deleteBroadcast(sock, broadcastId, workspaceId, sourceGroupJid, groupJids) {
  const history = readHistory(workspaceId);
  const broadcast = history.find((item) => item.id === broadcastId);
  if (!broadcast) return null;
  const selectedGroupJids = groupJids ? new Set(groupJids) : null;

  for (const group of broadcast.groups) {
    if (selectedGroupJids && !selectedGroupJids.has(group.jid)) {
      continue;
    }
    if (group.status === "deleted") {
      continue;
    }
    if (group.status === "source" || group.isSourceGroup || group.jid === sourceGroupJid) {
      group.status = "source";
      group.isSourceGroup = true;
      writeHistory(history, workspaceId);
      continue;
    }

    if (!group.messageId || !group.fromMe) {
      group.status = "untracked";
      group.deleteError = "The sent message ID is unavailable.";
      writeHistory(history, workspaceId);
      continue;
    }

    try {
      await sock.sendMessage(group.jid, {
        delete: {
          remoteJid: group.jid,
          fromMe: true,
          id: group.messageId,
        },
      });
      group.status = "deleted";
      group.deletedAt = Date.now();
      group.deleteError = null;
    } catch (error) {
      group.status = "failed";
      group.deleteError = error.message || "WhatsApp could not delete this message.";
    }
    writeHistory(history, workspaceId);
  }

  const affectedGroups = selectedGroupJids
    ? broadcast.groups.filter((group) => selectedGroupJids.has(group.jid))
    : broadcast.groups;
  const deleted = affectedGroups.filter((group) => group.status === "deleted").length;
  const failed = affectedGroups.filter((group) => ["failed", "untracked"].includes(group.status)).length;
  const skipped = broadcast.groups.filter((group) => group.status === "source" || group.isSourceGroup || group.jid === sourceGroupJid).length;
  return { broadcast, deleted, failed, skipped };
}

async function autoDeleteExpiredBroadcasts(sock, workspaceId, sourceGroupJid, now = Date.now()) {
  const history = readHistory(workspaceId);
  const expired = history.map((broadcast) => {
    const groupJids = (broadcast.groups || []).filter((group) => {
      if (!["sent", "failed"].includes(group.status) || group.isSourceGroup || group.jid === sourceGroupJid) {
        return false;
      }

      const sentAt = Number(group.sentAt || broadcast.createdAt);
      const age = now - sentAt;
      if (!Number.isFinite(sentAt) || age < COPY_RETENTION_MS) return false;
      return group.status === "sent" || age < WHATSAPP_DELETE_WINDOW_MS;
    }).map((group) => group.jid);
    return { broadcast, groupJids };
  }).filter(({ groupJids }) => groupJids.length > 0);
  const results = [];

  for (const { broadcast, groupJids } of expired) {
    const result = await deleteBroadcast(sock, broadcast.id, workspaceId, sourceGroupJid, groupJids);
    if (result) results.push(result);
  }

  return results;
}

module.exports = {
  COPY_RETENTION_MS,
  WHATSAPP_DELETE_WINDOW_MS,
  getBroadcastHistory,
  recordBroadcastMessage,
  deleteBroadcast,
  autoDeleteExpiredBroadcasts,
};
