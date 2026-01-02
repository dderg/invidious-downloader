/**
 * Dashboard UI for the downloader service.
 * 
 * Server-rendered HTML using HTMX for real-time updates via WebSocket.
 * All rendering logic is in templates.ts.
 */

import type { LocalDbClient } from "../db/local-db.ts";
import type { DownloadManager } from "../services/download-manager.ts";
import { renderDashboardPage, type DashboardData } from "./templates.ts";
import type { DashboardStats } from "./ws-manager.ts";

// ============================================================================
// Types
// ============================================================================

export interface DashboardDependencies {
  db: LocalDbClient;
  downloadManager?: DownloadManager;
}

// ============================================================================
// Dashboard Data Fetcher
// ============================================================================

/**
 * Fetch all data needed for the dashboard.
 */
export function getDashboardData(deps: DashboardDependencies): DashboardData {
  const { db, downloadManager } = deps;

  // Get stats
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
  const downloads = downloadsResult.ok ? downloadsResult.data : [];
  
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
  };
}

/**
 * Generate the full dashboard HTML page.
 */
export function generateDashboardHtml(deps: DashboardDependencies): string {
  const data = getDashboardData(deps);
  return renderDashboardPage(data);
}
