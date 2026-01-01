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
  phase: "downloading_video" | "downloading_audio" | "muxing" | "complete" | "failed";
  bytesDownloaded: number;
  totalBytes: number | null;
  percentage: number | null;
  speed: number | null; // bytes per second
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
  | { ok: true; filePath: string; fileSize: number; duration: number }
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
  phase: "downloading_video" | "downloading_audio" | "muxing" | "queued";
  bytesDownloaded: number;
  totalBytes: number | null;
  percentage: number | null;
  speed: number | null;
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
 * Default HTTP downloader using fetch.
 */
export const defaultHttpDownloader: HttpDownloader = {
  async downloadToFile(url, outputPath, options) {
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

      const chunks: Uint8Array[] = [];
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

        chunks.push(value);
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

      // Write to file
      const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const data = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      await Deno.writeFile(outputPath, data);
      return { ok: true, size: downloaded };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, error: "Download cancelled" };
      }
      return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
};

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
 * Generate output paths for a video download.
 */
export function generatePaths(
  videoId: string,
  title: string,
  outputDir: string,
  tempDir?: string,
): {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  thumbnailPath: string;
  metadataPath: string;
} {
  const safeName = sanitizeFilename(title);
  const temp = tempDir ?? outputDir;

  return {
    videoPath: `${temp}/${videoId}_video.tmp`,
    audioPath: `${temp}/${videoId}_audio.tmp`,
    outputPath: `${outputDir}/${videoId}.mp4`,
    thumbnailPath: `${outputDir}/${videoId}.webp`,
    metadataPath: `${outputDir}/${videoId}.json`,
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

    // Generate paths
    const paths = generatePaths(videoInfo.videoId, videoInfo.title, outputDir, config.tempDir);

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
        // Download video stream
        onProgress({
          videoId: videoInfo.videoId,
          phase: "downloading_video",
          bytesDownloaded: 0,
          totalBytes: streams.video.contentLength ? parseInt(streams.video.contentLength, 10) : null,
          percentage: 0,
          speed: null,
        });

        const videoResult = await downloader.downloadToFile(
          streams.video.url,
          paths.videoPath,
          {
            signal: abortController.signal,
            rateLimit,
            onProgress: (downloaded, total) => {
              onProgress({
                videoId: videoInfo.videoId,
                phase: "downloading_video",
                bytesDownloaded: downloaded,
                totalBytes: total,
                percentage: total ? Math.round((downloaded / total) * 100) : null,
                speed: null,
              });
            },
          },
        );

        if (!videoResult.ok) {
          return {
            ok: false,
            error: { type: "download_failed", message: `Video download failed: ${videoResult.error}` },
          };
        }

        // Download audio stream
        onProgress({
          videoId: videoInfo.videoId,
          phase: "downloading_audio",
          bytesDownloaded: 0,
          totalBytes: streams.audio.contentLength ? parseInt(streams.audio.contentLength, 10) : null,
          percentage: 0,
          speed: null,
        });

        const audioResult = await downloader.downloadToFile(
          streams.audio.url,
          paths.audioPath,
          {
            signal: abortController.signal,
            rateLimit,
            onProgress: (downloaded, total) => {
              onProgress({
                videoId: videoInfo.videoId,
                phase: "downloading_audio",
                bytesDownloaded: downloaded,
                totalBytes: total,
                percentage: total ? Math.round((downloaded / total) * 100) : null,
                speed: null,
              });
            },
          },
        );

        if (!audioResult.ok) {
          // Clean up video file
          await fs.remove(paths.videoPath).catch(() => {});
          return {
            ok: false,
            error: { type: "download_failed", message: `Audio download failed: ${audioResult.error}` },
          };
        }

        // Mux video and audio
        onProgress({
          videoId: videoInfo.videoId,
          phase: "muxing",
          bytesDownloaded: videoResult.size + audioResult.size,
          totalBytes: null,
          percentage: null,
          speed: null,
        });

        const muxResult = await muxer.mux({
          videoPath: paths.videoPath,
          audioPath: paths.audioPath,
          outputPath: paths.outputPath,
        });

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
        // Download combined stream directly
        onProgress({
          videoId: videoInfo.videoId,
          phase: "downloading_video",
          bytesDownloaded: 0,
          totalBytes: streams.combined.contentLength
            ? parseInt(streams.combined.contentLength, 10)
            : null,
          percentage: 0,
          speed: null,
        });

        const result = await downloader.downloadToFile(
          streams.combined.url,
          paths.outputPath,
          {
            signal: abortController.signal,
            rateLimit,
            onProgress: (downloaded, total) => {
              onProgress({
                videoId: videoInfo.videoId,
                phase: "downloading_video",
                bytesDownloaded: downloaded,
                totalBytes: total,
                percentage: total ? Math.round((downloaded / total) * 100) : null,
                speed: null,
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
        bytesDownloaded: finalSize,
        totalBytes: finalSize,
        percentage: 100,
        speed: null,
      });

      return {
        ok: true,
        filePath: paths.outputPath,
        fileSize: finalSize,
        duration: videoInfo.lengthSeconds,
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
    bytesDownloaded: number,
    totalBytes: number | null,
  ): void {
    const existing = activeProgress.get(videoId);
    const now = Date.now();
    const startedAt = existing?.startedAt ?? now;
    const elapsed = (now - startedAt) / 1000;
    const speed = elapsed > 0 ? bytesDownloaded / elapsed : null;

    activeProgress.set(videoId, {
      videoId,
      title,
      phase,
      bytesDownloaded,
      totalBytes,
      percentage: totalBytes ? Math.round((bytesDownloaded / totalBytes) * 100) : null,
      speed,
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
