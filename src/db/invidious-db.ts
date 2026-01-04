/**
 * Invidious PostgreSQL database client.
 * Read-only access to fetch subscriptions and channel videos.
 *
 * Design:
 * - Pure query builder functions (testable without DB)
 * - SQL executor interface for dependency injection
 * - Row mapper functions for type safety
 */

import type {
  Channel,
  ChannelVideo,
  DbError,
  DbResult,
  InvidiousUser,
  LatestVideosOptions,
} from "./types.ts";

// ============================================================================
// SQL Executor Interface (for dependency injection)
// ============================================================================

/**
 * Row type from PostgreSQL query result.
 */
export type SqlRow = Record<string, unknown>;

/**
 * SQL executor interface.
 * Allows injecting mock executor for tests.
 */
export interface SqlExecutor {
  queryRows<T extends SqlRow = SqlRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
  close(): Promise<void>;
}

// ============================================================================
// Row Mappers (pure functions)
// ============================================================================

/**
 * Map database row to InvidiousUser.
 */
export function mapUserRow(row: SqlRow): InvidiousUser {
  return {
    email: String(row.email ?? ""),
    subscriptions: parseSubscriptions(row.subscriptions),
  };
}

/**
 * Parse subscriptions from PostgreSQL array format.
 * Handles both array and string representations.
 */
export function parseSubscriptions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter((s) => s.length > 0);
  }

  if (typeof value === "string") {
    // PostgreSQL array string format: {UC...,UC...}
    if (value.startsWith("{") && value.endsWith("}")) {
      const inner = value.slice(1, -1);
      if (inner.length === 0) return [];
      return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    }
    // Try JSON parse
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(String).filter((s) => s.length > 0);
      }
    } catch {
      // Not JSON
    }
  }

  return [];
}

/**
 * Map database row to ChannelVideo.
 */
export function mapChannelVideoRow(row: SqlRow): ChannelVideo {
  return {
    id: String(row.id ?? ""),
    ucid: String(row.ucid ?? ""),
    title: String(row.title ?? ""),
    published: row.published instanceof Date
      ? row.published
      : new Date(String(row.published ?? 0)),
    lengthSeconds: Number(row.length_seconds ?? 0),
    liveNow: Boolean(row.live_now ?? false),
    premiere: Boolean(row.premiere_timestamp != null),
    views: Number(row.views ?? 0),
  };
}

/**
 * Map database row to Channel.
 */
export function mapChannelRow(row: SqlRow): Channel {
  return {
    id: String(row.id ?? ""),
    author: String(row.author ?? ""),
    updated: row.updated instanceof Date
      ? row.updated
      : new Date(String(row.updated ?? 0)),
  };
}

// ============================================================================
// Query Builders (pure functions)
// ============================================================================

/**
 * Build query to get user by email.
 */
export function buildGetUserQuery(email: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT email, subscriptions FROM users WHERE email = $1`,
    params: [email],
  };
}

/**
 * Build query to get all users with subscriptions.
 */
export function buildGetAllUsersQuery(): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT email, subscriptions FROM users WHERE array_length(subscriptions, 1) > 0`,
    params: [],
  };
}

/**
 * Build query to get latest videos from channels.
 */
export function buildLatestVideosQuery(options: LatestVideosOptions): {
  sql: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Channel filter (required)
  if (options.channelIds.length === 0) {
    return { sql: "SELECT * FROM channel_videos WHERE false", params: [] };
  }

  conditions.push(`ucid = ANY($${paramIndex})`);
  params.push(options.channelIds);
  paramIndex++;

  // Published after filter
  if (options.publishedAfter) {
    conditions.push(`published > $${paramIndex}`);
    params.push(options.publishedAfter);
    paramIndex++;
  }

  // Exclude live streams
  if (options.excludeLive) {
    conditions.push(`live_now = false`);
  }

  // Exclude premieres
  if (options.excludePremieres) {
    conditions.push(`premiere_timestamp IS NULL`);
  }

  // Minimum duration
  if (options.minDurationSeconds !== undefined && options.minDurationSeconds > 0) {
    conditions.push(`length_seconds >= $${paramIndex}`);
    params.push(options.minDurationSeconds);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = options.limit ? `LIMIT $${paramIndex}` : "";
  if (options.limit) {
    params.push(options.limit);
  }

  const sql = `
    SELECT id, ucid, title, published, length_seconds, live_now, premiere_timestamp, views
    FROM channel_videos
    ${whereClause}
    ORDER BY published DESC
    ${limitClause}
  `.trim();

  return { sql, params };
}

/**
 * Build query to get channel info.
 */
export function buildGetChannelQuery(ucid: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT id, author, updated FROM channels WHERE id = $1`,
    params: [ucid],
  };
}

/**
 * Build query to get multiple channels.
 */
export function buildGetChannelsQuery(ucids: string[]): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT id, author, updated FROM channels WHERE id = ANY($1)`,
    params: [ucids],
  };
}

/**
 * Build query to get the maximum published timestamp from channel videos.
 * Used for quick-checking if any new videos exist.
 */
export function buildGetMaxPublishedQuery(channelIds: string[]): {
  sql: string;
  params: unknown[];
} {
  if (channelIds.length === 0) {
    return { sql: "SELECT NULL as max_published", params: [] };
  }
  return {
    sql: `SELECT MAX(published) as max_published FROM channel_videos WHERE ucid = ANY($1)`,
    params: [channelIds],
  };
}

/**
 * Build query to get user email from session ID.
 */
export function buildGetUserBySessionIdQuery(sessionId: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT email FROM session_ids WHERE id = $1`,
    params: [sessionId],
  };
}

/**
 * Build query to check if a user has watched a video.
 */
export function buildHasUserWatchedVideoQuery(userId: string, videoId: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT $2 = ANY(watched) as watched FROM users WHERE email = $1`,
    params: [userId, videoId],
  };
}

/**
 * Build query to get which videos from a list a user has watched.
 */
export function buildGetWatchedVideoIdsQuery(userId: string, videoIds: string[]): {
  sql: string;
  params: unknown[];
} {
  if (videoIds.length === 0) {
    return { sql: "SELECT NULL as video_id WHERE false", params: [] };
  }
  return {
    sql: `
      SELECT unnest(watched) as video_id 
      FROM users 
      WHERE email = $1 AND watched && $2
    `,
    params: [userId, videoIds],
  };
}

/**
 * Build query to get all users subscribed to a channel.
 */
export function buildGetUsersSubscribedToChannelQuery(channelId: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `SELECT email FROM users WHERE $1 = ANY(subscriptions)`,
    params: [channelId],
  };
}

// ============================================================================
// Invidious Database Client
// ============================================================================

/**
 * Create error result helper.
 */
function errorResult<T>(
  type: DbError["type"],
  message: string,
  cause?: unknown,
): DbResult<T> {
  return {
    ok: false,
    error: { type, message, cause },
  };
}

/**
 * Create an Invidious database client.
 */
export function createInvidiousDb(executor: SqlExecutor) {
  /**
   * Get user by email.
   */
  async function getUser(email: string): Promise<DbResult<InvidiousUser>> {
    try {
      const { sql, params } = buildGetUserQuery(email);
      const row = await executor.queryOne(sql, params);

      if (!row) {
        return errorResult("not_found", `User not found: ${email}`);
      }

      return { ok: true, data: mapUserRow(row) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get all users with subscriptions.
   */
  async function getAllUsers(): Promise<DbResult<InvidiousUser[]>> {
    try {
      const { sql, params } = buildGetAllUsersQuery();
      const rows = await executor.queryRows(sql, params);
      return { ok: true, data: rows.map(mapUserRow) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get users: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get subscriptions for a user.
   */
  async function getSubscriptions(email: string): Promise<DbResult<string[]>> {
    const result = await getUser(email);
    if (!result.ok) return result;
    return { ok: true, data: result.data.subscriptions };
  }

  /**
   * Get latest videos from specified channels.
   */
  async function getLatestVideos(
    options: LatestVideosOptions,
  ): Promise<DbResult<ChannelVideo[]>> {
    try {
      const { sql, params } = buildLatestVideosQuery(options);
      const rows = await executor.queryRows(sql, params);
      return { ok: true, data: rows.map(mapChannelVideoRow) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get videos: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get channel info.
   */
  async function getChannel(ucid: string): Promise<DbResult<Channel>> {
    try {
      const { sql, params } = buildGetChannelQuery(ucid);
      const row = await executor.queryOne(sql, params);

      if (!row) {
        return errorResult("not_found", `Channel not found: ${ucid}`);
      }

      return { ok: true, data: mapChannelRow(row) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get channel: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get multiple channels.
   */
  async function getChannels(ucids: string[]): Promise<DbResult<Channel[]>> {
    try {
      if (ucids.length === 0) {
        return { ok: true, data: [] };
      }
      const { sql, params } = buildGetChannelsQuery(ucids);
      const rows = await executor.queryRows(sql, params);
      return { ok: true, data: rows.map(mapChannelRow) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get channels: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get the maximum published timestamp from videos of specified channels.
   * Used for quick-checking if any new videos exist since last check.
   */
  async function getMaxPublishedTimestamp(
    channelIds: string[],
  ): Promise<DbResult<Date | null>> {
    try {
      if (channelIds.length === 0) {
        return { ok: true, data: null };
      }
      const { sql, params } = buildGetMaxPublishedQuery(channelIds);
      const row = await executor.queryOne(sql, params);
      
      if (!row || row.max_published === null) {
        return { ok: true, data: null };
      }
      
      const maxPublished = row.max_published instanceof Date
        ? row.max_published
        : new Date(String(row.max_published));
      
      return { ok: true, data: maxPublished };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get max published timestamp: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get user email from session ID.
   * Returns null if session is invalid or expired.
   */
  async function getUserBySessionId(sessionId: string): Promise<DbResult<string | null>> {
    try {
      const { sql, params } = buildGetUserBySessionIdQuery(sessionId);
      const row = await executor.queryOne(sql, params);
      
      if (!row || !row.email) {
        return { ok: true, data: null };
      }
      
      return { ok: true, data: String(row.email) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get user by session ID: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Check if a user has watched a specific video.
   */
  async function hasUserWatchedVideo(userId: string, videoId: string): Promise<DbResult<boolean>> {
    try {
      const { sql, params } = buildHasUserWatchedVideoQuery(userId, videoId);
      const row = await executor.queryOne(sql, params);
      
      if (!row) {
        return { ok: true, data: false };
      }
      
      return { ok: true, data: Boolean(row.watched) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to check if user watched video: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get list of video IDs that a user has watched from a given list.
   */
  async function getWatchedVideoIds(userId: string, videoIds: string[]): Promise<DbResult<string[]>> {
    try {
      if (videoIds.length === 0) {
        return { ok: true, data: [] };
      }
      
      const { sql, params } = buildGetWatchedVideoIdsQuery(userId, videoIds);
      const rows = await executor.queryRows(sql, params);
      
      // Filter to only include videos from our input list
      const videoIdSet = new Set(videoIds);
      const watchedIds = rows
        .map((r) => String(r.video_id))
        .filter((id) => videoIdSet.has(id));
      
      return { ok: true, data: watchedIds };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get watched video IDs: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Get all users subscribed to a specific channel.
   */
  async function getUsersSubscribedToChannel(channelId: string): Promise<DbResult<string[]>> {
    try {
      const { sql, params } = buildGetUsersSubscribedToChannelQuery(channelId);
      const rows = await executor.queryRows(sql, params);
      
      return { ok: true, data: rows.map((r) => String(r.email)) };
    } catch (error) {
      return errorResult(
        "query_error",
        `Failed to get users subscribed to channel: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
      );
    }
  }

  /**
   * Close the database connection.
   */
  async function close(): Promise<void> {
    await executor.close();
  }

  return {
    getUser,
    getAllUsers,
    getSubscriptions,
    getLatestVideos,
    getChannel,
    getChannels,
    getMaxPublishedTimestamp,
    getUserBySessionId,
    hasUserWatchedVideo,
    getWatchedVideoIds,
    getUsersSubscribedToChannel,
    close,
  };
}

// ============================================================================
// PostgreSQL Executor Factory
// ============================================================================

/**
 * Create a PostgreSQL executor using the deno-postgres library.
 * This is the only impure function - it creates the actual DB connection.
 */
export async function createPostgresExecutor(
  connectionString: string,
): Promise<SqlExecutor> {
  // Dynamic import to avoid requiring postgres for tests
  const { Pool } = await import("postgres");
  const pool = new Pool(connectionString, 5, true);

  return {
    async queryRows<T extends SqlRow>(
      query: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const client = await pool.connect();
      try {
        const result = await client.queryObject(query, params);
        return result.rows as T[];
      } finally {
        client.release();
      }
    },

    async queryOne<T extends SqlRow>(
      query: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      const client = await pool.connect();
      try {
        const result = await client.queryObject(query, params);
        return (result.rows[0] as T) ?? null;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Type for the Invidious DB client.
 */
export type InvidiousDbClient = ReturnType<typeof createInvidiousDb>;
