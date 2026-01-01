# Invidious Downloader - Implementation Plan

## Overview

A TypeScript/Deno service that automatically downloads videos from Invidious subscriptions and serves them through the Invidious UI.

## Goals

1. **Read subscriptions** from Invidious PostgreSQL database
2. **Auto-download** new videos via Invidious Companion API
3. **Mux video+audio** into single MP4 with ffmpeg
4. **Proxy Invidious** and serve cached videos transparently
5. **Browser extension** for manual download triggers

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Docker Compose Network                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐    ┌───────────────────┐    ┌──────────────────────┐ │
│  │ Postgres │◄───│    Invidious      │◄───│     Companion        │ │
│  │  :5432   │    │     :3000         │    │      :8282           │ │
│  └────┬─────┘    └─────────┬─────────┘    └──────────┬───────────┘ │
│       │                    │                         │              │
│       │  ┌─────────────────┴─────────────────────────┘              │
│       │  │                                                          │
│       ▼  ▼                                                          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                   Invidious Downloader                          │ │
│  │                        :3001                                    │ │
│  │                                                                 │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │ │
│  │  │ Subscription    │  │  Download       │  │  HTTP Server    │ │ │
│  │  │ Watcher         │  │  Manager        │  │  (Proxy + API)  │ │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              ▼                                       │
│                     ┌──────────────┐                                │
│                     │   /videos    │  (mounted volume)              │
│                     └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Deno | Same as Invidious Companion, modern TS |
| Web Framework | Hono | Lightweight, fast, good for proxy |
| Download | Companion API + HTTP | Leverage PO tokens, no cookies needed |
| Muxing | ffmpeg | Combine video + audio into MP4 |
| Invidious DB | PostgreSQL | Read subscriptions directly |
| Local DB | SQLite | Track downloads, queue, exclusions |

## Database Schemas

### Invidious PostgreSQL (Read-only)

```sql
-- Users table (we read subscriptions from here)
users (
  email TEXT PRIMARY KEY,
  subscriptions TEXT[],  -- Array of channel UCIDs
  ...
)

-- Channel videos (for detecting new content)
channel_videos (
  id TEXT PRIMARY KEY,           -- Video ID
  ucid TEXT,                     -- Channel UCID
  title TEXT,
  published TIMESTAMP,
  length_seconds INTEGER,
  ...
)
```

### Local SQLite

```sql
-- Track downloaded videos
CREATE TABLE downloads (
  video_id TEXT PRIMARY KEY,
  user_id TEXT,
  channel_id TEXT,
  title TEXT,
  duration_seconds INTEGER,
  quality TEXT,
  file_path TEXT,
  thumbnail_path TEXT,
  metadata JSON,
  downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  file_size_bytes INTEGER
);

-- Track channel exclusions
CREATE TABLE channel_exclusions (
  channel_id TEXT PRIMARY KEY,
  user_id TEXT,
  excluded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Download queue
CREATE TABLE download_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT UNIQUE,
  user_id TEXT,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);
```

## Configuration

Environment variables:

```bash
# Required
INVIDIOUS_URL=http://invidious:3000
INVIDIOUS_DB_URL=postgres://kemal:kemal@postgres:5432/invidious
COMPANION_URL=http://companion:8282
COMPANION_SECRET=your_secret_key
VIDEOS_PATH=/videos

# Optional
PORT=3001
INVIDIOUS_USER=your@email.com
DOWNLOAD_QUALITY=best
DOWNLOAD_RATE_LIMIT=0
CHECK_INTERVAL_MINUTES=30
MAX_CONCURRENT_DOWNLOADS=2
```

## Companion API Integration

### Get Video Info

```
POST /companion/youtubei/v1/player
Headers: Authorization: Bearer {COMPANION_SECRET}
Body: { "videoId": "VIDEO_ID" }

Response: Full video info with decrypted stream URLs
```

### Get Specific Stream

```
GET /companion/latest_version?id={VIDEO_ID}&itag={ITAG}

Response: Direct stream URL
```

## File Structure

```
invidious-downloader/
├── src/
│   ├── main.ts                    # Entry point
│   ├── config.ts                  # Configuration (testable, pure)
│   │
│   ├── db/
│   │   ├── invidious.ts           # Invidious PostgreSQL queries
│   │   ├── local.ts               # Local SQLite operations
│   │   └── types.ts               # Database types
│   │
│   ├── services/
│   │   ├── companion-client.ts    # Companion API client
│   │   ├── subscription-watcher.ts
│   │   ├── download-manager.ts
│   │   └── muxer.ts               # ffmpeg wrapper
│   │
│   ├── server/
│   │   ├── index.ts               # Hono app
│   │   ├── proxy.ts               # Proxy to Invidious
│   │   ├── video-handler.ts       # Serve cached videos
│   │   └── api.ts                 # REST API
│   │
│   └── utils/
│       ├── logger.ts
│       └── stream.ts
│
├── tests/
│   ├── config.test.ts
│   ├── companion-client.test.ts
│   ├── download-manager.test.ts
│   └── ...
│
├── extension/
│   ├── manifest.json
│   ├── content.js
│   └── options.html
│
├── PLAN.md
├── README.md
├── Dockerfile
├── docker-compose.example.yml
├── deno.json
└── .gitignore
```

## Video Storage

```
/videos/
├── downloads.db
├── {video_id}.mp4          # Muxed video file
├── {video_id}.json         # Metadata
├── {video_id}.webp         # Thumbnail
└── ...
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/*` | ALL | Proxy to Invidious |
| `/videoplayback*` | GET | Serve cached or proxy |
| `/api/downloader/status` | GET | Service status |
| `/api/downloader/queue` | GET | List queue |
| `/api/downloader/queue` | POST | Add to queue |
| `/api/downloader/queue/:id` | DELETE | Cancel download |
| `/api/downloader/downloads` | GET | List downloads |
| `/api/downloader/downloads/:id` | DELETE | Delete download |
| `/api/downloader/exclusions` | GET/POST/DELETE | Manage exclusions |
| `/api/downloader/config` | GET/PATCH | Settings |

## Development Phases

### Phase 1: Foundation
- [x] Initialize git repo
- [x] Write PLAN.md
- [ ] Set up Deno project (deno.json)
- [ ] Create .gitignore
- [ ] Configuration module with tests
- [ ] Companion API client with tests
- [ ] Basic download function with tests

### Phase 2: Database Layer
- [ ] PostgreSQL client for Invidious (read subscriptions)
- [ ] SQLite module for local tracking
- [ ] Database types and interfaces
- [ ] Tests for all DB operations

### Phase 3: Proxy & Serve
- [ ] Hono HTTP server setup
- [ ] Proxy all requests to Invidious
- [ ] Intercept /videoplayback requests
- [ ] Serve cached video files
- [ ] Tests for routing logic

### Phase 4: Auto Downloads
- [ ] Subscription watcher service
- [ ] Download queue management
- [ ] Concurrent download handling
- [ ] Rate limiting
- [ ] ffmpeg muxing
- [ ] Tests for queue logic

### Phase 5: Browser Extension
- [ ] Extension manifest (Chrome/Firefox)
- [ ] Content script to inject download button
- [ ] Options page for URL configuration
- [ ] API integration

### Phase 6: Polish
- [ ] Channel exclusions
- [ ] Web dashboard at /downloader/
- [ ] Quality selection
- [ ] Multi-user support
- [ ] SponsorBlock segment storage

## Testing Strategy

All business logic should be pure functions that are easily testable:

1. **Config parsing** - Pure function, no I/O
2. **API response parsing** - Pure function
3. **Stream selection** - Pure function (select best quality)
4. **Queue management** - State machine, testable
5. **Path generation** - Pure function
6. **Request routing** - Pattern matching, testable

External dependencies (DB, HTTP, filesystem) are injected as interfaces.

## Docker Compose Example

```yaml
services:
  invidious:
    image: quay.io/invidious/invidious:latest
    depends_on:
      - postgres
    environment:
      INVIDIOUS_CONFIG: |
        db:
          dbname: invidious
          user: kemal
          password: kemal
          host: postgres
        companion: "companion:8282"
        companion_key: "your_secret_key"

  companion:
    image: quay.io/invidious/invidious-companion:latest
    environment:
      SERVER_SECRET_KEY: "your_secret_key"

  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: invidious
      POSTGRES_USER: kemal
      POSTGRES_PASSWORD: kemal
    volumes:
      - postgres_data:/var/lib/postgresql/data

  downloader:
    build: .
    depends_on:
      - invidious
      - companion
      - postgres
    ports:
      - "3001:3001"
    environment:
      INVIDIOUS_URL: "http://invidious:3000"
      INVIDIOUS_DB_URL: "postgres://kemal:kemal@postgres:5432/invidious"
      COMPANION_URL: "http://companion:8282"
      COMPANION_SECRET: "your_secret_key"
      VIDEOS_PATH: "/videos"
      INVIDIOUS_USER: "your@email.com"
    volumes:
      - ./videos:/videos

volumes:
  postgres_data:
```

## Notes

- User accesses `http://localhost:3001` (downloader) instead of `:3000` directly
- Downloader proxies all requests to Invidious
- Cached videos are served directly, others are proxied
- Single user first, but schema supports multi-user for future
