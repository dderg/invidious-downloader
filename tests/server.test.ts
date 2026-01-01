/**
 * Tests for server components.
 */

import { describe, it, beforeEach } from "@std/testing/bdd";
import { assertEquals, assertExists } from "@std/assert";

import {
  filterRequestHeaders,
  filterResponseHeaders,
  buildTargetUrl,
  extractPathAndQuery,
  createProxy,
  type HttpFetcher,
} from "../src/server/proxy.ts";

import {
  parseRangeHeader,
  getMimeType,
  extractVideoIdFromPath,
  isValidVideoId,
  buildVideoPath,
  buildThumbnailPath,
  buildMetadataPath,
  createVideoHandler,
  type VideoFileSystem,
} from "../src/server/video-handler.ts";

import {
  createApiRouter,
  type ApiDependencies,
} from "../src/server/api.ts";

import type { SqliteExecutor } from "../src/db/local-db.ts";
import { createLocalDb } from "../src/db/local-db.ts";

// ============================================================================
// Proxy Tests
// ============================================================================

describe("filterRequestHeaders", () => {
  it("should remove hop-by-hop headers", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Connection": "keep-alive",
      "Host": "example.com",
      "Accept": "*/*",
    });

    const filtered = filterRequestHeaders(headers);

    assertEquals(filtered.get("Content-Type"), "application/json");
    assertEquals(filtered.get("Accept"), "*/*");
    assertEquals(filtered.get("Connection"), null);
    assertEquals(filtered.get("Host"), null);
  });

  it("should keep regular headers", () => {
    const headers = new Headers({
      "Authorization": "Bearer token",
      "User-Agent": "test",
      "X-Custom-Header": "value",
    });

    const filtered = filterRequestHeaders(headers);

    assertEquals(filtered.get("Authorization"), "Bearer token");
    assertEquals(filtered.get("User-Agent"), "test");
    assertEquals(filtered.get("X-Custom-Header"), "value");
  });
});

describe("filterResponseHeaders", () => {
  it("should remove hop-by-hop headers from response", () => {
    const headers = new Headers({
      "Content-Type": "text/html",
      "Transfer-Encoding": "chunked",
      "Connection": "close",
    });

    const filtered = filterResponseHeaders(headers);

    assertEquals(filtered.get("Content-Type"), "text/html");
    assertEquals(filtered.get("Transfer-Encoding"), null);
    assertEquals(filtered.get("Connection"), null);
  });
});

describe("buildTargetUrl", () => {
  it("should build URL with path", () => {
    const url = buildTargetUrl("http://localhost:3000", "/watch", "v=abc123");
    assertEquals(url, "http://localhost:3000/watch?v=abc123");
  });

  it("should handle base URL with trailing slash", () => {
    const url = buildTargetUrl("http://localhost:3000/", "/api/test", "");
    assertEquals(url, "http://localhost:3000/api/test");
  });

  it("should handle path without leading slash", () => {
    const url = buildTargetUrl("http://localhost:3000", "api/test", "");
    assertEquals(url, "http://localhost:3000/api/test");
  });

  it("should handle empty query", () => {
    const url = buildTargetUrl("http://localhost:3000", "/path", "");
    assertEquals(url, "http://localhost:3000/path");
  });
});

describe("extractPathAndQuery", () => {
  it("should extract path and query from URL", () => {
    const result = extractPathAndQuery("http://localhost:3000/watch?v=abc123");
    assertEquals(result.path, "/watch");
    assertEquals(result.query, "v=abc123");
  });

  it("should handle URL without query", () => {
    const result = extractPathAndQuery("http://localhost:3000/path");
    assertEquals(result.path, "/path");
    assertEquals(result.query, "");
  });

  it("should handle relative path with query", () => {
    const result = extractPathAndQuery("/watch?v=abc123");
    assertEquals(result.path, "/watch");
    assertEquals(result.query, "v=abc123");
  });
});

describe("createProxy", () => {
  it("should proxy request to target URL", async () => {
    const mockFetcher: HttpFetcher = {
      fetch: async (input, _init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        assertEquals(url, "http://target:3000/test?foo=bar");
        return new Response("OK", { status: 200 });
      },
    };

    const proxy = createProxy({ targetUrl: "http://target:3000" }, mockFetcher);
    const request = new Request("http://localhost/test?foo=bar");

    const response = await proxy.proxy(request);

    assertEquals(response.status, 200);
    assertEquals(await response.text(), "OK");
  });

  it("should handle network errors", async () => {
    const mockFetcher: HttpFetcher = {
      fetch: async () => {
        throw new Error("Connection refused");
      },
    };

    const proxy = createProxy({ targetUrl: "http://target:3000" }, mockFetcher);
    const request = new Request("http://localhost/test");

    const response = await proxy.proxy(request);

    assertEquals(response.status, 502);
    const body = await response.json();
    assertEquals(body.error, "Connection refused");
  });
});

// ============================================================================
// Video Handler Tests
// ============================================================================

describe("parseRangeHeader", () => {
  it("should parse simple range header", () => {
    const result = parseRangeHeader("bytes=0-499", 1000);
    assertExists(result);
    assertEquals(result.start, 0);
    assertEquals(result.end, 499);
  });

  it("should parse open-ended range", () => {
    const result = parseRangeHeader("bytes=500-", 1000);
    assertExists(result);
    assertEquals(result.start, 500);
    assertEquals(result.end, 999);
  });

  it("should parse suffix range", () => {
    const result = parseRangeHeader("bytes=-200", 1000);
    assertExists(result);
    assertEquals(result.start, 800);
    assertEquals(result.end, 999);
  });

  it("should return null for invalid range", () => {
    assertEquals(parseRangeHeader("invalid", 1000), null);
    assertEquals(parseRangeHeader(null, 1000), null);
  });

  it("should return null for out-of-bounds range", () => {
    assertEquals(parseRangeHeader("bytes=1500-2000", 1000), null);
  });

  it("should clamp end to file size", () => {
    const result = parseRangeHeader("bytes=0-5000", 1000);
    assertExists(result);
    assertEquals(result.end, 999);
  });
});

describe("getMimeType", () => {
  it("should return correct MIME type for video files", () => {
    assertEquals(getMimeType("video.mp4"), "video/mp4");
    assertEquals(getMimeType("video.webm"), "video/webm");
    assertEquals(getMimeType("video.mkv"), "video/x-matroska");
  });

  it("should return correct MIME type for audio files", () => {
    assertEquals(getMimeType("audio.mp3"), "audio/mpeg");
    assertEquals(getMimeType("audio.m4a"), "audio/mp4");
    assertEquals(getMimeType("audio.opus"), "audio/opus");
  });

  it("should return correct MIME type for image files", () => {
    assertEquals(getMimeType("thumb.webp"), "image/webp");
    assertEquals(getMimeType("thumb.jpg"), "image/jpeg");
    assertEquals(getMimeType("thumb.png"), "image/png");
  });

  it("should return octet-stream for unknown types", () => {
    assertEquals(getMimeType("file.xyz"), "application/octet-stream");
    assertEquals(getMimeType("noext"), "application/octet-stream");
  });
});

describe("extractVideoIdFromPath", () => {
  it("should extract video ID from v parameter", () => {
    assertEquals(extractVideoIdFromPath("/watch", "v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("should extract video ID from /vi/ path", () => {
    assertEquals(extractVideoIdFromPath("/vi/dQw4w9WgXcQ/maxres.webp", ""), "dQw4w9WgXcQ");
  });

  it("should extract video ID from path ending", () => {
    assertEquals(extractVideoIdFromPath("/cached/dQw4w9WgXcQ", ""), "dQw4w9WgXcQ");
    assertEquals(extractVideoIdFromPath("/cached/dQw4w9WgXcQ.mp4", ""), "dQw4w9WgXcQ");
  });

  it("should return null for invalid paths", () => {
    assertEquals(extractVideoIdFromPath("/invalid", ""), null);
    assertEquals(extractVideoIdFromPath("/watch", "foo=bar"), null);
  });
});

describe("isValidVideoId", () => {
  it("should return true for valid video IDs", () => {
    assertEquals(isValidVideoId("dQw4w9WgXcQ"), true);
    assertEquals(isValidVideoId("abc123ABC_-"), true);
  });

  it("should return false for invalid video IDs", () => {
    assertEquals(isValidVideoId("short"), false);
    assertEquals(isValidVideoId("toolongvideoid123"), false);
    assertEquals(isValidVideoId("invalid!@#$"), false);
  });
});

describe("buildVideoPath", () => {
  it("should build correct video path", () => {
    assertEquals(buildVideoPath("/videos", "abc123ABC_-"), "/videos/abc123ABC_-.mp4");
  });
});

describe("buildThumbnailPath", () => {
  it("should build correct thumbnail path", () => {
    assertEquals(buildThumbnailPath("/videos", "abc123ABC_-"), "/videos/abc123ABC_-.webp");
  });
});

describe("buildMetadataPath", () => {
  it("should build correct metadata path", () => {
    assertEquals(buildMetadataPath("/videos", "abc123ABC_-"), "/videos/abc123ABC_-.json");
  });
});

describe("createVideoHandler", () => {
  const mockFs: VideoFileSystem = {
    exists: async (path) => path.includes("exists"),
    stat: async () => ({ size: 1000, mtime: new Date() }),
    open: async () => {
      throw new Error("Mock open");
    },
  };

  describe("isCached", () => {
    it("should return true for existing video", async () => {
      const handler = createVideoHandler({ videosPath: "/videos" }, mockFs);
      // Video ID "exists12345" contains "exists"
      const exists = "existsABC12";
      assertEquals(await handler.isCached(exists), true);
    });

    it("should return false for non-existing video", async () => {
      const handler = createVideoHandler({ videosPath: "/videos" }, mockFs);
      assertEquals(await handler.isCached("dQw4w9WgXcQ"), false);
    });
  });
});

// ============================================================================
// API Tests
// ============================================================================

describe("createApiRouter", () => {
  let mockExecutor: SqliteExecutor;
  let db: ReturnType<typeof createLocalDb>;
  let deps: ApiDependencies;

  beforeEach(() => {
    const store: Record<string, unknown[]> = {
      downloads: [],
      queue: [],
      exclusions: [],
    };

    mockExecutor = {
      execute: () => {},
      queryRows: <T>(sql: string, _params?: unknown[]): T[] => {
        if (sql.includes("downloads")) return store.downloads as T[];
        if (sql.includes("download_queue")) return store.queue as T[];
        if (sql.includes("exclusions")) return store.exclusions as T[];
        return [];
      },
      queryOne: <T>(sql: string, _params?: unknown[]): T | undefined => {
        if (sql.includes("COUNT")) {
          return { count: 0, total_bytes: 0 } as T;
        }
        return undefined;
      },
      close: () => {},
    };

    db = createLocalDb(mockExecutor);
    deps = { db };
  });

  describe("GET /status", () => {
    it("should return service status", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/status");

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.status, "ok");
      assertEquals(body.version, "0.1.0");
      assertExists(body.uptime);
      assertEquals(body.activeDownloads, 0);
    });
  });

  describe("GET /queue", () => {
    it("should return empty queue", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/queue");

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.items, []);
      assertEquals(body.count, 0);
    });
  });

  describe("POST /queue", () => {
    it("should reject invalid video ID", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "invalid" }),
      });

      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "Invalid video ID format");
    });

    it("should reject missing video ID", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "videoId is required");
    });

    it("should reject invalid JSON", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "Invalid JSON body");
    });
  });

  describe("GET /downloads", () => {
    it("should return empty downloads", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/downloads");

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.items, []);
      assertEquals(body.count, 0);
    });
  });

  describe("GET /exclusions", () => {
    it("should return empty exclusions", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/exclusions");

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.items, []);
      assertEquals(body.count, 0);
    });
  });

  describe("POST /exclusions", () => {
    it("should reject missing channel ID", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "channelId is required");
    });
  });

  describe("GET /stats", () => {
    it("should return stats", async () => {
      const api = createApiRouter(deps);
      const res = await api.request("/stats");

      assertEquals(res.status, 200);

      const body = await res.json();
      assertExists(body.downloads);
      assertExists(body.queue);
    });
  });
});
