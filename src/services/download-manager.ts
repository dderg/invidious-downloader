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
  phase: "downloading" | "muxing" | "complete" | "failed";
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
  phase: "downloading" | "muxing" | "queued";
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
 * HTTP downloader interface for dependency injection.
 */
export interface HttpDownloader {
  downloadToFile(
    url: string,
    outputPath: string,
    options?: {
      signal?: AbortSignal;
      rateLimit?: number;
      onProgress?: (downloaded: number, total: number | null) => void;
    },
  ): Promise<{ ok: true; size: number } | { ok: false; error: string }>;
}

/**
 * Default HTTP downloader using fetch with streaming writes to disk.
 * Writes chunks directly to disk to avoid memory pressure from large files.
 */
export const defaultHttpDownloader: HttpDownloader = {
  async downloadToFile(url, outputPath, options) {
    let file: Deno.FsFile | null = null;

    try {
      const response = await fetch(url, { signal: options?.signal });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const contentLength = response.headers.get("content-length");
      const total = contentLength ? parseInt(contentLength, 10) : null;

      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: false, error: "No response body" };
      }

      // Open file for streaming writes
      file = await Deno.open(outputPath, { write: true, create: true, truncate: true });

      let downloaded = 0;
      let lastProgressTime = Date.now();
      let lastDownloaded = 0;

      // Rate limiting state
      const rateLimit = options?.rateLimit ?? 0;
      let rateLimitBucket = rateLimit;
      let lastRateLimitTime = Date.now();

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

          if (downloaded > rateLimitBucket) {
            const delay = (downloaded - rateLimitBucket) / rateLimit * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            rateLimitBucket = downloaded;
          }
        }

        // Progress callback (throttled to every 100ms)
        const now = Date.now();
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

      return { ok: true, size: downloaded };
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
 * Download audio synced to video progress.
 * Throttles audio download to stay at or slightly behind video percentage.
 * This ensures both streams finish around the same time.
 */
async function downloadAudioSynced(
  url: string,
  outputPath: string,
  audioTotalBytes: number | null,
  options: {
    signal?: AbortSignal;
    getVideoPercentage: () => number; // Returns current video download percentage (0-1)
    onProgress?: (downloaded: number, total: number | null) => void;
  },
): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  let file: Deno.FsFile | null = null;
  const LEAD_BUFFER = 0.02; // Allow audio to lead by up to 2%

  try {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentLength = response.headers.get("content-length");
    const total = contentLength ? parseInt(contentLength, 10) : audioTotalBytes;

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, error: "No response body" };
    }

    file = await Deno.open(outputPath, { write: true, create: true, truncate: true });
    let downloaded = 0;
    let lastProgressTime = Date.now();

    while (true) {
      // Check if we need to throttle (audio ahead of video)
      if (total && total > 0) {
        const audioPercentage = downloaded / total;
        let videoPercentage = options.getVideoPercentage();

        // If audio is ahead of video + buffer, wait for video to catch up
        while (audioPercentage > videoPercentage + LEAD_BUFFER && videoPercentage < 1) {
          if (options.signal?.aborted) {
            return { ok: false, error: "Download cancelled" };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          videoPercentage = options.getVideoPercentage();
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

    return { ok: true, size: downloaded };
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
    const { videoInfo, streams, outputDir, rateLimit = config.rateLimit } = options;
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
          // Video: uses configured rate limit
          downloader.downloadToFile(streams.video.url, paths.videoPath, {
            signal: abortController.signal,
            rateLimit,
            onProgress: (downloaded, total) => {
              videoDownloaded = downloaded;
              if (total) videoTotal = total;
              reportProgress();
            },
          }),
          // Audio: synced to video progress (stays slightly behind or equal)
          downloadAudioSynced(streams.audio.url, paths.audioPath, audioTotal, {
            signal: abortController.signal,
            getVideoPercentage,
            onProgress: (downloaded, total) => {
              audioDownloaded = downloaded;
              if (total) audioTotal = total;
              reportProgress();
            },
          }),
        ]);

        // Handle errors - if either failed, clean up both
        if (!videoResult.ok || !audioResult.ok) {
          await fs.remove(paths.videoPath).catch(() => {});
          await fs.remove(paths.audioPath).catch(() => {});
          const errorMsg = !videoResult.ok
            ? `Video download failed: ${(videoResult as { ok: false; error: string }).error}`
            : `Audio download failed: ${(audioResult as { ok: false; error: string }).error}`;
          return {
            ok: false,
            error: { type: "download_failed", message: errorMsg },
          };
        }

        // Mux video and audio
        onProgress({
          videoId: videoInfo.videoId,
          phase: "muxing",
          videoBytesDownloaded: videoResult.size,
          videoTotalBytes: videoResult.size,
          videoPercentage: 100,
          videoSpeed: null,
          audioBytesDownloaded: audioResult.size,
          audioTotalBytes: audioResult.size,
          audioPercentage: 100,
          audioSpeed: null,
        });

        const muxResult = await muxer.mux({
          videoPath: paths.videoPath,
          audioPath: paths.audioPath,
          outputPath: paths.outputPath,
        });

        // Before cleaning up temp files, copy them to itag-based paths for DASH streaming
        if (paths.videoItagPath) {
          try {
            // Copy video stream to itag-based path
            const videoData = await Deno.readFile(paths.videoPath);
            await Deno.writeFile(paths.videoItagPath, videoData);
          } catch (e) {
            console.warn(`[download] Failed to save video stream: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (paths.audioItagPath) {
          try {
            // Copy audio stream to itag-based path
            const audioData = await Deno.readFile(paths.audioPath);
            await Deno.writeFile(paths.audioItagPath, audioData);
          } catch (e) {
            console.warn(`[download] Failed to save audio stream: ${e instanceof Error ? e.message : e}`);
          }
        }

        // Clean up temp files
        await fs.remove(paths.videoPath).catch(() => {});
        await fs.remove(paths.audioPath).catch(() => {});

        if (!muxResult.ok) {
          return {
            ok: false,
            error: {
              type: "mux_failed",
              message: `Muxing failed: ${muxResult.error.message}`,
              cause: muxResult.error,
            },
          };
        }

        const stat = await fs.stat(paths.outputPath);
        finalSize = stat.size;
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
          return {
            ok: false,
            error: { type: "download_failed", message: `Download failed: ${result.error}` },
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
      // Clean up any temp files
      await fs.remove(paths.videoPath).catch(() => {});
      await fs.remove(paths.audioPath).catch(() => {});

      if (error instanceof Error && error.name === "AbortError") {
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
