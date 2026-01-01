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
  QueueItem,
  QueueQueryOptions,
  QueueStatus,
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
}

interface ExclusionRow {
  channel_id: string;
  user_id: string | null;
  excluded_at: string;
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
}

/**
 * Input for adding to queue.
 */
export interface AddToQueueInput {
  videoId: string;
  userId?: string | null;
  priority?: number;
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
          quality, file_path, thumbnail_path, metadata, file_size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          quality = excluded.quality,
          file_path = excluded.file_path,
          thumbnail_path = excluded.thumbnail_path,
          metadata = excluded.metadata,
          file_size_bytes = excluded.file_size_bytes,
          downloaded_at = datetime('now')
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
   * Check if a video is downloaded.
   */
  function isDownloaded(videoId: string): DbResult<boolean> {
    const result = getDownload(videoId);
    if (!result.ok) return result;
    return okResult(result.data !== null);
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

  // ==========================================================================
  // Queue
  // ==========================================================================

  /**
   * Add video to download queue.
   */
  function addToQueue(input: AddToQueueInput): DbResult<QueueItem> {
    try {
      const sql = `
        INSERT INTO download_queue (video_id, user_id, priority)
        VALUES (?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          priority = MAX(download_queue.priority, excluded.priority)
        RETURNING *
      `;
      const params = [input.videoId, input.userId ?? null, input.priority ?? 0];

      const row = executor.queryOne<QueueRow>(sql, params);
      if (!row) {
        return errorResult("query_error", "Failed to add to queue");
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
   */
  function getNextQueueItem(): DbResult<QueueItem | null> {
    try {
      const sql = `
        SELECT * FROM download_queue
        WHERE status = 'pending'
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
    deleteDownload,
    getDownloadStats,
    // Queue
    addToQueue,
    getQueue,
    getNextQueueItem,
    updateQueueStatus,
    removeFromQueue,
    isInQueue,
    clearCompletedQueue,
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
