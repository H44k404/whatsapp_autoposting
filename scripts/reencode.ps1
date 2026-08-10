param(
    [Parameter(Mandatory=$true)] [string]$InputPath,
    [string]$OutputPath = ''
)

if (-not (Test-Path $InputPath)) {
    Write-Error "Input file not found: $InputPath"
    exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "ffmpeg not found in PATH. Install ffmpeg (winget/choco) and retry."
    exit 1
}

if ($OutputPath -eq '') {
    $dir = Split-Path $InputPath
    $base = [System.IO.Path]::GetFileNameWithoutExtension($InputPath)
    $OutputPath = Join-Path $dir ($base + "_reencoded.mp4")
}

# Probe codecs
$videoCodec = (& ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$InputPath") -replace '\r','' -replace '\n',''
$audioCodec = (& ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$InputPath") -replace '\r','' -replace '\n',''
$formatName = (& ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "$InputPath") -replace '\r','' -replace '\n',''

Write-Host "Video codec: $videoCodec"
Write-Host "Audio codec: $audioCodec"
Write-Host "Format: $formatName"

if ($videoCodec -eq 'h264' -and ($audioCodec -eq 'aac' -or $audioCodec -eq 'mp3') -and $formatName -like '*mp4*') {
    Write-Host "File already uses widely-supported codecs. Creating faststart copy to enable streaming/preview..."
    ffmpeg -y -i "$InputPath" -c copy -movflags +faststart "$OutputPath"
    if ($LASTEXITCODE -eq 0) { Write-Host "Output: $OutputPath"; exit 0 } else { Write-Error "ffmpeg copy failed"; exit 1 }
}

Write-Host "Re-encoding to H.264 + AAC..."
ffmpeg -y -i "$InputPath" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart "$OutputPath"
if ($LASTEXITCODE -eq 0) { Write-Host "Re-encode complete: $OutputPath"; exit 0 } else { Write-Error "ffmpeg failed"; exit 1 }
