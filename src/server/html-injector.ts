/**
 * HTML Injector module for modifying Invidious HTML responses.
 *
 * This module provides functions to inject UI elements into Invidious pages,
 * such as navigation links, download buttons, and status indicators.
 *
 * Design:
 * - Pure functions for easy testing
 * - Each injection function takes HTML string and returns modified HTML
 * - Injections are additive and don't break if target elements are missing
 */

// ============================================================================
// Types
// ============================================================================

export interface DownloadStatus {
  isDownloaded: boolean;
  isDownloading: boolean;
  isQueued: boolean;
  progress?: number; // 0-100
}

// ============================================================================
// Feed Menu Injection
// ============================================================================

/**
 * Inject "Downloader" link into the feed menu (Popular, Trending, etc.)
 * The link is added as the last item in the menu.
 *
 * @param html - The HTML string to modify
 * @returns Modified HTML with the Downloader link injected
 */
export function injectFeedMenuLink(html: string): string {
  const downloaderLink = `<a href="/downloader/" class="feed-menu-item pure-menu-heading">Downloader</a>`;

  // Find the feed-menu div and inject before its closing tag
  // This regex matches the feed-menu div and captures everything up to the closing </div>
  const feedMenuRegex = /(<div class="feed-menu">[\s\S]*?)(<\/div>)/;

  const match = html.match(feedMenuRegex);
  if (!match) {
    // Feed menu not found, return original HTML unchanged
    return html;
  }

  // Check if Downloader link already exists (avoid duplicate injection)
  if (html.includes('href="/downloader/"')) {
    return html;
  }

  // Inject the link before the closing </div>
  return html.replace(feedMenuRegex, `$1${downloaderLink}$2`);
}

// ============================================================================
// Watch Page Injection
// ============================================================================

/**
 * Inject download button and status into the watch page.
 * Uses data attributes and external script for CSP compliance.
 *
 * @param html - The HTML string to modify
 * @param videoId - The video ID
 * @param status - The download status of the video
 * @returns Modified HTML with download button/status injected
 */
export function injectDownloadButton(
  html: string,
  videoId: string,
  status: DownloadStatus | null
): string {
  // Check if already injected
  if (html.includes('id="downloader-status"')) {
    return html;
  }

  // Generate the UI based on status
  let statusHtml: string;
  const baseStyle = 'margin-top: 1em; padding: 0.5em 0.75em; border-left: 3px solid';

  if (status?.isDownloaded) {
    // Downloaded: Show checkmark + delete button
    statusHtml = `
      <div id="downloader-status" style="${baseStyle} #4CAF50;">
        <span style="color: #4CAF50; margin-right: 0.5em;">✓ Downloaded</span>
        <button class="pure-button" data-delete-video="${videoId}">
          <i class="icon ion-ios-trash"></i> Remove
        </button>
      </div>`;
  } else if (status?.isDownloading) {
    // Downloading: Show progress
    statusHtml = `
      <div id="downloader-status" style="${baseStyle} #2196F3;">
        <span style="color: #2196F3;">⏳ Downloading...</span>
      </div>`;
  } else if (status?.isQueued) {
    // Queued: Show waiting message
    statusHtml = `
      <div id="downloader-status" style="${baseStyle} #FF9800;">
        <span style="color: #FF9800;">✓ Queued for download</span>
      </div>`;
  } else {
    // Not downloaded: Show download button
    statusHtml = `
      <div id="downloader-status" style="${baseStyle} #9E9E9E;">
        <button class="pure-button" data-download-video="${videoId}">
          <i class="icon ion-ios-download"></i> Download
        </button>
      </div>`;
  }

  // Add external script reference (CSP-compliant)
  const scriptTag = `<script src="/downloader/button.js"></script>`;

  // Try to find the companion download form and inject after it
  const formRegex = /(<form[^>]*action=['"][^'"]*\/companion\/download[^>]*>[\s\S]*?<\/form>)/;
  const match = html.match(formRegex);

  if (match) {
    return html.replace(formRegex, `$1${statusHtml}${scriptTag}`);
  }

  // Fallback: Try to find the video player container and inject after it
  // Look for the player container div
  const playerRegex = /(<div[^>]*id=['"]player['""][^>]*>[\s\S]*?<\/div>\s*<\/div>)/;
  const playerMatch = html.match(playerRegex);

  if (playerMatch) {
    return html.replace(playerRegex, `$1${statusHtml}${scriptTag}`);
  }

  // Last resort: inject before </body>
  return html.replace('</body>', `${statusHtml}${scriptTag}</body>`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

export interface InjectionContext {
  /** The current request path */
  path: string;
  /** Video ID if on a watch page */
  videoId?: string;
  /** Download status if video ID is provided */
  downloadStatus?: DownloadStatus | null;
}

/**
 * Apply all relevant injections to an HTML response.
 *
 * @param html - The HTML string to modify
 * @param context - Context about the current request
 * @returns Modified HTML with all applicable injections
 */
export function applyInjections(html: string, context: InjectionContext): string {
  let result = html;

  // Always inject feed menu link (appears on all pages)
  result = injectFeedMenuLink(result);

  // Inject download button on watch pages (future)
  if (context.videoId && context.downloadStatus !== undefined) {
    result = injectDownloadButton(result, context.videoId, context.downloadStatus);
  }

  return result;
}
