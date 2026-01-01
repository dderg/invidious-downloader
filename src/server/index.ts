/**
 * Main HTTP server for Invidious Downloader.
 *
 * Routes:
 * - /api/downloader/* - REST API for downloader
 * - /videoplayback*   - Serve cached videos or proxy
 * - /*                - Proxy all other requests to Invidious
 */

import { Hono, type Context } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { cors } from "@hono/hono/cors";

import type { Config } from "../config.ts";
import type { LocalDbClient } from "../db/local-db.ts";
import type { DownloadManager } from "../services/download-manager.ts";

import { createProxy, type Proxy, type HttpFetcher } from "./proxy.ts";
import { createVideoHandler, type VideoHandler, type VideoFileSystem, extractVideoIdFromPath } from "./video-handler.ts";
import { createApiRouter } from "./api.ts";
import { dashboardHtml } from "./dashboard.ts";

// ============================================================================
// API Response Transformation for Cached Videos
// ============================================================================

/**
 * Transform video API response to serve from cache.
 * Clears DASH/adaptive formats and replaces with single cached progressive stream.
 */
// deno-lint-ignore no-explicit-any
function transformVideoApiResponse(data: any, cachedUrl: string): any {
  // Clear adaptive formats (disables DASH streaming)
  data.adaptiveFormats = [];

  // Replace formatStreams with single cached entry
  data.formatStreams = [{
    url: cachedUrl,
    itag: "22",
    type: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
    quality: "medium",
    fps: 30,
    container: "mp4",
    encoding: "h264",
    qualityLabel: "Cached",
    resolution: "1280x720",
    size: "1280x720",
  }];

  // Clear DASH manifest URL
  data.dashUrl = "";

  return data;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Server dependencies.
 */
export interface ServerDependencies {
  config: Config;
  db: LocalDbClient;
  downloadManager?: DownloadManager;
  /** Optional custom HTTP fetcher for proxy */
  httpFetcher?: HttpFetcher;
  /** Optional custom file system for video handler */
  videoFileSystem?: VideoFileSystem;
}

/**
 * Server instance.
 */
export interface Server {
  app: Hono;
  proxy: Proxy;
  videoHandler: VideoHandler;
  start(): Promise<void>;
  stop(): void;
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create the HTTP server.
 */
export function createServer(deps: ServerDependencies): Server {
  const { config, db, downloadManager, httpFetcher, videoFileSystem } = deps;

  // Create components
  const proxy = createProxy(
    { targetUrl: config.invidiousUrl, timeout: 30000 },
    httpFetcher,
  );

  const videoHandler = createVideoHandler(
    { videosPath: config.videosPath },
    videoFileSystem,
  );

  // Create Hono app
  const app = new Hono();

  // Middleware
  app.use("*", logger());
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }));

  // ==========================================================================
  // API Routes
  // ==========================================================================

  const apiRouter = createApiRouter({ db, downloadManager });
  app.route("/api/downloader", apiRouter);

  // ==========================================================================
  // Watch Page Interception - Modify HTML for cached videos
  // ==========================================================================

  app.get("/watch", async (c: Context) => {
    const url = new URL(c.req.url);
    const videoId = url.searchParams.get("v");

    // Validate video ID format
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return proxy.proxy(c.req.raw);
    }

    // Check if video is cached
    const isCached = await videoHandler.isCached(videoId);

    if (!isCached) {
      // Not cached, proxy normally
      return proxy.proxy(c.req.raw);
    }

    console.log(`[watch] Video ${videoId} is cached, modifying HTML response`);

    // Proxy to get original response
    const proxyResult = await proxy.proxyRequest({ request: c.req.raw });

    if (!proxyResult.ok) {
      return proxy.proxy(c.req.raw);
    }

    const response = proxyResult.response;
    const contentType = response.headers.get("content-type") || "";

    // Only process HTML responses
    if (!contentType.includes("text/html")) {
      return response;
    }

    // Get HTML content
    let html = await response.text();

    // Build cached video URL
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3001";
    const cachedUrl = `${protocol}://${host}/cached/${videoId}`;

    // Replace the DASH source with direct MP4 source
    // Original: <source src="/companion/api/manifest/dash/id/VIDEO_ID?..." type='application/dash+xml' label="dash">
    // New: <source src="/cached/VIDEO_ID" type='video/mp4' label="cached">
    const dashSourceRegex = new RegExp(
      `<source\\s+src="/companion/api/manifest/dash/id/${videoId}[^"]*"\\s+type='application/dash\\+xml'[^>]*>`,
      "g"
    );
    html = html.replace(dashSourceRegex, `<source src="${cachedUrl}" type='video/mp4' label="cached">`);

    // Also update the player_data JSON to use cached URL in formatStreams
    // and set quality to non-dash
    const qualityDashRegex = /"quality":\s*"dash"/g;
    html = html.replace(qualityDashRegex, '"quality": "medium"');

    console.log(`[watch] Modified HTML for cached video ${videoId}`);

    // Return modified HTML with same headers
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-length"); // Length changed

    return new Response(html, {
      status: response.status,
      headers: newHeaders,
    });
  });

  // ==========================================================================
  // Video API Interception - Modify response for cached videos
  // ==========================================================================

  app.get("/api/v1/videos/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    // Validate video ID format
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return proxy.proxy(c.req.raw);
    }

    // Check if video is cached
    const isCached = await videoHandler.isCached(videoId);

    if (!isCached) {
      // Not cached, proxy normally
      return proxy.proxy(c.req.raw);
    }

    console.log(`[api] Video ${videoId} is cached, modifying API response`);

    // Proxy to get original response
    const proxyResult = await proxy.proxyRequest({ request: c.req.raw });

    if (!proxyResult.ok) {
      return proxy.proxy(c.req.raw);
    }

    const response = proxyResult.response;
    const contentType = response.headers.get("content-type") || "";

    // Only process JSON responses
    if (!contentType.includes("application/json")) {
      return response;
    }

    // Parse and transform the response
    const data = await response.json();

    // Compute cached URL
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3001";
    const cachedUrl = `${protocol}://${host}/cached/${videoId}`;

    // Modify response for cached playback
    const modifiedData = transformVideoApiResponse(data, cachedUrl);

    return c.json(modifiedData);
  });

  // ==========================================================================
  // Latest Version - Main endpoint used by Invidious web player
  // ==========================================================================

  app.get("/latest_version", async (c: Context) => {
    const url = new URL(c.req.url);
    const videoId = url.searchParams.get("id");

    console.log(`[latest_version] Request for video: ${videoId}`);

    // If we have a video ID and it's cached, serve from cache
    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      const isCached = await videoHandler.isCached(videoId);
      console.log(`[latest_version] Video ${videoId} cached: ${isCached}, path: ${videoHandler.videosPath}/${videoId}.mp4`);

      if (isCached) {
        console.log(`[latest_version] Serving cached video: ${videoId}`);
        const rangeHeader = c.req.header("Range") ?? null;
        const result = await videoHandler.serveVideo(videoId, rangeHeader);

        if (result.ok) {
          return result.response;
        }
        console.log(`[latest_version] Serve failed:`, result.error);
      }
    }

    // Not cached or error, proxy to Invidious
    return proxy.proxy(c.req.raw);
  });

  // ==========================================================================
  // DASH Manifest - Intercept for cached videos
  // ==========================================================================

  app.get("/companion/api/manifest/dash/id/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    // Validate video ID format
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return proxy.proxy(c.req.raw);
    }

    // Check if video is cached
    const isCached = await videoHandler.isCached(videoId);

    if (!isCached) {
      console.log(`[dash-manifest] Video ${videoId} not cached, proxying`);
      return proxy.proxy(c.req.raw);
    }

    // For cached videos, return 404 to force player to fall back to progressive playback
    // The /api/v1/videos/:videoId endpoint already provides formatStreams with cached URL
    // DASH doesn't work well with non-fragmented MP4 files
    console.log(`[dash-manifest] Video ${videoId} is cached, returning 404 to force progressive playback`);
    return c.json({ error: "DASH not available for cached videos" }, 404);
  });

  // ==========================================================================
  // Video Playback - Serve cached or proxy
  // ==========================================================================

  app.all("/videoplayback*", async (c: Context) => {
    const url = new URL(c.req.url);
    const videoId = extractVideoIdFromPath(url.pathname, url.search.slice(1));

    // If we have a video ID and it's cached, serve from cache
    if (videoId && await videoHandler.isCached(videoId)) {
      const rangeHeader = c.req.header("Range") ?? null;
      const result = await videoHandler.serveVideo(videoId, rangeHeader);

      if (result.ok) {
        return result.response;
      }
      // Fall through to proxy if serving fails
    }

    // Proxy to Invidious
    return proxy.proxy(c.req.raw);
  });

  // ==========================================================================
  // Cached Video Direct Access
  // ==========================================================================

  app.get("/cached/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return c.json({ error: "Invalid video ID" }, 400);
    }

    const rangeHeader = c.req.header("Range") ?? null;
    const result = await videoHandler.serveVideo(videoId, rangeHeader);

    if (!result.ok) {
      if (result.error.type === "not_found") {
        return c.json({ error: result.error.message }, 404);
      }
      return c.json({ error: result.error.message }, 500);
    }

    return result.response;
  });

  app.get("/cached/:videoId/thumbnail", async (c: Context) => {
    const videoId = c.req.param("videoId");

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return c.json({ error: "Invalid video ID" }, 400);
    }

    const result = await videoHandler.serveThumbnail(videoId);

    if (!result.ok) {
      if (result.error.type === "not_found") {
        return c.json({ error: result.error.message }, 404);
      }
      return c.json({ error: result.error.message }, 500);
    }

    return result.response;
  });

  app.get("/cached/:videoId/metadata", async (c: Context) => {
    const videoId = c.req.param("videoId");

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return c.json({ error: "Invalid video ID" }, 400);
    }

    const metadata = await videoHandler.getMetadata(videoId);

    if (!metadata) {
      return c.json({ error: "Metadata not found" }, 404);
    }

    return c.json(metadata);
  });

  // ==========================================================================
  // Dashboard
  // ==========================================================================

  app.get("/dashboard", (c: Context) => {
    return c.html(dashboardHtml);
  });

  // ==========================================================================
  // Health Check
  // ==========================================================================

  app.get("/health", (c: Context) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ==========================================================================
  // Proxy All Other Requests
  // ==========================================================================

  app.all("*", async (c: Context) => {
    return proxy.proxy(c.req.raw);
  });

  // ==========================================================================
  // Server Lifecycle
  // ==========================================================================

  let server: Deno.HttpServer | null = null;

  async function start(): Promise<void> {
    console.log(`Starting server on port ${config.port}...`);
    console.log(`Proxying to Invidious at ${config.invidiousUrl}`);
    console.log(`Serving cached videos from ${config.videosPath}`);

    server = Deno.serve(
      { port: config.port },
      app.fetch,
    );

    console.log(`Server listening on http://localhost:${config.port}`);
  }

  function stop(): void {
    if (server) {
      server.shutdown();
      server = null;
      console.log("Server stopped");
    }
  }

  return {
    app,
    proxy,
    videoHandler,
    start,
    stop,
  };
}
