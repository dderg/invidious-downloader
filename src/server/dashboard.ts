/**
 * Dashboard UI for the downloader service.
 * 
 * Server-rendered HTML using HTMX for real-time updates via WebSocket.
 * All rendering logic is in templates.ts.
 */

import type { LocalDbClient } from "../db/local-db.ts";
import type { DownloadManager } from "../services/download-manager.ts";
import { renderDashboardPage, renderLoginRequired, type DashboardData, type DownloadWithStatus } from "./templates.ts";
import type { DashboardStats } from "./ws-manager.ts";

// ============================================================================
// Types
// ============================================================================

export interface DashboardDependencies {
  db: LocalDbClient;
  downloadManager?: DownloadManager;
  /** Current user's email (from session), null if not logged in */
  userId?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Dashboard Data Fetcher
// ============================================================================

/**
 * Fetch all data needed for the dashboard.
 * If userId is provided, shows only that user's downloads.
 */
export async function getDashboardData(deps: DashboardDependencies): Promise<DashboardData> {
  const { db, downloadManager, userId } = deps;

  // If user is logged in, get user-specific data
  if (userId) {
    // Get user's stats
    const statsResult = db.getUserDownloadStats(userId);
    const queueResult = db.getUserQueue(userId, { status: ["pending", "downloading"] });
    
    const stats: DashboardStats = {
      status: "ok",
      activeDownloads: downloadManager?.getActiveCount() ?? 0,
      queueLength: queueResult.ok ? queueResult.data.length : 0,
      totalDownloads: statsResult.ok ? statsResult.data.count : 0,
      totalSizeBytes: statsResult.ok ? statsResult.data.totalBytes : 0,
    };

    // Get user's queue items
    const allQueueResult = db.getUserQueue(userId, {});
    const queue = allQueueResult.ok ? allQueueResult.data : [];

    // Get progress for active downloads
    const progressArray = downloadManager?.getProgress() ?? [];
    const progress = new Map(progressArray.map(p => [p.videoId, p]));

    // Get user's downloads (first page)
    const limit = 20;
    const downloadsResult = db.getUserDownloads(userId, { limit, offset: 0 });
    const rawDownloads = downloadsResult.ok ? downloadsResult.data : [];
    
    // Check if MP4 exists for each download
    const downloads: DownloadWithStatus[] = await Promise.all(
      rawDownloads.map(async (item) => ({
        ...item,
        hasMuxedFile: await fileExists(item.filePath),
      }))
    );
    
    // Get total downloads count
    const countResult = db.getUserDownloadsCount(userId);
    const total = countResult.ok ? countResult.data : downloads.length;

    return {
      stats,
      queue,
      progress,
      downloads,
      downloadsPagination: {
        page: 1,
        limit,
        total,
      },
      userId,
    };
  }

  // Not logged in - show global stats (for backwards compatibility / admin view)
  const statsResult = db.getDownloadStats();
  const queueResult = db.getQueue({ status: ["pending", "downloading"] });
  
  const stats: DashboardStats = {
    status: "ok",
    activeDownloads: downloadManager?.getActiveCount() ?? 0,
    queueLength: queueResult.ok ? queueResult.data.length : 0,
    totalDownloads: statsResult.ok ? statsResult.data.count : 0,
    totalSizeBytes: statsResult.ok ? statsResult.data.totalBytes : 0,
  };

  // Get queue items
  const allQueueResult = db.getQueue({});
  const queue = allQueueResult.ok ? allQueueResult.data : [];

  // Get progress for active downloads
  const progressArray = downloadManager?.getProgress() ?? [];
  const progress = new Map(progressArray.map(p => [p.videoId, p]));

  // Get downloads (first page)
  const limit = 20;
  const downloadsResult = db.getDownloads({ limit, offset: 0, orderBy: "downloadedAt", orderDir: "desc" });
  const rawDownloads = downloadsResult.ok ? downloadsResult.data : [];
  
  // Check if MP4 exists for each download
  const downloads: DownloadWithStatus[] = await Promise.all(
    rawDownloads.map(async (item) => ({
      ...item,
      hasMuxedFile: await fileExists(item.filePath),
    }))
  );
  
  // Get total downloads count
  const countResult = db.getDownloadsCount({});
  const total = countResult.ok ? countResult.data : downloads.length;

  return {
    stats,
    queue,
    progress,
    downloads,
    downloadsPagination: {
      page: 1,
      limit,
      total,
    },
    userId: null,
  };
}

/**
 * Generate the full dashboard HTML page.
 * Requires authentication to protect user privacy.
 */
export async function generateDashboardHtml(deps: DashboardDependencies): Promise<string> {
  // Require login to view dashboard - protects user privacy
  if (!deps.userId) {
    return renderLoginRequired();
  }
  
  const data = await getDashboardData(deps);
  return renderDashboardPage(data);
}
