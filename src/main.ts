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

  log.info("Services initialized");

  // 4. Create and start HTTP server
  log.info("Starting HTTP server...");
  const server = createServer({
    config,
    db: localDb,
    downloadManager,
  });

  const httpServer = Deno.serve(
    { port: config.port },
    server.app.fetch,
  );
  registerCleanup("HTTP Server", () => httpServer.shutdown());
  log.info(`HTTP server listening on port ${config.port}`);

  // 5. Start background services
  log.info("Starting background services...");

  // Start subscription watcher
  subscriptionWatcher.start();
  log.info("Subscription watcher started", {
    checkIntervalMinutes: config.checkIntervalMinutes,
    userId: config.invidiousUser ?? "all users",
  });

  // Start download manager queue processor
  startQueueProcessor(downloadManager, companionClient, localDb, config);

  log.info("Invidious Downloader is ready!");
  log.info(`Access the service at http://localhost:${config.port}`);

  // 6. Set up signal handlers
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  // Keep running
  await httpServer.finished;
}

// ============================================================================
// Queue Processor
// ============================================================================

type CompanionClientType = ReturnType<typeof createCompanionClient>;
type DownloadManagerType = ReturnType<typeof createDownloadManager>;
type LocalDbType = ReturnType<typeof createLocalDb>;

/**
 * Start the queue processor that downloads videos from the queue.
 */
function startQueueProcessor(
  downloadManager: DownloadManagerType,
  companionClient: CompanionClientType,
  localDb: LocalDbType,
  config: Config,
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

      // Get video info from Companion
      const infoResult = await companionClient.getVideoInfo(queueItem.videoId);
      if (!infoResult.ok) {
        localDb.updateQueueStatus(queueItem.videoId, "failed", infoResult.error.message);
        log.error("Failed to get video info", {
          videoId: queueItem.videoId,
          error: infoResult.error.message,
        });
        return;
      }

      const videoInfo = infoResult.data;

      // Select best streams
      const streams = selectBestStreams(videoInfo, config.downloadQuality as QualityPreference);
      if (!streams.video && !streams.audio && !streams.combined) {
        localDb.updateQueueStatus(queueItem.videoId, "failed", "No suitable streams found");
        log.error("No suitable streams", { videoId: queueItem.videoId });
        return;
      }

      // Start download
      log.info("Starting download", {
        videoId: queueItem.videoId,
        title: videoInfo.title,
      });

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
        localDb.updateQueueStatus(queueItem.videoId, "failed", downloadResult.error.message);
        log.error("Download failed", {
          videoId: queueItem.videoId,
          error: downloadResult.error.message,
        });
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
    } catch (err) {
      localDb.updateQueueStatus(
        queueItem.videoId,
        "failed",
        err instanceof Error ? err.message : String(err),
      );
      log.error("Queue processing error", {
        videoId: queueItem.videoId,
        error: err instanceof Error ? err.message : String(err),
      });
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
