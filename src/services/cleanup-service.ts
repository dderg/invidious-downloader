/**
 * Cleanup Service for Invidious Downloader.
 *
 * Automatically deletes subscription videos after a configurable number of days
 * if ALL owners have watched them (checked via Invidious `watched` array).
 *
 * Design:
 * - Runs periodically (default: every 24 hours)
 * - Only deletes subscription videos (manual downloads are never auto-deleted)
 * - Only deletes if ALL owners have watched OR deleted the video
 * - Respects keep_forever flag - videos with this flag are never deleted
 * - Soft deletes: marks files_deleted_at but keeps DB record for tracking
 */

import type { InvidiousDbClient } from "../db/invidious-db.ts";
import type { LocalDbClient } from "../db/local-db.ts";
import type { Download } from "../db/types.ts";

// ============================================================================
// Types
// ============================================================================

export interface CleanupConfig {
  /** Whether cleanup is enabled */
  enabled: boolean;
  /** Days after which watched subscription videos can be deleted */
  days: number;
  /** How often to run cleanup check (hours) */
  intervalHours: number;
  /** Path to videos directory */
  videosPath: string;
}

export interface CleanupState {
  isRunning: boolean;
  lastRunAt: Date | null;
  lastRunDurationMs: number | null;
  videosDeletedTotal: number;
  bytesFreedTotal: number;
  runsCompleted: number;
  errors: CleanupError[];
}

export interface CleanupError {
  timestamp: Date;
  type: "db_error" | "fs_error" | "unknown";
  message: string;
  videoId?: string;
}

export interface CleanupResult {
  ok: boolean;
  videosChecked: number;
  videosDeleted: number;
  bytesFreed: number;
  durationMs: number;
  errors: CleanupError[];
}

export interface CleanupDependencies {
  invidiousDb: InvidiousDbClient;
  localDb: LocalDbClient;
}

// ============================================================================
// Cleanup Service
// ============================================================================

export function createCleanupService(
  deps: CleanupDependencies,
  config: CleanupConfig,
) {
  let state: CleanupState = {
    isRunning: false,
    lastRunAt: null,
    lastRunDurationMs: null,
    videosDeletedTotal: 0,
    bytesFreedTotal: 0,
    runsCompleted: 0,
    errors: [],
  };

  let intervalId: number | null = null;

  /**
   * Check if a video can be cleaned up.
   * Returns true if ALL active owners have watched the video.
   */
  async function canCleanup(video: Download): Promise<boolean> {
    // Get active owners (not deleted, not keep_forever)
    const ownersResult = deps.localDb.getActiveVideoOwners(video.videoId);
    if (!ownersResult.ok || ownersResult.data.length === 0) {
      // No active owners - video can be deleted
      return true;
    }

    // Check if any owner has keep_forever set
    const hasKeepResult = deps.localDb.hasActiveKeepForever(video.videoId);
    if (hasKeepResult.ok && hasKeepResult.data) {
      // Someone wants to keep this forever
      return false;
    }

    // Check if ALL active owners have watched
    for (const owner of ownersResult.data) {
      const watchedResult = await deps.invidiousDb.hasUserWatchedVideo(
        owner.userId,
        video.videoId,
      );
      
      if (!watchedResult.ok || !watchedResult.data) {
        // This owner hasn't watched - can't delete yet
        return false;
      }
    }

    // All owners have watched
    return true;
  }

  /**
   * Delete video files from disk.
   */
  async function deleteVideoFiles(video: Download): Promise<{
    deleted: string[];
    errors: string[];
    bytesFreed: number;
  }> {
    const deleted: string[] = [];
    const errors: string[] = [];
    let bytesFreed = 0;

    const { videosPath } = config;
    const videoId = video.videoId;

    // Files to delete:
    // - {videoId}.mp4 (muxed)
    // - {videoId}_video_*.mp4 (video streams)
    // - {videoId}_audio_*.m4a (audio streams)
    // - {videoId}_audio_*.webm (opus audio streams)
    // - {videoId}.webp (thumbnail)
    // - {videoId}.json (metadata)

    const filesToCheck = [
      video.filePath, // Muxed MP4
      video.thumbnailPath,
    ].filter(Boolean) as string[];

    // Also check for stream files
    try {
      for await (const entry of Deno.readDir(videosPath)) {
        if (!entry.isFile) continue;
        
        const name = entry.name;
        if (
          name.startsWith(`${videoId}_video_`) ||
          name.startsWith(`${videoId}_audio_`) ||
          name === `${videoId}.json`
        ) {
          filesToCheck.push(`${videosPath}/${name}`);
        }
      }
    } catch {
      // Ignore errors reading directory
    }

    // Delete each file
    for (const filePath of filesToCheck) {
      try {
        const stat = await Deno.stat(filePath);
        bytesFreed += stat.size;
        await Deno.remove(filePath);
        deleted.push(filePath);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          errors.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    return { deleted, errors, bytesFreed };
  }

  /**
   * Run a single cleanup cycle.
   */
  async function runCleanup(): Promise<CleanupResult> {
    const startTime = Date.now();
    const errors: CleanupError[] = [];
    let videosChecked = 0;
    let videosDeleted = 0;
    let bytesFreed = 0;

    try {
      // Get cleanup candidates (subscription videos older than X days)
      const candidatesResult = deps.localDb.getCleanupCandidates(config.days);
      
      if (!candidatesResult.ok) {
        errors.push({
          timestamp: new Date(),
          type: "db_error",
          message: candidatesResult.error.message,
        });
        return {
          ok: false,
          videosChecked: 0,
          videosDeleted: 0,
          bytesFreed: 0,
          durationMs: Date.now() - startTime,
          errors,
        };
      }

      const candidates = candidatesResult.data;
      console.log(`[cleanup] Found ${candidates.length} candidates for cleanup (older than ${config.days} days)`);

      for (const video of candidates) {
        videosChecked++;
        
        // Check if this video can be cleaned up
        const canDelete = await canCleanup(video);
        
        if (!canDelete) {
          continue;
        }

        console.log(`[cleanup] Deleting video ${video.videoId}: "${video.title}"`);

        // Delete files
        const deleteResult = await deleteVideoFiles(video);
        
        if (deleteResult.errors.length > 0) {
          for (const err of deleteResult.errors) {
            errors.push({
              timestamp: new Date(),
              type: "fs_error",
              message: err,
              videoId: video.videoId,
            });
          }
        }

        if (deleteResult.deleted.length > 0) {
          // Mark as deleted in database
          deps.localDb.markFilesDeleted(video.videoId);
          
          videosDeleted++;
          bytesFreed += deleteResult.bytesFreed;
          
          console.log(`[cleanup] Deleted ${deleteResult.deleted.length} files for ${video.videoId}, freed ${formatBytes(deleteResult.bytesFreed)}`);
        }
      }

      const durationMs = Date.now() - startTime;
      
      // Update state
      state = {
        ...state,
        lastRunAt: new Date(),
        lastRunDurationMs: durationMs,
        videosDeletedTotal: state.videosDeletedTotal + videosDeleted,
        bytesFreedTotal: state.bytesFreedTotal + bytesFreed,
        runsCompleted: state.runsCompleted + 1,
        errors: [...errors, ...state.errors].slice(0, 20), // Keep last 20 errors
      };

      console.log(`[cleanup] Completed: checked ${videosChecked}, deleted ${videosDeleted}, freed ${formatBytes(bytesFreed)} in ${durationMs}ms`);

      return {
        ok: errors.length === 0,
        videosChecked,
        videosDeleted,
        bytesFreed,
        durationMs,
        errors,
      };
    } catch (e) {
      const error: CleanupError = {
        timestamp: new Date(),
        type: "unknown",
        message: e instanceof Error ? e.message : String(e),
      };
      errors.push(error);
      
      return {
        ok: false,
        videosChecked,
        videosDeleted,
        bytesFreed,
        durationMs: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Start the cleanup service.
   */
  function start(): void {
    if (!config.enabled) {
      console.log("[cleanup] Cleanup service is disabled");
      return;
    }

    if (state.isRunning) return;

    state = { ...state, isRunning: true };
    console.log(`[cleanup] Starting cleanup service (check every ${config.intervalHours} hours, delete after ${config.days} days)`);

    // Run immediately, then on interval
    runCleanup();
    const intervalMs = config.intervalHours * 60 * 60 * 1000;
    intervalId = setInterval(runCleanup, intervalMs);
  }

  /**
   * Stop the cleanup service.
   */
  function stop(): void {
    if (!state.isRunning) return;

    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }

    state = { ...state, isRunning: false };
    console.log("[cleanup] Cleanup service stopped");
  }

  /**
   * Get current state.
   */
  function getState(): CleanupState {
    return { ...state };
  }

  /**
   * Manually trigger a cleanup run.
   */
  async function triggerCleanup(): Promise<CleanupResult> {
    return await runCleanup();
  }

  return {
    start,
    stop,
    getState,
    triggerCleanup,
  };
}

// Helper function
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export type CleanupService = ReturnType<typeof createCleanupService>;
