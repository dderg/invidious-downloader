/**
 * Main entry point for Invidious Downloader.
 *
 * Initializes and starts all services:
 * - HTTP server (proxy + API)
 * - Subscription watcher
 * - Download manager (queue processing)
 */

import { parseConfig, type Config } from "./config.ts";
import { createInvidiousDb, createPostgresExecutor } from "./db/invidious-db.ts";
import { createLocalDb, createSqliteExecutor } from "./db/local-db.ts";
import { createServer } from "./server/index.ts";
import { createSubscriptionWatcher } from "./services/subscription-watcher.ts";
import { createCompanionClient, selectBestStreams, type QualityPreference } from "./services/companion-client.ts";
import { createDownloadManager } from "./services/download-manager.ts";
import { createMuxer } from "./services/muxer.ts";
import { createCleanupService } from "./services/cleanup-service.ts";
import { join } from "@std/path";

// ============================================================================
// Logger
// ============================================================================

const log = {
  info: (msg: string, data?: Record<string, unknown>) => {
    console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : "");
  },
  error: (msg: string, data?: Record<string, unknown>) => {
    console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : "");
  },
  warn: (msg: string, data?: Record<string, unknown>) => {
    console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : "");
  },
};

// ============================================================================
// Graceful Shutdown
// ============================================================================

interface Cleanup {
  name: string;
  fn: () => void | Promise<void>;
}

const cleanupTasks: Cleanup[] = [];

function registerCleanup(name: string, fn: () => void | Promise<void>): void {
  cleanupTasks.push({ name, fn });
}

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal}, shutting down...`);

  for (const task of cleanupTasks.reverse()) {
    try {
      log.info(`Cleaning up: ${task.name}`);
      await task.fn();
    } catch (err) {
      log.error(`Error during cleanup of ${task.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Shutdown complete");
  Deno.exit(0);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  log.info("Starting Invidious Downloader...");

  // 1. Parse configuration
  const configResult = parseConfig(Deno.env.toObject());
  if (!configResult.ok) {
    log.error("Configuration error", { errors: configResult.errors });
    Deno.exit(1);
  }
  const config: Config = configResult.config;
  log.info("Configuration loaded", {
    invidiousUrl: config.invidiousUrl,
    companionUrl: config.companionUrl,
    port: config.port,
    videosPath: config.videosPath,
  });

  // 2. Initialize databases
  log.info("Initializing databases...");

  // PostgreSQL (Invidious - read-only)
  const pgExecutor = await createPostgresExecutor(config.invidiousDbUrl);
  const invidiousDb = createInvidiousDb(pgExecutor);
  registerCleanup("Invidious DB", () => invidiousDb.close());

  // SQLite (local tracking)
  const sqliteDbPath = join(config.videosPath, "downloads.db");
  const sqliteExecutor = await createSqliteExecutor(sqliteDbPath);
  const localDb = createLocalDb(sqliteExecutor);
  const initResult = localDb.init();
  if (!initResult.ok) {
    log.error("Failed to initialize local database", { error: initResult.error });
    Deno.exit(1);
  }
  registerCleanup("Local DB", () => localDb.close());
  log.info("Databases initialized");

  // 2a. Recover orphaned downloads (items stuck in "downloading" status from previous run)
  const orphanedDownloads = localDb.getOrphanedDownloads();
  if (orphanedDownloads.ok && orphanedDownloads.data.length > 0) {
    log.info("Found orphaned downloads from previous run", {
      count: orphanedDownloads.data.length,
      videoIds: orphanedDownloads.data.map(d => d.videoId),
    });
    const resetCount = localDb.resetOrphanedDownloads();
    if (resetCount.ok) {
      log.info(`Reset ${resetCount.data} orphaned downloads to pending for resume`);
    }
  }

  // 2b. Clean up old tmp files (older than 7 days)
  await cleanupOldTmpFiles(config.videosPath, 7);

  // 3. Initialize services
  log.info("Initializing services...");

  // Companion client
  const companionClient = createCompanionClient({
    companionUrl: config.companionUrl,
    companionSecret: config.companionSecret,
  });

  // Muxer (ffmpeg)
  const muxer = createMuxer();

  // Download manager
  const downloadManager = createDownloadManager(
    {
      videosPath: config.videosPath,
      maxConcurrent: config.maxConcurrentDownloads,
      rateLimit: config.downloadRateLimit,
    },
    muxer,
    localDb,
  );
  registerCleanup("Download Manager", () => downloadManager.stopProcessing());

  // Subscription watcher
  const subscriptionWatcher = createSubscriptionWatcher(
    { invidiousDb, localDb },
    {
      checkIntervalMs: config.checkIntervalMinutes * 60 * 1000,
      userId: config.invidiousUser,
    },
  );
  registerCleanup("Subscription Watcher", () => subscriptionWatcher.stop());

  // Cleanup service (auto-delete watched subscription videos)
  const cleanupService = createCleanupService(
    { invidiousDb, localDb },
    {
      enabled: config.cleanupEnabled,
      days: config.cleanupDays,
      intervalHours: config.cleanupIntervalHours,
      videosPath: config.videosPath,
    },
  );
  registerCleanup("Cleanup Service", () => cleanupService.stop());

  log.info("Services initialized");

  // 4. Create and start HTTP server
  log.info("Starting HTTP server...");
  const server = createServer({
    config,
    db: localDb,
    invidiousDb,
    downloadManager,
    muxer,
  });

  const httpServer = Deno.serve(
    { port: config.port },
    server.app.fetch,
  );
  registerCleanup("HTTP Server", () => httpServer.shutdown());
  registerCleanup("WebSocket Manager", () => server.wsManager.closeAll());
  log.info(`HTTP server listening on port ${config.port}`);

  // 4a. Start WebSocket progress broadcasts
  server.wsManager.startProgressBroadcasts(() => {
    const progressArray = downloadManager.getProgress();
    return new Map(progressArray.map(p => [p.videoId, p]));
  });

  // 5. Start background services
  log.info("Starting background services...");

  // Start subscription watcher
  subscriptionWatcher.start();
  log.info("Subscription watcher started", {
    checkIntervalMinutes: config.checkIntervalMinutes,
    userId: config.invidiousUser ?? "all users",
  });

  // Start cleanup service
  cleanupService.start();
  if (config.cleanupEnabled) {
    log.info("Cleanup service started", {
      cleanupDays: config.cleanupDays,
      cleanupIntervalHours: config.cleanupIntervalHours,
    });
  }

  // Start download manager queue processor
  startQueueProcessor(downloadManager, companionClient, localDb, config, server.wsManager);

  log.info("Invidious Downloader is ready!");
  log.info(`Access the service at http://localhost:${config.port}`);

  // 6. Set up signal handlers
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  // Keep running
  await httpServer.finished;
}

// ============================================================================
// Tmp File Utilities
// ============================================================================

/**
 * Clean up old .tmp files that are older than the specified number of days.
 * These are partial downloads that were never completed.
 */
async function cleanupOldTmpFiles(videosPath: string, maxAgeDays: number): Promise<void> {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleanedCount = 0;
  let cleanedBytes = 0;

  try {
    for await (const entry of Deno.readDir(videosPath)) {
      if (entry.isFile && entry.name.endsWith(".tmp")) {
        const filePath = join(videosPath, entry.name);
        try {
          const stat = await Deno.stat(filePath);
          const fileAge = now - stat.mtime!.getTime();
          if (fileAge > maxAgeMs) {
            cleanedBytes += stat.size;
            await Deno.remove(filePath);
            cleanedCount++;
            log.info(`Cleaned up old tmp file: ${entry.name} (${Math.round(stat.size / 1024 / 1024)}MB, ${Math.round(fileAge / 1000 / 60 / 60 / 24)} days old)`);
          }
        } catch (err) {
          log.warn(`Failed to check/remove tmp file: ${entry.name}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (cleanedCount > 0) {
      log.info(`Cleaned up ${cleanedCount} old tmp files (${Math.round(cleanedBytes / 1024 / 1024)}MB total)`);
    }
  } catch (err) {
    log.warn("Failed to scan for old tmp files", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check if partial download files exist for a video ID.
 * Returns info about the partial files found.
 */
async function hasPartialDownload(
  videoId: string,
  videosPath: string,
): Promise<{ hasPartial: boolean; videoTmpSize: number; audioTmpSize: number }> {
  const videoTmpPath = join(videosPath, `${videoId}_video.tmp`);
  const audioTmpPath = join(videosPath, `${videoId}_audio.tmp`);

  let videoTmpSize = 0;
  let audioTmpSize = 0;

  try {
    const videoStat = await Deno.stat(videoTmpPath);
    videoTmpSize = videoStat.size;
  } catch {
    // File doesn't exist
  }

  try {
    const audioStat = await Deno.stat(audioTmpPath);
    audioTmpSize = audioStat.size;
  } catch {
    // File doesn't exist
  }

  return {
    hasPartial: videoTmpSize > 0 || audioTmpSize > 0,
    videoTmpSize,
    audioTmpSize,
  };
}

/**
 * Delete partial download files for a video ID.
 */
async function deletePartialDownload(videoId: string, videosPath: string): Promise<void> {
  const videoTmpPath = join(videosPath, `${videoId}_video.tmp`);
  const audioTmpPath = join(videosPath, `${videoId}_audio.tmp`);

  try {
    await Deno.remove(videoTmpPath);
  } catch {
    // File doesn't exist
  }

  try {
    await Deno.remove(audioTmpPath);
  } catch {
    // File doesn't exist
  }
}

// ============================================================================
// Queue Processor
// ============================================================================

type CompanionClientType = ReturnType<typeof createCompanionClient>;
type DownloadManagerType = ReturnType<typeof createDownloadManager>;
type LocalDbType = ReturnType<typeof createLocalDb>;
type WebSocketManagerType = ReturnType<typeof createServer>["wsManager"];

// ============================================================================
// Error Classification for Retry Logic
// ============================================================================

/**
 * Error categories for retry logic.
 * - "transient": Network issues, rate limiting - worth retrying
 * - "temporary": Video processing, not available yet - retry with longer delay
 * - "permanent": Video deleted, private, age-restricted - don't auto-retry
 */
type ErrorCategory = "transient" | "temporary" | "permanent";

/**
 * Classify an error message to determine retry behavior.
 * Even "permanent" errors can still be manually retried.
 */
function classifyError(errorMessage: string): ErrorCategory {
  const permanentPatterns = [
    /video.*unavailable/i,
    /video.*private/i,
    /video.*deleted/i,
    /removed/i,
    /age.*restrict/i,
    /copyright/i,
    /blocked/i,
    /sign.?in/i,
    /login.*required/i,
    /members.?only/i,
  ];

  const temporaryPatterns = [
    /no.*suitable.*stream/i,
    /no.*streams.*found/i,
    /processing/i,
    /try.*later/i,
    /temporarily/i,
  ];

  const lowerMessage = errorMessage.toLowerCase();

  for (const pattern of permanentPatterns) {
    if (pattern.test(lowerMessage)) return "permanent";
  }
  for (const pattern of temporaryPatterns) {
    if (pattern.test(lowerMessage)) return "temporary";
  }
  return "transient";
}

/**
 * Handle a download failure with retry logic.
 */
function handleDownloadFailure(
  videoId: string,
  title: string,
  errorMessage: string,
  currentRetryCount: number,
  config: Config,
  localDb: LocalDbType,
  wsManager: WebSocketManagerType,
  downloadManager: DownloadManagerType,
): void {
  const errorCategory = classifyError(errorMessage);

  if (errorCategory === "permanent") {
    // Don't auto-retry permanent errors, but user can still manually retry
    localDb.updateQueueStatus(videoId, "failed", errorMessage);
    log.warn("Download failed (permanent error, not retrying)", {
      videoId,
      error: errorMessage,
    });
    wsManager.broadcastToast(`Failed: "${title}" - ${errorMessage}`, "error");
  } else if (currentRetryCount >= config.maxRetryAttempts) {
    // Max retries reached
    localDb.updateQueueStatus(
      videoId,
      "failed",
      `${errorMessage} (max retries reached)`,
    );
    log.warn("Download failed (max retries reached)", {
      videoId,
      attempts: currentRetryCount,
      error: errorMessage,
    });
    wsManager.broadcastToast(
      `Failed after ${currentRetryCount} attempts: "${title}"`,
      "error",
    );
  } else {
    // Schedule retry with exponential backoff: 1 → 4 → 16 minutes
    const newRetryCount = currentRetryCount + 1;
    const delayMinutes =
      config.retryBaseDelayMinutes * Math.pow(4, newRetryCount - 1);
    const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);

    localDb.scheduleRetry(videoId, errorMessage, newRetryCount, nextRetryAt);

    log.info("Scheduled retry", {
      videoId,
      attempt: newRetryCount,
      maxAttempts: config.maxRetryAttempts,
      delayMinutes,
      nextRetryAt: nextRetryAt.toISOString(),
    });
    wsManager.broadcastToast(
      `Retry ${newRetryCount}/${config.maxRetryAttempts} for "${title}" in ${delayMinutes} min`,
      "warning",
    );
  }

  broadcastDashboardUpdate(wsManager, localDb, downloadManager);
}

/**
 * Helper to broadcast dashboard stats via WebSocket.
 */
function broadcastDashboardUpdate(
  wsManager: WebSocketManagerType,
  localDb: LocalDbType,
  downloadManager: DownloadManagerType,
): void {
  const statsResult = localDb.getDownloadStats();
  const queueResult = localDb.getQueue({});
  const progressArray = downloadManager.getProgress();
  const progress = new Map(progressArray.map(p => [p.videoId, p]));
  
  const stats = {
    status: "ok" as const,
    activeDownloads: downloadManager.getActiveCount(),
    queueLength: queueResult.ok 
      ? queueResult.data.filter(q => q.status === "pending" || q.status === "downloading").length 
      : 0,
    totalDownloads: statsResult.ok ? statsResult.data.count : 0,
    totalSizeBytes: statsResult.ok ? statsResult.data.totalBytes : 0,
  };
  
  wsManager.broadcastStats(stats);
  if (queueResult.ok) {
    wsManager.broadcastQueue(queueResult.data, progress);
  }
}

/**
 * Start the queue processor that downloads videos from the queue.
 */
function startQueueProcessor(
  downloadManager: DownloadManagerType,
  companionClient: CompanionClientType,
  localDb: LocalDbType,
  config: Config,
  wsManager: WebSocketManagerType,
): void {
  const processInterval = 5000; // Check every 5 seconds
  let isProcessing = false;

  async function processNext(): Promise<void> {
    if (isProcessing) return;

    const activeCount = downloadManager.getActiveCount();
    if (activeCount >= config.maxConcurrentDownloads) return;

    const nextResult = localDb.getNextQueueItem();
    if (!nextResult.ok || !nextResult.data) return;

    const queueItem = nextResult.data;
    isProcessing = true;

    try {
      // Mark as downloading
      localDb.updateQueueStatus(queueItem.videoId, "downloading");
      
      // Broadcast that download started
      broadcastDashboardUpdate(wsManager, localDb, downloadManager);

      // Get video info from Companion
      const infoResult = await companionClient.getVideoInfo(queueItem.videoId);
      if (!infoResult.ok) {
        log.error("Failed to get video info", {
          videoId: queueItem.videoId,
          error: infoResult.error.message,
        });
        handleDownloadFailure(
          queueItem.videoId,
          queueItem.videoId, // Use videoId as title since we don't have it yet
          infoResult.error.message,
          queueItem.retryCount,
          config,
          localDb,
          wsManager,
          downloadManager,
        );
        return;
      }

      const videoInfo = infoResult.data;

      // Select best streams
      const streams = selectBestStreams(videoInfo, config.downloadQuality as QualityPreference);
      if (!streams.video && !streams.audio && !streams.combined) {
        log.error("No suitable streams", { videoId: queueItem.videoId });
        handleDownloadFailure(
          queueItem.videoId,
          videoInfo.title,
          "No suitable streams found",
          queueItem.retryCount,
          config,
          localDb,
          wsManager,
          downloadManager,
        );
        return;
      }

      // Check for partial downloads (from interrupted downloads)
      const partial = await hasPartialDownload(queueItem.videoId, config.videosPath);
      const shouldResume = partial.hasPartial;
      
      if (shouldResume) {
        const videoMB = Math.round(partial.videoTmpSize / 1024 / 1024);
        const audioMB = Math.round(partial.audioTmpSize / 1024 / 1024);
        log.info("Resuming interrupted download", {
          videoId: queueItem.videoId,
          title: videoInfo.title,
          videoTmpSize: `${videoMB}MB`,
          audioTmpSize: `${audioMB}MB`,
        });
        wsManager.broadcastToast(`Resuming: "${videoInfo.title}" (${videoMB}MB video, ${audioMB}MB audio)`, "success");
      } else {
        // Start fresh download
        log.info("Starting download", {
          videoId: queueItem.videoId,
          title: videoInfo.title,
        });
      }

      // Initialize progress tracking
      downloadManager.updateProgress(
        queueItem.videoId,
        videoInfo.title,
        "downloading",
        0,
        null,
        0,
        null,
        null,
        null,
      );

      const downloadResult = await downloadManager.downloadVideo({
        videoInfo,
        streams,
        outputDir: config.videosPath,
        rateLimit: config.downloadRateLimit,
        resume: shouldResume,
        // Throttle detection config (only enabled if threshold > 0)
        throttleConfig: config.throttleSpeedThreshold > 0 ? {
          speedThreshold: config.throttleSpeedThreshold,
          detectionWindow: config.throttleDetectionWindow,
        } : undefined,
        onProgress: (progress) => {
          // Update progress in manager for API access
          downloadManager.updateProgress(
            queueItem.videoId,
            videoInfo.title,
            progress.phase === "complete" || progress.phase === "failed"
              ? "muxing"
              : progress.phase,
            progress.videoBytesDownloaded,
            progress.videoTotalBytes,
            progress.audioBytesDownloaded,
            progress.audioTotalBytes,
            progress.videoSpeed,
            progress.audioSpeed,
          );

          if (progress.phase === "complete") {
            log.info("Download complete", {
              videoId: queueItem.videoId,
            });
          }
        },
      });

      // Remove progress tracking when done
      downloadManager.removeProgress(queueItem.videoId);

      if (!downloadResult.ok) {
        // Check for resume-specific errors
        const cause = downloadResult.error.cause as { urlExpired?: boolean; startFresh?: boolean; throttled?: boolean } | undefined;
        
        // Check for throttling - handle with separate retry counter
        if (cause?.throttled) {
          const throttleRetries = queueItem.throttleRetryCount + 1;
          
          if (throttleRetries >= config.throttleMaxRetries) {
            // Max throttle retries reached - continue downloading at slow speed
            // (don't abort, just log and let normal retry logic handle it)
            log.warn("Throttle detection max retries reached, continuing at slow speed", {
              videoId: queueItem.videoId,
              throttleRetries,
              maxThrottleRetries: config.throttleMaxRetries,
            });
            wsManager.broadcastToast(
              `Max throttle retries (${config.throttleMaxRetries}) reached for "${videoInfo.title}", continuing at slow speed`,
              "warning",
            );
            // Fall through to normal error handling
          } else {
            // Throttle detected - retry with fresh URLs
            log.info("Throttling detected, retrying with fresh URLs", {
              videoId: queueItem.videoId,
              throttleRetry: throttleRetries,
              maxThrottleRetries: config.throttleMaxRetries,
            });
            localDb.incrementThrottleRetry(queueItem.videoId);
            wsManager.broadcastToast(
              `Throttling detected for "${videoInfo.title}", retry ${throttleRetries}/${config.throttleMaxRetries}`,
              "warning",
            );
            broadcastDashboardUpdate(wsManager, localDb, downloadManager);
            return;
          }
        }
        
        if (cause?.startFresh && shouldResume) {
          // Server doesn't support resume - delete tmp files and retry immediately
          log.info("Server doesn't support resume, restarting download fresh", {
            videoId: queueItem.videoId,
          });
          await deletePartialDownload(queueItem.videoId, config.videosPath);
          // Don't count this as a retry - just let it retry on next cycle with fresh start
          localDb.updateQueueStatus(queueItem.videoId, "pending");
          wsManager.broadcastToast(`Restarting download (no resume support): "${videoInfo.title}"`, "warning");
          return;
        }
        
        // URL expired is handled normally - we get fresh URLs each time anyway
        log.error("Download failed", {
          videoId: queueItem.videoId,
          error: downloadResult.error.message,
        });
        handleDownloadFailure(
          queueItem.videoId,
          videoInfo.title,
          downloadResult.error.message,
          queueItem.retryCount,
          config,
          localDb,
          wsManager,
          downloadManager,
        );
        return;
      }

      // Save download record
      localDb.addDownload({
        videoId: queueItem.videoId,
        userId: queueItem.userId,
        channelId: videoInfo.channelId,
        title: videoInfo.title,
        durationSeconds: videoInfo.lengthSeconds,
        quality: config.downloadQuality,
        filePath: downloadResult.filePath,
        thumbnailPath: null,
        metadata: {
          author: videoInfo.author,
          description: videoInfo.description,
          viewCount: videoInfo.viewCount,
          videoItag: downloadResult.videoItag,
          audioItag: downloadResult.audioItag,
          width: downloadResult.videoWidth,
          height: downloadResult.videoHeight,
          videoMimeType: downloadResult.videoMimeType,
          audioMimeType: downloadResult.audioMimeType,
          videoBitrate: downloadResult.videoBitrate,
          audioBitrate: downloadResult.audioBitrate,
          videoContentLength: downloadResult.videoContentLength,
          audioContentLength: downloadResult.audioContentLength,
          audioExtension: downloadResult.audioExtension,
        },
        fileSizeBytes: downloadResult.fileSize,
      });

      // Mark queue item as completed
      localDb.updateQueueStatus(queueItem.videoId, "completed");
      log.info("Download saved", {
        videoId: queueItem.videoId,
        filePath: downloadResult.filePath,
        fileSize: downloadResult.fileSize,
      });
      
      // Broadcast completion
      broadcastDashboardUpdate(wsManager, localDb, downloadManager);
      wsManager.broadcastDownloadComplete(queueItem.videoId, videoInfo.title);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Queue processing error", {
        videoId: queueItem.videoId,
        error: errorMessage,
      });
      // Note: We may not have videoInfo.title here if the error occurred early
      // The handleDownloadFailure function will use videoId as fallback title
      handleDownloadFailure(
        queueItem.videoId,
        queueItem.videoId, // Use videoId as title (videoInfo might not be available)
        errorMessage,
        queueItem.retryCount,
        config,
        localDb,
        wsManager,
        downloadManager,
      );
    } finally {
      isProcessing = false;
    }
  }

  // Start periodic processing
  setInterval(processNext, processInterval);
  log.info("Queue processor started");
}

// ============================================================================
// Entry Point
// ============================================================================

if (import.meta.main) {
  main().catch((err) => {
    log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
    Deno.exit(1);
  });
}
