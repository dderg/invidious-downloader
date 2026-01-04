/**
 * HTML templates for dashboard components.
 * 
 * All functions return HTML strings. Templates that are meant for
 * WebSocket OOB swaps include hx-swap-oob attributes.
 */

import type { ActiveDownloadProgress } from "../services/download-manager.ts";
import type { QueueItem, Download } from "../db/types.ts";
import type { DashboardStats } from "./ws-manager.ts";

// ============================================================================
// Extended Types
// ============================================================================

/**
 * Download with optional runtime status info.
 */
export interface DownloadWithStatus extends Download {
  hasMuxedFile?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format bytes to human readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Format date to locale string.
 */
export function formatDate(date: string | Date): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return dateObj.toLocaleDateString() + " " + dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Format speed (bytes per second).
 */
export function formatSpeed(bytesPerSec: number | null): string {
  if (!bytesPerSec) return "";
  return formatBytes(bytesPerSec) + "/s";
}

/**
 * Get phase label for display.
 */
export function getPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    "downloading": "Downloading",
    "downloading_video": "Downloading video",
    "downloading_audio": "Downloading audio",
    "muxing": "Muxing...",
    "finalizing": "Finalizing...",
    "queued": "Queued",
  };
  return labels[phase] || phase;
}

/**
 * Get thumbnail URL for a video.
 */
export function getThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * Escape HTML entities.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================================
// Pagination Types
// ============================================================================

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

// ============================================================================
// OOB Templates (for WebSocket updates)
// ============================================================================

/**
 * Render stats with OOB swap.
 */
export function renderStats(stats: DashboardStats): string {
  return `
<span id="stat-active" hx-swap-oob="innerHTML">${stats.activeDownloads}</span>
<span id="stat-queue" hx-swap-oob="innerHTML">${stats.queueLength}</span>
<span id="stat-total" hx-swap-oob="innerHTML">${stats.totalDownloads}</span>
<span id="stat-size" hx-swap-oob="innerHTML">${formatBytes(stats.totalSizeBytes)}</span>
<span id="status-badge" class="status-badge status-${stats.status}" hx-swap-oob="outerHTML">${stats.status.toUpperCase()}</span>
`;
}

/**
 * Render queue list with OOB swap.
 */
export function renderQueueList(items: QueueItem[], progress: Map<string, ActiveDownloadProgress>): string {
  const content = items.length === 0
    ? `<li class="empty-state">No items in queue</li>`
    : items.map(item => renderQueueItem(item, progress.get(item.videoId))).join("");
  
  return `<ul id="queue-list" class="queue-list" hx-swap-oob="true">${content}</ul>`;
}

/**
 * Format time for display (e.g., "10:30 AM").
 */
export function formatTime(date: string | Date): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Render a single queue item.
 */
export function renderQueueItem(item: QueueItem, progress?: ActiveDownloadProgress): string {
  const phase = progress?.phase ?? item.status;
  const title = escapeHtml(progress?.title || item.videoId);
  const isActive = item.status === "downloading" || item.status === "muxing";
  
  let progressHtml = "";
  if (isActive && progress) {
    progressHtml = renderProgressSection(item.videoId, progress);
  }

  // Build status display and retry information
  let statusDisplay: string = item.status;
  let statusClass: string = item.status;
  let retryInfo = "";

  if (item.status === "pending" && item.retryCount > 0 && item.nextRetryAt) {
    // Scheduled retry - show when it will retry
    statusDisplay = "retry scheduled";
    statusClass = "retry";
    const retryTime = formatTime(item.nextRetryAt);
    retryInfo = `Retry ${item.retryCount}/3 scheduled for ${retryTime}`;
  } else if (item.status === "downloading" && !progress) {
    // Stuck in downloading without active progress - interrupted download
    statusDisplay = "interrupted";
    statusClass = "interrupted";
    retryInfo = "Download was interrupted";
  } else if (item.status === "failed") {
    // Failed - show attempt count if retried
    if (item.retryCount > 0) {
      retryInfo = `after ${item.retryCount} attempt${item.retryCount > 1 ? "s" : ""}`;
    }
  }

  // Error message display
  const errorHtml = item.errorMessage 
    ? `<span class="error-text">${escapeHtml(item.errorMessage)}</span>` 
    : "";

  // Build meta line
  const metaParts = [`Added ${formatDate(item.queuedAt)}`];
  if (retryInfo) metaParts.push(retryInfo);
  const metaLine = metaParts.join(" &bull; ");

  return `
<li class="queue-item" id="queue-item-${item.videoId}" data-video-id="${item.videoId}">
  <div class="item-thumbnail">
    <img src="${getThumbnailUrl(item.videoId)}" alt="" loading="lazy">
  </div>
  <div class="item-info">
    <div class="item-title">${title}</div>
    <div class="item-meta">${metaLine}</div>
    ${errorHtml ? `<div class="item-meta">${errorHtml}</div>` : ""}
    ${progressHtml}
  </div>
  <span class="item-status status-${statusClass}">${statusDisplay}</span>
  <div class="item-actions">
    ${item.status === "pending" || (item.status === "downloading" && progress) ? `
      <button class="secondary" hx-delete="/api/downloader/queue/${item.videoId}" hx-swap="none">Cancel</button>
    ` : ""}
    ${item.status === "downloading" && !progress ? `
      <button hx-post="/api/downloader/queue/${item.videoId}/retry" hx-swap="none" title="Resume from where it stopped">Resume</button>
      <button class="secondary" hx-post="/api/downloader/queue/${item.videoId}/retry?fresh=true" hx-swap="none" title="Delete partial files and start over">Restart</button>
    ` : ""}
    ${item.status === "failed" ? `
      <button hx-post="/api/downloader/queue" hx-vals='{"videoId":"${item.videoId}"}' hx-swap="none">Retry</button>
    ` : ""}
  </div>
</li>`;
}

/**
 * Render progress section for a queue item.
 */
function renderProgressSection(videoId: string, progress: ActiveDownloadProgress): string {
  const hasAudio = progress.audioBytesDownloaded !== null;
  const phaseLabel = getPhaseLabel(progress.phase);

  if (hasAudio) {
    // Dual progress bars for separate video + audio
    const videoSpeedText = formatSpeed(progress.videoSpeed);
    const audioSpeedText = formatSpeed(progress.audioSpeed);

    return `
<div id="progress-${videoId}" class="progress-container">
  <div class="item-meta progress-text" style="color: var(--accent)">${phaseLabel}</div>
  <div class="dual-progress">
    <div class="progress-row">
      <span class="progress-label">Video</span>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress.videoPercentage || 0}%"></div>
      </div>
      <span class="progress-pct">${progress.videoPercentage || 0}%</span>
      <span class="progress-speed">${videoSpeedText}</span>
    </div>
    <div class="progress-row">
      <span class="progress-label">Audio</span>
      <div class="progress-bar">
        <div class="progress-fill audio" style="width: ${progress.audioPercentage || 0}%"></div>
      </div>
      <span class="progress-pct">${progress.audioPercentage || 0}%</span>
      <span class="progress-speed">${audioSpeedText}</span>
    </div>
  </div>
</div>`;
  } else {
    // Single progress bar
    const speedText = progress.videoSpeed ? ` (${formatSpeed(progress.videoSpeed)})` : "";
    const downloaded = formatBytes(progress.videoBytesDownloaded);
    const total = progress.videoTotalBytes ? " / " + formatBytes(progress.videoTotalBytes) : "";

    return `
<div id="progress-${videoId}" class="progress-container">
  <div class="item-meta progress-text" style="color: var(--accent)">${phaseLabel} - ${downloaded}${total}${speedText}</div>
  <div class="progress-bar">
    <div class="progress-fill" style="width: ${progress.videoPercentage || 0}%"></div>
  </div>
</div>`;
  }
}

/**
 * Render only progress bars for OOB swap (lightweight update).
 */
export function renderProgressBars(progress: Map<string, ActiveDownloadProgress>): string {
  let html = "";
  for (const [videoId, p] of progress) {
    html += `<div id="progress-${videoId}" hx-swap-oob="true">${renderProgressSection(videoId, p).replace(`id="progress-${videoId}"`, "").trim()}</div>`;
  }
  return html;
}

/**
 * Render toast notification with OOB swap.
 */
export function renderToast(message: string, variant: "success" | "error" | "warning"): string {
  const id = `toast-${Date.now()}`;
  return `
<div id="toast-container" hx-swap-oob="beforeend">
  <div id="${id}" class="toast ${variant}" data-auto-dismiss="true">
    ${escapeHtml(message)}
  </div>
</div>`;
}

/**
 * Render notification that new download is available.
 * Includes an auto-refresh trigger to update the downloads list.
 */
export function renderDownloadsNewNotification(videoId: string, title: string): string {
  const id = `toast-${Date.now()}`;
  return `
<div id="toast-container" hx-swap-oob="beforeend">
  <div id="${id}" class="toast success" data-auto-dismiss="true">
    Downloaded: ${escapeHtml(title)}
  </div>
</div>
<div id="downloads-refresh-trigger" hx-get="/api/downloader/downloads-html?page=1" hx-target="#downloads-list" hx-swap="innerHTML" hx-trigger="load" hx-swap-oob="true"></div>`;
}

/**
 * Render connection status banner.
 */
export function renderConnectionStatus(connected: boolean): string {
  if (connected) {
    return `<div id="connection-status" class="connection-banner hidden" hx-swap-oob="true"></div>`;
  }
  return `<div id="connection-status" class="connection-banner" hx-swap-oob="true">Reconnecting...</div>`;
}

// ============================================================================
// Full Page Templates (for initial render)
// ============================================================================

/**
 * Render downloads list (for both initial render and HTMX swap).
 */
export function renderDownloadsList(items: Download[], pagination: Pagination, oob = false): string {
  const oobAttr = oob ? ' hx-swap-oob="true"' : "";
  
  const content = items.length === 0
    ? `<li class="empty-state">No downloaded videos yet</li>`
    : items.map(item => renderDownloadItem(item)).join("");

  const paginationHtml = renderPagination(pagination);

  return `
<ul id="downloads-list" class="downloads-list"${oobAttr}>${content}</ul>
${oob ? `<div id="downloads-pagination" hx-swap-oob="true">${paginationHtml}</div>` : ""}
${oob ? `<span id="downloads-count" hx-swap-oob="innerHTML">${pagination.total} videos</span>` : ""}`;
}

/**
 * Render a single download item.
 */
export function renderDownloadItem(item: DownloadWithStatus): string {
  const title = escapeHtml(item.title || item.videoId);
  const channelTitle = escapeHtml(item.metadata?.author || "Unknown");
  const hasMuxedFile = item.hasMuxedFile ?? true; // Default to true for backwards compatibility

  // Create MP4 button - only shown when MP4 doesn't exist
  const createMp4Button = hasMuxedFile 
    ? ""
    : `<button 
        class="secondary" 
        hx-post="/api/downloader/downloads/${item.videoId}/mux" 
        hx-swap="none"
        hx-indicator="#mux-indicator-${item.videoId}"
        hx-disabled-elt="this">
        <span class="htmx-indicator" id="mux-indicator-${item.videoId}">Creating...</span>
        <span class="button-text">Create MP4</span>
      </button>`;

  // MP4 indicator badge
  const mp4Badge = hasMuxedFile 
    ? `<span class="badge badge-mp4" title="MP4 available">MP4</span>` 
    : `<span class="badge badge-dash" title="DASH streams only">DASH</span>`;

  return `
<li class="download-item" id="download-${item.videoId}">
  <div class="item-thumbnail">
    <img src="${getThumbnailUrl(item.videoId)}" alt="" loading="lazy">
  </div>
  <div class="item-info">
    <div class="item-title">${title} ${mp4Badge}</div>
    <div class="item-meta">
      ${channelTitle}
      &bull; ${formatBytes(item.fileSizeBytes || 0)}
      &bull; Downloaded ${formatDate(item.downloadedAt)}
    </div>
  </div>
  <div class="item-actions">
    <button class="secondary" onclick="window.open('/watch?v=${item.videoId}', '_blank')">Watch</button>
    ${createMp4Button}
    <button class="secondary danger" hx-delete="/api/downloader/downloads/${item.videoId}" hx-swap="none" hx-confirm="Delete this video? This cannot be undone.">Delete</button>
  </div>
</li>`;
}

/**
 * Render pagination controls.
 */
export function renderPagination(pagination: Pagination): string {
  const { page, limit, total } = pagination;
  const totalPages = Math.ceil(total / limit) || 1;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return `
<div class="pagination">
  <button 
    class="secondary"
    ${hasPrev ? `hx-get="/api/downloader/downloads-html?page=${page - 1}&limit=${limit}" hx-target="#downloads-list" hx-swap="innerHTML"` : "disabled"}>
    Previous
  </button>
  <span class="pagination-info">Page ${page} of ${totalPages}</span>
  <button 
    class="secondary"
    ${hasNext ? `hx-get="/api/downloader/downloads-html?page=${page + 1}&limit=${limit}" hx-target="#downloads-list" hx-swap="innerHTML"` : "disabled"}>
    Next
  </button>
</div>`;
}

// ============================================================================
// Full Dashboard Page
// ============================================================================

export interface DashboardData {
  stats: DashboardStats;
  queue: QueueItem[];
  progress: Map<string, ActiveDownloadProgress>;
  downloads: DownloadWithStatus[];
  downloadsPagination: Pagination;
  /** Current user's email if logged in, null otherwise */
  userId?: string | null;
}

/**
 * Render login required page HTML.
 */
export function renderLoginRequired(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Required - Invidious Downloader</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --bg-card: #16213e;
      --text: #eee;
      --text-muted: #888;
      --accent: #e94560;
      --border: #333;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .login-card {
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: var(--text-muted); margin-bottom: 24px; }
    
    a {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 8px;
      background: var(--accent);
      color: white;
      text-decoration: none;
      font-weight: 500;
    }
    
    a:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>Login Required</h1>
    <p>Please log in to Invidious to view your downloads and manage your video library.</p>
    <a href="/">Go to Invidious</a>
  </div>
</body>
</html>`;
}

/**
 * Render full dashboard page HTML.
 */
export function renderDashboardPage(data: DashboardData): string {
  const { stats, queue, progress, downloads, downloadsPagination } = data;

  const queueContent = queue.length === 0
    ? `<li class="empty-state">No items in queue</li>`
    : queue.map(item => renderQueueItem(item, progress.get(item.videoId))).join("");

  const downloadsContent = downloads.length === 0
    ? `<li class="empty-state">No downloaded videos yet</li>`
    : downloads.map(item => renderDownloadItem(item)).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invidious Downloader</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-ws@2.0.4/ws.js"></script>
  <style>
    :root {
      --bg: #1a1a2e;
      --bg-card: #16213e;
      --bg-input: #0f0f23;
      --text: #eee;
      --text-muted: #888;
      --accent: #e94560;
      --success: #4ade80;
      --warning: #fbbf24;
      --error: #f87171;
      --border: #333;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .connection-banner {
      background: var(--warning);
      color: #000;
      padding: 8px 16px;
      text-align: center;
      font-size: 14px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    
    .connection-banner.hidden {
      display: none;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    h1 {
      font-size: 24px;
      font-weight: 600;
    }
    
    .status-badge {
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
    }
    
    .status-ok { background: var(--success); color: #000; }
    .status-degraded { background: var(--warning); color: #000; }
    .status-error { background: var(--error); color: #000; }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .stat-card {
      background: var(--bg-card);
      padding: 20px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    
    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent);
    }
    
    .stat-label {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    
    .card {
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
      overflow: hidden;
    }
    
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .card-header h2 {
      font-size: 18px;
      font-weight: 600;
    }
    
    .card-body {
      padding: 20px;
    }
    
    .download-form {
      display: flex;
      gap: 12px;
    }
    
    .download-form input {
      flex: 1;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-input);
      color: var(--text);
      font-size: 16px;
    }
    
    .download-form input:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    .download-form input::placeholder {
      color: var(--text-muted);
    }
    
    button {
      padding: 12px 24px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: white;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    
    button:hover {
      opacity: 0.9;
    }
    
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    button.secondary {
      background: var(--border);
      padding: 8px 16px;
      font-size: 14px;
    }
    
    button.danger {
      background: var(--error);
    }
    
    .queue-list, .downloads-list {
      list-style: none;
    }
    
    .queue-item, .download-item {
      display: flex;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      gap: 16px;
    }
    
    .queue-item:last-child, .download-item:last-child {
      border-bottom: none;
    }
    
    .item-thumbnail {
      width: 120px;
      height: 68px;
      background: var(--bg);
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    
    .item-thumbnail img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .item-info {
      flex: 1;
      min-width: 0;
    }
    
    .item-title {
      font-weight: 500;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .item-meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    
    .item-status {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
    }
    
    .status-pending { background: var(--warning); color: #000; }
    .status-downloading { background: var(--accent); color: #fff; }
    .status-completed { background: var(--success); color: #000; }
    .status-failed { background: var(--error); color: #000; }
    .status-cancelled { background: var(--border); color: var(--text); }
    .status-muxing { background: #9c27b0; color: #fff; }
    .status-retry { background: #ff9800; color: #000; }
    .status-interrupted { background: #ff5722; color: #fff; }
    
    .error-text {
      color: var(--error);
      font-size: 12px;
    }
    
    /* Badges for MP4/DASH status */
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
      vertical-align: middle;
    }
    
    .badge-mp4 {
      background: var(--success);
      color: #000;
    }
    
    .badge-dash {
      background: var(--accent);
      color: #fff;
    }
    
    /* HTMX loading indicator for Create MP4 button */
    .htmx-indicator {
      display: none;
    }
    
    .htmx-request .htmx-indicator {
      display: inline;
    }
    
    .htmx-request .button-text {
      display: none;
    }
    
    .item-actions {
      display: flex;
      gap: 8px;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
    }
    
    .progress-container {
      margin-top: 8px;
    }
    
    .progress-bar {
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin-top: 8px;
      overflow: hidden;
      flex: 1;
    }
    
    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s;
    }
    
    .progress-fill.audio {
      background: #9c27b0;
    }
    
    .dual-progress {
      margin-top: 8px;
    }
    
    .progress-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    
    .progress-label {
      font-size: 11px;
      width: 40px;
      color: var(--text-muted);
    }
    
    .progress-pct {
      font-size: 11px;
      width: 35px;
      text-align: right;
      color: var(--text-muted);
    }
    
    .progress-speed {
      font-size: 11px;
      width: 70px;
      text-align: right;
      color: var(--accent);
      font-weight: 500;
    }
    
    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
      padding: 16px;
      border-top: 1px solid var(--border);
    }
    
    .pagination-info {
      font-size: 14px;
      color: var(--text-muted);
    }
    
    .refresh-hint {
      font-size: 12px;
      color: var(--warning);
      margin-left: 8px;
    }
    
    #toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 1000;
    }
    
    .toast {
      padding: 12px 20px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideIn 0.3s ease;
    }
    
    .toast.success { border-color: var(--success); }
    .toast.error { border-color: var(--error); }
    .toast.warning { border-color: var(--warning); }
    
    .toast-action {
      margin-left: 12px;
      padding: 4px 8px;
      font-size: 12px;
      background: transparent;
      border: 1px solid currentColor;
    }
    
    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    
    @media (max-width: 600px) {
      .download-form {
        flex-direction: column;
      }
      
      .queue-item, .download-item {
        flex-direction: column;
        align-items: flex-start;
      }
      
      .item-thumbnail {
        width: 100%;
        height: auto;
        aspect-ratio: 16/9;
      }
      
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  </style>
</head>
<body hx-ext="ws">
  <div class="container" ws-connect="/ws/dashboard">
    
    <div id="connection-status" class="connection-banner hidden"></div>
    
    <header>
      <h1><a href="/" style="color: inherit; text-decoration: none;">Invidious Downloader</a></h1>
      <span id="status-badge" class="status-badge status-${stats.status}">${stats.status.toUpperCase()}</span>
    </header>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="stat-active">${stats.activeDownloads}</div>
        <div class="stat-label">Active Downloads</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-queue">${stats.queueLength}</div>
        <div class="stat-label">In Queue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-total">${stats.totalDownloads}</div>
        <div class="stat-label">Total Downloaded</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-size">${formatBytes(stats.totalSizeBytes)}</div>
        <div class="stat-label">Total Size</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Download Video</h2>
      </div>
      <div class="card-body">
        <form class="download-form" id="download-form" hx-post="/api/downloader/queue" hx-swap="none">
          <input 
            type="text" 
            name="videoId" 
            id="video-input"
            placeholder="Enter YouTube video ID or URL (e.g., dQw4w9WgXcQ or https://youtube.com/watch?v=...)"
            required
          >
          <button type="submit">Download</button>
        </form>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Queue</h2>
        <button class="secondary" hx-post="/api/downloader/queue/clear" hx-swap="none">Clear Completed</button>
      </div>
      <div id="queue-container">
        <ul class="queue-list" id="queue-list">${queueContent}</ul>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Downloaded Videos</h2>
        <span>
          <span id="downloads-count">${downloadsPagination.total} videos</span>
        </span>
      </div>
      <div id="downloads-container">
        <ul class="downloads-list" id="downloads-list" hx-get="/api/downloader/downloads-html?page=1&limit=20" hx-trigger="refresh" hx-swap="innerHTML">${downloadsContent}</ul>
      </div>
      <div id="downloads-pagination">
        ${renderPagination(downloadsPagination)}
      </div>
    </div>
  </div>
  
  <div id="downloads-refresh-trigger"></div>
  <div id="toast-container"></div>
  
  <script>
    // Connection status handling
    document.body.addEventListener('htmx:wsOpen', function() {
      document.getElementById('connection-status').classList.add('hidden');
    });
    
    document.body.addEventListener('htmx:wsClose', function() {
      document.getElementById('connection-status').classList.remove('hidden');
      document.getElementById('connection-status').textContent = 'Reconnecting...';
    });
    
    // Auto-dismiss toasts
    const toastContainer = document.getElementById('toast-container');
    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (node.nodeType === 1 && node.dataset.autoDismiss) {
            setTimeout(function() {
              node.style.animation = 'slideIn 0.3s ease reverse';
              setTimeout(function() { node.remove(); }, 300);
            }, 3000);
          }
        });
      });
    });
    observer.observe(toastContainer, { childList: true });
    
    // Extract video ID from URL before submit
    document.getElementById('download-form').addEventListener('htmx:configRequest', function(e) {
      const input = e.detail.parameters.videoId;
      const videoId = extractVideoId(input);
      if (videoId) {
        e.detail.parameters.videoId = videoId;
      }
    });
    
    // Clear input on successful submit
    document.getElementById('download-form').addEventListener('htmx:afterRequest', function(e) {
      if (e.detail.successful) {
        document.getElementById('video-input').value = '';
      }
    });
    
    function extractVideoId(input) {
      input = input.trim();
      
      // Already a video ID
      if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        return input;
      }
      
      // YouTube URL patterns
      const patterns = [
        /(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/|youtube\\.com\\/embed\\/|youtube\\.com\\/v\\/)([a-zA-Z0-9_-]{11})/,
        /[?&]v=([a-zA-Z0-9_-]{11})/
      ];
      
      for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) return match[1];
      }
      
      return input; // Return as-is, let server validate
    }
    
    // Handle Create MP4 button responses
    document.body.addEventListener('htmx:afterRequest', function(e) {
      // Check if this was a mux request
      if (e.detail.pathInfo && e.detail.pathInfo.requestPath.includes('/mux')) {
        const videoId = e.detail.pathInfo.requestPath.match(/downloads\\/([^/]+)\\/mux/)?.[1];
        if (videoId && e.detail.successful) {
          // Refresh the downloads list to show updated status
          htmx.trigger('#downloads-list', 'refresh');
          // Show success toast
          showToast('MP4 created successfully!', 'success');
        } else if (!e.detail.successful) {
          showToast('Failed to create MP4', 'error');
        }
      }
    });
    
    // Helper to show toast messages
    function showToast(message, type) {
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      toast.dataset.autoDismiss = 'true';
      document.getElementById('toast-container').appendChild(toast);
    }
  </script>
</body>
</html>`;
}
