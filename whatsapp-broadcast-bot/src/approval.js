const { v4: uuidv4 } = require("uuid");
const { downloadMediaMessage } = require("baileys");
const { savePending, getPending, deletePending, readAll, saveMediaBuffer } = require("./store");
const { classifyReply, describeMedia } = require("./ollama");
const { broadcastToGroups, broadcastRawMedia } = require("./broadcaster");
const logger = require("./utils/logger");
const bus = require("./events");

const CONTROL_CHAT = process.env.CONTROL_CHAT_JID;
// parseFloat (not parseInt) so fractional-minute timeouts work correctly too
const TIMEOUT_MS = (parseFloat(process.env.APPROVAL_TIMEOUT_MINUTES) || 30) * 60000;

// setTimeout handles for pending expirations, keyed by request id.
const timeoutHandles = new Map();

/**
 * Sends an approval-request DM to the control chat and stores the pending entry.
 * Also downloads a media preview for the dashboard and emits approval:new.
 */
async function requestApproval(sock, originalMsg, mediaType, caption) {
  if (!CONTROL_CHAT) {
    throw new Error("CONTROL_CHAT_JID is not set in .env — cannot send approval requests.");
  }

  const id = uuidv4().slice(0, 8);
  let description = caption || "";

  if (process.env.USE_OLLAMA === "true") {
    try {
      description = await describeMedia(caption);
    } catch (e) {
      logger.warn({ err: e.message }, "Ollama describe failed, using raw caption");
    }
  }

  savePending(id, {
    mediaMessage: originalMsg,
    mediaType,
    caption: caption || "",
    createdAt: Date.now(),
    status: "pending",
    isDashboardUpload: false,
  });

  // Download a preview buffer for the dashboard (best-effort, non-fatal).
  let previewBase64 = null;
  try {
    const buf = await downloadMediaMessage(originalMsg, "buffer", {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    saveMediaBuffer(id, buf);
    previewBase64 = buf.toString("base64");
  } catch (e) {
    logger.warn({ err: e.message }, "Could not download media preview for dashboard");
  }

  await sock.sendMessage(CONTROL_CHAT, {
    text:
      `🆕 New ${mediaType} received.\n` +
      `ID: *${id}*\n` +
      `${description}\n\n` +
      `Reply "YES ${id}" or "NO ${id}" to confirm.\n` +
      `(Or just reply YES/NO if this is the only pending item.)`,
  });

  // Emit to dashboard
  bus.emit("approval:new", { id, mediaType, caption: description, previewBase64, createdAt: Date.now() });

  // Auto-expire after APPROVAL_TIMEOUT_MINUTES if nobody responds.
  const handle = setTimeout(async () => {
    const p = getPending(id);
    if (p && p.status === "pending") {
      deletePending(id);
      bus.emit("approval:expired", { id });
      try {
        await sock.sendMessage(CONTROL_CHAT, { text: `⌛ Request ${id} expired (no response). Discarded.` });
      } catch (e) {
        logger.error({ err: e.message }, "Failed to send expiry notice");
      }
    }
    timeoutHandles.delete(id);
  }, TIMEOUT_MS);
  timeoutHandles.set(id, handle);

  return id;
}

/**
 * Handles a text reply sent in the control chat: figures out which pending
 * request it refers to, classifies it as yes/no, and either broadcasts or discards.
 */
async function handleControlReply(sock, text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return;

  const match = cleaned.match(/([a-f0-9]{8})/i);
  let id = match ? match[1].toLowerCase() : null;

  const allPending = readAll();
  if (!id) {
    const pendingIds = Object.keys(allPending).filter((k) => allPending[k].status === "pending");
    if (pendingIds.length === 1) {
      id = pendingIds[0];
    } else if (pendingIds.length > 1) {
      await sock.sendMessage(CONTROL_CHAT, {
        text: `⚠️ Multiple pending requests (${pendingIds.join(", ")}). Please include the ID, e.g. "YES ${pendingIds[0]}".`,
      });
      return;
    }
  }

  if (!id || !allPending[id] || allPending[id].status !== "pending") {
    return;
  }

  let decision = /^(yes|y)\b/i.test(cleaned) ? "yes" : /^(no|n)\b/i.test(cleaned) ? "no" : null;

  if (!decision && process.env.USE_OLLAMA === "true") {
    decision = await classifyReply(cleaned);
    if (decision === "unclear") {
      await sock.sendMessage(CONTROL_CHAT, {
        text: `❓ Couldn't tell if that's a YES or NO for ${id}. Please reply clearly (e.g. "YES ${id}" / "NO ${id}").`,
      });
      return;
    }
  }
  if (!decision) return;

  const handle = timeoutHandles.get(id);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(id);
  }

  const entry = getPending(id);
  if (!entry) return;

  bus.emit("approval:resolved", { id, decision });

  if (decision === "yes") {
    await sock.sendMessage(CONTROL_CHAT, { text: `✅ Broadcasting ${id} to all target groups...` });
    let sent, failed;
    if (entry.isDashboardUpload) {
      // Dashboard upload: buffer already saved in store, use broadcastRawMedia
      const { getMediaBuffer } = require("./store");
      const buf = getMediaBuffer(id);
      if (!buf) {
        await sock.sendMessage(CONTROL_CHAT, { text: `❌ Buffer for ${id} not found. Upload may have expired.` });
        deletePending(id);
        return;
      }
      ({ sent, failed } = await broadcastRawMedia(sock, buf, entry.mediaType, entry.caption));
    } else {
      ({ sent, failed } = await broadcastToGroups(sock, entry.mediaMessage));
    }
    const summary =
      failed.length === 0
        ? `✅ Done. Sent ${id} to ${sent.length} group(s).`
        : `⚠️ Sent ${id} to ${sent.length} group(s), failed for ${failed.length}: ${failed.map((f) => f.jid).join(", ")}`;
    await sock.sendMessage(CONTROL_CHAT, { text: summary });
  } else {
    await sock.sendMessage(CONTROL_CHAT, { text: `🚫 Discarded ${id}.` });
  }

  deletePending(id);
}

module.exports = { requestApproval, handleControlReply };
