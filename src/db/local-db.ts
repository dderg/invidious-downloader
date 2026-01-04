/**
 * Local SQLite database for tracking downloads, queue, and exclusions.
 *
 * Design:
 * - Pure query builder functions (testable)
 * - SQL executor interface for dependency injection
 * - Automatic schema migration on init
 */

import type {
  ChannelExclusion,
  DbError,
  DbResult,
  Download,
  DownloadMetadata,
  DownloadQueryOptions,
  DownloadSource,
  QueueItem,
  QueueQueryOptions,
  QueueStatus,
  VideoUserStatus,
} from "./types.ts";

// ============================================================================
// SQL Executor Interface
// ============================================================================

/**
 * SQLite executor interface for dependency injection.
 */
export interface SqliteExecutor {
  execute(sql: string, params?: unknown[]): void;
  queryRows<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_SQL = `
-- Track downloaded videos
CREATE TABLE IF NOT EXISTS downloads (
  video_id TEXT PRIMARY KEY,
  user_id TEXT,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  quality TEXT NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  file_size_bytes INTEGER NOT NULL DEFAULT 0
);

-- Index for queries by channel
CREATE INDEX IF NOT EXISTS idx_downloads_channel ON downloads(channel_id);

-- Index for queries by user
CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id);

-- Track channel exclusions
CREATE TABLE IF NOT EXISTS channel_exclusions (
  channel_id TEXT NOT NULL,
  user_id TEXT,
  excluded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, user_id)
);

-- Download queue
CREATE TABLE IF NOT EXISTS download_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT UNIQUE NOT NULL,
  user_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- Index for queue status queries
CREATE INDEX IF NOT EXISTS idx_queue_status ON download_queue(status);

-- Index for queue priority ordering
CREATE INDEX IF NOT EXISTS idx_queue_priority ON download_queue(priority DESC, queued_at ASC);
`;

// Migration SQL to add retry columns to existing databases
const MIGRATION_RETRY_COLUMNS_SQL = `
-- Add retry_count column if it doesn't exist
ALTER TABLE download_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_NEXT_RETRY_AT_SQL = `
-- Add next_retry_at column if it doesn't exist
ALTER TABLE download_queue ADD COLUMN next_retry_at TEXT;
`;

// Migration: Add source column to downloads table
const MIGRATION_DOWNLOADS_SOURCE_SQL = `
ALTER TABLE downloads ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
`;

// Migration: Add files_deleted_at column to downloads table
const MIGRATION_DOWNLOADS_FILES_DELETED_AT_SQL = `
ALTER TABLE downloads ADD COLUMN files_deleted_at TEXT;
`;

// Migration: Add source column to download_queue table
const MIGRATION_QUEUE_SOURCE_SQL = `
ALTER TABLE download_queue ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
`;

// Migration: Create video_user_status table
const MIGRATION_VIDEO_USER_STATUS_SQL = `
CREATE TABLE IF NOT EXISTS video_user_status (
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 1,
  keep_forever INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (video_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vus_user ON video_user_status(user_id);
CREATE INDEX IF NOT EXISTS idx_vus_video ON video_user_status(video_id);
CREATE INDEX IF NOT EXISTS idx_vus_deleted ON video_user_status(deleted_at);
`;

// Migration: Add throttle_retry_count column to download_queue table
const MIGRATION_THROTTLE_RETRY_COUNT_SQL = `
ALTER TABLE download_queue ADD COLUMN throttle_retry_count INTEGER NOT NULL DEFAULT 0;
`;

// ============================================================================
// Row Mappers (pure functions)
// ============================================================================

interface DownloadRow {
  video_id: string;
  user_id: string | null;
  channel_id: string;
  title: string;
  duration_seconds: number;
  quality: string;
  file_path: string;
  thumbnail_path: string | null;
  metadata: string;
  downloaded_at: string;
  file_size_bytes: number;
  source: string;
  files_deleted_at: string | null;
}

interface QueueRow {
  id: number;
  video_id: string;
  user_id: string | null;
  priority: number;
  status: string;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  next_retry_at: string | null;
  source: string;
  throttle_retry_count: number;
}

interface ExclusionRow {
  channel_id: string;
  user_id: string | null;
  excluded_at: string;
}

interface VideoUserStatusRow {
  video_id: string;
  user_id: string;
  is_owner: number;
  keep_forever: number;
  deleted_at: string | null;
  created_at: string;
}

/**
 * Map download row to Download type.
 */
export function mapDownloadRow(row: DownloadRow): Download {
  let metadata: DownloadMetadata = { author: "" };
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    // Use default
  }

  return {
    videoId: row.video_id,
    userId: row.user_id,
    channelId: row.channel_id,
    title: row.title,
    durationSeconds: row.duration_seconds,
    quality: row.quality,
    filePath: row.file_path,
    thumbnailPath: row.thumbnail_path,
    metadata,
    downloadedAt: new Date(row.downloaded_at),
    fileSizeBytes: row.file_size_bytes,
    source: (row.source as DownloadSource) || "manual",
    filesDeletedAt: row.files_deleted_at ? new Date(row.files_deleted_at) : null,
  };
}

/**
 * Map video user status row to VideoUserStatus type.
 */
export function mapVideoUserStatusRow(row: VideoUserStatusRow): VideoUserStatus {
  return {
    videoId: row.video_id,
    userId: row.user_id,
    isOwner: Boolean(row.is_owner),
    keepForever: Boolean(row.keep_forever),
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Map queue row to QueueItem type.
 */
export function mapQueueRow(row: QueueRow): QueueItem {
  return {
    id: row.id,
    videoId: row.video_id,
    userId: row.user_id,
    priority: row.priority,
    status: row.status as QueueStatus,
    errorMessage: row.error_message,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    retryCount: row.retry_count ?? 0,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
    source: (row.source as DownloadSource) || "manual",
    throttleRetryCount: row.throttle_retry_count ?? 0,
  };
}

/**
 * Map exclusion row to ChannelExclusion type.
 */
export function mapExclusionRow(row: ExclusionRow): ChannelExclusion {
  return {
    channelId: row.channel_id,
    userId: row.user_id,
    excludedAt: new Date(row.excluded_at),
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function errorResult<T>(
  type: DbError["type"],
  message: string,
  cause?: unknown,
): DbResult<T> {
  return { ok: false, error: { type, message, cause } };
}

function okResult<T>(data: T): DbResult<T> {
  return { ok: true, data };
}

// ============================================================================
// Local Database Client
// ============================================================================

/**
 * Input for adding a download.
 */
export interface AddDownloadInput {
  videoId: string;
  userId?: string | null;
  channelId: string;
  title: string;
  durationSeconds: number;
  quality: string;
  filePath: string;
  thumbnailPath?: string | null;
  metadata: DownloadMetadata;
  fileSizeBytes: number;
  source?: DownloadSource;
}

/**
 * Input for adding to queue.
 */
export interface AddToQueueInput {
  videoId: string;
  userId?: string | null;
  priority?: number;
  source?: DownloadSource;
  /** User IDs who will own this video (for subscription downloads) */
  ownerUserIds?: string[];
}

/**
 * Create a local database client.
 */
export function createLocalDb(executor: SqliteExecutor) {
  /**
   * Initialize database schema.
   */
  function init(): DbResult<void> {
    try {
      executor.execute(SCHEMA_SQL);
      
      // Run migrations (safe to run multiple times - fails silently if column/table exists)
      const migrations = [
        MIGRATION_RETRY_COLUMNS_SQL,
        MIGRATION_NEXT_RETRY_AT_SQL,
        MIGRATION_DOWNLOADS_SOURCE_SQL,
        MIGRATION_DOWNLOADS_FILES_DELETED_AT_SQL,
        MIGRATION_QUEUE_SOURCE_SQL,
        MIGRATION_VIDEO_USER_STATUS_SQL,
        MIGRATION_THROTTLE_RETRY_COUNT_SQL,
      ];
      
      for (const migration of migrations) {
        try {
          executor.execute(migration);
        } catch {
          // Migration already applied or table/column already exists, ignore
        }
      }
      
      return okResult(undefined);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to initialize schema: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  // ==========================================================================
  // Downloads
  // ==========================================================================

  /**
   * Add a downloaded video.
   */
  function addDownload(input: AddDownloadInput): DbResult<Download> {
    try {
      const sql = `
        INSERT INTO downloads (
          video_id, user_id, channel_id, title, duration_seconds,
          quality, file_path, thumbnail_path, metadata, file_size_bytes, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          quality = excluded.quality,
          file_path = excluded.file_path,
          thumbnail_path = excluded.thumbnail_path,
          metadata = excluded.metadata,
          file_size_bytes = excluded.file_size_bytes,
          downloaded_at = datetime('now'),
          files_deleted_at = NULL
        RETURNING *
      `;
      const params = [
        input.videoId,
        input.userId ?? null,
        input.channelId,
        input.title,
        input.durationSeconds,
        input.quality,
        input.filePath,
        input.thumbnailPath ?? null,
        JSON.stringify(input.metadata),
        input.fileSizeBytes,
        input.source ?? "manual",
      ];

      const row = executor.queryOne<DownloadRow>(sql, params);
      if (!row) {
        return errorResult("query_error", "Failed to insert download");
      }
      return okResult(mapDownloadRow(row));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to add download: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get a download by video ID.
   */
  function getDownload(videoId: string): DbResult<Download | null> {
    try {
      const sql = "SELECT * FROM downloads WHERE video_id = ?";
      const row = executor.queryOne<DownloadRow>(sql, [videoId]);
      return okResult(row ? mapDownloadRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get download: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Check if a video is downloaded (files exist).
   */
  function isDownloaded(videoId: string): DbResult<boolean> {
    try {
      const sql = "SELECT 1 FROM downloads WHERE video_id = ? AND files_deleted_at IS NULL";
      const row = executor.queryOne<{ "1": number }>(sql, [videoId]);
      return okResult(row !== undefined);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to check download: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get downloads with optional filters.
   */
  function getDownloads(options: DownloadQueryOptions = {}): DbResult<Download[]> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(options.userId);
      }

      if (options.channelId !== undefined) {
        conditions.push("channel_id = ?");
        params.push(options.channelId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderBy = options.orderBy ?? "downloadedAt";
      const orderDir = options.orderDir ?? "desc";

      const orderColumn = {
        downloadedAt: "downloaded_at",
        title: "title",
        fileSizeBytes: "file_size_bytes",
      }[orderBy];

      let sql = `SELECT * FROM downloads ${whereClause} ORDER BY ${orderColumn} ${orderDir.toUpperCase()}`;

      if (options.limit !== undefined) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }

      if (options.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }

      const rows = executor.queryRows<DownloadRow>(sql, params);
      return okResult(rows.map(mapDownloadRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get downloads: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Delete a download record (not the file).
   */
  function deleteDownload(videoId: string): DbResult<boolean> {
    try {
      executor.execute("DELETE FROM downloads WHERE video_id = ?", [videoId]);
      return okResult(true);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to delete download: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get total download stats.
   */
  function getDownloadStats(): DbResult<{ count: number; totalBytes: number }> {
    try {
      const row = executor.queryOne<{ count: number; total_bytes: number }>(
        "SELECT COUNT(*) as count, COALESCE(SUM(file_size_bytes), 0) as total_bytes FROM downloads",
      );
      return okResult({
        count: row?.count ?? 0,
        totalBytes: row?.total_bytes ?? 0,
      });
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get stats: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get total count of downloads (with optional filters).
   */
  function getDownloadsCount(options: { userId?: string; channelId?: string } = {}): DbResult<number> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(options.userId);
      }

      if (options.channelId !== undefined) {
        conditions.push("channel_id = ?");
        params.push(options.channelId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = executor.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM downloads ${whereClause}`,
        params,
      );
      return okResult(row?.count ?? 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get downloads count: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  // ==========================================================================
  // Queue
  // ==========================================================================

  /**
   * Add video to download queue.
   */
  function addToQueue(input: AddToQueueInput): DbResult<QueueItem> {
    try {
      const sql = `
        INSERT INTO download_queue (video_id, user_id, priority, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          priority = MAX(download_queue.priority, excluded.priority)
        RETURNING *
      `;
      const params = [
        input.videoId,
        input.userId ?? null,
        input.priority ?? 0,
        input.source ?? "manual",
      ];

      const row = executor.queryOne<QueueRow>(sql, params);
      if (!row) {
        return errorResult("query_error", "Failed to add to queue");
      }
      
      // If owner user IDs provided, create video_user_status entries
      if (input.ownerUserIds && input.ownerUserIds.length > 0) {
        for (const userId of input.ownerUserIds) {
          addVideoOwner(input.videoId, userId);
        }
      } else if (input.userId) {
        // For manual downloads, the requesting user is the owner
        addVideoOwner(input.videoId, input.userId);
      }
      
      return okResult(mapQueueRow(row));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to add to queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get queue items with optional filters.
   */
  function getQueue(options: QueueQueryOptions = {}): DbResult<QueueItem[]> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.status !== undefined) {
        if (Array.isArray(options.status)) {
          const placeholders = options.status.map(() => "?").join(", ");
          conditions.push(`status IN (${placeholders})`);
          params.push(...options.status);
        } else {
          conditions.push("status = ?");
          params.push(options.status);
        }
      }

      if (options.userId !== undefined) {
        conditions.push("user_id = ?");
        params.push(options.userId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      let sql = `SELECT * FROM download_queue ${whereClause} ORDER BY priority DESC, queued_at ASC`;

      if (options.limit !== undefined) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }

      if (options.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }

      const rows = executor.queryRows<QueueRow>(sql, params);
      return okResult(rows.map(mapQueueRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get next pending item from queue.
   * Only returns items that are ready to process (no pending retry delay).
   */
  function getNextQueueItem(): DbResult<QueueItem | null> {
    try {
      const sql = `
        SELECT * FROM download_queue
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now'))
        ORDER BY priority DESC, queued_at ASC
        LIMIT 1
      `;
      const row = executor.queryOne<QueueRow>(sql);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get next queue item: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Update queue item status.
   */
  function updateQueueStatus(
    videoId: string,
    status: QueueStatus,
    errorMessage?: string,
  ): DbResult<QueueItem | null> {
    try {
      let sql: string;
      let params: unknown[];

      if (status === "downloading") {
        sql = `
          UPDATE download_queue
          SET status = ?, started_at = datetime('now')
          WHERE video_id = ?
          RETURNING *
        `;
        params = [status, videoId];
      } else if (status === "completed" || status === "failed" || status === "cancelled") {
        sql = `
          UPDATE download_queue
          SET status = ?, error_message = ?, completed_at = datetime('now')
          WHERE video_id = ?
          RETURNING *
        `;
        params = [status, errorMessage ?? null, videoId];
      } else {
        sql = `
          UPDATE download_queue
          SET status = ?, error_message = ?
          WHERE video_id = ?
          RETURNING *
        `;
        params = [status, errorMessage ?? null, videoId];
      }

      const row = executor.queryOne<QueueRow>(sql, params);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to update queue status: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Remove item from queue.
   */
  function removeFromQueue(videoId: string): DbResult<boolean> {
    try {
      executor.execute("DELETE FROM download_queue WHERE video_id = ?", [videoId]);
      return okResult(true);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to remove from queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Check if video is in queue.
   */
  function isInQueue(videoId: string): DbResult<boolean> {
    try {
      const row = executor.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM download_queue WHERE video_id = ?",
        [videoId],
      );
      return okResult((row?.count ?? 0) > 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to check queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get a queue item by video ID.
   */
  function getQueueItem(videoId: string): DbResult<QueueItem | null> {
    try {
      const sql = "SELECT * FROM download_queue WHERE video_id = ?";
      const row = executor.queryOne<QueueRow>(sql, [videoId]);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get queue item: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Clear completed/failed/cancelled items from queue.
   */
  function clearCompletedQueue(): DbResult<number> {
    try {
      const result = executor.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM download_queue WHERE status IN ('completed', 'failed', 'cancelled')",
      );
      executor.execute(
        "DELETE FROM download_queue WHERE status IN ('completed', 'failed', 'cancelled')",
      );
      return okResult(result?.count ?? 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to clear queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get orphaned downloads (items stuck in 'downloading' status).
   * These are downloads that were interrupted by a crash or restart.
   */
  function getOrphanedDownloads(): DbResult<QueueItem[]> {
    try {
      const sql = `
        SELECT * FROM download_queue
        WHERE status = 'downloading'
        ORDER BY started_at ASC
      `;
      const rows = executor.queryRows<QueueRow>(sql);
      return okResult(rows.map(mapQueueRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get orphaned downloads: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Reset orphaned downloads back to pending status.
   * Returns the count of reset items.
   */
  function resetOrphanedDownloads(): DbResult<number> {
    try {
      const countResult = executor.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM download_queue WHERE status = 'downloading'",
      );
      const count = countResult?.count ?? 0;
      
      if (count > 0) {
        executor.execute(`
          UPDATE download_queue
          SET status = 'pending',
              started_at = NULL
          WHERE status = 'downloading'
        `);
      }
      
      return okResult(count);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to reset orphaned downloads: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Schedule a retry for a failed download.
   * Sets status back to 'pending' with a future retry time.
   */
  function scheduleRetry(
    videoId: string,
    errorMessage: string,
    retryCount: number,
    nextRetryAt: Date,
  ): DbResult<QueueItem | null> {
    try {
      const sql = `
        UPDATE download_queue
        SET status = 'pending',
            error_message = ?,
            retry_count = ?,
            next_retry_at = ?,
            completed_at = NULL
        WHERE video_id = ?
        RETURNING *
      `;
      const params = [
        errorMessage,
        retryCount,
        nextRetryAt.toISOString(),
        videoId,
      ];
      const row = executor.queryOne<QueueRow>(sql, params);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to schedule retry: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Reset retry count for a video (used when manually retrying).
   * Clears error message and sets status back to pending.
   */
  function resetRetryCount(videoId: string): DbResult<QueueItem | null> {
    try {
      const sql = `
        UPDATE download_queue
        SET status = 'pending',
            retry_count = 0,
            next_retry_at = NULL,
            error_message = NULL,
            started_at = NULL,
            completed_at = NULL
        WHERE video_id = ?
        RETURNING *
      `;
      const row = executor.queryOne<QueueRow>(sql, [videoId]);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to reset retry count: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Increment throttle retry count and reset to pending status.
   * Used when download is aborted due to throttling detection.
   */
  function incrementThrottleRetry(videoId: string): DbResult<QueueItem | null> {
    try {
      const sql = `
        UPDATE download_queue
        SET status = 'pending',
            throttle_retry_count = throttle_retry_count + 1,
            started_at = NULL,
            completed_at = NULL
        WHERE video_id = ?
        RETURNING *
      `;
      const row = executor.queryOne<QueueRow>(sql, [videoId]);
      return okResult(row ? mapQueueRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to increment throttle retry: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  // ==========================================================================
  // Video User Status (Per-User Video Ownership)
  // ==========================================================================

  /**
   * Add a user as owner of a video.
   */
  function addVideoOwner(videoId: string, userId: string): DbResult<VideoUserStatus> {
    try {
      const sql = `
        INSERT INTO video_user_status (video_id, user_id, is_owner)
        VALUES (?, ?, 1)
        ON CONFLICT(video_id, user_id) DO UPDATE SET
          is_owner = 1,
          deleted_at = NULL
        RETURNING *
      `;
      const row = executor.queryOne<VideoUserStatusRow>(sql, [videoId, userId]);
      if (!row) {
        return errorResult("query_error", "Failed to add video owner");
      }
      return okResult(mapVideoUserStatusRow(row));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to add video owner: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Add multiple users as owners of a video.
   */
  function addVideoOwners(videoId: string, userIds: string[]): DbResult<number> {
    try {
      let count = 0;
      for (const userId of userIds) {
        const result = addVideoOwner(videoId, userId);
        if (result.ok) count++;
      }
      return okResult(count);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to add video owners: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get all owners of a video (users who have it in their library).
   */
  function getVideoOwners(videoId: string): DbResult<VideoUserStatus[]> {
    try {
      const sql = `
        SELECT * FROM video_user_status
        WHERE video_id = ? AND is_owner = 1
        ORDER BY created_at ASC
      `;
      const rows = executor.queryRows<VideoUserStatusRow>(sql, [videoId]);
      return okResult(rows.map(mapVideoUserStatusRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get video owners: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get active owners of a video (not deleted, not keep_forever).
   * These are users who could potentially trigger cleanup.
   */
  function getActiveVideoOwners(videoId: string): DbResult<VideoUserStatus[]> {
    try {
      const sql = `
        SELECT * FROM video_user_status
        WHERE video_id = ? AND is_owner = 1 AND deleted_at IS NULL
        ORDER BY created_at ASC
      `;
      const rows = executor.queryRows<VideoUserStatusRow>(sql, [videoId]);
      return okResult(rows.map(mapVideoUserStatusRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get active video owners: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get video user status for a specific user.
   */
  function getVideoUserStatus(videoId: string, userId: string): DbResult<VideoUserStatus | null> {
    try {
      const sql = "SELECT * FROM video_user_status WHERE video_id = ? AND user_id = ?";
      const row = executor.queryOne<VideoUserStatusRow>(sql, [videoId, userId]);
      return okResult(row ? mapVideoUserStatusRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get video user status: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get all video IDs owned by a user.
   */
  function getUserVideoIds(
    userId: string,
    options: { source?: DownloadSource; includeDeleted?: boolean } = {},
  ): DbResult<string[]> {
    try {
      const conditions = ["vus.user_id = ?", "vus.is_owner = 1"];
      const params: unknown[] = [userId];

      if (!options.includeDeleted) {
        conditions.push("vus.deleted_at IS NULL");
      }

      if (options.source) {
        conditions.push("d.source = ?");
        params.push(options.source);
      }

      // Only include videos where files still exist
      conditions.push("d.files_deleted_at IS NULL");

      const sql = `
        SELECT DISTINCT vus.video_id
        FROM video_user_status vus
        JOIN downloads d ON d.video_id = vus.video_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY d.downloaded_at DESC
      `;
      const rows = executor.queryRows<{ video_id: string }>(sql, params);
      return okResult(rows.map((r) => r.video_id));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user video IDs: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get downloads for a user (with pagination).
   */
  function getUserDownloads(
    userId: string,
    options: {
      source?: DownloadSource;
      limit?: number;
      offset?: number;
    } = {},
  ): DbResult<Download[]> {
    try {
      const conditions = ["vus.user_id = ?", "vus.is_owner = 1", "vus.deleted_at IS NULL"];
      const params: unknown[] = [userId];

      if (options.source) {
        conditions.push("d.source = ?");
        params.push(options.source);
      }

      // Only include videos where files still exist
      conditions.push("d.files_deleted_at IS NULL");

      let sql = `
        SELECT d.*
        FROM downloads d
        JOIN video_user_status vus ON vus.video_id = d.video_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY d.downloaded_at DESC
      `;

      if (options.limit !== undefined) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }

      if (options.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }

      const rows = executor.queryRows<DownloadRow>(sql, params);
      return okResult(rows.map(mapDownloadRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user downloads: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get count of user's downloads.
   */
  function getUserDownloadsCount(
    userId: string,
    options: { source?: DownloadSource } = {},
  ): DbResult<number> {
    try {
      const conditions = ["vus.user_id = ?", "vus.is_owner = 1", "vus.deleted_at IS NULL"];
      const params: unknown[] = [userId];

      if (options.source) {
        conditions.push("d.source = ?");
        params.push(options.source);
      }

      conditions.push("d.files_deleted_at IS NULL");

      const sql = `
        SELECT COUNT(*) as count
        FROM downloads d
        JOIN video_user_status vus ON vus.video_id = d.video_id
        WHERE ${conditions.join(" AND ")}
      `;
      const row = executor.queryOne<{ count: number }>(sql, params);
      return okResult(row?.count ?? 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user downloads count: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get user's download stats.
   */
  function getUserDownloadStats(userId: string): DbResult<{ count: number; totalBytes: number }> {
    try {
      const sql = `
        SELECT COUNT(*) as count, COALESCE(SUM(d.file_size_bytes), 0) as total_bytes
        FROM downloads d
        JOIN video_user_status vus ON vus.video_id = d.video_id
        WHERE vus.user_id = ? AND vus.is_owner = 1 AND vus.deleted_at IS NULL
          AND d.files_deleted_at IS NULL
      `;
      const row = executor.queryOne<{ count: number; total_bytes: number }>(sql, [userId]);
      return okResult({
        count: row?.count ?? 0,
        totalBytes: row?.total_bytes ?? 0,
      });
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user download stats: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Set keep_forever flag for a video/user.
   */
  function setKeepForever(videoId: string, userId: string, keep: boolean): DbResult<VideoUserStatus | null> {
    try {
      const sql = `
        UPDATE video_user_status
        SET keep_forever = ?
        WHERE video_id = ? AND user_id = ?
        RETURNING *
      `;
      const row = executor.queryOne<VideoUserStatusRow>(sql, [keep ? 1 : 0, videoId, userId]);
      return okResult(row ? mapVideoUserStatusRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to set keep forever: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Mark a video as deleted for a user.
   */
  function markVideoDeletedForUser(videoId: string, userId: string): DbResult<VideoUserStatus | null> {
    try {
      const sql = `
        UPDATE video_user_status
        SET deleted_at = datetime('now')
        WHERE video_id = ? AND user_id = ?
        RETURNING *
      `;
      const row = executor.queryOne<VideoUserStatusRow>(sql, [videoId, userId]);
      return okResult(row ? mapVideoUserStatusRow(row) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to mark video deleted for user: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get count of active owners for a video (not deleted).
   */
  function getActiveOwnerCount(videoId: string): DbResult<number> {
    try {
      const sql = `
        SELECT COUNT(*) as count
        FROM video_user_status
        WHERE video_id = ? AND is_owner = 1 AND deleted_at IS NULL
      `;
      const row = executor.queryOne<{ count: number }>(sql, [videoId]);
      return okResult(row?.count ?? 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get active owner count: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Check if any owner has keep_forever set.
   */
  function hasActiveKeepForever(videoId: string): DbResult<boolean> {
    try {
      const sql = `
        SELECT 1 FROM video_user_status
        WHERE video_id = ? AND is_owner = 1 AND deleted_at IS NULL AND keep_forever = 1
        LIMIT 1
      `;
      const row = executor.queryOne<{ "1": number }>(sql, [videoId]);
      return okResult(row !== undefined);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to check keep forever: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Mark files as deleted for a download.
   */
  function markFilesDeleted(videoId: string): DbResult<boolean> {
    try {
      executor.execute(
        "UPDATE downloads SET files_deleted_at = datetime('now') WHERE video_id = ?",
        [videoId],
      );
      return okResult(true);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to mark files deleted: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get subscription downloads that are candidates for cleanup.
   * Returns videos where:
   * - source = 'subscription'
   * - files_deleted_at IS NULL (files still exist)
   * - downloaded_at < NOW() - olderThanDays
   */
  function getCleanupCandidates(olderThanDays: number): DbResult<Download[]> {
    try {
      const sql = `
        SELECT * FROM downloads
        WHERE source = 'subscription'
          AND files_deleted_at IS NULL
          AND datetime(downloaded_at) < datetime('now', '-' || ? || ' days')
        ORDER BY downloaded_at ASC
      `;
      const rows = executor.queryRows<DownloadRow>(sql, [olderThanDays]);
      return okResult(rows.map(mapDownloadRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get cleanup candidates: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get queue items for a specific user.
   */
  function getUserQueue(userId: string, options: QueueQueryOptions = {}): DbResult<QueueItem[]> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      // Filter by video_user_status ownership
      conditions.push(`video_id IN (
        SELECT video_id FROM video_user_status 
        WHERE user_id = ? AND is_owner = 1 AND deleted_at IS NULL
      )`);
      params.push(userId);

      if (options.status !== undefined) {
        if (Array.isArray(options.status)) {
          const placeholders = options.status.map(() => "?").join(", ");
          conditions.push(`status IN (${placeholders})`);
          params.push(...options.status);
        } else {
          conditions.push("status = ?");
          params.push(options.status);
        }
      }

      const whereClause = `WHERE ${conditions.join(" AND ")}`;
      let sql = `SELECT * FROM download_queue ${whereClause} ORDER BY priority DESC, queued_at ASC`;

      if (options.limit !== undefined) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
      }

      if (options.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }

      const rows = executor.queryRows<QueueRow>(sql, params);
      return okResult(rows.map(mapQueueRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user queue: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get queue source for a video.
   */
  function getQueueSource(videoId: string): DbResult<DownloadSource | null> {
    try {
      const sql = "SELECT source FROM download_queue WHERE video_id = ?";
      const row = executor.queryOne<{ source: string }>(sql, [videoId]);
      return okResult(row ? (row.source as DownloadSource) : null);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get queue source: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  // ==========================================================================
  // Channel Exclusions
  // ==========================================================================

  /**
   * Add channel exclusion.
   */
  function addExclusion(channelId: string, userId?: string | null): DbResult<ChannelExclusion> {
    try {
      const sql = `
        INSERT INTO channel_exclusions (channel_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(channel_id, user_id) DO NOTHING
        RETURNING *
      `;
      const row = executor.queryOne<ExclusionRow>(sql, [channelId, userId ?? null]);

      // If no row returned, it already exists - fetch it
      if (!row) {
        const existing = executor.queryOne<ExclusionRow>(
          "SELECT * FROM channel_exclusions WHERE channel_id = ? AND user_id IS ?",
          [channelId, userId ?? null],
        );
        if (existing) {
          return okResult(mapExclusionRow(existing));
        }
        return errorResult("query_error", "Failed to add exclusion");
      }

      return okResult(mapExclusionRow(row));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to add exclusion: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Remove channel exclusion.
   */
  function removeExclusion(channelId: string, userId?: string | null): DbResult<boolean> {
    try {
      executor.execute(
        "DELETE FROM channel_exclusions WHERE channel_id = ? AND user_id IS ?",
        [channelId, userId ?? null],
      );
      return okResult(true);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to remove exclusion: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Check if channel is excluded.
   */
  function isExcluded(channelId: string, userId?: string | null): DbResult<boolean> {
    try {
      const row = executor.queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM channel_exclusions WHERE channel_id = ? AND (user_id IS ? OR user_id IS NULL)",
        [channelId, userId ?? null],
      );
      return okResult((row?.count ?? 0) > 0);
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to check exclusion: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get all exclusions for a user.
   */
  function getExclusions(userId?: string | null): DbResult<ChannelExclusion[]> {
    try {
      let sql: string;
      let params: unknown[];

      if (userId !== undefined) {
        sql = "SELECT * FROM channel_exclusions WHERE user_id IS ? OR user_id IS NULL ORDER BY excluded_at DESC";
        params = [userId];
      } else {
        sql = "SELECT * FROM channel_exclusions ORDER BY excluded_at DESC";
        params = [];
      }

      const rows = executor.queryRows<ExclusionRow>(sql, params);
      return okResult(rows.map(mapExclusionRow));
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get exclusions: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get list of excluded channel IDs.
   */
  function getExcludedChannelIds(userId?: string | null): DbResult<string[]> {
    const result = getExclusions(userId);
    if (!result.ok) return result;
    return okResult([...new Set(result.data.map((e) => e.channelId))]);
  }

  /**
   * Close the database connection.
   */
  function close(): void {
    executor.close();
  }

  return {
    init,
    // Downloads
    addDownload,
    getDownload,
    isDownloaded,
    getDownloads,
    getDownloadsCount,
    deleteDownload,
    getDownloadStats,
    markFilesDeleted,
    getCleanupCandidates,
    // Queue
    addToQueue,
    getQueue,
    getNextQueueItem,
    updateQueueStatus,
    removeFromQueue,
    isInQueue,
    getQueueItem,
    clearCompletedQueue,
    getOrphanedDownloads,
    resetOrphanedDownloads,
    scheduleRetry,
    resetRetryCount,
    incrementThrottleRetry,
    getQueueSource,
    // Video User Status
    addVideoOwner,
    addVideoOwners,
    getVideoOwners,
    getActiveVideoOwners,
    getVideoUserStatus,
    getUserVideoIds,
    getUserDownloads,
    getUserDownloadsCount,
    getUserDownloadStats,
    getUserQueue,
    setKeepForever,
    markVideoDeletedForUser,
    getActiveOwnerCount,
    hasActiveKeepForever,
    // Exclusions
    addExclusion,
    removeExclusion,
    isExcluded,
    getExclusions,
    getExcludedChannelIds,
    // Lifecycle
    close,
  };
}

// ============================================================================
// SQLite Executor Factory
// ============================================================================

// deno-lint-ignore no-explicit-any
type SqliteParams = any[];

/**
 * Create a SQLite executor using the sqlite library.
 */
export async function createSqliteExecutor(dbPath: string): Promise<SqliteExecutor> {
  const { DB } = await import("sqlite");
  const db = new DB(dbPath);

  return {
    execute(sql: string, params: unknown[] = []): void {
      if (params.length === 0) {
        db.execute(sql);
      } else {
        // Use prepared query for parameterized execution
        const query = db.prepareQuery(sql);
        try {
          query.execute(params as SqliteParams);
        } finally {
          query.finalize();
        }
      }
    },

    queryRows<T>(sql: string, params: unknown[] = []): T[] {
      // deno-lint-ignore no-explicit-any
      return db.queryEntries(sql, params as SqliteParams) as any as T[];
    },

    queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
      // deno-lint-ignore no-explicit-any
      const rows = db.queryEntries(sql, params as SqliteParams) as any as T[];
      return rows[0];
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * Type for the local DB client.
 */
export type LocalDbClient = ReturnType<typeof createLocalDb>;
