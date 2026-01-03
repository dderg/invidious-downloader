/**
 * WebSocket manager for dashboard real-time updates.
 * 
 * Manages WebSocket connections and broadcasts HTML fragments
 * to all connected dashboard clients using HTMX's OOB swap format.
 */

import type { ActiveDownloadProgress } from "../services/download-manager.ts";
import type { QueueItem, Download } from "../db/types.ts";
import {
  renderStats,
  renderQueueList,
  renderProgressBars,
  renderToast,
  renderConnectionStatus,
  renderDownloadsNewNotification,
} from "./templates.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Dashboard statistics for display.
 */
export interface DashboardStats {
  status: "ok" | "degraded" | "error";
  activeDownloads: number;
  queueLength: number;
  totalDownloads: number;
  totalSizeBytes: number;
}

/**
 * Event types that trigger broadcasts.
 */
export type DashboardEvent =
  | { type: "stats"; data: DashboardStats }
  | { type: "queue"; data: { items: QueueItem[]; progress: Map<string, ActiveDownloadProgress> } }
  | { type: "progress"; data: Map<string, ActiveDownloadProgress> }
  | { type: "download-complete"; data: { videoId: string; title: string } }
  | { type: "toast"; data: { message: string; variant: "success" | "error" | "warning" } };

// ============================================================================
// WebSocket Manager
// ============================================================================

/**
 * Create a WebSocket manager for dashboard updates.
 */
export function createWebSocketManager() {
  const clients = new Set<WebSocket>();
  let progressInterval: number | null = null;
  let getProgressFn: (() => Map<string, ActiveDownloadProgress>) | null = null;

  /**
   * Add a new WebSocket client.
   */
  function addClient(ws: WebSocket): void {
    clients.add(ws);
    console.log(`[ws] Client connected. Total clients: ${clients.size}`);
  }

  /**
   * Remove a WebSocket client.
   */
  function removeClient(ws: WebSocket): void {
    clients.delete(ws);
    console.log(`[ws] Client disconnected. Total clients: ${clients.size}`);
    
    // Stop progress broadcasts if no clients
    if (clients.size === 0 && progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
      console.log("[ws] Stopped progress broadcasts (no clients)");
    }
  }

  /**
   * Get number of connected clients.
   */
  function getClientCount(): number {
    return clients.size;
  }

  /**
   * Broadcast HTML to all connected clients.
   */
  function broadcast(html: string): void {
    if (clients.size === 0) return;
    
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(html);
        } catch (e) {
          console.error("[ws] Failed to send to client:", e);
          clients.delete(client);
        }
      }
    }
  }

  /**
   * Broadcast stats update.
   */
  function broadcastStats(stats: DashboardStats): void {
    broadcast(renderStats(stats));
  }

  /**
   * Broadcast queue list update.
   */
  function broadcastQueue(items: QueueItem[], progress: Map<string, ActiveDownloadProgress>): void {
    broadcast(renderQueueList(items, progress));
  }

  /**
   * Broadcast progress bars only (lightweight update).
   */
  function broadcastProgress(progress: Map<string, ActiveDownloadProgress>): void {
    if (progress.size === 0) return;
    broadcast(renderProgressBars(progress));
  }

  /**
   * Broadcast toast notification.
   */
  function broadcastToast(message: string, variant: "success" | "error" | "warning"): void {
    broadcast(renderToast(message, variant));
  }

  /**
   * Broadcast notification that a new download is available.
   */
  function broadcastDownloadComplete(videoId: string, title: string): void {
    broadcast(renderDownloadsNewNotification(videoId, title));
  }

  /**
   * Start periodic progress broadcasts (1 second interval).
   * Only broadcasts when there are active downloads.
   */
  function startProgressBroadcasts(getProgress: () => Map<string, ActiveDownloadProgress>): void {
    getProgressFn = getProgress;
    
    if (progressInterval !== null) {
      return; // Already running
    }

    progressInterval = setInterval(() => {
      if (clients.size === 0) return;
      if (!getProgressFn) return;
      
      const progress = getProgressFn();
      if (progress.size > 0) {
        broadcastProgress(progress);
      }
    }, 1000);
    
    console.log("[ws] Started progress broadcasts (1s interval)");
  }

  /**
   * Stop progress broadcasts.
   */
  function stopProgressBroadcasts(): void {
    if (progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
      getProgressFn = null;
      console.log("[ws] Stopped progress broadcasts");
    }
  }

  /**
   * Close all client connections.
   */
  function closeAll(): void {
    for (const client of clients) {
      try {
        client.close(1000, "Server shutting down");
      } catch {
        // Ignore close errors
      }
    }
    clients.clear();
    stopProgressBroadcasts();
  }

  return {
    addClient,
    removeClient,
    getClientCount,
    broadcast,
    broadcastStats,
    broadcastQueue,
    broadcastProgress,
    broadcastToast,
    broadcastDownloadComplete,
    startProgressBroadcasts,
    stopProgressBroadcasts,
    closeAll,
  };
}

/**
 * Type for the WebSocket manager instance.
 */
export type WebSocketManager = ReturnType<typeof createWebSocketManager>;
