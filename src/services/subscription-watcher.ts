/**
 * Subscription Watcher Service.
 *
 * Periodically checks Invidious database for new videos from subscribed channels
 * and queues them for download.
 *
 * Design:
 * - Pure functions for filtering and selection logic
 * - Dependency injection for database clients
 * - Configurable check interval
 * - Respects channel exclusions
 */

import type { InvidiousDbClient } from "../db/invidious-db.ts";
import type { LocalDbClient } from "../db/local-db.ts";
import type { ChannelVideo, LatestVideosOptions, QueueItem, Download } from "../db/types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the subscription watcher.
 */
export interface WatcherConfig {
  /** Check interval in milliseconds */
  checkIntervalMs: number;
  /** User email to watch subscriptions for (null = all users) */
  userId: string | null;
  /** Only queue videos published after this date */
  publishedAfter?: Date;
  /** Exclude live streams */
  excludeLive: boolean;
  /** Exclude premieres */
  excludePremieres: boolean;
  /** Minimum video duration in seconds (0 = no minimum) */
  minDurationSeconds: number;
  /** Maximum videos to queue per check */
  maxVideosPerCheck: number;
}

/**
 * Default watcher configuration.
 */
export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  userId: null,
  excludeLive: true,
  excludePremieres: true,
  minDurationSeconds: 60, // At least 1 minute
  maxVideosPerCheck: 50,
};

/**
 * Watcher state.
 */
export interface WatcherState {
  isRunning: boolean;
  lastCheckAt: Date | null;
  lastCheckDurationMs: number | null;
  videosQueuedTotal: number;
  checksCompleted: number;
  errors: WatcherError[];
  /** Tracks the newest video timestamp we've seen - used for quick-check optimization */
  lastSeenVideoTimestamp: Date | null;
}

/**
 * Watcher error.
 */
export interface WatcherError {
  timestamp: Date;
  type: "db_error" | "queue_error" | "unknown";
  message: string;
}

/**
 * Check result.
 */
export interface CheckResult {
  ok: boolean;
  videosFound: number;
  videosQueued: number;
  videosSkipped: number;
  durationMs: number;
  error?: string;
}

/**
 * Video filter result.
 */
export interface FilteredVideos {
  toQueue: ChannelVideo[];
  skipped: {
    video: ChannelVideo;
    reason: SkipReason;
  }[];
}

export type SkipReason =
  | "already_downloaded"
  | "already_queued"
  | "channel_excluded"
  | "too_short"
  | "is_live"
  | "is_premiere";

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Filter videos based on configuration and existing data.
 *
 * @param videos - Videos to filter
 * @param config - Watcher configuration
 * @param downloadedIds - Set of already downloaded video IDs
 * @param queuedIds - Set of already queued video IDs
 * @param excludedChannels - Set of excluded channel IDs
 * @returns Filtered videos with reasons for skipping
 */
export function filterVideos(
  videos: ChannelVideo[],
  config: WatcherConfig,
  downloadedIds: Set<string>,
  queuedIds: Set<string>,
  excludedChannels: Set<string>,
): FilteredVideos {
  const toQueue: ChannelVideo[] = [];
  const skipped: FilteredVideos["skipped"] = [];

  for (const video of videos) {
    // Check if already downloaded
    if (downloadedIds.has(video.id)) {
      skipped.push({ video, reason: "already_downloaded" });
      continue;
    }

    // Check if already queued
    if (queuedIds.has(video.id)) {
      skipped.push({ video, reason: "already_queued" });
      continue;
    }

    // Check if channel is excluded
    if (excludedChannels.has(video.ucid)) {
      skipped.push({ video, reason: "channel_excluded" });
      continue;
    }

    // Check duration
    if (config.minDurationSeconds > 0 && video.lengthSeconds < config.minDurationSeconds) {
      skipped.push({ video, reason: "too_short" });
      continue;
    }

    // Check if live
    if (config.excludeLive && video.liveNow) {
      skipped.push({ video, reason: "is_live" });
      continue;
    }

    // Check if premiere
    if (config.excludePremieres && video.premiere) {
      skipped.push({ video, reason: "is_premiere" });
      continue;
    }

    // Passed all filters
    toQueue.push(video);
  }

  return { toQueue, skipped };
}

/**
 * Sort videos by priority for queueing.
 * Newer videos get higher priority.
 */
export function sortVideosByPriority(videos: ChannelVideo[]): ChannelVideo[] {
  return [...videos].sort((a, b) => b.published.getTime() - a.published.getTime());
}

/**
 * Calculate the "published after" date for first run.
 * Defaults to 24 hours ago to avoid queuing entire video history.
 */
export function getDefaultPublishedAfter(): Date {
  const date = new Date();
  date.setDate(date.getDate() - 1); // 24 hours ago
  return date;
}

/**
 * Merge configuration with defaults.
 */
export function mergeConfig(
  partial: Partial<WatcherConfig>,
): WatcherConfig {
  return {
    ...DEFAULT_WATCHER_CONFIG,
    ...partial,
  };
}

/**
 * Helper: Get all downloaded video IDs from local database.
 */
function getDownloadedVideoIds(localDb: LocalDbClient): Set<string> {
  const result = localDb.getDownloads({ limit: 10000 });
  if (!result.ok) return new Set();
  return new Set(result.data.map((d: Download) => d.videoId));
}

/**
 * Helper: Get all queued video IDs from local database.
 */
function getQueuedVideoIds(localDb: LocalDbClient): Set<string> {
  // Get pending and downloading items
  const pendingResult = localDb.getQueue({ status: "pending", limit: 10000 });
  const downloadingResult = localDb.getQueue({ status: "downloading", limit: 10000 });
  
  const ids = new Set<string>();
  if (pendingResult.ok) {
    for (const item of pendingResult.data) {
      ids.add(item.videoId);
    }
  }
  if (downloadingResult.ok) {
    for (const item of downloadingResult.data) {
      ids.add(item.videoId);
    }
  }
  return ids;
}

// ============================================================================
// Watcher Service
// ============================================================================

/**
 * Dependencies for the subscription watcher.
 */
export interface WatcherDependencies {
  invidiousDb: InvidiousDbClient;
  localDb: LocalDbClient;
}

/**
 * Create a subscription watcher service.
 */
export function createSubscriptionWatcher(
  deps: WatcherDependencies,
  config: Partial<WatcherConfig> = {},
) {
  const fullConfig = mergeConfig(config);
  let state: WatcherState = {
    isRunning: false,
    lastCheckAt: null,
    lastCheckDurationMs: null,
    videosQueuedTotal: 0,
    checksCompleted: 0,
    errors: [],
    lastSeenVideoTimestamp: null,
  };
  let intervalId: number | null = null;
  let publishedAfter: Date = fullConfig.publishedAfter ?? getDefaultPublishedAfter();

  /**
   * Perform a single check for new videos.
   */
  async function check(): Promise<CheckResult> {
    const startTime = Date.now();

    try {
      // 1. Get subscribed channels
      let channelIds: string[];
      
      if (fullConfig.userId) {
        // Get subscriptions for specific user
        const subscriptionsResult = await deps.invidiousDb.getSubscriptions(fullConfig.userId);
        if (!subscriptionsResult.ok) {
          const error = `Failed to get subscriptions: ${subscriptionsResult.error.message}`;
          addError("db_error", error);
          return {
            ok: false,
            videosFound: 0,
            videosQueued: 0,
            videosSkipped: 0,
            durationMs: Date.now() - startTime,
            error,
          };
        }
        channelIds = subscriptionsResult.data;
      } else {
        // Get all users and merge their subscriptions
        const usersResult = await deps.invidiousDb.getAllUsers();
        if (!usersResult.ok) {
          const error = `Failed to get users: ${usersResult.error.message}`;
          addError("db_error", error);
          return {
            ok: false,
            videosFound: 0,
            videosQueued: 0,
            videosSkipped: 0,
            durationMs: Date.now() - startTime,
            error,
          };
        }
        // Merge all subscriptions into unique set
        const allChannels = new Set<string>();
        for (const user of usersResult.data) {
          for (const channelId of user.subscriptions) {
            allChannels.add(channelId);
          }
        }
        channelIds = Array.from(allChannels);
      }

      if (channelIds.length === 0) {
        return {
          ok: true,
          videosFound: 0,
          videosQueued: 0,
          videosSkipped: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // 2. Quick-check: See if there are any new videos since last check
      // This is a cheap query that avoids the full check when nothing has changed
      const maxPublishedResult = await deps.invidiousDb.getMaxPublishedTimestamp(channelIds);
      if (maxPublishedResult.ok && maxPublishedResult.data) {
        const maxPublished = maxPublishedResult.data;
        
        // If we've seen videos before and the newest video hasn't changed, skip full check
        if (state.lastSeenVideoTimestamp && maxPublished <= state.lastSeenVideoTimestamp) {
          const durationMs = Date.now() - startTime;
          state = {
            ...state,
            lastCheckAt: new Date(),
            lastCheckDurationMs: durationMs,
          };
          return {
            ok: true,
            videosFound: 0,
            videosQueued: 0,
            videosSkipped: 0,
            durationMs,
          };
        }
      }

      // 3. Get latest videos from subscribed channels
      const options: LatestVideosOptions = {
        channelIds,
        publishedAfter,
        limit: fullConfig.maxVideosPerCheck * 2, // Fetch more than needed to account for filtering
        excludeLive: fullConfig.excludeLive,
        excludePremieres: fullConfig.excludePremieres,
        minDurationSeconds: fullConfig.minDurationSeconds,
      };

      const videosResult = await deps.invidiousDb.getLatestVideos(options);
      if (!videosResult.ok) {
        const error = `Failed to get latest videos: ${videosResult.error.message}`;
        addError("db_error", error);
        return {
          ok: false,
          videosFound: 0,
          videosQueued: 0,
          videosSkipped: 0,
          durationMs: Date.now() - startTime,
          error,
        };
      }

      const videos = videosResult.data;

      // 4. Get existing data for filtering
      const downloadedIds = getDownloadedVideoIds(deps.localDb);
      const queuedIds = getQueuedVideoIds(deps.localDb);
      const excludedChannelsResult = deps.localDb.getExcludedChannelIds();
      const excludedChannels = excludedChannelsResult.ok
        ? new Set(excludedChannelsResult.data)
        : new Set<string>();

      // 5. Filter videos
      const filtered = filterVideos(
        videos,
        fullConfig,
        downloadedIds,
        queuedIds,
        excludedChannels,
      );

      // 6. Sort and limit
      const sorted = sortVideosByPriority(filtered.toQueue);
      const toQueue = sorted.slice(0, fullConfig.maxVideosPerCheck);

      // 7. Add to queue
      let queued = 0;
      for (const video of toQueue) {
        const result = deps.localDb.addToQueue({
          videoId: video.id,
          userId: fullConfig.userId,
        });
        if (result.ok) {
          queued++;
        }
      }

      // 8. Update state and track newest video timestamp
      const durationMs = Date.now() - startTime;
      
      // Find the newest video timestamp from this batch
      let newestTimestamp = state.lastSeenVideoTimestamp;
      for (const video of videos) {
        if (!newestTimestamp || video.published > newestTimestamp) {
          newestTimestamp = video.published;
        }
      }
      
      state = {
        ...state,
        lastCheckAt: new Date(),
        lastCheckDurationMs: durationMs,
        videosQueuedTotal: state.videosQueuedTotal + queued,
        checksCompleted: state.checksCompleted + 1,
        lastSeenVideoTimestamp: newestTimestamp,
      };

      // Update publishedAfter to now for next check
      publishedAfter = new Date();

      return {
        ok: true,
        videosFound: videos.length,
        videosQueued: queued,
        videosSkipped: filtered.skipped.length,
        durationMs,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      addError("unknown", error);
      return {
        ok: false,
        videosFound: 0,
        videosQueued: 0,
        videosSkipped: 0,
        durationMs: Date.now() - startTime,
        error,
      };
    }
  }

  /**
   * Add an error to the state (keep last 10 errors).
   */
  function addError(type: WatcherError["type"], message: string): void {
    state.errors = [
      { timestamp: new Date(), type, message },
      ...state.errors.slice(0, 9),
    ];
  }

  /**
   * Start the watcher.
   */
  function start(): void {
    if (state.isRunning) return;

    state = { ...state, isRunning: true };

    // Run immediately, then on interval
    check();
    intervalId = setInterval(check, fullConfig.checkIntervalMs);
  }

  /**
   * Stop the watcher.
   */
  function stop(): void {
    if (!state.isRunning) return;

    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }

    state = { ...state, isRunning: false };
  }

  /**
   * Get current state.
   */
  function getState(): WatcherState {
    return { ...state };
  }

  /**
   * Get current configuration.
   */
  function getConfig(): WatcherConfig {
    return { ...fullConfig };
  }

  /**
   * Manually trigger a check.
   */
  async function triggerCheck(): Promise<CheckResult> {
    return await check();
  }

  /**
   * Reset the "published after" date.
   * Useful for re-scanning older videos.
   */
  function resetPublishedAfter(date?: Date): void {
    publishedAfter = date ?? getDefaultPublishedAfter();
  }

  return {
    start,
    stop,
    getState,
    getConfig,
    triggerCheck,
    resetPublishedAfter,
  };
}

/**
 * Type for the subscription watcher.
 */
export type SubscriptionWatcher = ReturnType<typeof createSubscriptionWatcher>;
