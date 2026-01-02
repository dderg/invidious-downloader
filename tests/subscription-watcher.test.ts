/**
 * Tests for the Subscription Watcher service.
 */

import { describe, it, beforeEach } from "@std/testing/bdd";
import { assertEquals, assertExists } from "@std/assert";

import {
  filterVideos,
  sortVideosByPriority,
  getDefaultPublishedAfter,
  mergeConfig,
  createSubscriptionWatcher,
  DEFAULT_WATCHER_CONFIG,
  type WatcherConfig,
  type CheckResult,
} from "../src/services/subscription-watcher.ts";
import type { ChannelVideo, DbResult, InvidiousUser, LatestVideosOptions } from "../src/db/types.ts";
import type { InvidiousDbClient } from "../src/db/invidious-db.ts";
import type { LocalDbClient } from "../src/db/local-db.ts";

// ============================================================================
// Test Data
// ============================================================================

function createTestVideo(overrides: Partial<ChannelVideo> = {}): ChannelVideo {
  return {
    id: "testVideo11",
    ucid: "UCxxxxxxxx1111",
    title: "Test Video",
    published: new Date("2024-01-15T10:00:00Z"),
    lengthSeconds: 600, // 10 minutes
    liveNow: false,
    premiere: false,
    views: 1000,
    ...overrides,
  };
}

// ============================================================================
// Pure Function Tests
// ============================================================================

describe("filterVideos", () => {
  const defaultConfig: WatcherConfig = {
    checkIntervalMs: 30000,
    userId: null,
    excludeLive: true,
    excludePremieres: true,
    minDurationSeconds: 60,
    maxVideosPerCheck: 50,
  };

  it("should pass videos that meet all criteria", () => {
    const videos = [createTestVideo({ id: "video1111111" })];
    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 1);
    assertEquals(result.skipped.length, 0);
    assertEquals(result.toQueue[0].id, "video1111111");
  });

  it("should skip already downloaded videos", () => {
    const videos = [createTestVideo({ id: "video1111111" })];
    const downloadedIds = new Set(["video1111111"]);

    const result = filterVideos(
      videos,
      defaultConfig,
      downloadedIds,
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "already_downloaded");
  });

  it("should skip already queued videos", () => {
    const videos = [createTestVideo({ id: "video1111111" })];
    const queuedIds = new Set(["video1111111"]);

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      queuedIds,
      new Set(),
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "already_queued");
  });

  it("should skip videos from excluded channels", () => {
    const videos = [createTestVideo({ id: "video1111111", ucid: "UCexcluded1" })];
    const excludedChannels = new Set(["UCexcluded1"]);

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      excludedChannels,
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "channel_excluded");
  });

  it("should skip videos that are too short", () => {
    const videos = [createTestVideo({ id: "video1111111", lengthSeconds: 30 })];

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "too_short");
  });

  it("should skip live videos when excludeLive is true", () => {
    const videos = [createTestVideo({ id: "video1111111", liveNow: true })];

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "is_live");
  });

  it("should include live videos when excludeLive is false", () => {
    const videos = [createTestVideo({ id: "video1111111", liveNow: true })];
    const config = { ...defaultConfig, excludeLive: false };

    const result = filterVideos(
      videos,
      config,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 1);
    assertEquals(result.skipped.length, 0);
  });

  it("should skip premieres when excludePremieres is true", () => {
    const videos = [createTestVideo({ id: "video1111111", premiere: true })];

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].reason, "is_premiere");
  });

  it("should handle multiple videos with mixed results", () => {
    const videos = [
      createTestVideo({ id: "video1111111" }), // Pass
      createTestVideo({ id: "video2222222" }), // Downloaded
      createTestVideo({ id: "video3333333", lengthSeconds: 10 }), // Too short
      createTestVideo({ id: "video4444444", liveNow: true }), // Live
      createTestVideo({ id: "video5555555" }), // Pass
    ];

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(["video2222222"]),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 2);
    assertEquals(result.skipped.length, 3);
  });

  it("should allow videos with duration equal to minimum", () => {
    const videos = [createTestVideo({ id: "video1111111", lengthSeconds: 60 })];

    const result = filterVideos(
      videos,
      defaultConfig,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 1);
  });

  it("should allow any duration when minDurationSeconds is 0", () => {
    const videos = [createTestVideo({ id: "video1111111", lengthSeconds: 5 })];
    const config = { ...defaultConfig, minDurationSeconds: 0 };

    const result = filterVideos(
      videos,
      config,
      new Set(),
      new Set(),
      new Set(),
    );

    assertEquals(result.toQueue.length, 1);
  });
});

describe("sortVideosByPriority", () => {
  it("should sort videos by published date (newest first)", () => {
    const videos = [
      createTestVideo({ id: "old1111111", published: new Date("2024-01-01") }),
      createTestVideo({ id: "new1111111", published: new Date("2024-01-15") }),
      createTestVideo({ id: "mid1111111", published: new Date("2024-01-10") }),
    ];

    const sorted = sortVideosByPriority(videos);

    assertEquals(sorted[0].id, "new1111111");
    assertEquals(sorted[1].id, "mid1111111");
    assertEquals(sorted[2].id, "old1111111");
  });

  it("should not mutate original array", () => {
    const videos = [
      createTestVideo({ id: "video1111111", published: new Date("2024-01-01") }),
      createTestVideo({ id: "video2222222", published: new Date("2024-01-15") }),
    ];

    const sorted = sortVideosByPriority(videos);

    assertEquals(videos[0].id, "video1111111");
    assertEquals(sorted[0].id, "video2222222");
  });

  it("should handle empty array", () => {
    const sorted = sortVideosByPriority([]);
    assertEquals(sorted.length, 0);
  });
});

describe("getDefaultPublishedAfter", () => {
  it("should return a date approximately 24 hours ago", () => {
    const result = getDefaultPublishedAfter();
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Allow 1 minute tolerance
    const diff = Math.abs(result.getTime() - twentyFourHoursAgo.getTime());
    assertEquals(diff < 60000, true);
  });
});

describe("mergeConfig", () => {
  it("should use defaults for missing values", () => {
    const config = mergeConfig({});
    assertEquals(config.checkIntervalMs, DEFAULT_WATCHER_CONFIG.checkIntervalMs);
    assertEquals(config.excludeLive, DEFAULT_WATCHER_CONFIG.excludeLive);
  });

  it("should override defaults with provided values", () => {
    const config = mergeConfig({
      checkIntervalMs: 5000,
      excludeLive: false,
    });

    assertEquals(config.checkIntervalMs, 5000);
    assertEquals(config.excludeLive, false);
    assertEquals(config.excludePremieres, DEFAULT_WATCHER_CONFIG.excludePremieres);
  });

  it("should handle null userId", () => {
    const config = mergeConfig({ userId: null });
    assertEquals(config.userId, null);
  });

  it("should handle specific userId", () => {
    const config = mergeConfig({ userId: "test@example.com" });
    assertEquals(config.userId, "test@example.com");
  });
});

// ============================================================================
// Watcher Service Tests (with mocks)
// ============================================================================

describe("createSubscriptionWatcher", () => {
  // Mock Invidious DB
  function createMockInvidiousDb(
    overrides: Partial<InvidiousDbClient> = {},
  ): InvidiousDbClient {
    return {
      getUser: async () => ({ ok: false, error: { type: "not_found", message: "Not found" } }),
      getAllUsers: async (): Promise<DbResult<InvidiousUser[]>> => ({ ok: true, data: [] }),
      getSubscriptions: async () => ({ ok: true, data: [] }),
      getChannel: async () => ({ ok: false, error: { type: "not_found", message: "Not found" } }),
      getChannels: async () => ({ ok: true, data: [] }),
      getLatestVideos: async () => ({ ok: true, data: [] }),
      getMaxPublishedTimestamp: async () => ({ ok: true, data: null }),
      close: async () => {},
      ...overrides,
    };
  }

  // Mock Local DB (simplified)
  function createMockLocalDb(
    overrides: Partial<LocalDbClient> = {},
  ): LocalDbClient {
    // deno-lint-ignore no-explicit-any
    const mock: any = {
      init: () => ({ ok: true, data: undefined }),
      addDownload: () => ({ ok: true, data: {} }),
      getDownload: () => ({ ok: true, data: null }),
      isDownloaded: () => false,
      getDownloads: () => ({ ok: true, data: [] }),
      deleteDownload: () => ({ ok: true, data: true }),
      getDownloadStats: () => ({ ok: true, data: { count: 0, totalBytes: 0 } }),
      addToQueue: () => ({ ok: true, data: { id: 1, videoId: "", userId: null, priority: 0, status: "pending", errorMessage: null, queuedAt: new Date(), startedAt: null, completedAt: null } }),
      getQueue: () => ({ ok: true, data: [] }),
      getNextQueueItem: () => ({ ok: true, data: null }),
      updateQueueStatus: () => ({ ok: true, data: {} }),
      removeFromQueue: () => ({ ok: true, data: true }),
      isInQueue: () => false,
      clearCompletedQueue: () => ({ ok: true, data: 0 }),
      addExclusion: () => ({ ok: true, data: {} }),
      removeExclusion: () => ({ ok: true, data: true }),
      isExcluded: () => false,
      getExclusions: () => ({ ok: true, data: [] }),
      getExcludedChannelIds: () => ({ ok: true, data: [] }),
      close: () => {},
      ...overrides,
    };
    return mock;
  }

  describe("getState", () => {
    it("should return initial state", () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb(),
        localDb: createMockLocalDb(),
      });

      const state = watcher.getState();

      assertEquals(state.isRunning, false);
      assertEquals(state.lastCheckAt, null);
      assertEquals(state.videosQueuedTotal, 0);
      assertEquals(state.checksCompleted, 0);
      assertEquals(state.errors.length, 0);
      assertEquals(state.lastSeenVideoTimestamp, null);
    });
  });

  describe("getConfig", () => {
    it("should return merged configuration", () => {
      const watcher = createSubscriptionWatcher(
        {
          invidiousDb: createMockInvidiousDb(),
          localDb: createMockLocalDb(),
        },
        { checkIntervalMs: 5000 },
      );

      const config = watcher.getConfig();

      assertEquals(config.checkIntervalMs, 5000);
      assertEquals(config.excludeLive, true); // Default
    });
  });

  describe("triggerCheck", () => {
    it("should return success with no subscriptions", async () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({ ok: true, data: [] }),
        }),
        localDb: createMockLocalDb(),
      });

      const result = await watcher.triggerCheck();

      assertEquals(result.ok, true);
      assertEquals(result.videosFound, 0);
      assertEquals(result.videosQueued, 0);
    });

    it("should find and queue new videos", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111" }),
        createTestVideo({ id: "video2222222" }),
      ];

      let queuedCount = 0;
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => ({ ok: true, data: testVideos }),
        }),
        localDb: createMockLocalDb({
          addToQueue: () => {
            queuedCount++;
            return { ok: true, data: { id: queuedCount, videoId: "", userId: null, priority: 0, status: "pending", errorMessage: null, queuedAt: new Date(), startedAt: null, completedAt: null } };
          },
        }),
      });

      const result = await watcher.triggerCheck();

      assertEquals(result.ok, true);
      assertEquals(result.videosFound, 2);
      assertEquals(result.videosQueued, 2);
      assertEquals(queuedCount, 2);
    });

    it("should skip already downloaded videos", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111" }),
      ];

      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => ({ ok: true, data: testVideos }),
        }),
        localDb: createMockLocalDb({
          getDownloads: () => ({
            ok: true,
            data: [{ videoId: "video1111111" } as any],
          }),
        }),
      });

      const result = await watcher.triggerCheck();

      assertEquals(result.ok, true);
      assertEquals(result.videosFound, 1);
      assertEquals(result.videosQueued, 0);
      assertEquals(result.videosSkipped, 1);
    });

    it("should handle database errors gracefully", async () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: false,
            error: { type: "connection_error", message: "Database connection failed" },
          }),
        }),
        localDb: createMockLocalDb(),
      });

      const result = await watcher.triggerCheck();

      assertEquals(result.ok, false);
      assertExists(result.error);
      assertEquals(result.error.includes("Database connection failed"), true);
    });

    it("should use specific user subscriptions when userId is set", async () => {
      let requestedEmail: string | undefined;
      
      const watcher = createSubscriptionWatcher(
        {
          invidiousDb: createMockInvidiousDb({
            getSubscriptions: async (email: string) => {
              requestedEmail = email;
              return { ok: true, data: ["UCtest1111"] };
            },
            getLatestVideos: async () => ({ ok: true, data: [] }),
          }),
          localDb: createMockLocalDb(),
        },
        { userId: "specific@example.com" },
      );

      await watcher.triggerCheck();

      assertEquals(requestedEmail, "specific@example.com");
    });

    it("should update state after check", async () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => ({
            ok: true,
            data: [createTestVideo({ id: "video1111111" })],
          }),
        }),
        localDb: createMockLocalDb(),
      });

      await watcher.triggerCheck();
      const state = watcher.getState();

      assertExists(state.lastCheckAt);
      assertExists(state.lastCheckDurationMs);
      assertEquals(state.checksCompleted, 1);
      assertEquals(state.videosQueuedTotal, 1);
    });

    it("should record errors in state", async () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: false,
            error: { type: "connection_error", message: "Connection failed" },
          }),
        }),
        localDb: createMockLocalDb(),
      });

      await watcher.triggerCheck();
      const state = watcher.getState();

      assertEquals(state.errors.length, 1);
      assertEquals(state.errors[0].type, "db_error");
    });
  });

  describe("start/stop", () => {
    it("should set isRunning to true when started", () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb(),
        localDb: createMockLocalDb(),
      });

      watcher.start();
      assertEquals(watcher.getState().isRunning, true);

      watcher.stop();
      assertEquals(watcher.getState().isRunning, false);
    });

    it("should not start twice", () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb(),
        localDb: createMockLocalDb(),
      });

      watcher.start();
      watcher.start(); // Should be no-op
      assertEquals(watcher.getState().isRunning, true);

      watcher.stop();
    });
  });

  describe("resetPublishedAfter", () => {
    it("should reset to default when no date provided", () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb(),
        localDb: createMockLocalDb(),
      });

      // This just verifies it doesn't throw
      watcher.resetPublishedAfter();
    });

    it("should reset to specific date when provided", () => {
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb(),
        localDb: createMockLocalDb(),
      });

      const specificDate = new Date("2024-01-01");
      watcher.resetPublishedAfter(specificDate);
      // No direct way to verify, but should not throw
    });
  });

  describe("quick-check optimization", () => {
    it("should skip full check when no new videos since last check", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111", published: new Date("2024-01-15T10:00:00Z") }),
      ];

      let latestVideosCalled = 0;
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => {
            latestVideosCalled++;
            return { ok: true, data: testVideos };
          },
          getMaxPublishedTimestamp: async () => ({
            ok: true,
            data: new Date("2024-01-15T10:00:00Z"),
          }),
        }),
        localDb: createMockLocalDb(),
      });

      // First check should process videos
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 1);
      assertEquals(watcher.getState().lastSeenVideoTimestamp?.getTime(), new Date("2024-01-15T10:00:00Z").getTime());

      // Second check should skip (same max timestamp)
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 1); // Should NOT have increased
    });

    it("should do full check when newer videos exist", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111", published: new Date("2024-01-15T10:00:00Z") }),
      ];
      const newerVideos: ChannelVideo[] = [
        createTestVideo({ id: "video2222222", published: new Date("2024-01-16T10:00:00Z") }),
      ];

      let latestVideosCalled = 0;
      let maxTimestamp = new Date("2024-01-15T10:00:00Z");

      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => {
            latestVideosCalled++;
            return { ok: true, data: latestVideosCalled === 1 ? testVideos : newerVideos };
          },
          getMaxPublishedTimestamp: async () => ({
            ok: true,
            data: maxTimestamp,
          }),
        }),
        localDb: createMockLocalDb(),
      });

      // First check
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 1);

      // Simulate Invidious finding a new video
      maxTimestamp = new Date("2024-01-16T10:00:00Z");

      // Second check should process (newer max timestamp)
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 2);
    });

    it("should do full check on first run (no lastSeenVideoTimestamp)", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111", published: new Date("2024-01-15T10:00:00Z") }),
      ];

      let latestVideosCalled = 0;
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => {
            latestVideosCalled++;
            return { ok: true, data: testVideos };
          },
          getMaxPublishedTimestamp: async () => ({
            ok: true,
            data: new Date("2024-01-15T10:00:00Z"),
          }),
        }),
        localDb: createMockLocalDb(),
      });

      // First check should always do full check
      assertEquals(watcher.getState().lastSeenVideoTimestamp, null);
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 1);
    });

    it("should update lastSeenVideoTimestamp after successful check", async () => {
      const videoDate = new Date("2024-01-20T15:30:00Z");
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111", published: videoDate }),
      ];

      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => ({ ok: true, data: testVideos }),
          getMaxPublishedTimestamp: async () => ({ ok: true, data: videoDate }),
        }),
        localDb: createMockLocalDb(),
      });

      await watcher.triggerCheck();
      const state = watcher.getState();

      assertEquals(state.lastSeenVideoTimestamp?.getTime(), videoDate.getTime());
    });

    it("should handle getMaxPublishedTimestamp returning null gracefully", async () => {
      const testVideos: ChannelVideo[] = [
        createTestVideo({ id: "video1111111" }),
      ];

      let latestVideosCalled = 0;
      const watcher = createSubscriptionWatcher({
        invidiousDb: createMockInvidiousDb({
          getAllUsers: async () => ({
            ok: true,
            data: [{ email: "test@example.com", subscriptions: ["UCtest1111"] }],
          }),
          getLatestVideos: async () => {
            latestVideosCalled++;
            return { ok: true, data: testVideos };
          },
          getMaxPublishedTimestamp: async () => ({ ok: true, data: null }),
        }),
        localDb: createMockLocalDb(),
      });

      // Should still do full check when max timestamp is null
      await watcher.triggerCheck();
      assertEquals(latestVideosCalled, 1);
    });
  });
});
