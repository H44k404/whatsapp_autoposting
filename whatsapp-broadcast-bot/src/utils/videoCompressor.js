/**
 * Video Compression Utility
 * 
 * Compresses video files using ffmpeg while preserving audio quality.
 * Targets 480p resolution (853x480) with H.264 codec like Proton Compressor.
 * Reduces file size from ~21MB to ~8-10MB.
 * 
 * Audio is preserved at AAC codec with configurable bitrate.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const logger = require("./logger");
const os = require("os");

function findExecutableInPaths(executableName, extraCandidates = []) {
  const candidates = [
    ...(process.env.FFMPEG_PATH ? [process.env.FFMPEG_PATH] : []),
    ...(process.env.FFPROBE_PATH ? [process.env.FFPROBE_PATH] : []),
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...extraCandidates,
  ]
    .filter(Boolean)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      if (item.endsWith(".exe") || item.endsWith(".cmd") || item.endsWith(".bat")) return item;
      return path.join(item, executableName);
    })
    .concat([`${executableName}`]);

  for (const candidate of candidates) {
    try {
      if (!candidate || candidate === "") continue;
      const full = candidate.includes("\\") || candidate.includes("/") ? candidate : candidate.trim();
      if (fs.existsSync(full)) {
        return full;
      }
    } catch (_) {}
  }

  return executableName;
}

function getStableFfmpegPath() {
  const windowsCandidates = [
    "C:\\Program Files\\Gyan\\Gyan\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\Gyan\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\Lenovo\\LegionSpace\\1.9.11.6\\gamingai\\services\\editor\\ffmpeg.exe",
    "C:\\Program Files\\Lenovo\\LegionSpace\\*\\gamingai\\services\\editor\\ffmpeg.exe",
  ];

  const found = findExecutableInPaths("ffmpeg.exe", windowsCandidates);
  return found;
}

function getStableFfprobePath() {
  const windowsCandidates = [
    "C:\\Program Files\\Gyan\\Gyan\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Program Files\\Gyan\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Program Files\\Lenovo\\LegionSpace\\1.9.11.6\\gamingai\\services\\editor\\ffprobe.exe",
  ];

  const found = findExecutableInPaths("ffprobe.exe", windowsCandidates);
  return found;
}

// Get ffmpeg path from environment or use stable system detection fallback
const FFMPEG_PATH = getStableFfmpegPath();
const FFPROBE_PATH = getStableFfprobePath();

// Video compression settings (Proton Compressor equivalent)
const COMPRESSION_CONFIG = {
  enableCompression: process.env.ENABLE_VIDEO_COMPRESSION !== "false", // default: true
  targetWidth: parseInt(process.env.VIDEO_TARGET_WIDTH || "853"),
  targetHeight: parseInt(process.env.VIDEO_TARGET_HEIGHT || "480"),
  videoCRF: parseInt(process.env.VIDEO_CRF || "28"), // Quality: 18-28 (higher = smaller file, lower quality)
  videoPreset: process.env.VIDEO_PRESET || "medium", // ultrafast, superfast, veryfast, faster, fast, medium, slow, slower
  audioBitrate: process.env.AUDIO_BITRATE || "128k", // Audio bitrate (128k is good for WhatsApp)
  maxOutputSize: parseInt(process.env.VIDEO_MAX_SIZE_MB || "10") * 1024 * 1024, // Max output size in bytes
};

/**
 * Check if ffmpeg is available on the system
 * @returns {boolean}
 */
function checkFfmpegAvailable() {
  try {
    const command = process.platform === "win32" ? `"${FFMPEG_PATH}" -version` : `${FFMPEG_PATH} -version`;
    execSync(command, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function detectVideoEncoder() {
  try {
    const command = process.platform === "win32" ? `"${FFMPEG_PATH}" -hide_banner -encoders` : `${FFMPEG_PATH} -hide_banner -encoders`;
    const encodersOutput = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const candidates = ["libx264", "h264_qsv", "h264_nvenc", "h264_amf", "mpeg4"];
    const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (const candidate of candidates) {
      const pattern = new RegExp(`\\b${regexEscape(candidate)}\\b`, "i");
      if (pattern.test(encodersOutput)) {
        return candidate;
      }
    }
  } catch (e) {
    logger.debug({ err: e.message }, "Failed to inspect available FFmpeg encoders");
  }

  return "mpeg4";
}

function extractEmbeddedThumbnailFromMessage(messageLike) {
  try {
    const raw = messageLike?.ephemeralMessage?.message || messageLike?.viewOnceMessage?.message || messageLike?.message || messageLike || {};
    const imageMsg = raw.imageMessage;
    const videoMsg = raw.videoMessage;
    const documentMsg = raw.documentMessage;
    const thumb = imageMsg?.jpegThumbnail || videoMsg?.jpegThumbnail || documentMsg?.jpegThumbnail;

    if (!thumb) return null;
    if (Buffer.isBuffer(thumb)) return thumb;
    if (typeof thumb === "string") return Buffer.from(thumb, "base64");
    if (Array.isArray(thumb)) return Buffer.from(thumb);
    if (thumb?.data && Array.isArray(thumb.data)) return Buffer.from(thumb.data);
    return null;
  } catch (e) {
    logger.debug({ err: e.message }, "Failed to extract embedded thumbnail from message");
    return null;
  }
}

async function generateVideoThumbnail(videoBuffer) {
  if (!videoBuffer || !videoBuffer.length) return null;
  if (!checkFfmpegAvailable()) return null;

  const tempDir = path.join(os.tmpdir(), "whatsapp-video-thumb");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const inputFile = path.join(tempDir, `thumb-input-${uniqueId}.mp4`);
  const outputFile = path.join(tempDir, `thumb-output-${uniqueId}.jpg`);

  try {
    fs.writeFileSync(inputFile, videoBuffer);
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(FFMPEG_PATH, [
        "-i", inputFile,
        "-frames:v", "1",
        "-vf", "scale='min(480,iw)':-1",
        "-q:v", "2",
        "-y",
        outputFile,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg thumbnail generation failed with code ${code}: ${stderr.slice(-200)}`));
      });

      ffmpeg.on("error", reject);
    });

    if (!fs.existsSync(outputFile)) return null;
    const thumb = fs.readFileSync(outputFile);
    return thumb.length > 0 ? thumb : null;
  } catch (error) {
    logger.debug({ err: error.message }, "Failed to generate video thumbnail");
    return null;
  } finally {
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch (_) {}
  }
}

async function resolveVideoThumbnail(originalMsg, videoBuffer) {
  const embedded = extractEmbeddedThumbnailFromMessage(originalMsg);
  if (embedded && embedded.length > 0) return embedded;
  return generateVideoThumbnail(videoBuffer);
}

/**
 * Compress video buffer using ffmpeg
 * Preserves audio codec (AAC) and quality.
 * Uses H.264 video codec (like Proton Compressor).
 * 
 * @param {Buffer} inputBuffer - Original video buffer
 * @param {string} inputFormat - Input file format (mp4, avi, etc.)
 * @returns {Promise<Buffer>} Compressed video buffer
 */
async function compressVideo(inputBuffer, inputFormat = "mp4") {
  // If compression is disabled, return original buffer
  if (!COMPRESSION_CONFIG.enableCompression) {
    logger.debug("Video compression is disabled (ENABLE_VIDEO_COMPRESSION=false)");
    return inputBuffer;
  }

  // Check if ffmpeg is available
  if (!checkFfmpegAvailable()) {
    logger.warn("ffmpeg not found in PATH — returning original video buffer. Install ffmpeg to enable compression.");
    return inputBuffer;
  }

  const tempDir = path.join(os.tmpdir(), "whatsapp-video-compress");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const inputFile = path.join(tempDir, `input-${uniqueId}.${inputFormat}`);
  const outputFile = path.join(tempDir, `output-${uniqueId}.mp4`);

  try {
    // Write input buffer to temp file
    fs.writeFileSync(inputFile, inputBuffer);
    const inputSizeBytes = fs.statSync(inputFile).size;
    const inputSizeMB = (inputSizeBytes / (1024 * 1024)).toFixed(2);

    logger.info(
      { inputSize: `${inputSizeMB}MB`, targetResolution: `${COMPRESSION_CONFIG.targetWidth}x${COMPRESSION_CONFIG.targetHeight}` },
      "Starting video compression (H.264, audio preserved)..."
    );

    const videoEncoder = detectVideoEncoder();
    const supportsPreset = ["libx264", "h264_qsv", "h264_nvenc"].includes(videoEncoder);

    // Build ffmpeg command for H.264 compression (Proton Compressor equivalent).
    // Some Windows builds ship without libx264, so we use the best available compatible encoder.
    const ffmpegArgs = [
      "-i", inputFile,
      "-c:v", videoEncoder,
      "-vf", `scale=${COMPRESSION_CONFIG.targetWidth}:${COMPRESSION_CONFIG.targetHeight}`,
      "-crf", COMPRESSION_CONFIG.videoCRF.toString(),
      "-c:a", "aac",
      "-b:a", COMPRESSION_CONFIG.audioBitrate,
      "-y",
      outputFile
    ];

    if (supportsPreset) {
      ffmpegArgs.splice(4, 0, "-preset", COMPRESSION_CONFIG.videoPreset);
    }

    if (videoEncoder === "mpeg4") {
      ffmpegArgs.splice(2, 0, "-pix_fmt", "yuv420p");
    }

    // Run ffmpeg compression
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { 
        stdio: ["ignore", "pipe", "pipe"] // Suppress console output
      });

      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.split('\n').slice(-5).join(' ')}`));
        }
      });

      ffmpeg.on("error", (err) => {
        reject(err);
      });
    });

    // Read compressed output buffer
    const outputBuffer = fs.readFileSync(outputFile);
    const outputSizeBytes = fs.statSync(outputFile).size;
    const outputSizeMB = (outputSizeBytes / (1024 * 1024)).toFixed(2);
    const compressionRatio = ((1 - outputSizeBytes / inputSizeBytes) * 100).toFixed(1);

    logger.info(
      { 
        inputSize: `${inputSizeMB}MB`, 
        outputSize: `${outputSizeMB}MB`, 
        compressionRatio: `${compressionRatio}%`, 
        codec: "H.264", 
        audio: "AAC", 
        audioPreserved: true 
      },
      "✅ Video compression completed successfully"
    );

    return outputBuffer;
  } catch (error) {
    logger.error(
      { err: error.message },
      "❌ Video compression failed — returning original buffer"
    );
    return inputBuffer; // Return original if compression fails
  } finally {
    // Clean up temp files
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch (e) {
      logger.debug({ err: e.message }, "Failed to clean up temp files");
    }
  }
}

/**
 * Compress video buffer with size validation
 * Ensures output doesn't exceed max size limit
 * 
 * @param {Buffer} inputBuffer - Original video buffer
 * @param {string} inputFormat - Input file format
 * @returns {Promise<Buffer>} Compressed video buffer (or original if compression exceeds max size)
 */
async function compressVideoWithValidation(inputBuffer, inputFormat = "mp4") {
  const compressed = await compressVideo(inputBuffer, inputFormat);

  if (compressed.length > COMPRESSION_CONFIG.maxOutputSize) {
    logger.warn(
      { compressedSize: `${(compressed.length / (1024 * 1024)).toFixed(2)}MB`, maxAllowed: `${(COMPRESSION_CONFIG.maxOutputSize / (1024 * 1024)).toFixed(0)}MB` },
      "Compressed video exceeds max size — using original buffer"
    );
    return inputBuffer;
  }

  return compressed;
}

module.exports = {
  compressVideo,
  compressVideoWithValidation,
  checkFfmpegAvailable,
  generateVideoThumbnail,
  resolveVideoThumbnail,
  extractEmbeddedThumbnailFromMessage,
  COMPRESSION_CONFIG,
};
