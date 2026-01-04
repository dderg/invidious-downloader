/**
 * Download Manager for downloading videos from Companion API.
 *
 * Handles:
 * - Streaming video/audio from URLs
 * - Muxing into MP4 with ffmpeg
 * - Queue processing with concurrency control
 * - Progress tracking and error handling
 */

import type { VideoInfo, SelectedStreams } from "./companion-types.ts";
import type { Muxer } from "./muxer.ts";
import type { LocalDbClient } from "../db/local-db.ts";
import type { DownloadMetadata } from "../db/types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Download progress event.
 */
export interface DownloadProgress {
  videoId: string;
  phase: "downloading" | "muxing" | "finalizing" | "complete" | "failed";
  // Video stream progress
  videoBytesDownloaded: number;
  videoTotalBytes: number | null;
  videoPercentage: number | null;
  videoSpeed: number | null; // bytes per second
  // Audio stream progress (null if combined stream or no audio)
  audioBytesDownloaded: number | null;
  audioTotalBytes: number | null;
  audioPercentage: number | null;
  audioSpeed: number | null; // bytes per second
  error?: string;
}

/**
 * Download options.
 */
export interface DownloadOptions {
  /** Video information from Companion API */
  videoInfo: VideoInfo;
  /** Selected streams (video + audio) */
  streams: SelectedStreams;
  /** Output directory for the downloaded file */
  outputDir: string;
  /** Optional: rate limit in bytes per second (0 = unlimited) */
  rateLimit?: number;
  /** Optional: progress callback */
  onProgress?: (progress: DownloadProgress) => void;
  /** Optional: attempt to resume from existing partial files */
  resume?: boolean;
  /** Optional: throttle detection config (only applied to video stream) */
  throttleConfig?: {
    /** Minimum speed in bytes/sec before considering throttled */
    speedThreshold: number;
    /** Seconds to measure rolling average */
    detectionWindow: number;
  };
}

/**
 * Download result.
 */
export type DownloadResult =
  | { ok: true; filePath: string; fileSize: number; duration: number; videoItag?: number; audioItag?: number; videoWidth?: number; videoHeight?: number; videoMimeType?: string; audioMimeType?: string; videoBitrate?: number; audioBitrate?: number; videoContentLength?: number; audioContentLength?: number; audioExtension?: string }
  | { ok: false; error: DownloadError };

export interface DownloadError {
  type: "no_streams" | "download_failed" | "mux_failed" | "filesystem_error" | "cancelled";
  message: string;
  cause?: unknown;
}

/**
 * Download manager configuration.
 */
export interface DownloadManagerConfig {
  /** Directory to store downloaded videos */
  videosPath: string;
  /** Maximum concurrent downloads */
  maxConcurrent: number;
  /** Rate limit in bytes per second (0 = unlimited) */
  rateLimit: number;
  /** Temporary directory for partial downloads */
  tempDir?: string;
}

/**
 * Active download tracking.
 */
interface ActiveDownload {
  videoId: string;
  abortController: AbortController;
  promise: Promise<DownloadResult>;
}

/**
 * Progress info for active downloads (exposed via API).
 */
export interface ActiveDownloadProgress {
  videoId: string;
  title: string;
  phase: "downloading" | "muxing" | "finalizing" | "queued";
  // Video stream progress
  videoBytesDownloaded: number;
  videoTotalBytes: number | null;
  videoPercentage: number | null;
  videoSpeed: number | null; // bytes per second
  // Audio stream progress (null if combined stream or no audio)
  audioBytesDownloaded: number | null;
  audioTotalBytes: number | null;
  audioPercentage: number | null;
  audioSpeed: number | null; // bytes per second
  startedAt: number;
}

// ============================================================================
// File System Interface
// ============================================================================

/**
 * File system interface for dependency injection.
 */
export interface FileSystem {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number }>;
}

/**
 * Default file system using Deno APIs.
 */
export const defaultFileSystem: FileSystem = {
  writeFile: (path, data) => Deno.writeFile(path, data),
  readFile: (path) => Deno.readFile(path),
  remove: (path) => Deno.remove(path),
  mkdir: (path, options) => Deno.mkdir(path, options),
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
    return { size: info.size };
  },
};

// ============================================================================
// HTTP Downloader Interface
// ============================================================================

/**
 * Result of a download operation.
 */
export interface HttpDownloadResult {
  ok: true;
  /** Total bytes written to file */
  size: number;
  /** Whether the download was resumed from an existing partial file */
  resumed: boolean;
  /** Bytes that were already downloaded before this operation (if resumed) */
  resumedFromByte: number;
}

export interface HttpDownloadError {
  ok: false;
  error: string;
  /** If true, the error is likely due to expired URL - should get fresh URL and retry */
  urlExpired?: boolean;
  /** If true, should delete partial file and start fresh */
  startFresh?: boolean;
  /** If true, download was aborted due to throttling detection */
  throttled?: boolean;
}

/**
 * HTTP downloader interface for dependency injection.
 */
export interface HttpDownloader {
  downloadToFile(
    url: string,
    outputPath: string,
    options?: {
      signal?: AbortSignal;
      rateLimit?: number;
      /** If true, attempt to resume from existing partial file */
      resume?: boolean;
      onProgress?: (downloaded: number, total: number | null) => void;
      /** Throttle detection config (if not provided, throttle detection is disabled) */
      throttleConfig?: {
        /** Minimum speed in bytes/sec before considering throttled */
        speedThreshold: number;
        /** Seconds to measure rolling average */
        detectionWindow: number;
      };
    },
  ): Promise<HttpDownloadResult | HttpDownloadError>;
}

// ============================================================================
// Speed Tracker for Throttle Detection
// ============================================================================

/**
 * Tracks download speed using a rolling window of samples.
 * Used to detect YouTube throttling.
 */
class SpeedTracker {
  private samples: { time: number; bytes: number }[] = [];
  private readonly windowMs: number;
  private readonly threshold: number;

  constructor(windowSeconds: number, thresholdBytesPerSec: number) {
    this.windowMs = windowSeconds * 1000;
    this.threshold = thresholdBytesPerSec;
  }

  /**
   * Add a sample with the current cumulative bytes downloaded.
   */
  addSample(totalBytes: number): void {
    const now = Date.now();
    this.samples.push({ time: now, bytes: totalBytes });
    
    // Prune samples outside the window
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter(s => s.time >= cutoff);
  }

  /**
   * Check if download is throttled based on rolling average speed.
   * Only returns true if we have enough data (at least 90% of the window).
   */
  isThrottled(): boolean {
    if (this.samples.length < 2) return false;
    
    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const elapsedMs = newest.time - oldest.time;
    
    // Only check if we have at least 90% of the detection window
    if (elapsedMs < this.windowMs * 0.9) return false;
    
    const bytesDownloaded = newest.bytes - oldest.bytes;
    const speedBytesPerSec = (bytesDownloaded / elapsedMs) * 1000;
    
    return speedBytesPerSec < this.threshold;
  }

  /**
   * Get current rolling average speed in bytes/sec.
   */
  getCurrentSpeed(): number | null {
    if (this.samples.length < 2) return null;
    
    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const elapsedMs = newest.time - oldest.time;
    
    if (elapsedMs === 0) return null;
    
    const bytesDownloaded = newest.bytes - oldest.bytes;
    return (bytesDownloaded / elapsedMs) * 1000;
  }
}

/**
 * Default HTTP downloader using fetch with streaming writes to disk.
 * Writes chunks directly to disk to avoid memory pressure from large files.
 * Supports resuming interrupted downloads using HTTP Range requests.
 */
export const defaultHttpDownloader: HttpDownloader = {
  async downloadToFile(url, outputPath, options) {
    let file: Deno.FsFile | null = null;
    let startByte = 0;
    let resumed = false;

    try {
      // Check for existing partial file if resume is requested
      if (options?.resume) {
        try {
          const stat = await Deno.stat(outputPath);
          startByte = stat.size;
          if (startByte > 0) {
            console.log(`[download] Found partial file: ${outputPath} (${startByte} bytes), attempting resume`);
          }
        } catch {
          // File doesn't exist, start from beginning
          startByte = 0;
        }
      }

      // Build request headers
      const headers: Record<string, string> = {};
      if (startByte > 0) {
        headers["Range"] = `bytes=${startByte}-`;
      }

      const response = await fetch(url, { 
        signal: options?.signal,
        headers,
      });

      // Handle different response codes
      if (response.status === 416) {
        // Range Not Satisfiable - file is likely complete or server doesn't support range
        // Check if file already exists and return success
        if (startByte > 0) {
          console.log(`[download] Got 416, file appears complete at ${startByte} bytes`);
          return { ok: true, size: startByte, resumed: true, resumedFromByte: startByte };
        }
        return { ok: false, error: "Range not satisfiable and no partial file exists", startFresh: true };
      }

      if (response.status === 403) {
        // Forbidden - likely expired URL
        return { ok: false, error: `HTTP 403: ${response.statusText}`, urlExpired: true };
      }

      if (!response.ok && response.status !== 206) {
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      // Check if server honored our Range request
      if (startByte > 0 && response.status === 200) {
        // Server ignored Range header, sent full content - must start over
        console.log(`[download] Server ignored Range header, starting fresh`);
        startByte = 0;
        resumed = false;
      } else if (response.status === 206) {
        // Partial content - resuming successfully
        resumed = true;
        console.log(`[download] Resuming from byte ${startByte}`);
      }

      const contentLength = response.headers.get("content-length");
      const contentRange = response.headers.get("content-range");
      
      // Calculate total size
      let total: number | null = null;
      if (contentRange) {
        // Format: "bytes 21010-47021/47022" or "bytes 21010-47021/*"
        const match = contentRange.match(/bytes \d+-\d+\/(\d+|\*)/);
        if (match && match[1] !== "*") {
          total = parseInt(match[1], 10);
        }
      } else if (contentLength) {
        total = startByte + parseInt(contentLength, 10);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: false, error: "No response body" };
      }

      // Open file - append if resuming, truncate if starting fresh
      if (startByte > 0 && resumed) {
        file = await Deno.open(outputPath, { write: true, append: true });
      } else {
        file = await Deno.open(outputPath, { write: true, create: true, truncate: true });
        startByte = 0;
      }

      let downloaded = startByte; // Start counting from resumed position
      let lastProgressTime = Date.now();
      let lastDownloaded = downloaded;

      // Rate limiting state
      const rateLimit = options?.rateLimit ?? 0;
      let rateLimitBucket = rateLimit;
      let lastRateLimitTime = Date.now();

      // Throttle detection state
      const speedTracker = options?.throttleConfig 
        ? new SpeedTracker(options.throttleConfig.detectionWindow, options.throttleConfig.speedThreshold)
        : null;
      let lastThrottleCheckTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Write chunk directly to disk (no memory accumulation)
        await file.write(value);
        downloaded += value.length;

        // Rate limiting
        if (rateLimit > 0) {
          const now = Date.now();
          const elapsed = (now - lastRateLimitTime) / 1000;
          rateLimitBucket = Math.min(rateLimit, rateLimitBucket + rateLimit * elapsed);
          lastRateLimitTime = now;

          // Rate limit based on bytes downloaded in this session (not including resumed bytes)
          const sessionDownloaded = downloaded - startByte;
          if (sessionDownloaded > rateLimitBucket) {
            const delay = (sessionDownloaded - rateLimitBucket) / rateLimit * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            rateLimitBucket = sessionDownloaded;
          }
        }

        // Throttle detection (check every second to avoid overhead)
        const now = Date.now();
        if (speedTracker && now - lastThrottleCheckTime >= 1000) {
          speedTracker.addSample(downloaded);
          lastThrottleCheckTime = now;
          
          if (speedTracker.isThrottled()) {
            const speed = speedTracker.getCurrentSpeed();
            const speedKBs = speed ? Math.round(speed / 1024) : 0;
            console.log(`[download] Throttling detected: ${speedKBs} KB/s < ${Math.round(options!.throttleConfig!.speedThreshold / 1024)} KB/s threshold`);
            // Close file before returning
            file.close();
            file = null;
            return { ok: false, error: `Throttling detected (${speedKBs} KB/s)`, throttled: true };
          }
        }

        // Progress callback (throttled to every 100ms)
        if (options?.onProgress && now - lastProgressTime > 100) {
          options.onProgress(downloaded, total);
          lastDownloaded = downloaded;
          lastProgressTime = now;
        }
      }

      // Final progress
      if (options?.onProgress && downloaded !== lastDownloaded) {
        options.onProgress(downloaded, total);
      }

      return { ok: true, size: downloaded, resumed, resumedFromByte: startByte };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, error: "Download cancelled" };
      }
      return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
    } finally {
      // Always close the file handle
      if (file) {
        try {
          file.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  },
};

/**
 * Result type for downloadAudioSynced.
 */
interface AudioDownloadResult {
  ok: true;
  size: number;
  resumed: boolean;
  resumedFromByte: number;
}

interface AudioDownloadError {
  ok: false;
  error: string;
  urlExpired?: boolean;
  startFresh?: boolean;
}

/**
 * Download audio synced to video progress.
 * Throttles audio download to stay at or slightly behind video percentage.
 * This ensures both streams finish around the same time.
 * Supports resuming interrupted downloads using HTTP Range requests.
 */
async function downloadAudioSynced(
  url: string,
  outputPath: string,
  audioTotalBytes: number | null,
  options: {
    signal?: AbortSignal;
    getVideoPercentage: () => number; // Returns current video download percentage (0-1)
    /** If true, attempt to resume from existing partial file */
    resume?: boolean;
    /** If resuming, the video's resumed percentage (0-1) - audio can catch up faster */
    videoResumedPercentage?: number;
    onProgress?: (downloaded: number, total: number | null) => void;
  },
): Promise<AudioDownloadResult | AudioDownloadError> {
  let file: Deno.FsFile | null = null;
  const LEAD_BUFFER = 0.02; // Allow audio to lead by up to 2%
  let startByte = 0;
  let resumed = false;

  try {
    // Check for existing partial file if resume is requested
    if (options.resume) {
      try {
        const stat = await Deno.stat(outputPath);
        startByte = stat.size;
        if (startByte > 0) {
          console.log(`[download] Found partial audio file: ${outputPath} (${startByte} bytes), attempting resume`);
        }
      } catch {
        // File doesn't exist, start from beginning
        startByte = 0;
      }
    }

    // Build request headers
    const headers: Record<string, string> = {};
    if (startByte > 0) {
      headers["Range"] = `bytes=${startByte}-`;
    }

    const response = await fetch(url, { signal: options.signal, headers });

    // Handle different response codes
    if (response.status === 416) {
      // Range Not Satisfiable - file is likely complete
      if (startByte > 0) {
        console.log(`[download] Got 416 for audio, file appears complete at ${startByte} bytes`);
        return { ok: true, size: startByte, resumed: true, resumedFromByte: startByte };
      }
      return { ok: false, error: "Range not satisfiable and no partial file exists", startFresh: true };
    }

    if (response.status === 403) {
      // Forbidden - likely expired URL
      return { ok: false, error: `HTTP 403: ${response.statusText}`, urlExpired: true };
    }

    if (!response.ok && response.status !== 206) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    // Check if server honored our Range request
    if (startByte > 0 && response.status === 200) {
      // Server ignored Range header, sent full content - must start over
      console.log(`[download] Server ignored Range header for audio, starting fresh`);
      startByte = 0;
      resumed = false;
    } else if (response.status === 206) {
      // Partial content - resuming successfully
      resumed = true;
      console.log(`[download] Resuming audio from byte ${startByte}`);
    }

    // Calculate total size
    const contentLength = response.headers.get("content-length");
    const contentRange = response.headers.get("content-range");
    
    let total: number | null = null;
    if (contentRange) {
      // Format: "bytes 21010-47021/47022" or "bytes 21010-47021/*"
      const match = contentRange.match(/bytes \d+-\d+\/(\d+|\*)/);
      if (match && match[1] !== "*") {
        total = parseInt(match[1], 10);
      }
    } else if (contentLength) {
      total = startByte + parseInt(contentLength, 10);
    } else {
      total = audioTotalBytes;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, error: "No response body" };
    }

    // Open file - append if resuming, truncate if starting fresh
    if (startByte > 0 && resumed) {
      file = await Deno.open(outputPath, { write: true, append: true });
    } else {
      file = await Deno.open(outputPath, { write: true, create: true, truncate: true });
      startByte = 0;
    }

    let downloaded = startByte; // Start counting from resumed position
    let lastProgressTime = Date.now();

    // Calculate audio's resumed percentage (for throttling logic)
    const audioResumedPercentage = total && startByte > 0 ? startByte / total : 0;
    const videoResumedPercentage = options.videoResumedPercentage ?? 0;

    while (true) {
      // Check if we need to throttle (audio ahead of video)
      // But if audio was resumed ahead of video, let it run at full speed until video catches up
      if (total && total > 0) {
        const audioPercentage = downloaded / total;
        let videoPercentage = options.getVideoPercentage();

        // Only throttle if audio would get ahead of where it started OR ahead of video + buffer
        // This allows audio to catch up if it was behind after resume
        const shouldThrottle = audioPercentage > audioResumedPercentage && 
                               audioPercentage > videoPercentage + LEAD_BUFFER;

        while (shouldThrottle && videoPercentage < 1) {
          if (options.signal?.aborted) {
            return { ok: false, error: "Download cancelled" };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          videoPercentage = options.getVideoPercentage();
          // Re-check throttle condition
          if (!(audioPercentage > videoPercentage + LEAD_BUFFER)) break;
        }
      }

      if (options.signal?.aborted) {
        return { ok: false, error: "Download cancelled" };
      }

      const { done, value } = await reader.read();
      if (done) break;

      await file.write(value);
      downloaded += value.length;

      // Progress callback (throttled to every 100ms)
      const now = Date.now();
      if (options.onProgress && now - lastProgressTime > 100) {
        options.onProgress(downloaded, total);
        lastProgressTime = now;
      }
    }

    // Final progress
    if (options.onProgress) {
      options.onProgress(downloaded, total);
    }

    return { ok: true, size: downloaded, resumed, resumedFromByte: startByte };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Download cancelled" };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    if (file) {
      try {
        file.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ============================================================================
// Path Utilities (pure functions)
// ============================================================================

/**
 * Sanitize filename by removing/replacing invalid characters.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200); // Limit length
}

/**
 * Determine audio file extension from mimeType.
 * WebM/Opus stays as .webm, MP4/AAC stays as .m4a
 */
export function getAudioExtension(mimeType?: string): string {
  if (!mimeType) return "m4a"; // Default to m4a
  
  // Check container type from mimeType (e.g., "audio/webm; codecs=\"opus\"")
  if (mimeType.startsWith("audio/webm")) {
    return "webm";
  }
  // audio/mp4, audio/m4a, etc. -> m4a
  return "m4a";
}

/**
 * Generate output paths for a video download.
 * Includes itag-based paths for DASH streaming support.
 */
export function generatePaths(
  videoId: string,
  title: string,
  outputDir: string,
  tempDir?: string,
  videoItag?: number,
  audioItag?: number,
  audioMimeType?: string,
): {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  thumbnailPath: string;
  metadataPath: string;
  // Itag-based paths for DASH streaming
  videoItagPath: string | null;
  audioItagPath: string | null;
  audioExtension: string;
} {
  const safeName = sanitizeFilename(title);
  const temp = tempDir ?? outputDir;
  const audioExt = getAudioExtension(audioMimeType);

  return {
    videoPath: `${temp}/${videoId}_video.tmp`,
    audioPath: `${temp}/${videoId}_audio.tmp`,
    outputPath: `${outputDir}/${videoId}.mp4`,
    thumbnailPath: `${outputDir}/${videoId}.webp`,
    metadataPath: `${outputDir}/${videoId}.json`,
    // Store separate streams with itag for DASH support
    // Audio extension depends on codec (webm for Opus, m4a for AAC)
    videoItagPath: videoItag ? `${outputDir}/${videoId}_video_${videoItag}.mp4` : null,
    audioItagPath: audioItag ? `${outputDir}/${videoId}_audio_${audioItag}.${audioExt}` : null,
    audioExtension: audioExt,
  };
}

// ============================================================================
// Download Manager
// ============================================================================

/**
 * Create a download manager instance.
 */
export function createDownloadManager(
  config: DownloadManagerConfig,
  muxer: Muxer,
  db?: LocalDbClient,
  fs: FileSystem = defaultFileSystem,
  downloader: HttpDownloader = defaultHttpDownloader,
) {
  const activeDownloads = new Map<string, ActiveDownload>();
  const activeProgress = new Map<string, ActiveDownloadProgress>();
  let isProcessingQueue = false;
  let shouldStopQueue = false;

  /**
   * Download a single video.
   */
  async function downloadVideo(options: DownloadOptions): Promise<DownloadResult> {
    const { videoInfo, streams, outputDir, rateLimit = config.rateLimit, resume = false, throttleConfig } = options;
    const onProgress = options.onProgress ?? (() => {});

    // Check we have streams to download
    if (!streams.video && !streams.audio && !streams.combined) {
      return {
        ok: false,
        error: { type: "no_streams", message: "No streams available for download" },
      };
    }

    // Get itags for separate stream storage
    const videoItag = streams.video?.itag;
    const audioItag = streams.audio?.itag;
    const audioMimeType = streams.audio?.mimeType;

    // Generate paths (including itag-based paths for DASH support)
    const paths = generatePaths(
      videoInfo.videoId,
      videoInfo.title,
      outputDir,
      config.tempDir,
      videoItag,
      audioItag,
      audioMimeType,
    );

    // Ensure output directory exists
    try {
      await fs.mkdir(outputDir, { recursive: true });
      if (config.tempDir) {
        await fs.mkdir(config.tempDir, { recursive: true });
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "filesystem_error",
          message: `Failed to create directories: ${error instanceof Error ? error.message : "Unknown error"}`,
          cause: error,
        },
      };
    }

    // Create abort controller for this download
    const abortController = new AbortController();

    try {
      let finalSize = 0;

      // Strategy: prefer separate video + audio (better quality), fall back to combined
      if (streams.video && streams.audio) {
        // Shared progress state for parallel downloads
        let videoDownloaded = 0;
        let videoTotal: number | null = streams.video.contentLength
          ? parseInt(streams.video.contentLength, 10)
          : null;
        let audioDownloaded = 0;
        let audioTotal: number | null = streams.audio.contentLength
          ? parseInt(streams.audio.contentLength, 10)
          : null;

        // Speed tracking
        const startTime = Date.now();
        let lastVideoDownloaded = 0;
        let lastAudioDownloaded = 0;
        let lastSpeedTime = startTime;
        let videoSpeed: number | null = null;
        let audioSpeed: number | null = null;

        // Get current video download percentage (0-1)
        const getVideoPercentage = () => (videoTotal ? videoDownloaded / videoTotal : 0);

        // Report combined progress for both streams
        const reportProgress = () => {
          // Calculate speeds (bytes per second over last interval)
          const now = Date.now();
          const elapsed = (now - lastSpeedTime) / 1000;
          if (elapsed >= 0.5) {
            // Update speed every 500ms
            videoSpeed = (videoDownloaded - lastVideoDownloaded) / elapsed;
            audioSpeed = (audioDownloaded - lastAudioDownloaded) / elapsed;
            lastVideoDownloaded = videoDownloaded;
            lastAudioDownloaded = audioDownloaded;
            lastSpeedTime = now;
          }

          onProgress({
            videoId: videoInfo.videoId,
            phase: "downloading",
            videoBytesDownloaded: videoDownloaded,
            videoTotalBytes: videoTotal,
            videoPercentage: videoTotal ? Math.round((videoDownloaded / videoTotal) * 100) : null,
            videoSpeed,
            audioBytesDownloaded: audioDownloaded,
            audioTotalBytes: audioTotal,
            audioPercentage: audioTotal ? Math.round((audioDownloaded / audioTotal) * 100) : null,
            audioSpeed,
          });
        };

        // Initial progress
        reportProgress();

        // Download both streams in parallel
        const [videoResult, audioResult] = await Promise.all([
          // Video: uses configured rate limit, with resume support and throttle detection
          downloader.downloadToFile(streams.video.url, paths.videoPath, {
            signal: abortController.signal,
            rateLimit,
            resume,
            throttleConfig, // Only video stream gets throttle detection (audio is synced)
            onProgress: (downloaded, total) => {
              videoDownloaded = downloaded;
              if (total) videoTotal = total;
              reportProgress();
            },
          }),
          // Audio: synced to video progress (stays slightly behind or equal), with resume support
          downloadAudioSynced(streams.audio.url, paths.audioPath, audioTotal, {
            signal: abortController.signal,
            getVideoPercentage,
            resume,
            onProgress: (downloaded, total) => {
              audioDownloaded = downloaded;
              if (total) audioTotal = total;
              reportProgress();
            },
          }),
        ]);

        // Handle errors - check for special error types
        if (!videoResult.ok || !audioResult.ok) {
          // Check for URL expired errors - don't clean up tmp files, signal to retry with fresh URLs
          const videoError = !videoResult.ok ? videoResult as HttpDownloadError : null;
          const audioError = !audioResult.ok ? audioResult as AudioDownloadError : null;
          
          // Check for throttling first (video stream only)
          if (videoError?.throttled) {
            // Don't delete tmp files - they can be resumed with fresh URLs
            return {
              ok: false,
              error: { 
                type: "download_failed", 
                message: videoError.error,
                cause: { throttled: true },
              },
            };
          }
          
          if (videoError?.urlExpired || audioError?.urlExpired) {
            // Don't delete tmp files - they can be resumed with fresh URLs
            return {
              ok: false,
              error: { 
                type: "download_failed", 
                message: "Stream URL expired - retry with fresh URLs",
                cause: { urlExpired: true },
              },
            };
          }
          
          if (videoError?.startFresh || audioError?.startFresh) {
            // Server doesn't support resume - delete tmp files and signal to retry fresh
            await fs.remove(paths.videoPath).catch(() => {});
            await fs.remove(paths.audioPath).catch(() => {});
            return {
              ok: false,
              error: { 
                type: "download_failed", 
                message: "Server doesn't support resume - retry from start",
                cause: { startFresh: true },
              },
            };
          }
          
          // Regular error - clean up and report
          await fs.remove(paths.videoPath).catch(() => {});
          await fs.remove(paths.audioPath).catch(() => {});
          const errorMsg = !videoResult.ok
            ? `Video download failed: ${videoError?.error}`
            : `Audio download failed: ${audioError?.error}`;
          return {
            ok: false,
            error: { type: "download_failed", message: errorMsg },
          };
        }

        // Log if we resumed
        if ((videoResult as HttpDownloadResult).resumed || (audioResult as AudioDownloadResult).resumed) {
          const vResumed = (videoResult as HttpDownloadResult).resumed;
          const aResumed = (audioResult as AudioDownloadResult).resumed;
          console.log(`[download] ${videoInfo.videoId}: Completed with resume (video: ${vResumed}, audio: ${aResumed})`);
        }

        // Move temp streams to itag-based paths for DASH streaming (no auto-muxing)
        // MP4 muxing is done on-demand via dashboard button
        onProgress({
          videoId: videoInfo.videoId,
          phase: "finalizing",
          videoBytesDownloaded: videoResult.size,
          videoTotalBytes: videoResult.size,
          videoPercentage: 100,
          videoSpeed: null,
          audioBytesDownloaded: audioResult.size,
          audioTotalBytes: audioResult.size,
          audioPercentage: 100,
          audioSpeed: null,
        });

        // Move temp files to itag-based paths (more efficient than copy)
        if (paths.videoItagPath) {
          try {
            await Deno.rename(paths.videoPath, paths.videoItagPath);
          } catch (e) {
            console.warn(`[download] Failed to move video stream: ${e instanceof Error ? e.message : e}`);
            // Fallback to copy if rename fails (e.g., cross-device)
            try {
              const videoData = await Deno.readFile(paths.videoPath);
              await Deno.writeFile(paths.videoItagPath, videoData);
              await fs.remove(paths.videoPath).catch(() => {});
            } catch (copyErr) {
              console.error(`[download] Failed to copy video stream: ${copyErr instanceof Error ? copyErr.message : copyErr}`);
            }
          }
        }
        if (paths.audioItagPath) {
          try {
            await Deno.rename(paths.audioPath, paths.audioItagPath);
          } catch (e) {
            console.warn(`[download] Failed to move audio stream: ${e instanceof Error ? e.message : e}`);
            // Fallback to copy if rename fails (e.g., cross-device)
            try {
              const audioData = await Deno.readFile(paths.audioPath);
              await Deno.writeFile(paths.audioItagPath, audioData);
              await fs.remove(paths.audioPath).catch(() => {});
            } catch (copyErr) {
              console.error(`[download] Failed to copy audio stream: ${copyErr instanceof Error ? copyErr.message : copyErr}`);
            }
          }
        }

        // Calculate total size from streams (no muxed file yet)
        finalSize = videoResult.size + audioResult.size;
      } else if (streams.combined) {
        // Download combined stream directly (single progress bar, no audio)
        // Speed tracking for combined stream
        let lastCombinedDownloaded = 0;
        let lastCombinedSpeedTime = Date.now();
        let combinedSpeed: number | null = null;

        onProgress({
          videoId: videoInfo.videoId,
          phase: "downloading",
          videoBytesDownloaded: 0,
          videoTotalBytes: streams.combined.contentLength
            ? parseInt(streams.combined.contentLength, 10)
            : null,
          videoPercentage: 0,
          videoSpeed: null,
          audioBytesDownloaded: null,
          audioTotalBytes: null,
          audioPercentage: null,
          audioSpeed: null,
        });

        const result = await downloader.downloadToFile(
          streams.combined.url,
          paths.outputPath,
          {
            signal: abortController.signal,
            rateLimit,
            resume,
            onProgress: (downloaded, total) => {
              // Calculate speed
              const now = Date.now();
              const elapsed = (now - lastCombinedSpeedTime) / 1000;
              if (elapsed >= 0.5) {
                combinedSpeed = (downloaded - lastCombinedDownloaded) / elapsed;
                lastCombinedDownloaded = downloaded;
                lastCombinedSpeedTime = now;
              }

              onProgress({
                videoId: videoInfo.videoId,
                phase: "downloading",
                videoBytesDownloaded: downloaded,
                videoTotalBytes: total,
                videoPercentage: total ? Math.round((downloaded / total) * 100) : null,
                videoSpeed: combinedSpeed,
                audioBytesDownloaded: null,
                audioTotalBytes: null,
                audioPercentage: null,
                audioSpeed: null,
              });
            },
          },
        );

        if (!result.ok) {
          const combinedError = result as HttpDownloadError;
          // Check for URL expired - don't clean up, can retry
          if (combinedError.urlExpired) {
            return {
              ok: false,
              error: { 
                type: "download_failed", 
                message: "Stream URL expired - retry with fresh URLs",
                cause: { urlExpired: true },
              },
            };
          }
          return {
            ok: false,
            error: { type: "download_failed", message: `Download failed: ${combinedError.error}` },
          };
        }

        finalSize = result.size;
      } else {
        return {
          ok: false,
          error: { type: "no_streams", message: "No usable streams available" },
        };
      }

      // Success!
      onProgress({
        videoId: videoInfo.videoId,
        phase: "complete",
        videoBytesDownloaded: finalSize,
        videoTotalBytes: finalSize,
        videoPercentage: 100,
        videoSpeed: null,
        audioBytesDownloaded: null,
        audioTotalBytes: null,
        audioPercentage: null,
        audioSpeed: null,
      });

      return {
        ok: true,
        filePath: paths.outputPath,
        fileSize: finalSize,
        duration: videoInfo.lengthSeconds,
        videoItag: streams.video?.itag,
        audioItag: streams.audio?.itag,
        videoWidth: streams.video?.width,
        videoHeight: streams.video?.height,
        videoMimeType: streams.video?.mimeType,
        audioMimeType: streams.audio?.mimeType,
        videoBitrate: streams.video?.bitrate,
        audioBitrate: streams.audio?.bitrate,
        videoContentLength: streams.video?.contentLength ? parseInt(streams.video.contentLength, 10) : undefined,
        audioContentLength: streams.audio?.contentLength ? parseInt(streams.audio.contentLength, 10) : undefined,
        audioExtension: paths.audioExtension,
      };
    } catch (error) {
      // Only clean up temp files if not cancelled (cancelled = user wants to keep progress)
      // and not a resumable error
      const isCancelled = error instanceof Error && error.name === "AbortError";
      if (!isCancelled && !resume) {
        // If not resuming, clean up temp files on any error
        await fs.remove(paths.videoPath).catch(() => {});
        await fs.remove(paths.audioPath).catch(() => {});
      }

      if (isCancelled) {
        return {
          ok: false,
          error: { type: "cancelled", message: "Download was cancelled" },
        };
      }

      return {
        ok: false,
        error: {
          type: "download_failed",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        },
      };
    }
  }

  /**
   * Queue a video for download.
   */
  async function queueDownload(
    videoId: string,
    userId?: string,
    priority?: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!db) {
      return { ok: false, error: "Database not configured" };
    }

    // Check if already downloaded
    const isDownloaded = await db.isDownloaded(videoId);
    if (isDownloaded.ok && isDownloaded.data) {
      return { ok: false, error: "Video already downloaded" };
    }

    // Check if already in queue
    const isInQueue = await db.isInQueue(videoId);
    if (isInQueue.ok && isInQueue.data) {
      return { ok: false, error: "Video already in queue" };
    }

    // Add to queue
    const result = db.addToQueue({ videoId, userId, priority });
    if (!result.ok) {
      return { ok: false, error: result.error.message };
    }

    return { ok: true };
  }

  /**
   * Cancel an active download.
   */
  function cancelDownload(videoId: string): boolean {
    const active = activeDownloads.get(videoId);
    if (active) {
      active.abortController.abort();
      activeDownloads.delete(videoId);
      return true;
    }
    return false;
  }

  /**
   * Get active downloads.
   */
  function getActiveDownloads(): string[] {
    return Array.from(activeDownloads.keys());
  }

  /**
   * Check if currently processing queue.
   */
  function isProcessing(): boolean {
    return isProcessingQueue;
  }

  /**
   * Stop queue processing.
   */
  function stopProcessing(): void {
    shouldStopQueue = true;
  }

  /**
   * Get current download count.
   */
  function getActiveCount(): number {
    return activeDownloads.size;
  }

  /**
   * Update progress for a download (called externally during download).
   */
  function updateProgress(
    videoId: string,
    title: string,
    phase: ActiveDownloadProgress["phase"],
    videoBytesDownloaded: number,
    videoTotalBytes: number | null,
    audioBytesDownloaded: number | null = null,
    audioTotalBytes: number | null = null,
    videoSpeed: number | null = null,
    audioSpeed: number | null = null,
  ): void {
    const existing = activeProgress.get(videoId);
    const now = Date.now();
    const startedAt = existing?.startedAt ?? now;

    activeProgress.set(videoId, {
      videoId,
      title,
      phase,
      videoBytesDownloaded,
      videoTotalBytes,
      videoPercentage: videoTotalBytes ? Math.round((videoBytesDownloaded / videoTotalBytes) * 100) : null,
      videoSpeed,
      audioBytesDownloaded,
      audioTotalBytes,
      audioPercentage:
        audioTotalBytes && audioBytesDownloaded !== null
          ? Math.round((audioBytesDownloaded / audioTotalBytes) * 100)
          : null,
      audioSpeed,
      startedAt,
    });
  }

  /**
   * Remove progress tracking for a download.
   */
  function removeProgress(videoId: string): void {
    activeProgress.delete(videoId);
  }

  /**
   * Get all active download progress.
   */
  function getProgress(): ActiveDownloadProgress[] {
    return Array.from(activeProgress.values());
  }

  return {
    downloadVideo,
    queueDownload,
    cancelDownload,
    getActiveDownloads,
    isProcessing,
    stopProcessing,
    getActiveCount,
    updateProgress,
    removeProgress,
    getProgress,
  };
}

/**
 * Type for the download manager instance.
 */
export type DownloadManager = ReturnType<typeof createDownloadManager>;
