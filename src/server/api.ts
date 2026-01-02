/**
 * REST API for the downloader service.
 *
 * Endpoints:
 * - GET  /api/downloader/status      - Service status
 * - GET  /api/downloader/queue       - List queue
 * - POST /api/downloader/queue       - Add to queue
 * - DELETE /api/downloader/queue/:id - Cancel/remove from queue
 * - GET  /api/downloader/downloads   - List downloads
 * - GET  /api/downloader/downloads/:id - Get download details
 * - DELETE /api/downloader/downloads/:id - Delete download
 * - GET  /api/downloader/exclusions  - List exclusions
 * - POST /api/downloader/exclusions  - Add exclusion
 * - DELETE /api/downloader/exclusions/:id - Remove exclusion
 */

import { Hono, type Context } from "@hono/hono";
import type { LocalDbClient } from "../db/local-db.ts";
import type { DownloadManager } from "../services/download-manager.ts";
import type { QueueStatus } from "../db/types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * API dependencies.
 */
export interface ApiDependencies {
  db: LocalDbClient;
  downloadManager?: DownloadManager;
}

/**
 * Service status response.
 */
export interface StatusResponse {
  status: "ok" | "degraded" | "error";
  version: string;
  uptime: number;
  activeDownloads: number;
  queueLength: number;
  totalDownloads: number;
  totalSizeBytes: number;
}

/**
 * Queue request body.
 */
export interface QueueRequestBody {
  videoId: string;
  userId?: string;
  priority?: number;
}

/**
 * Exclusion request body.
 */
export interface ExclusionRequestBody {
  channelId: string;
  userId?: string;
}

// ============================================================================
// API Factory
// ============================================================================

/**
 * Create the API router.
 */
export function createApiRouter(deps: ApiDependencies) {
  const { db, downloadManager } = deps;
  const startTime = Date.now();

  const api = new Hono();

  // ==========================================================================
  // Status
  // ==========================================================================

  api.get("/status", async (c: Context) => {
    const statsResult = db.getDownloadStats();
    const queueResult = db.getQueue({ status: ["pending", "downloading"] });

    const stats = statsResult.ok ? statsResult.data : { count: 0, totalBytes: 0 };
    const queueLength = queueResult.ok ? queueResult.data.length : 0;

    const status: StatusResponse = {
      status: "ok",
      version: "0.1.0",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeDownloads: downloadManager?.getActiveCount() ?? 0,
      queueLength,
      totalDownloads: stats.count,
      totalSizeBytes: stats.totalBytes,
    };

    return c.json(status);
  });

  // ==========================================================================
  // Queue
  // ==========================================================================

  api.get("/queue", async (c: Context) => {
    const statusParam = c.req.query("status");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");

    const options: { status?: QueueStatus[]; limit?: number; offset?: number } = {};

    if (statusParam) {
      options.status = statusParam.split(",") as QueueStatus[];
    }
    if (limitParam) {
      options.limit = parseInt(limitParam, 10);
    }
    if (offsetParam) {
      options.offset = parseInt(offsetParam, 10);
    }

    const result = db.getQueue(options);

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json({
      items: result.data,
      count: result.data.length,
    });
  });

  api.post("/queue", async (c: Context) => {
    let body: QueueRequestBody;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.videoId || typeof body.videoId !== "string") {
      return c.json({ error: "videoId is required" }, 400);
    }

    // Validate video ID format
    if (!/^[a-zA-Z0-9_-]{11}$/.test(body.videoId)) {
      return c.json({ error: "Invalid video ID format" }, 400);
    }

    // Check if already downloaded
    const isDownloaded = db.isDownloaded(body.videoId);
    if (isDownloaded.ok && isDownloaded.data) {
      return c.json({ error: "Video already downloaded" }, 409);
    }

    // Check if already in queue
    const queueItem = db.getQueueItem(body.videoId);
    if (queueItem.ok && queueItem.data) {
      const status = queueItem.data.status;
      
      // If video is actively being processed, reject
      if (status === "pending" || status === "downloading") {
        return c.json({ error: "Video already in queue" }, 409);
      }
      
      // If video failed or was cancelled, remove from queue to allow retry
      if (status === "failed" || status === "cancelled") {
        db.removeFromQueue(body.videoId);
      }
    }

    // Add to queue
    const result = db.addToQueue({
      videoId: body.videoId,
      userId: body.userId,
      priority: body.priority,
    });

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json(result.data, 201);
  });

  api.delete("/queue/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    // Try to cancel if actively downloading
    if (downloadManager) {
      downloadManager.cancelDownload(videoId);
    }

    // Update status to cancelled or remove
    const updateResult = db.updateQueueStatus(videoId, "cancelled");

    if (!updateResult.ok) {
      return c.json({ error: updateResult.error.message }, 500);
    }

    if (!updateResult.data) {
      return c.json({ error: "Video not found in queue" }, 404);
    }

    return c.json({ success: true, item: updateResult.data });
  });

  // ==========================================================================
  // Downloads
  // ==========================================================================

  api.get("/downloads", async (c: Context) => {
    const channelId = c.req.query("channelId");
    const userId = c.req.query("userId");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const orderBy = c.req.query("orderBy") as "downloadedAt" | "title" | "fileSizeBytes" | undefined;
    const orderDir = c.req.query("orderDir") as "asc" | "desc" | undefined;

    const result = db.getDownloads({
      channelId,
      userId,
      limit: limitParam ? parseInt(limitParam, 10) : undefined,
      offset: offsetParam ? parseInt(offsetParam, 10) : undefined,
      orderBy,
      orderDir,
    });

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json({
      items: result.data,
      count: result.data.length,
    });
  });

  api.get("/downloads/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    const result = db.getDownload(videoId);

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    if (!result.data) {
      return c.json({ error: "Download not found" }, 404);
    }

    return c.json(result.data);
  });

  api.delete("/downloads/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    // Get download info first
    const downloadResult = db.getDownload(videoId);
    if (!downloadResult.ok) {
      return c.json({ error: downloadResult.error.message }, 500);
    }

    if (!downloadResult.data) {
      return c.json({ error: "Download not found" }, 404);
    }

    const { filePath, thumbnailPath } = downloadResult.data;

    // Delete from database
    const deleteResult = db.deleteDownload(videoId);

    if (!deleteResult.ok) {
      return c.json({ error: deleteResult.error.message }, 500);
    }

    // Also remove from queue so video can be re-downloaded
    db.removeFromQueue(videoId);

    // Delete actual files
    const deletedFiles: string[] = [];
    
    // Get the directory from the filePath
    const videosDir = filePath.substring(0, filePath.lastIndexOf("/"));
    
    // Delete the main muxed file
    try {
      await Deno.remove(filePath);
      deletedFiles.push(filePath);
    } catch {
      // Ignore if file doesn't exist
    }

    // Delete thumbnail
    if (thumbnailPath) {
      try {
        await Deno.remove(thumbnailPath);
        deletedFiles.push(thumbnailPath);
      } catch {
        // Ignore if file doesn't exist
      }
    }

    // Delete all related files (streams, metadata)
    // Pattern: {videoId}_video_*.mp4, {videoId}_audio_*.m4a, {videoId}_audio_*.webm, {videoId}.json
    try {
      for await (const entry of Deno.readDir(videosDir)) {
        if (!entry.isFile) continue;
        
        const name = entry.name;
        // Match: videoId_video_*, videoId_audio_*, videoId.json
        if (
          name.startsWith(`${videoId}_video_`) ||
          name.startsWith(`${videoId}_audio_`) ||
          name === `${videoId}.json`
        ) {
          const fullPath = `${videosDir}/${name}`;
          try {
            await Deno.remove(fullPath);
            deletedFiles.push(fullPath);
          } catch {
            // Ignore errors for individual files
          }
        }
      }
    } catch {
      // Ignore errors when reading directory
    }

    return c.json({
      success: true,
      deletedFiles,
    });
  });

  // ==========================================================================
  // Exclusions
  // ==========================================================================

  api.get("/exclusions", async (c: Context) => {
    const userId = c.req.query("userId");

    const result = db.getExclusions(userId);

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json({
      items: result.data,
      count: result.data.length,
    });
  });

  api.post("/exclusions", async (c: Context) => {
    let body: ExclusionRequestBody;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.channelId || typeof body.channelId !== "string") {
      return c.json({ error: "channelId is required" }, 400);
    }

    const result = db.addExclusion(body.channelId, body.userId);

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json(result.data, 201);
  });

  api.delete("/exclusions/:channelId", async (c: Context) => {
    const channelId = c.req.param("channelId");
    const userId = c.req.query("userId");

    const result = db.removeExclusion(channelId, userId);

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json({ success: true });
  });

  // ==========================================================================
  // Queue Management
  // ==========================================================================

  api.post("/queue/clear", async (c: Context) => {
    const result = db.clearCompletedQueue();

    if (!result.ok) {
      return c.json({ error: result.error.message }, 500);
    }

    return c.json({ cleared: result.data });
  });

  // ==========================================================================
  // Stats
  // ==========================================================================

  api.get("/stats", async (c: Context) => {
    const downloadStats = db.getDownloadStats();
    const pendingQueue = db.getQueue({ status: "pending" });
    const failedQueue = db.getQueue({ status: "failed" });

    if (!downloadStats.ok) {
      return c.json({ error: downloadStats.error.message }, 500);
    }

    return c.json({
      downloads: downloadStats.data,
      queue: {
        pending: pendingQueue.ok ? pendingQueue.data.length : 0,
        failed: failedQueue.ok ? failedQueue.data.length : 0,
        active: downloadManager?.getActiveCount() ?? 0,
      },
    });
  });

  // ==========================================================================
  // Progress (real-time download progress)
  // ==========================================================================

  api.get("/progress", (c: Context) => {
    if (!downloadManager) {
      return c.json({ items: [] });
    }

    const progress = downloadManager.getProgress();
    return c.json({
      items: progress,
      count: progress.length,
    });
  });

  return api;
}

/**
 * Type for the API router instance.
 */
export type ApiRouter = ReturnType<typeof createApiRouter>;
