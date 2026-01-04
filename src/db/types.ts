/**
 * Database types for Invidious Downloader.
 * Covers both Invidious PostgreSQL (read-only) and local SQLite.
 */

// ============================================================================
// Invidious PostgreSQL Types (read-only)
// ============================================================================

/**
 * User from Invidious database.
 */
export interface InvidiousUser {
  email: string;
  subscriptions: string[]; // Array of channel UCIDs
}

/**
 * Channel video from Invidious database.
 */
export interface ChannelVideo {
  id: string; // Video ID
  ucid: string; // Channel UCID
  title: string;
  published: Date;
  lengthSeconds: number;
  liveNow: boolean;
  premiere: boolean;
  views: number;
}

/**
 * Channel info from Invidious database.
 */
export interface Channel {
  id: string; // UCID
  author: string;
  updated: Date;
}

// ============================================================================
// Local SQLite Types
// ============================================================================

/**
 * Download source type.
 */
export type DownloadSource = "subscription" | "manual";

/**
 * Downloaded video record.
 */
export interface Download {
  videoId: string;
  userId: string | null;
  channelId: string;
  title: string;
  durationSeconds: number;
  quality: string;
  filePath: string;
  thumbnailPath: string | null;
  metadata: DownloadMetadata;
  downloadedAt: Date;
  fileSizeBytes: number;
  /** How this video was downloaded */
  source: DownloadSource;
  /** When files were deleted by cleanup (null = files exist) */
  filesDeletedAt: Date | null;
}

/**
 * Video ownership and status per user.
 */
export interface VideoUserStatus {
  videoId: string;
  userId: string;
  /** User was subscribed when video was downloaded */
  isOwner: boolean;
  /** User wants to keep this video forever (no auto-delete) */
  keepForever: boolean;
  /** When user "deleted" this video from their view (null = active) */
  deletedAt: Date | null;
  createdAt: Date;
}

/**
 * Metadata stored with downloads.
 */
export interface DownloadMetadata {
  author: string;
  description?: string;
  viewCount?: number;
  publishedAt?: string;
  videoItag?: number;
  audioItag?: number;
  width?: number;
  height?: number;
  /** Video stream mimeType (e.g., "video/mp4; codecs=\"avc1.640028\"") */
  videoMimeType?: string;
  /** Audio stream mimeType (e.g., "audio/webm; codecs=\"opus\"") */
  audioMimeType?: string;
  /** Video bitrate in bits per second */
  videoBitrate?: number;
  /** Audio bitrate in bits per second */
  audioBitrate?: number;
  /** Video stream content length in bytes */
  videoContentLength?: number;
  /** Audio stream content length in bytes */
  audioContentLength?: number;
  /** Audio file extension (e.g., "m4a", "webm") */
  audioExtension?: string;
}

/**
 * Channel exclusion record.
 */
export interface ChannelExclusion {
  channelId: string;
  userId: string | null;
  excludedAt: Date;
}

/**
 * Download queue status.
 */
export type QueueStatus =
  | "pending"
  | "downloading"
  | "muxing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Download queue item.
 */
export interface QueueItem {
  id: number;
  videoId: string;
  userId: string | null;
  priority: number;
  status: QueueStatus;
  errorMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  retryCount: number;
  nextRetryAt: Date | null;
  source: DownloadSource;
  /** Separate retry counter for throttle-related failures */
  throttleRetryCount: number;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Generic database result type for error handling.
 */
export type DbResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DbError };

/**
 * Database error types.
 */
export type DbErrorType =
  | "connection_error"
  | "query_error"
  | "not_found"
  | "constraint_error"
  | "unknown";

export interface DbError {
  type: DbErrorType;
  message: string;
  cause?: unknown;
}

// ============================================================================
// Query Parameter Types
// ============================================================================

/**
 * Options for fetching latest videos.
 */
export interface LatestVideosOptions {
  /** Channel UCIDs to fetch videos from */
  channelIds: string[];
  /** Only fetch videos published after this date */
  publishedAfter?: Date;
  /** Maximum number of videos to return */
  limit?: number;
  /** Exclude live streams */
  excludeLive?: boolean;
  /** Exclude premieres */
  excludePremieres?: boolean;
  /** Minimum video duration in seconds */
  minDurationSeconds?: number;
}

/**
 * Options for queue queries.
 */
export interface QueueQueryOptions {
  status?: QueueStatus | QueueStatus[];
  userId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Options for download queries.
 */
export interface DownloadQueryOptions {
  userId?: string;
  channelId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "downloadedAt" | "title" | "fileSizeBytes";
  orderDir?: "asc" | "desc";
}
