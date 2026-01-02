# Future Plans

## Progressive Caching / Cache-on-View

**Goal:** When a user starts watching a video (even if not explicitly downloaded), begin caching the stream data so that:
1. Subsequent plays of the same video are served from cache
2. Partially cached videos can still be played (serve cached portions + proxy the rest)

### Phase 1: Partial File Playback
- Modify video handler to support serving partially downloaded files
- Track which byte ranges are cached (could be sparse/non-contiguous)
- For range requests: serve from cache if available, proxy to origin if not
- Need a way to track "in-progress" downloads vs "complete" downloads

### Phase 2: Background Caching on View
- When `/videoplayback` is requested and video is NOT cached:
  - Start proxying immediately to the client
  - Simultaneously write the stream data to disk (tee the response)
  - Track progress in database
- Handle multiple concurrent viewers of the same uncached video
  - First viewer triggers the cache write
  - Subsequent viewers read from the growing cache file

### Phase 3: Smart Caching Decisions
- Don't cache everything - only cache if user watches > X% of video
- Configurable: auto-cache subscribed channels vs manual-only
- Storage management: LRU eviction when disk space is low
- Quality selection: cache the quality level being watched

### Technical Considerations

**Sparse file support:**
- Option A: Single file with byte-range tracking (complex)
- Option B: Segment-based caching (split into chunks)
- Option C: Simple sequential caching (only serve from cache once complete or from start)

**Database schema additions:**
```sql
-- Track partial downloads
CREATE TABLE partial_downloads (
  video_id TEXT PRIMARY KEY,
  total_bytes INTEGER,
  cached_bytes INTEGER,
  itag INTEGER,
  started_at INTEGER,
  last_accessed INTEGER,
  status TEXT -- 'downloading', 'complete', 'stale'
);

-- Track cached byte ranges (for sparse caching)
CREATE TABLE cached_ranges (
  video_id TEXT,
  itag INTEGER,
  start_byte INTEGER,
  end_byte INTEGER,
  PRIMARY KEY (video_id, itag, start_byte)
);
```

**Serving logic for partial cache:**
```
on range request (start, end):
  if entire range is cached:
    serve from disk
  else if range starts within cache:
    serve cached portion, then proxy remainder
  else:
    proxy entire request (optionally trigger background cache)
```

### Open Questions
- Should we cache adaptive streams (separate video/audio) or combined streams?
- How to handle expired YouTube URLs mid-download?
- Should partial caches be usable across sessions or cleared on restart?
