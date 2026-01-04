# Invidious Downloader

A companion service for [Invidious](https://github.com/iv-org/invidious) that automatically downloads videos from your subscriptions and serves them transparently through the Invidious UI.

## Why Invidious Downloader?

If you're considering archiving YouTube content, you might be looking at [TubeArchivist](https://github.com/tubearchivist/tubearchivist). Here's why Invidious Downloader might be a better fit:

| | Invidious Downloader | TubeArchivist |
|---|---|---|
| **Resource usage** | Lightweight - Deno + FFmpeg + SQLite | Requires Elasticsearch + Redis (~2-4GB RAM) |
| **Subscription source** | Uses your existing Invidious subscriptions | Separate subscription management |
| **Setup complexity** | Add one container to your Invidious stack | Three containers (app + Redis + Elasticsearch) |
| **UI approach** | Transparent - works within Invidious UI | Separate web application |
| **SponsorBlock** | Works with Invidious clients (Yattee, web) | Works in TubeArchivist UI |
| **Mobile/TV apps** | Native Yattee support (iOS/tvOS/macOS) | Cast support (requires HTTPS setup) |

### Key Benefits

- **Leverages your existing Invidious setup** - No duplicate subscription management. Your Invidious subscriptions are automatically monitored for new videos.
- **Transparent caching** - Users don't notice any difference. Cached videos play from local storage; uncached ones proxy seamlessly to YouTube.
- **Works with existing Invidious clients** - Use Yattee on your iPhone, iPad, or Apple TV. SponsorBlock just works because we inject cached videos between Invidious and Companion.
- **Minimal footprint** - Single container, SQLite database, no external services required beyond your existing Invidious + Companion setup.

## Vibecoded Project

> **This project was entirely generated through AI pair programming using [OpenCode](https://opencode.ai) and Claude Opus 4.5. The author has not manually written or reviewed any code.**

## Features

- **Auto-download subscriptions** - Automatically downloads new videos from your Invidious subscribed channels
- **Transparent proxy** - Cached videos served locally; uncached ones proxied seamlessly to YouTube
- **DASH streaming** - Separate video/audio streams injected between Invidious and Companion
- **Yattee compatible** - Works with Yattee and other Invidious clients with full SponsorBlock support
- **Quality selection** - Choose from best, 1080p, 720p, 480p, or 360p
- **Real-time dashboard** - Monitor downloads with live progress via WebSocket
- **Channel exclusions** - Prevent specific channels from auto-downloading
- **Rate limiting** - Configurable download bandwidth limits
- **REST API** - Full control over queue, downloads, and exclusions
- **Docker-ready** - Easy deployment alongside your existing Invidious stack

## How It Works

```
User -> Invidious Downloader (port 3001) -> Invidious (port 3000)
                |
                v
        Checks if video is cached
                |
        +-------+-------+
        |               |
     Cached          Not Cached
        |               |
        v               v
   Serve from       Proxy to
   local file       Companion/YouTube
```

1. Users access Invidious through the downloader proxy (port 3001 instead of 3000)
2. The downloader intercepts video requests
3. If the video is cached locally, it serves the MP4 directly
4. If not cached, it proxies the request to the Invidious Companion

## Quick Start

### Docker Compose

1. Copy the example compose file:
   ```bash
   cp docker-compose.example.yml docker-compose.yml
   ```

2. Update the configuration:
   - Change `CHANGE_ME_SECRET_KEY` to a secure random string
   - Set `INVIDIOUS_USER` to your Invidious account email (optional)

3. Start the stack:
   ```bash
   docker compose up -d
   ```

4. Access Invidious at `http://localhost:3001`

### Adding to Existing Invidious Setup

If you already have Invidious running, add the downloader service to your compose file:

```yaml
services:
  downloader:
    image: ghcr.io/dderg/invidious-downloader:latest
    # Or build from source:
    # build: .
    ports:
      - "3001:3001"
    environment:
      INVIDIOUS_URL: "http://invidious:3000"
      INVIDIOUS_DB_URL: "postgres://kemal:kemal@postgres:5432/invidious"
      COMPANION_URL: "http://companion:8282"
      COMPANION_SECRET: "your_companion_secret"
      VIDEOS_PATH: "/videos"
    volumes:
      - videos:/videos
    depends_on:
      - invidious
      - companion
      - postgres

volumes:
  videos:
```

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `INVIDIOUS_URL` | Yes | - | URL to your Invidious instance |
| `INVIDIOUS_DB_URL` | Yes | - | PostgreSQL connection string for Invidious DB |
| `COMPANION_URL` | Yes | - | URL to Invidious Companion |
| `COMPANION_SECRET` | Yes | - | Shared secret with Companion |
| `VIDEOS_PATH` | Yes | - | Path to store downloaded videos |
| `PORT` | No | `3001` | Port for the downloader service |
| `INVIDIOUS_USER` | No | - | Specific user email to watch (watches all users if not set) |
| `DOWNLOAD_QUALITY` | No | `best` | Video quality: `best`, `1080p`, `720p`, `480p`, `360p` |
| `DOWNLOAD_RATE_LIMIT` | No | `0` | Download rate limit in bytes/sec (0 = unlimited) |
| `CHECK_INTERVAL_MINUTES` | No | `5` | How often to check for new videos |
| `MAX_CONCURRENT_DOWNLOADS` | No | `2` | Maximum concurrent downloads |

## API Endpoints

### Downloader API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/downloader/status` | GET | Service status and stats |
| `/api/downloader/stats` | GET | Detailed statistics |
| `/api/downloader/progress` | GET | Real-time download progress |
| `/api/downloader/queue` | GET | List download queue |
| `/api/downloader/queue` | POST | Add video to queue |
| `/api/downloader/queue/:id` | DELETE | Cancel queued download |
| `/api/downloader/queue/clear` | POST | Clear completed queue items |
| `/api/downloader/downloads` | GET | List completed downloads |
| `/api/downloader/downloads/:id` | GET | Get download details |
| `/api/downloader/downloads/:id` | DELETE | Delete a download |
| `/api/downloader/exclusions` | GET | List excluded channels |
| `/api/downloader/exclusions` | POST | Exclude a channel |
| `/api/downloader/exclusions/:id` | DELETE | Remove exclusion |

### Dashboard & Cached Video Access

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/downloader/` | GET | Web dashboard |
| `/ws/dashboard` | GET | WebSocket for real-time updates |
| `/cached/:videoId` | GET | Direct access to cached MP4 |
| `/cached/:videoId/thumbnail` | GET | Cached thumbnail |
| `/cached/:videoId/metadata` | GET | Video metadata JSON |
| `/health` | GET | Health check endpoint |

### Proxy & DASH Streaming

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/*` | ALL | Transparent proxy to Invidious |
| `/videoplayback*` | ALL | Serves cached streams or proxies |
| `/api/v1/videos/:id` | GET | Modified API with local stream URLs |

## Development

### Prerequisites

- [Deno](https://deno.land/) 2.x
- [FFmpeg](https://ffmpeg.org/)
- PostgreSQL (for Invidious DB)
- Running Invidious + Companion instance

### Running Locally

```bash
# Set environment variables
export INVIDIOUS_URL="http://localhost:3000"
export INVIDIOUS_DB_URL="postgres://kemal:kemal@localhost:5432/invidious"
export COMPANION_URL="http://localhost:8282"
export COMPANION_SECRET="your_secret"
export VIDEOS_PATH="./videos"

# Run the service
deno task dev
```

### Running Tests

```bash
deno task test
```

## Project Status

See [PLAN.md](PLAN.md) for detailed development phases and progress.

### What's Working

- Automatic subscription monitoring and download queuing
- DASH streaming with separate video/audio streams
- Cached streams injected between Invidious and Companion
- SponsorBlock works with existing Invidious clients (Yattee, web player)
- Transparent proxy with cached video interception
- Quality selection (best/1080p/720p/480p/360p)
- FFmpeg muxing for Jellyfin/direct download compatibility
- Real-time dashboard with WebSocket updates
- REST API for queue and download management
- Channel exclusions
- Rate limiting and concurrent download control

### Planned

- Browser extension for one-click downloads
- Thumbnail caching

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

This is the same license used by [Invidious](https://github.com/iv-org/invidious).
