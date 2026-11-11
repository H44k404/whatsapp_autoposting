function unwrapMessage(message) {
  let content = message?.message || message || {};
  while (content.ephemeralMessage?.message || content.viewOnceMessage?.message) {
    content = content.ephemeralMessage?.message || content.viewOnceMessage?.message;
  }
  return content;
}

function normalizeUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().replace(/[.,!?;:)\]}]+$/, "");
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function extractLinkPreview(message) {
  const content = unwrapMessage(message);
  const extended = content.extendedTextMessage || {};
  const preview = extended.contextInfo?.externalAdReply || {};
  const text = extended.text || content.conversation || "";
  const textUrl = text.match(/https?:\/\/[^\s<>]+/i)?.[0];
  const url = normalizeUrl(extended.canonicalUrl) ||
    normalizeUrl(extended.matchedText) ||
    normalizeUrl(textUrl);

  if (!url) return null;

  return {
    url,
    title: extended.title || preview.title || "",
    description: extended.description || preview.body || "",
  };
}

function isSelfPostedLink(message, chatJid) {
  return Boolean(
    chatJid &&
    message?.key?.fromMe &&
    message.key.remoteJid === chatJid &&
    extractLinkPreview(message)
  );
}

function restoreMessageBuffers(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(restoreMessageBuffers);
  if (!value || typeof value !== "object") return value;
  if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, restoreMessageBuffers(nested)])
  );
}

function toThumbnailBuffer(thumbnail) {
  if (Buffer.isBuffer(thumbnail)) return thumbnail.length ? thumbnail : null;
  if (ArrayBuffer.isView(thumbnail)) {
    const buffer = Buffer.from(thumbnail);
    return buffer.length ? buffer : null;
  }
  if (Array.isArray(thumbnail)) {
    const buffer = Buffer.from(thumbnail);
    return buffer.length ? buffer : null;
  }
  if (typeof thumbnail === "string") {
    const buffer = Buffer.from(thumbnail, "base64");
    return buffer.length ? buffer : null;
  }
  return null;
}

function createLinkPreviewMessage(message) {
  const restoredMessage = restoreMessageBuffers(message);
  const content = unwrapMessage(restoredMessage);
  const extended = content.extendedTextMessage || {};
  const externalPreview = extended.contextInfo?.externalAdReply || {};
  const preview = extractLinkPreview(restoredMessage);
  if (!preview) return null;

  const linkPreview = {
    "canonical-url": normalizeUrl(extended.canonicalUrl) || preview.url,
    "matched-text": normalizeUrl(extended.matchedText) || preview.url,
    title: extended.title || externalPreview.title || preview.url,
  };
  const description = extended.description || externalPreview.body || preview.description;
  const thumbnail = [extended.jpegThumbnail, externalPreview.thumbnail]
    .map(toThumbnailBuffer)
    .find(Boolean);
  if (description) linkPreview.description = description;
  if (thumbnail) linkPreview.jpegThumbnail = thumbnail;

  return {
    text: extended.text || content.conversation || preview.url,
    linkPreview,
  };
}

module.exports = {
  extractLinkPreview,
  isSelfPostedLink,
  restoreMessageBuffers,
  createLinkPreviewMessage,
};
