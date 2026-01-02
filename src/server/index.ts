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
import { createVideoHandler, type VideoHandler, type VideoFileSystem, extractVideoIdFromPath, buildVideoStreamPath, buildAudioStreamPath } from "./video-handler.ts";
import { createApiRouter } from "./api.ts";
import { dashboardHtml } from "./dashboard.ts";
import { applyInjections, type DownloadStatus } from "./html-injector.ts";
import { getMediaByteRangesCached, type DASHByteRanges } from "../services/media-parser.ts";

// ============================================================================
// API Response Transformation for Cached Videos
// ============================================================================

/**
 * Transform video API response to serve from cache.
 * For videos with cached DASH streams, modify adaptiveFormats to point to local URLs.
 * Uses stored metadata from database to build proper format info.
 */
// deno-lint-ignore no-explicit-any
async function transformVideoApiResponse(
  data: any,
  videoId: string,
  videoHandler: VideoHandler,
  baseUrl: string,
  db: LocalDbClient,
): Promise<any> {
  // Check for cached DASH streams
  const cachedStreams = await videoHandler.getCachedStreams(videoId);
  const hasAdaptiveStreams = cachedStreams.videoItags.length > 0 && cachedStreams.audioItags.length > 0;

  if (!hasAdaptiveStreams) {
    // No DASH streams cached, disable adaptive streaming
    // The player should fall back to formatStreams from the original response
    data.adaptiveFormats = [];
    data.dashUrl = "";
    console.log(`[api] Video ${videoId} has no cached DASH streams, player will use original formatStreams`);
    return data;
  }

  console.log(`[api] Video ${videoId} has cached DASH streams: video=${cachedStreams.videoItags}, audio=${cachedStreams.audioItags}`);

  // Get download metadata from database
  const downloadResult = db.getDownload(videoId);
  const downloadMeta = downloadResult.ok && downloadResult.data ? downloadResult.data.metadata : null;

  // Build adaptiveFormats from cached streams
  // We prefer using original API data when available, with fallback to stored metadata
  const cachedAdaptiveFormats: any[] = [];

  // Process video streams
  for (const videoItag of cachedStreams.videoItags) {
    // Try to find matching format from original API response
    const originalFormat = data.adaptiveFormats?.find((f: any) => f.itag === videoItag);
    
    if (originalFormat) {
      // Use original format info with local URL
      cachedAdaptiveFormats.push({
        ...originalFormat,
        url: `${baseUrl}/videoplayback?v=${videoId}&itag=${videoItag}`,
      });
    } else if (downloadMeta?.videoItag === videoItag) {
      // Fallback: build from stored metadata
      cachedAdaptiveFormats.push({
        itag: videoItag,
        url: `${baseUrl}/videoplayback?v=${videoId}&itag=${videoItag}`,
        mimeType: downloadMeta.videoMimeType || "video/mp4",
        bitrate: downloadMeta.videoBitrate || 5000000,
        width: downloadMeta.width || 1920,
        height: downloadMeta.height || 1080,
        contentLength: downloadMeta.videoContentLength?.toString(),
      });
    }
  }

  // Process audio streams
  for (const audioItag of cachedStreams.audioItags) {
    // Try to find matching format from original API response
    const originalFormat = data.adaptiveFormats?.find((f: any) => f.itag === audioItag);
    
    if (originalFormat) {
      // Use original format info with local URL
      cachedAdaptiveFormats.push({
        ...originalFormat,
        url: `${baseUrl}/videoplayback?v=${videoId}&itag=${audioItag}`,
      });
    } else if (downloadMeta?.audioItag === audioItag) {
      // Fallback: build from stored metadata
      // Determine correct mimeType based on actual cached file extension
      const audioExt = cachedStreams.audioExtensions[audioItag];
      let audioMimeType = downloadMeta.audioMimeType || "audio/mp4";
      
      // Override mimeType based on actual file extension (more reliable for old downloads)
      if (audioExt === "webm") {
        audioMimeType = 'audio/webm; codecs="opus"';
      } else if (audioExt === "m4a" && !audioMimeType.includes("mp4")) {
        audioMimeType = 'audio/mp4; codecs="mp4a.40.2"';
      }
      
      cachedAdaptiveFormats.push({
        itag: audioItag,
        url: `${baseUrl}/videoplayback?v=${videoId}&itag=${audioItag}`,
        mimeType: audioMimeType,
        bitrate: downloadMeta.audioBitrate || 128000,
        contentLength: downloadMeta.audioContentLength?.toString(),
      });
    }
  }

  if (cachedAdaptiveFormats.length > 0) {
    data.adaptiveFormats = cachedAdaptiveFormats;
    // Clear the dashUrl since we're providing raw streams, not a manifest
    data.dashUrl = "";
    console.log(`[api] Serving ${cachedAdaptiveFormats.length} cached adaptive formats for ${videoId}`);
  } else {
    // No matching formats found, fall back to progressive
    data.adaptiveFormats = [];
    data.dashUrl = "";
    console.log(`[api] Could not build adaptiveFormats for ${videoId}, player will use original formatStreams`);
  }

  // Don't modify formatStreams - keep original response.
  // MP4 is only for consuming outside Invidious (Jellyfin, direct downloads).
  // The web player and Yattee should use DASH with adaptiveFormats.

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

    // Check if video ID is valid and cached
    const isValidVideoId = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId);
    const isCached = isValidVideoId ? await videoHandler.isCached(videoId) : false;

    // Build download status for injection
    let downloadStatus: DownloadStatus | null = null;
    if (isValidVideoId && videoId) {
      const isDownloadedResult = db.isDownloaded(videoId);
      const queueItemResult = db.getQueueItem(videoId);

      if (isDownloadedResult.ok && isDownloadedResult.data) {
        downloadStatus = { isDownloaded: true, isDownloading: false, isQueued: false };
      } else if (queueItemResult.ok && queueItemResult.data) {
        const item = queueItemResult.data;
        downloadStatus = {
          isDownloaded: false,
          isDownloading: item.status === "downloading",
          isQueued: item.status === "pending",
        };
      } else {
        downloadStatus = { isDownloaded: false, isDownloading: false, isQueued: false };
      }
    }

    if (isCached && videoId) {
      console.log(`[watch] Video ${videoId} is cached, using DASH streaming from local cache`);
      // No HTML modification needed - the /api/v1/videos/:videoId endpoint
      // will return adaptiveFormats with local URLs, and /videoplayback
      // will serve cached streams
    }

    // Always apply feed menu injection and download button
    html = applyInjections(html, {
      path: "/watch",
      videoId: videoId || undefined,
      downloadStatus,
    });

    // Return modified HTML with same headers
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-length"); // Length may have changed

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

    // Compute cached URL and base URL
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3001";
    const baseUrl = `${protocol}://${host}`;

    // Modify response for cached playback
    const modifiedData = await transformVideoApiResponse(data, videoId, videoHandler, baseUrl, db);

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
  // DASH Manifest - Generate local manifest for cached videos
  // ==========================================================================

  app.get("/companion/api/manifest/dash/id/:videoId", async (c: Context) => {
    const videoId = c.req.param("videoId");

    // Validate video ID format
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return proxy.proxy(c.req.raw);
    }

    // Check if video is cached with DASH streams
    const isCached = await videoHandler.isCached(videoId);
    const cachedStreams = await videoHandler.getCachedStreams(videoId);
    const hasAdaptiveStreams = cachedStreams.videoItags.length > 0 && cachedStreams.audioItags.length > 0;

    if (!isCached || !hasAdaptiveStreams) {
      console.log(`[dash-manifest] Video ${videoId} not cached or no DASH streams, proxying to Companion`);
      return proxy.proxy(c.req.raw);
    }

    console.log(`[dash-manifest] Video ${videoId} is cached with DASH streams, generating local manifest`);

    // Build base URL for stream requests
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3001";
    const baseUrl = `${protocol}://${host}`;

    // Get download metadata from database for duration and codec info
    const downloadResult = db.getDownload(videoId);
    const downloadMeta = downloadResult.ok && downloadResult.data ? downloadResult.data : null;
    
    // Get duration from download record
    const duration = downloadMeta?.durationSeconds || 0;
    const durationISO = `PT${Math.floor(duration / 60)}M${(duration % 60).toFixed(3)}S`;

    // Get metadata for dimensions and codec info
    const metadata = downloadMeta?.metadata;
    const videoItag = cachedStreams.videoItags[0]; // Use first available video itag
    const audioItag = cachedStreams.audioItags[0]; // Use first available audio itag
    const width = metadata?.width || 1920;
    const height = metadata?.height || 1080;
    
    // Determine audio mime type and codec from cached file extension
    const audioExt = cachedStreams.audioExtensions[audioItag] || "m4a";
    let audioMimeType = "audio/mp4";
    let audioCodec = "mp4a.40.2"; // AAC
    
    if (audioExt === "webm") {
      audioMimeType = "audio/webm";
      audioCodec = "opus";
    }
    
    // Get video codec from stored mimeType or default
    let videoCodec = "avc1.640028"; // H.264 High Profile
    if (metadata?.videoMimeType) {
      const codecMatch = metadata.videoMimeType.match(/codecs="([^"]+)"/);
      if (codecMatch) {
        videoCodec = codecMatch[1];
      }
    }

    // Parse byte ranges from the actual media files
    const videoStreamPath = buildVideoStreamPath(videoHandler.videosPath, videoId, videoItag);
    const audioStreamPath = buildAudioStreamPath(videoHandler.videosPath, videoId, audioItag, audioExt);

    const videoRangesResult = await getMediaByteRangesCached(videoStreamPath);
    const audioRangesResult = await getMediaByteRangesCached(audioStreamPath);

    // Default ranges if parsing fails
    let videoRanges: DASHByteRanges = { initRange: "0-0", indexRange: "0-0" };
    let audioRanges: DASHByteRanges = { initRange: "0-0", indexRange: "0-0" };

    if (videoRangesResult.ok) {
      videoRanges = videoRangesResult.ranges;
      console.log(`[dash-manifest] Video ${videoId} video stream ranges: init=${videoRanges.initRange}, index=${videoRanges.indexRange}`);
    } else {
      console.error(`[dash-manifest] Failed to parse video stream ${videoStreamPath}: ${videoRangesResult.error}`);
    }

    if (audioRangesResult.ok) {
      audioRanges = audioRangesResult.ranges;
      console.log(`[dash-manifest] Video ${videoId} audio stream ranges: init=${audioRanges.initRange}, index=${audioRanges.indexRange}`);
    } else {
      console.error(`[dash-manifest] Failed to parse audio stream ${audioStreamPath}: ${audioRangesResult.error}`);
    }

    // Generate DASH manifest XML with real byte ranges
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${durationISO}" minBufferTime="PT1.5S">
  <Period duration="${durationISO}">
    <AdaptationSet mimeType="video/mp4" contentType="video" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="${videoItag}" bandwidth="${metadata?.videoBitrate || 5000000}" codecs="${videoCodec}" width="${width}" height="${height}">
        <BaseURL>${baseUrl}/videoplayback?v=${videoId}&amp;itag=${videoItag}</BaseURL>
        <SegmentBase indexRange="${videoRanges.indexRange}">
          <Initialization range="${videoRanges.initRange}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="${audioMimeType}" contentType="audio" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="${audioItag}" bandwidth="${metadata?.audioBitrate || 128000}" codecs="${audioCodec}" audioSamplingRate="48000">
        <BaseURL>${baseUrl}/videoplayback?v=${videoId}&amp;itag=${audioItag}</BaseURL>
        <SegmentBase indexRange="${audioRanges.indexRange}">
          <Initialization range="${audioRanges.initRange}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    console.log(`[dash-manifest] Generated manifest for ${videoId}: video itag ${videoItag} (${videoCodec}), audio itag ${audioItag} (${audioCodec})`);

    return new Response(manifest, {
      headers: {
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-cache",
      },
    });
  });

  // ==========================================================================
  // Video Playback - Serve cached or proxy
  // ==========================================================================

  // Handle videoplayback requests - intercept by itag for DASH streaming
  app.all("/videoplayback*", async (c: Context) => {
    const url = new URL(c.req.url);
    const videoId = extractVideoIdFromPath(url.pathname, url.search.slice(1));
    const itag = url.searchParams.get("itag");

    console.log(`[videoplayback] Request for video: ${videoId}, itag: ${itag}`);

    // If we have a video ID and itag, try to serve the specific stream
    if (videoId && itag) {
      const itagNum = parseInt(itag, 10);
      const rangeHeader = c.req.header("Range") ?? null;

      // Try video stream first
      if (await videoHandler.hasVideoStream(videoId, itagNum)) {
        console.log(`[videoplayback] Serving cached video stream: ${videoId} itag ${itagNum}`);
        const result = await videoHandler.serveVideoStream(videoId, itagNum, rangeHeader);
        if (result.ok) {
          return result.response;
        }
      }

      // Try audio stream
      if (await videoHandler.hasAudioStream(videoId, itagNum)) {
        console.log(`[videoplayback] Serving cached audio stream: ${videoId} itag ${itagNum}`);
        const result = await videoHandler.serveAudioStream(videoId, itagNum, rangeHeader);
        if (result.ok) {
          return result.response;
        }
      }
    }

    // Fallback: If we have a video ID and it's cached (muxed), serve from cache
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

  app.get("/downloader", (c: Context) => {
    return c.redirect("/downloader/");
  });

  app.get("/downloader/", (c: Context) => {
    return c.html(dashboardHtml);
  });

  // ==========================================================================
  // Downloader Button Script (CSP-compliant external JS)
  // ==========================================================================

  app.get("/downloader/button.js", (c: Context) => {
    const js = `
(function() {
  function handleDownloadClick(e) {
    const btn = e.target.closest('[data-download-video]');
    if (!btn) return;
    
    e.preventDefault();
    const videoId = btn.dataset.downloadVideo;
    const container = btn.parentElement;
    
    btn.disabled = true;
    btn.textContent = 'Adding...';
    
    fetch('/api/downloader/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId })
    })
    .then(function(res) {
      if (res.status === 201) {
        container.innerHTML = '<span style="color: #4CAF50;">✓ Queued for download</span>';
        container.style.borderLeftColor = '#FF9800';
      } else if (res.status === 409) {
        res.json().then(function(data) {
          container.innerHTML = '<span>' + data.error + '</span>';
        });
      } else {
        btn.textContent = 'Error - Try again';
        btn.disabled = false;
      }
    })
    .catch(function() {
      btn.textContent = 'Error - Try again';
      btn.disabled = false;
    });
  }

  function handleDeleteClick(e) {
    const btn = e.target.closest('[data-delete-video]');
    if (!btn) return;
    
    e.preventDefault();
    if (!confirm('Remove this video from your library?')) return;
    
    const videoId = btn.dataset.deleteVideo;
    btn.disabled = true;
    btn.textContent = 'Removing...';
    
    fetch('/api/downloader/downloads/' + videoId, { method: 'DELETE' })
    .then(function(res) {
      if (res.ok) {
        location.reload();
      } else {
        alert('Failed to delete');
        btn.disabled = false;
        btn.textContent = 'Remove';
      }
    })
    .catch(function() {
      alert('Failed to delete');
      btn.disabled = false;
      btn.textContent = 'Remove';
    });
  }

  document.addEventListener('click', function(e) {
    handleDownloadClick(e);
    handleDeleteClick(e);
  });
})();
`;
    
    return new Response(js, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=3600",
      },
    });
  });

  // ==========================================================================
  // Health Check
  // ==========================================================================

  app.get("/health", (c: Context) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ==========================================================================
  // Proxy All Other Requests (with HTML injection)
  // ==========================================================================

  app.all("*", async (c: Context) => {
    const response = await proxy.proxy(c.req.raw);
    
    // Check if response is HTML and inject UI elements
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      const path = new URL(c.req.url).pathname;
      
      // Apply injections
      const modifiedHtml = applyInjections(html, { path });
      
      // Return modified response
      const newHeaders = new Headers(response.headers);
      newHeaders.delete("content-length"); // Length may have changed
      
      return new Response(modifiedHtml, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }
    
    return response;
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
