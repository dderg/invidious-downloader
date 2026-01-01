# Invidious Downloader

A companion service for [Invidious](https://github.com/iv-org/invidious) that automatically downloads videos from your subscriptions and serves them transparently through the Invidious UI.

## Vibecoded Project

> **This project was entirely generated through AI pair programming using [OpenCode](https://opencode.ai) and Claude Opus 4.5. The author has not manually written or reviewed any code.**

## Features

- **Auto-download** - Automatically downloads new videos from your subscribed channels
- **Transparent proxy** - Cached videos are served locally; uncached ones are proxied to YouTube
- **FFmpeg muxing** - Combines separate video and audio streams into a single MP4 file
- **Web dashboard** - Monitor downloads, queue status, and manage exclusions
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
| `CHECK_INTERVAL_MINUTES` | No | `30` | How often to check for new videos |
| `MAX_CONCURRENT_DOWNLOADS` | No | `2` | Maximum concurrent downloads |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/*` | ALL | Proxy to Invidious |
| `/api/downloader/status` | GET | Service status and stats |
| `/api/downloader/queue` | GET | List download queue |
| `/api/downloader/queue` | POST | Add video to queue |
| `/api/downloader/queue/:id` | DELETE | Cancel queued download |
| `/api/downloader/downloads` | GET | List completed downloads |
| `/api/downloader/downloads/:id` | DELETE | Delete a download |
| `/api/downloader/exclusions` | GET | List excluded channels |
| `/api/downloader/exclusions` | POST | Exclude a channel |
| `/api/downloader/exclusions/:id` | DELETE | Remove exclusion |
| `/downloader/` | GET | Web dashboard |

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

- Configuration and environment handling
- Companion API client for video info and streams
- Download manager with queue and concurrent downloads
- FFmpeg muxing (video + audio -> MP4)
- Subscription watcher for auto-downloads
- Proxy server with video interception
- Cached video playback (transparent to user)
- Web dashboard for monitoring
- SQLite database for tracking downloads

### Not Yet Implemented

- Browser extension for manual downloads
- SponsorBlock segment storage
- Thumbnail downloads

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

This is the same license used by [Invidious](https://github.com/iv-org/invidious).
