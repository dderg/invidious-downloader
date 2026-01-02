# Invidious Downloader - Project Context

## Project Overview
**Invidious Downloader** - A Deno/TypeScript service that auto-downloads videos from Invidious subscriptions and serves cached videos transparently. Published at https://github.com/dderg/invidious-downloader

## Server Environment
- **Platform:** Raspberry Pi (aarch64)
- **Docker:** Uses `docker-compose` (not `docker compose`)
- **Stack location:** `/opt/stacks/invidious/`
- **Code mount:** `./downloader:/app` (code changes require `docker-compose restart downloader`)
- **Invidious URL:** http://invidious.home
- **Videos directory:** `/videos/` (inside container)

## Current Implementation Status

### DASH/itag Streaming Feature (In Progress)
**Goal:** Enable Yattee and web UI to play cached videos using DASH/adaptive streaming with SponsorBlock support.

### What's Been Implemented

1. **Download Manager** (`src/services/download-manager.ts`):
   - Downloads save separate video/audio streams with itag in filename
   - File naming: `{videoId}_video_{itag}.mp4` and `{videoId}_audio_{itag}.m4a`
   - Also saves muxed MP4 for external consumption (Jellyfin, direct downloads)

2. **Video Handler** (`src/server/video-handler.ts`):
   - `getCachedStreams(videoId)` - scans directory for available itag files
   - `hasVideoStream(videoId, itag)` / `hasAudioStream(videoId, itag)` - check if stream exists
   - `serveVideoStream()` / `serveAudioStream()` - serve stream files with range support

3. **Server** (`src/server/index.ts`):
   - `/videoplayback*` handler checks for `v` and `itag` params, serves cached streams
   - `/companion/api/manifest/dash/id/:videoId` generates custom DASH manifest for cached videos
   - `/api/v1/videos/:videoId` modifies `adaptiveFormats` to point to local URLs

### Video Storage Structure
```
/videos/
├── downloads.db
├── {video_id}.mp4              # Muxed file (for Jellyfin/external use)
├── {video_id}_video_{itag}.mp4 # Separate video stream (for DASH)
├── {video_id}_audio_{itag}.m4a # Separate audio stream (for DASH)
├── {video_id}.json             # Metadata
└── {video_id}.webp             # Thumbnail
```

### How DASH Streaming Should Work

1. User visits `/watch?v={videoId}` for a cached video
2. Page loads with original DASH source in HTML (unmodified)
3. Player requests DASH manifest from `/companion/api/manifest/dash/id/{videoId}`
4. **We generate a custom manifest** pointing to local `/videoplayback?v={videoId}&itag={itag}` URLs
5. Player requests streams via `/videoplayback?v={videoId}&itag={itag}`
6. Our server serves cached video/audio stream files directly
7. Video plays with DASH/adaptive streaming and SponsorBlock works!

### Current Issue Being Debugged
The DASH manifest is being generated, but need to verify:
1. The manifest XML format is correct
2. The `/videoplayback` handler is matching requests properly
3. Stream files are being served correctly

### Test Video
- Video ID: `Npy2CUZZUng`
- Files present:
  - `Npy2CUZZUng.mp4` (muxed)
  - `Npy2CUZZUng_video_401.mp4` (video stream)
  - `Npy2CUZZUng_audio_251.m4a` (audio stream)

### Useful Commands
```bash
# Check container logs
docker-compose logs -f downloader

# List video files
docker exec downloader ls -la /videos/

# Check what streams are cached
docker exec downloader ls /videos/ | grep Npy2CUZZUng

# Restart after code changes
docker-compose restart downloader

# Test DASH manifest endpoint
curl -s http://localhost:3001/companion/api/manifest/dash/id/Npy2CUZZUng

# Test videoplayback endpoint
curl -I "http://localhost:3001/videoplayback?v=Npy2CUZZUng&itag=401"
```

### Key Files to Examine
- `src/server/index.ts` - Main server routes, DASH manifest generation
- `src/server/video-handler.ts` - File serving, stream detection
- `src/services/download-manager.ts` - Download logic, file naming

### API Response Transformation
For cached videos with DASH streams:
- `adaptiveFormats` → filtered to only cached itags, URLs rewritten to local endpoints
- `dashUrl` → cleared (we serve streams directly, not through a manifest URL)
- `formatStreams` → NOT modified (kept from original response)
