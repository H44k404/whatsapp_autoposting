Purpose
- Re-encode videos to a WhatsApp-friendly MP4 (H.264 video + AAC audio) and ensure `faststart` (streaming/preview) is set.

Requirements
- `ffmpeg` + `ffprobe` available in `PATH`.
  - Install on Windows using one of:
    - `winget install --id Gyan.FFmpeg -e`  (Gyan builds)
    - `choco install ffmpeg` (if you use Chocolatey)

Usage (PowerShell)
```powershell
# From PowerShell
cd "d:\whatapp_automation\scripts"
.\reencode.ps1 -InputPath "C:\path\to\WhatsApp Video 2026-08-09 at 23.04.18.mp4"
```

Usage (cmd)
```cmd
cd d:\whatapp_automation\scripts
reencode.bat "C:\path\to\WhatsApp Video 2026-08-09 at 23.04.18.mp4"
```

What the script does
- Uses `ffprobe` to check the input's codecs and container.
- If already H.264/AAC in MP4, it copies into a `*_reencoded.mp4` with `-movflags +faststart` so WhatsApp can stream/preview.
- Otherwise it re-encodes to `libx264` + `aac` with reasonable defaults.

After running
- Use your phone to transfer the resulting `*_reencoded.mp4` file back to the sender device (or send it from your PC), then share in WhatsApp using Gallery/Photos & Videos (not "Send as document").
