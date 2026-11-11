# Video Compression Feature

## Overview

The WhatsApp broadcast bot now includes automatic video compression to reduce file sizes for WhatsApp compatibility. Videos are compressed from ~21MB to ~8-10MB before being sent to target groups, while **preserving audio quality**.

This feature:
- ✅ Compresses only **videos** (images are untouched)
- ✅ Preserves **audio** quality (AAC codec)
- ✅ Uses **H.264 video codec** (like Proton Compressor)
- ✅ Targets **480p resolution** (853×480)
- ✅ Works for both **source-group approvals** and **dashboard uploads**
- ✅ Gracefully falls back to original if ffmpeg unavailable

---

## Installation & Setup

### 1. Install FFmpeg (Required)

#### On Windows (Recommended):
```powershell
# Using winget (Windows 11+)
winget install --id Gyan.FFmpeg -e

# Or using Chocolatey
choco install ffmpeg
```

#### On Ubuntu/Linux:
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

#### On macOS:
```bash
brew install ffmpeg
```

### 2. Verify ffmpeg Installation

```bash
ffmpeg -version
ffprobe -version
```

Both commands should return version information without errors.

---

## Configuration

Add these environment variables to `.env` to customize video compression:

```bash
# Enable/Disable video compression (default: true)
ENABLE_VIDEO_COMPRESSION=true

# Target video resolution (default: 480p)
VIDEO_TARGET_WIDTH=853
VIDEO_TARGET_HEIGHT=480

# Starting video quality (higher CRF = smaller file, lower quality)
# Default 32; if the output is still above half the original size, the bot retries at CRF 36 and 40.
VIDEO_CRF=32

# Encoding speed (ultrafast, superfast, veryfast, faster, fast, medium, slow, slower)
# Default: medium
VIDEO_PRESET=medium

# Audio bitrate (default: 128k, good for WhatsApp)
AUDIO_BITRATE=128k

# Maximum output file size in MB (default: 10)
VIDEO_MAX_SIZE_MB=10

# Custom ffmpeg path (optional, if not in system PATH)
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
```

---

## How It Works

### Compression Flow

1. **Source Group Media**
   - Video received from main source group
   - Approval request created with original media
   - ↓
   - **When approved:** Video is compressed → sent to target groups

2. **Dashboard Upload**
   - Video uploaded via dashboard interface
   - ↓
   - **When approved:** Video is compressed → sent to target groups

### Key Points

- **Approval preview**: Uses original media (no compression)
- **Broadcast delivery**: Uses compressed media (smaller file)
- **Audio**: Always preserved (AAC codec at 128kbps)
- **Best-effort size target**: The bot tries up to 50% size reduction by encoding at progressively higher CRF values, while keeping the configured resolution cap.
- **Quality trade-off**: Higher CRF can make image detail less sharp. If the 50% target is not reached at the configured resolution, the smallest successful encode is used and a warning is logged.
- **Fallback**: If compression fails or does not make the file smaller, the original video is sent

---

## Quality Settings Reference

### CRF Values (Video Quality)
```
CRF 18 → Best quality, larger file (~15-20MB from 21MB source)
CRF 23 → High quality, medium file (~10-12MB)
CRF 28 → Higher quality, larger file
CRF 32 → Balanced quality and size ← DEFAULT
CRF 36 → Lower quality, smaller file
CRF 40 → Lowest quality retry, smallest file
```

### Preset Values (Encoding Speed)
```
ultrafast  → Fastest, worst compression
superfast  → Very fast, poor compression
veryfast   → Fast, fair compression
faster     → Slower, better compression
fast       → Good balance
medium     → Better compression, slower ← DEFAULT
slow       → Slow, good compression
slower     → Very slow, best compression
```

---

## Monitoring Compression

Watch the application logs to see compression statistics:

```
[INFO] Starting video compression (H.264, audio preserved)...
       inputSize: "21.45MB"
       targetResolution: "853x480"

[INFO] ✅ Video compression completed successfully
       inputSize: "21.45MB"
       outputSize: "9.32MB"
       compressionRatio: "56.5%"
       codec: "H.264"
       audio: "AAC"
       audioPreserved: true
```

---

## Troubleshooting

### "ffmpeg not found in PATH"
**Cause**: FFmpeg is not installed or not in system PATH

**Solution**:
1. Install ffmpeg (see Installation section)
2. Verify installation: `ffmpeg -version`
3. If still not found, set custom path in `.env`:
   ```bash
   FFMPEG_PATH=/usr/local/bin/ffmpeg
   FFPROBE_PATH=/usr/local/bin/ffprobe
   ```

### Compressed video exceeds max size
**Cause**: CRF setting is too aggressive, file is still too large

**Solution**:
- Lower VIDEO_CRF value (e.g., 32 instead of 28)
- Increase VIDEO_MAX_SIZE_MB in `.env`
- Reduce target resolution (e.g., 640×360 instead of 853×480)

### Compression is slow
**Cause**: VIDEO_PRESET is set to "slow" or "slower"

**Solution**:
- Use faster preset: `VIDEO_PRESET=medium` or `VIDEO_PRESET=fast`
- Trade-off: less compression, faster processing

### Audio is missing after compression
**Issue**: Should not happen - audio is preserved by default

**Check**: Verify `ENABLE_VIDEO_COMPRESSION=true` and ffmpeg is working

---

## API Endpoints

### Dashboard Upload (with auto-compression)
```bash
POST /api/approve/:id
{
  "targetGroups": ["120363429052816210@g.us", ...],
  "delayMs": 8
}
```

The uploaded video will be automatically compressed before sending to target groups.

### Source Group Approval (with auto-compression)
When you reply "YES {id}" in the control chat, the approved video is automatically compressed before broadcast.

---

## Disable Compression

To disable video compression (send original files):

```bash
ENABLE_VIDEO_COMPRESSION=false
```

Or remove/comment out the `.env` line and restart the bot.

---

## Remote Server Deployment

### EC2 Ubuntu Setup

```bash
# SSH to server
ssh -i "your-key.pem" ubuntu@your-ip

# Install ffmpeg
sudo apt-get update
sudo apt-get install -y ffmpeg

# Verify installation
ffmpeg -version

# Add to .env if needed
echo "ENABLE_VIDEO_COMPRESSION=true" >> /home/ubuntu/whatsapp_automation/whatsapp-broadcast-bot/.env

# Restart PM2
cd /home/ubuntu/whatsapp_automation/whatsapp-broadcast-bot
pm2 restart ecosystem.config.cjs
pm2 logs
```

---

## Performance Notes

- **Compression time**: 2-5 seconds per video (depends on VIDEO_PRESET)
- **CPU usage**: ~40-60% during compression
- **Memory**: ~200-300MB temporary per video
- **Temp storage**: Videos are compressed to /tmp (automatically cleaned up)

---

## Testing

Test compression with a sample video:

```bash
# Generate a test video (21MB)
ffmpeg -f lavfi -i color=c=blue:s=1920x1080:d=60 \
  -c:v libx264 -preset slow -crf 18 \
  -c:a aac -b:a 192k test-input.mp4

# Check file size
ls -lh test-input.mp4

# The bot will compress it to ~8-10MB when processing
```

---

## Summary

With this feature enabled, your bot will:
1. Accept large videos from source groups
2. Create approval requests with original quality preview
3. Compress videos to WhatsApp-friendly sizes before broadcast
4. Preserve audio quality throughout
5. Send compressed files to all target groups

Result: **Better WhatsApp compatibility + smaller bandwidth usage** ✅
