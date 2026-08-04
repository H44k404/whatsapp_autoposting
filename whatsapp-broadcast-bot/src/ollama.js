/**
 * Optional local Ollama integration:
 *  - classifyReply(): parses natural-language approval replies into yes/no/unclear
 *  - describeMedia(): summarizes a media caption into a short description
 *
 * Note: this only sends TEXT to Ollama. A plain text model cannot "see" the
 * actual image/video content — it only summarizes the caption string, if any
 * caption was attached to the media. For real vision-based captioning of the
 * image/video pixels themselves, switch OLLAMA_MODEL to a vision-capable model
 * (e.g. "llava") and pass the image as base64 via the "images" field on the
 * /api/generate request (see roadmap Section 8 — Optional Future Upgrades).
 */
const logger = require("./utils/logger");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const REQUEST_TIMEOUT_MS = 15000;

async function callOllama(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama responded with HTTP ${res.status}`);
    }
    const data = await res.json();
    return (data.response || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns "yes", "no", or "unclear".
 */
async function classifyReply(text) {
  const prompt = `The user was asked to approve sharing a media file to several WhatsApp groups.
Their reply was: "${text}"
Respond with ONLY one word: YES, NO, or UNCLEAR.`;

  try {
    const answer = (await callOllama(prompt)).toLowerCase();
    if (answer.includes("yes")) return "yes";
    if (answer.includes("no")) return "no";
    return "unclear";
  } catch (e) {
    logger.warn({ err: e.message }, "Ollama classifyReply failed, falling back to unclear");
    return "unclear";
  }
}

/**
 * Summarizes a caption into a short description for the approval prompt.
 * Falls back to the raw caption (or a default string) if Ollama is unreachable.
 */
async function describeMedia(caption) {
  if (!caption) return "New media (no caption)";
  const prompt = `Summarize this WhatsApp media caption in under 10 words: "${caption}"`;
  try {
    const answer = await callOllama(prompt);
    return answer || caption;
  } catch (e) {
    logger.warn({ err: e.message }, "Ollama describeMedia failed, using raw caption");
    return caption;
  }
}

module.exports = { classifyReply, describeMedia };
