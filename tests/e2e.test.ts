/**
 * End-to-end tests for the server.
 *
 * These tests spin up real server instances with actual SQLite databases
 * and test the full request/response flow.
 */

import { describe, it, beforeEach, afterEach, beforeAll, afterAll } from "@std/testing/bdd";
import { assertEquals, assertExists, assert } from "@std/assert";
import { join } from "@std/path";

import { createServer, type Server } from "../src/server/index.ts";
import { createLocalDb, createSqliteExecutor, type LocalDbClient } from "../src/db/local-db.ts";
import { createProxy, type HttpFetcher } from "../src/server/proxy.ts";
import type { Config } from "../src/config.ts";

// ============================================================================
// Test Utilities
// ============================================================================

// Lazy initialization to avoid module-level side effects
let TEST_DIR: string;
let TEST_DB_PATH: string;
let TEST_VIDEOS_PATH: string;

async function initTestDir(): Promise<void> {
  if (!TEST_DIR) {
    TEST_DIR = await Deno.makeTempDir({ prefix: "invidious_e2e_" });
    TEST_DB_PATH = join(TEST_DIR, "test.db");
    TEST_VIDEOS_PATH = join(TEST_DIR, "videos");
  }
}

/**
 * Create a test configuration.
 */
function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    invidiousUrl: "http://mock-invidious:3000",
    invidiousDbUrl: "postgres://test:test@localhost:5432/test",
    companionUrl: "http://mock-companion:8282",
    companionSecret: "test-secret",
    videosPath: TEST_VIDEOS_PATH!,
    port: 0, // Use random available port
    invidiousUser: null,
    downloadQuality: "best",
    downloadRateLimit: 0,
    checkIntervalMinutes: 30,
    maxConcurrentDownloads: 2,
    maxRetryAttempts: 3,
    retryBaseDelayMinutes: 1,
    cleanupEnabled: false,
    cleanupDays: 14,
    cleanupIntervalHours: 24,
    throttleSpeedThreshold: 102400,
    throttleDetectionWindow: 30,
    throttleMaxRetries: 5,
    ...overrides,
  };
}

/**
 * Create a mock HTTP fetcher that simulates Invidious responses.
 */
function createMockInvidiousFetcher(): HttpFetcher {
  return {
    async fetch(input: Request | URL | string): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      const parsedUrl = new URL(url);

      // Mock different Invidious endpoints
      if (parsedUrl.pathname === "/") {
        return new Response("<html><body>Invidious Home</body></html>", {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (parsedUrl.pathname === "/api/v1/stats") {
        return new Response(JSON.stringify({
          version: "2.0",
          software: { name: "invidious", version: "2.0" },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (parsedUrl.pathname.startsWith("/watch")) {
        const videoId = parsedUrl.searchParams.get("v");
        return new Response(`<html><body>Video: ${videoId}</body></html>`, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (parsedUrl.pathname.startsWith("/api/v1/videos/")) {
        const videoId = parsedUrl.pathname.split("/").pop();
        return new Response(JSON.stringify({
          videoId,
          title: `Test Video ${videoId}`,
          author: "Test Author",
          lengthSeconds: 120,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Default 404
      return new Response("Not Found", { status: 404 });
    },
  };
}

/**
 * Helper to make requests to the test server.
 */
async function request(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `http://localhost${path}`;
  const req = new Request(url, options);
  return await app.fetch(req);
}

// ============================================================================
// Setup and Teardown
// ============================================================================

let db: LocalDbClient;

// Wrap all tests in a describe block with sanitizers disabled
// SQLite library keeps internal file handles that trigger false positives
describe("E2E Tests", { sanitizeResources: false, sanitizeOps: false }, () => {

beforeAll(async () => {
  // Initialize test directories
  await initTestDir();
  await Deno.mkdir(TEST_VIDEOS_PATH!, { recursive: true });
});

afterAll(async () => {
  // Clean up test directory
  try {
    if (TEST_DIR) {
      await Deno.remove(TEST_DIR, { recursive: true });
    }
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// E2E Tests: Full Server with Real Database
// ============================================================================

describe("E2E: Server with Real SQLite", () => {
  let server: Server;

  beforeEach(async () => {
    // Create fresh database for each test
    const dbPath = join(TEST_DIR!, `test_${Date.now()}.db`);
    const executor = await createSqliteExecutor(dbPath);
    db = createLocalDb(executor);
    db.init();

    // Create server with mock Invidious
    const config = createTestConfig();
    server = createServer({
      config,
      db,
      httpFetcher: createMockInvidiousFetcher(),
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("Health Check", () => {
    it("should return health status", async () => {
      const res = await request(server.app, "/health");

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "ok");
      assertExists(body.timestamp);
    });
  });

  describe("API: Status", () => {
    it("should return service status with real stats", async () => {
      const res = await request(server.app, "/api/downloader/status");

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "ok");
      assertEquals(body.version, "0.1.0");
      assertEquals(body.totalDownloads, 0);
      assertEquals(body.queueLength, 0);
    });
  });

  describe("API: Queue Operations", () => {
    it("should add video to queue and retrieve it", async () => {
      // Add to queue
      const addRes = await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "dQw4w9WgXcQ" }),
      });

      assertEquals(addRes.status, 201);
      const addBody = await addRes.json();
      assertEquals(addBody.videoId, "dQw4w9WgXcQ");
      assertEquals(addBody.status, "pending");

      // Retrieve queue
      const listRes = await request(server.app, "/api/downloader/queue");

      assertEquals(listRes.status, 200);
      const listBody = await listRes.json();
      assertEquals(listBody.count, 1);
      assertEquals(listBody.items[0].videoId, "dQw4w9WgXcQ");
    });

    it("should reject duplicate queue entries", async () => {
      // Add first
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "dQw4w9WgXcQ" }),
      });

      // Try to add again
      const res = await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "dQw4w9WgXcQ" }),
      });

      assertEquals(res.status, 409);
      const body = await res.json();
      assertEquals(body.error, "Video already in queue");
    });

    it("should cancel queued item", async () => {
      // Add to queue
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "dQw4w9WgXcQ" }),
      });

      // Cancel it
      const cancelRes = await request(server.app, "/api/downloader/queue/dQw4w9WgXcQ", {
        method: "DELETE",
      });

      assertEquals(cancelRes.status, 200);
      const body = await cancelRes.json();
      assertEquals(body.success, true);
      assertEquals(body.item.status, "cancelled");
    });

    it("should filter queue by status", async () => {
      // Add multiple items
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "video111111" }),
      });
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "video222222" }),
      });

      // Cancel one
      await request(server.app, "/api/downloader/queue/video111111", {
        method: "DELETE",
      });

      // Filter by pending
      const pendingRes = await request(server.app, "/api/downloader/queue?status=pending");
      const pendingBody = await pendingRes.json();
      assertEquals(pendingBody.count, 1);
      assertEquals(pendingBody.items[0].videoId, "video222222");

      // Filter by cancelled
      const cancelledRes = await request(server.app, "/api/downloader/queue?status=cancelled");
      const cancelledBody = await cancelledRes.json();
      assertEquals(cancelledBody.count, 1);
      assertEquals(cancelledBody.items[0].videoId, "video111111");
    });
  });

  describe("API: Exclusions", () => {
    it("should add and list exclusions", async () => {
      // Add exclusion
      const addRes = await request(server.app, "/api/downloader/exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "UCxxxxxxxxxxxxxxxx" }),
      });

      assertEquals(addRes.status, 201);

      // List exclusions
      const listRes = await request(server.app, "/api/downloader/exclusions");
      const body = await listRes.json();

      assertEquals(body.count, 1);
      assertEquals(body.items[0].channelId, "UCxxxxxxxxxxxxxxxx");
    });

    it("should remove exclusion", async () => {
      // Add exclusion
      await request(server.app, "/api/downloader/exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "UCxxxxxxxxxxxxxxxx" }),
      });

      // Remove it
      const removeRes = await request(server.app, "/api/downloader/exclusions/UCxxxxxxxxxxxxxxxx", {
        method: "DELETE",
      });

      assertEquals(removeRes.status, 200);

      // Verify removed
      const listRes = await request(server.app, "/api/downloader/exclusions");
      const body = await listRes.json();
      assertEquals(body.count, 0);
    });
  });

  describe("API: Stats", () => {
    it("should return accurate stats after operations", async () => {
      // Add some queue items
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "video111111" }),
      });
      await request(server.app, "/api/downloader/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "video222222" }),
      });

      const res = await request(server.app, "/api/downloader/stats");
      const body = await res.json();

      assertEquals(body.downloads.count, 0);
      assertEquals(body.queue.pending, 2);
    });
  });

  describe("Proxy: Invidious Requests", () => {
    it("should proxy homepage request", async () => {
      const res = await request(server.app, "/");

      assertEquals(res.status, 200);
      const body = await res.text();
      assert(body.includes("Invidious Home"));
    });

    it("should proxy watch page request", async () => {
      const res = await request(server.app, "/watch?v=dQw4w9WgXcQ");

      assertEquals(res.status, 200);
      const body = await res.text();
      assert(body.includes("Video: dQw4w9WgXcQ"));
    });

    it("should proxy API requests", async () => {
      const res = await request(server.app, "/api/v1/videos/dQw4w9WgXcQ");

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.videoId, "dQw4w9WgXcQ");
      assertEquals(body.title, "Test Video dQw4w9WgXcQ");
    });

    it("should proxy stats endpoint", async () => {
      const res = await request(server.app, "/api/v1/stats");

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.software.name, "invidious");
    });
  });
});

// ============================================================================
// E2E Tests: Video Serving
// ============================================================================

describe("E2E: Video Serving", () => {
  let server: Server;
  const testVideoId = "testVideo12";
  let testVideoPath: string;
  let testThumbnailPath: string;
  let testMetadataPath: string;

  beforeEach(async () => {
    // Initialize paths after TEST_VIDEOS_PATH is set
    testVideoPath = join(TEST_VIDEOS_PATH!, `${testVideoId}.mp4`);
    testThumbnailPath = join(TEST_VIDEOS_PATH!, `${testVideoId}.webp`);
    testMetadataPath = join(TEST_VIDEOS_PATH!, `${testVideoId}.json`);

    // Create test video file (small binary content)
    const videoContent = new Uint8Array(10000); // 10KB test file
    for (let i = 0; i < videoContent.length; i++) {
      videoContent[i] = i % 256;
    }
    await Deno.writeFile(testVideoPath, videoContent);

    // Create test thumbnail
    const thumbnailContent = new TextEncoder().encode("FAKE_WEBP_DATA");
    await Deno.writeFile(testThumbnailPath, thumbnailContent);

    // Create test metadata
    const metadata = {
      title: "Test Video",
      author: "Test Author",
      lengthSeconds: 120,
      viewCount: 1000,
    };
    await Deno.writeTextFile(testMetadataPath, JSON.stringify(metadata));

    // Create database
    const dbPath = join(TEST_DIR!, `video_test_${Date.now()}.db`);
    const executor = await createSqliteExecutor(dbPath);
    db = createLocalDb(executor);
    db.init();

    // Create server
    const config = createTestConfig();
    server = createServer({
      config,
      db,
      httpFetcher: createMockInvidiousFetcher(),
    });
  });

  afterEach(async () => {
    db.close();
    // Clean up test files
    try {
      await Deno.remove(testVideoPath);
      await Deno.remove(testThumbnailPath);
      await Deno.remove(testMetadataPath);
    } catch {
      // Ignore
    }
  });

  describe("Direct Cached Video Access", () => {
    it("should serve cached video", async () => {
      const res = await request(server.app, `/cached/${testVideoId}`);

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), "video/mp4");
      assertEquals(res.headers.get("Content-Length"), "10000");
      assertEquals(res.headers.get("Accept-Ranges"), "bytes");

      const body = await res.arrayBuffer();
      assertEquals(body.byteLength, 10000);
    });

    it("should support range requests", async () => {
      const res = await request(server.app, `/cached/${testVideoId}`, {
        headers: { Range: "bytes=0-499" },
      });

      assertEquals(res.status, 206);
      assertEquals(res.headers.get("Content-Length"), "500");
      assertEquals(res.headers.get("Content-Range"), "bytes 0-499/10000");

      const body = await res.arrayBuffer();
      assertEquals(body.byteLength, 500);
    });

    it("should support open-ended range requests", async () => {
      const res = await request(server.app, `/cached/${testVideoId}`, {
        headers: { Range: "bytes=9000-" },
      });

      assertEquals(res.status, 206);
      assertEquals(res.headers.get("Content-Length"), "1000");
      assertEquals(res.headers.get("Content-Range"), "bytes 9000-9999/10000");
    });

    it("should return 404 for non-existent video", async () => {
      const res = await request(server.app, "/cached/nonexisten1");

      assertEquals(res.status, 404);
    });

    it("should reject invalid video ID", async () => {
      const res = await request(server.app, "/cached/invalid!");

      assertEquals(res.status, 400);
    });
  });

  describe("Thumbnail Access", () => {
    it("should serve cached thumbnail", async () => {
      const res = await request(server.app, `/cached/${testVideoId}/thumbnail`);

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Content-Type"), "image/webp");
    });

    it("should return 404 for non-existent thumbnail", async () => {
      const res = await request(server.app, "/cached/nonexisten1/thumbnail");

      assertEquals(res.status, 404);
    });
  });

  describe("Metadata Access", () => {
    it("should serve video metadata", async () => {
      const res = await request(server.app, `/cached/${testVideoId}/metadata`);

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.title, "Test Video");
      assertEquals(body.author, "Test Author");
      assertEquals(body.lengthSeconds, 120);
    });

    it("should return 404 for non-existent metadata", async () => {
      const res = await request(server.app, "/cached/nonexisten1/metadata");

      assertEquals(res.status, 404);
    });
  });
});

// ============================================================================
// E2E Tests: Queue Clear
// ============================================================================

describe("E2E: Queue Management", () => {
  let server: Server;

  beforeEach(async () => {
    const dbPath = join(TEST_DIR!, `queue_test_${Date.now()}.db`);
    const executor = await createSqliteExecutor(dbPath);
    db = createLocalDb(executor);
    db.init();

    const config = createTestConfig();
    server = createServer({
      config,
      db,
      httpFetcher: createMockInvidiousFetcher(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("should clear completed queue items", async () => {
    // Add items
    await request(server.app, "/api/downloader/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: "video111111" }),
    });
    await request(server.app, "/api/downloader/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: "video222222" }),
    });

    // Cancel one (simulating completed/failed)
    await request(server.app, "/api/downloader/queue/video111111", {
      method: "DELETE",
    });

    // Clear completed
    const clearRes = await request(server.app, "/api/downloader/queue/clear", {
      method: "POST",
    });

    assertEquals(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assertEquals(clearBody.cleared, 1);

    // Verify only pending remains
    const listRes = await request(server.app, "/api/downloader/queue");
    const listBody = await listRes.json();
    assertEquals(listBody.count, 1);
    assertEquals(listBody.items[0].status, "pending");
  });
});

// ============================================================================
// E2E Tests: Error Handling
// ============================================================================

describe("E2E: Error Handling", () => {
  let server: Server;

  beforeEach(async () => {
    const dbPath = join(TEST_DIR!, `error_test_${Date.now()}.db`);
    const executor = await createSqliteExecutor(dbPath);
    db = createLocalDb(executor);
    db.init();

    const config = createTestConfig();
    server = createServer({
      config,
      db,
      httpFetcher: createMockInvidiousFetcher(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("should handle malformed JSON gracefully", async () => {
    const res = await request(server.app, "/api/downloader/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json }",
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Invalid JSON body");
  });

  it("should handle missing required fields", async () => {
    const res = await request(server.app, "/api/downloader/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: 1 }), // Missing videoId
    });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "videoId is required");
  });

  it("should handle delete of non-existent queue item", async () => {
    const res = await request(server.app, "/api/downloader/queue/nonexisten1", {
      method: "DELETE",
    });

    assertEquals(res.status, 404);
  });

  it("should handle delete of non-existent download", async () => {
    const res = await request(server.app, "/api/downloader/downloads/nonexisten1", {
      method: "DELETE",
    });

    assertEquals(res.status, 404);
  });
});

// ============================================================================
// E2E Tests: Proxy Error Handling
// ============================================================================

describe("E2E: Proxy Error Handling", () => {
  it("should handle upstream errors gracefully", async () => {
    const errorFetcher: HttpFetcher = {
      async fetch(): Promise<Response> {
        throw new Error("Connection refused");
      },
    };

    const dbPath = join(TEST_DIR!, `proxy_error_${Date.now()}.db`);
    const executor = await createSqliteExecutor(dbPath);
    const localDb = createLocalDb(executor);
    localDb.init();

    const config = createTestConfig();
    const server = createServer({
      config,
      db: localDb,
      httpFetcher: errorFetcher,
    });

    try {
      const res = await request(server.app, "/some/proxied/path");

      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error, "Connection refused");
    } finally {
      localDb.close();
    }
  });
});

}); // End of E2E Tests wrapper
