/**
 * Video handler for serving cached videos.
 *
 * Handles:
 * - Checking if a video is cached locally
 * - Serving cached video files with proper headers
 * - Range request support for seeking
 * - MIME type detection
 */

// ============================================================================
// Types
// ============================================================================

/**
 * File system interface for dependency injection.
 */
export interface VideoFileSystem {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtime: Date | null }>;
  open(path: string): Promise<Deno.FsFile>;
}

/**
 * Default file system using Deno APIs.
 */
export const defaultVideoFileSystem: VideoFileSystem = {
  exists: async (path) => {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  },
  stat: async (path) => {
    const info = await Deno.stat(path);
    return { size: info.size, mtime: info.mtime };
  },
  open: (path) => Deno.open(path, { read: true }),
};

/**
 * Video handler configuration.
 */
export interface VideoHandlerConfig {
  /** Directory where videos are stored */
  videosPath: string;
}

/**
 * Video serve result.
 */
export type VideoServeResult =
  | { ok: true; response: Response }
  | { ok: false; error: VideoServeError };

export interface VideoServeError {
  type: "not_found" | "invalid_range" | "filesystem_error";
  message: string;
  cause?: unknown;
}

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Parse a Range header value.
 * Returns the start and optional end byte positions.
 */
export function parseRangeHeader(
  rangeHeader: string | null,
  fileSize: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;

  const [, startStr, endStr] = match;

  let start: number;
  let end: number;

  if (startStr === "" && endStr !== "") {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffix = parseInt(endStr, 10);
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else if (startStr !== "" && endStr === "") {
    // Open-ended range: bytes=500-
    start = parseInt(startStr, 10);
    end = fileSize - 1;
  } else if (startStr !== "" && endStr !== "") {
    // Closed range: bytes=500-999
    start = parseInt(startStr, 10);
    end = Math.min(parseInt(endStr, 10), fileSize - 1);
  } else {
    return null;
  }

  // Validate range
  if (start > end || start < 0 || start >= fileSize) {
    return null;
  }

  return { start, end };
}

/**
 * Get MIME type for a file extension.
 */
export function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/opus",
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    json: "application/json",
  };

  return mimeTypes[ext ?? ""] ?? "application/octet-stream";
}

/**
 * Extract video ID from various URL patterns.
 * Supports:
 * - /videoplayback?v=VIDEO_ID
 * - /vi/VIDEO_ID/...
 * - /watch?v=VIDEO_ID
 * - Direct VIDEO_ID
 */
export function extractVideoIdFromPath(path: string, query: string): string | null {
  // Check query parameter 'v'
  const params = new URLSearchParams(query);
  const vParam = params.get("v");
  if (vParam && isValidVideoId(vParam)) {
    return vParam;
  }

  // Check /vi/VIDEO_ID/... pattern (thumbnails)
  const viMatch = path.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
  if (viMatch) {
    return viMatch[1];
  }

  // Check /watch pattern
  const watchMatch = path.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) {
    return watchMatch[1];
  }

  // Check if path is just the video ID
  const pathParts = path.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1]?.split(".")[0];
  if (lastPart && isValidVideoId(lastPart)) {
    return lastPart;
  }

  return null;
}

/**
 * Validate a YouTube video ID.
 */
export function isValidVideoId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

/**
 * Build the file path for a cached video.
 */
export function buildVideoPath(videosPath: string, videoId: string): string {
  return `${videosPath}/${videoId}.mp4`;
}

/**
 * Build the file path for a cached video stream by itag.
 */
export function buildVideoStreamPath(videosPath: string, videoId: string, itag: number): string {
  return `${videosPath}/${videoId}_video_${itag}.mp4`;
}

/**
 * Build the file path for a cached audio stream by itag.
 * Supports both .m4a (AAC) and .webm (Opus) extensions.
 */
export function buildAudioStreamPath(videosPath: string, videoId: string, itag: number, extension?: string): string {
  // If extension is provided, use it; otherwise default to .m4a
  const ext = extension || "m4a";
  return `${videosPath}/${videoId}_audio_${itag}.${ext}`;
}

/**
 * Build the file path for a cached thumbnail.
 */
export function buildThumbnailPath(videosPath: string, videoId: string): string {
  return `${videosPath}/${videoId}.webp`;
}

/**
 * Build the file path for video metadata.
 */
export function buildMetadataPath(videosPath: string, videoId: string): string {
  return `${videosPath}/${videoId}.json`;
}

// ============================================================================
// Video Handler Factory
// ============================================================================

/**
 * Create a video handler with the given configuration.
 */
export function createVideoHandler(
  config: VideoHandlerConfig,
  fs: VideoFileSystem = defaultVideoFileSystem,
) {
  const { videosPath } = config;

  /**
   * Check if a video is cached locally.
   */
  async function isCached(videoId: string): Promise<boolean> {
    const videoPath = buildVideoPath(videosPath, videoId);
    return await fs.exists(videoPath);
  }

  /**
   * Check if a video has cached streams available for playback.
   * Returns true if either:
   * - Muxed MP4 file exists, OR
   * - Both video AND audio DASH streams exist
   */
  async function hasCachedStreams(videoId: string): Promise<boolean> {
    // Check muxed file first (fast path)
    if (await isCached(videoId)) return true;
    
    // Check for DASH streams
    const streams = await getCachedStreams(videoId);
    return streams.videoItags.length > 0 && streams.audioItags.length > 0;
  }

  /**
   * Serve a cached video file.
   */
  async function serveVideo(
    videoId: string,
    rangeHeader: string | null,
  ): Promise<VideoServeResult> {
    const videoPath = buildVideoPath(videosPath, videoId);

    // Check if file exists
    if (!(await fs.exists(videoPath))) {
      return {
        ok: false,
        error: { type: "not_found", message: `Video ${videoId} not found in cache` },
      };
    }

    try {
      const stat = await fs.stat(videoPath);
      const fileSize = stat.size;
      const mimeType = getMimeType(videoPath);

      // Common headers
      const headers = new Headers({
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000", // 1 year
      });

      if (stat.mtime) {
        headers.set("Last-Modified", stat.mtime.toUTCString());
      }

      // Handle range request
      const range = parseRangeHeader(rangeHeader, fileSize);

      if (range) {
        const { start, end } = range;
        const contentLength = end - start + 1;

        headers.set("Content-Length", contentLength.toString());
        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

        // Open file and seek to start position
        const file = await fs.open(videoPath);

        // Create a readable stream from the file with range
        const stream = createRangeStream(file, start, contentLength);

        return {
          ok: true,
          response: new Response(stream, {
            status: 206, // Partial Content
            headers,
          }),
        };
      }

      // Full file request
      headers.set("Content-Length", fileSize.toString());

      const file = await fs.open(videoPath);
      const stream = file.readable;

      return {
        ok: true,
        response: new Response(stream, {
          status: 200,
          headers,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "filesystem_error",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        },
      };
    }
  }

  /**
   * Serve a cached thumbnail.
   */
  async function serveThumbnail(videoId: string): Promise<VideoServeResult> {
    const thumbnailPath = buildThumbnailPath(videosPath, videoId);

    if (!(await fs.exists(thumbnailPath))) {
      return {
        ok: false,
        error: { type: "not_found", message: `Thumbnail for ${videoId} not found` },
      };
    }

    try {
      const stat = await fs.stat(thumbnailPath);
      const mimeType = getMimeType(thumbnailPath);

      const headers = new Headers({
        "Content-Type": mimeType,
        "Content-Length": stat.size.toString(),
        "Cache-Control": "public, max-age=31536000",
      });

      if (stat.mtime) {
        headers.set("Last-Modified", stat.mtime.toUTCString());
      }

      const file = await fs.open(thumbnailPath);

      return {
        ok: true,
        response: new Response(file.readable, {
          status: 200,
          headers,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "filesystem_error",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        },
      };
    }
  }

  /**
   * Get video metadata if available.
   */
  async function getMetadata(videoId: string): Promise<Record<string, unknown> | null> {
    const metadataPath = buildMetadataPath(videosPath, videoId);

    if (!(await fs.exists(metadataPath))) {
      return null;
    }

    try {
      const file = await fs.open(metadataPath);
      const reader = file.readable.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const data = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      const text = new TextDecoder().decode(data);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Check if a video stream by itag is cached.
   */
  async function hasVideoStream(videoId: string, itag: number): Promise<boolean> {
    const streamPath = buildVideoStreamPath(videosPath, videoId, itag);
    return await fs.exists(streamPath);
  }

  /**
   * Check if an audio stream by itag is cached.
   * Checks both .m4a and .webm extensions.
   */
  async function hasAudioStream(videoId: string, itag: number): Promise<boolean> {
    // Try .m4a first (AAC)
    const m4aPath = buildAudioStreamPath(videosPath, videoId, itag, "m4a");
    if (await fs.exists(m4aPath)) return true;
    
    // Try .webm (Opus)
    const webmPath = buildAudioStreamPath(videosPath, videoId, itag, "webm");
    return await fs.exists(webmPath);
  }

  /**
   * Serve a cached video stream by itag.
   * 
   * For DASH streaming, this expands small range requests to at least 64MB
   * to reduce HTTP request overhead and eliminate micro-stutters.
   */
  async function serveVideoStream(
    videoId: string,
    itag: number,
    rangeHeader: string | null,
  ): Promise<VideoServeResult> {
    const streamPath = buildVideoStreamPath(videosPath, videoId, itag);

    if (!(await fs.exists(streamPath))) {
      return {
        ok: false,
        error: { type: "not_found", message: `Video stream ${videoId} itag ${itag} not found in cache` },
      };
    }

    try {
      const stat = await fs.stat(streamPath);
      const fileSize = stat.size;
      const mimeType = "video/mp4";

      const headers = new Headers({
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
        "X-Cache": "HIT",
        "X-Cache-Source": "local-dash-video",
      });

      if (stat.mtime) {
        headers.set("Last-Modified", stat.mtime.toUTCString());
      }

      const range = parseRangeHeader(rangeHeader, fileSize);

      if (range) {
        // Expand small range requests to reduce HTTP overhead
        const expanded = expandRangeForStreaming(range.start, range.end, fileSize);
        const { start, end, wasExpanded } = expanded;
        const contentLength = end - start + 1;

        if (wasExpanded) {
          console.log(`[video-stream] Expanded range for ${videoId} itag ${itag}: ${range.start}-${range.end} -> ${start}-${end} (${Math.round(contentLength / 1024 / 1024)}MB)`);
        }

        headers.set("Content-Length", contentLength.toString());
        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

        const file = await fs.open(streamPath);
        const stream = createRangeStream(file, start, contentLength);

        return {
          ok: true,
          response: new Response(stream, { status: 206, headers }),
        };
      }

      headers.set("Content-Length", fileSize.toString());
      const file = await fs.open(streamPath);

      return {
        ok: true,
        response: new Response(file.readable, { status: 200, headers }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "filesystem_error",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        },
      };
    }
  }

  /**
   * Serve a cached audio stream by itag.
   * Automatically detects the actual file extension (.m4a or .webm).
   * 
   * For DASH streaming, this expands small range requests to at least 64MB
   * to reduce HTTP request overhead and eliminate micro-stutters.
   */
  async function serveAudioStream(
    videoId: string,
    itag: number,
    rangeHeader: string | null,
  ): Promise<VideoServeResult> {
    // Try to find the audio file with either extension
    let streamPath = buildAudioStreamPath(videosPath, videoId, itag, "m4a");
    let mimeType = "audio/mp4";
    
    if (!(await fs.exists(streamPath))) {
      // Try .webm
      streamPath = buildAudioStreamPath(videosPath, videoId, itag, "webm");
      mimeType = "audio/webm";
      
      if (!(await fs.exists(streamPath))) {
        return {
          ok: false,
          error: { type: "not_found", message: `Audio stream ${videoId} itag ${itag} not found in cache` },
        };
      }
    }

    try {
      const stat = await fs.stat(streamPath);
      const fileSize = stat.size;

      const headers = new Headers({
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
        "X-Cache": "HIT",
        "X-Cache-Source": "local-dash-audio",
      });

      if (stat.mtime) {
        headers.set("Last-Modified", stat.mtime.toUTCString());
      }

      const range = parseRangeHeader(rangeHeader, fileSize);

      if (range) {
        // Expand small range requests to reduce HTTP overhead
        const expanded = expandRangeForStreaming(range.start, range.end, fileSize);
        const { start, end, wasExpanded } = expanded;
        const contentLength = end - start + 1;

        if (wasExpanded) {
          console.log(`[audio-stream] Expanded range for ${videoId} itag ${itag}: ${range.start}-${range.end} -> ${start}-${end} (${Math.round(contentLength / 1024 / 1024)}MB)`);
        }

        headers.set("Content-Length", contentLength.toString());
        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

        const file = await fs.open(streamPath);
        const stream = createRangeStream(file, start, contentLength);

        return {
          ok: true,
          response: new Response(stream, { status: 206, headers }),
        };
      }

      headers.set("Content-Length", fileSize.toString());
      const file = await fs.open(streamPath);

      return {
        ok: true,
        response: new Response(file.readable, { status: 200, headers }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "filesystem_error",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        },
      };
    }
  }

  /**
   * Find all cached streams for a video.
   * Returns itags of available video and audio streams with their extensions.
   */
  async function getCachedStreams(videoId: string): Promise<{ 
    videoItags: number[]; 
    audioItags: number[];
    /** Map of audio itag -> extension (e.g., "m4a" or "webm") */
    audioExtensions: Record<number, string>;
  }> {
    const videoItags: number[] = [];
    const audioItags: number[] = [];
    const audioExtensions: Record<number, string> = {};

    try {
      // List all files in videos directory
      for await (const entry of Deno.readDir(videosPath)) {
        if (!entry.isFile) continue;

        // Check for video streams: {videoId}_video_{itag}.mp4
        const videoMatch = entry.name.match(new RegExp(`^${videoId}_video_(\\d+)\\.mp4$`));
        if (videoMatch) {
          videoItags.push(parseInt(videoMatch[1], 10));
        }

        // Check for audio streams: {videoId}_audio_{itag}.m4a or .webm
        const audioMatch = entry.name.match(new RegExp(`^${videoId}_audio_(\\d+)\\.(m4a|webm)$`));
        if (audioMatch) {
          const itag = parseInt(audioMatch[1], 10);
          const ext = audioMatch[2];
          audioItags.push(itag);
          audioExtensions[itag] = ext;
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return { videoItags, audioItags, audioExtensions };
  }

  return {
    isCached,
    hasCachedStreams,
    serveVideo,
    serveThumbnail,
    getMetadata,
    hasVideoStream,
    hasAudioStream,
    serveVideoStream,
    serveAudioStream,
    getCachedStreams,
    videosPath,
  };
}

/**
 * Type for the video handler instance.
 */
export type VideoHandler = ReturnType<typeof createVideoHandler>;

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum chunk size for DASH streaming responses.
 * When a player requests a small segment, we expand the response to at least
 * this size to reduce HTTP request overhead and eliminate micro-stutters.
 * 
 * 64MB chosen based on YouTube's behavior (~60-70MB per request).
 */
const DASH_MIN_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

// ============================================================================
// Helpers
// ============================================================================

/**
 * Expand a range request to serve larger chunks for smoother streaming.
 * 
 * DISABLED: Chunk expansion causes issues with VHS player's parallel requests.
 * The player makes multiple parallel segment requests, and expanding them
 * causes overlapping responses that break playback.
 * 
 * TODO: Investigate alternative approaches:
 * - Removing sidx/indexRange from manifest (but then seeking breaks)
 * - Server-side segment coalescing with request tracking
 * - Different DASH profile that doesn't use segment index
 * 
 * @param start - Requested start byte
 * @param end - Requested end byte
 * @param fileSize - Total file size
 * @param minChunkSize - Minimum response size (unused - expansion disabled)
 * @returns Original range unchanged
 */
function expandRangeForStreaming(
  start: number,
  end: number,
  _fileSize: number,
  _minChunkSize: number = DASH_MIN_CHUNK_SIZE,
): { start: number; end: number; wasExpanded: boolean } {
  // Expansion disabled - return original range
  return { start, end, wasExpanded: false };
}

/**
 * Create a readable stream for a range of a file.
 * Uses larger chunks and simpler logic for better performance.
 */
function createRangeStream(
  file: Deno.FsFile,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  let bytesRemaining = length;
  // Use 1MB chunks for high bitrate video streaming
  const CHUNK_SIZE = 1024 * 1024;

  // Seek to start position synchronously before creating stream
  file.seekSync(start, Deno.SeekMode.Start);

  return new ReadableStream({
    async pull(controller) {
      if (bytesRemaining <= 0) {
        controller.close();
        file.close();
        return;
      }

      const toRead = Math.min(CHUNK_SIZE, bytesRemaining);
      const buffer = new Uint8Array(toRead);

      const n = await file.read(buffer);
      if (n === null || n === 0) {
        controller.close();
        file.close();
        return;
      }

      bytesRemaining -= n;
      controller.enqueue(n === toRead ? buffer : buffer.subarray(0, n));
    },

    cancel() {
      file.close();
    },
  });
}
