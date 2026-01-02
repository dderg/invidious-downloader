import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildGetAllUsersQuery,
  buildGetChannelQuery,
  buildGetChannelsQuery,
  buildGetMaxPublishedQuery,
  buildGetUserQuery,
  buildLatestVideosQuery,
  createInvidiousDb,
  mapChannelRow,
  mapChannelVideoRow,
  mapUserRow,
  parseSubscriptions,
  type SqlExecutor,
  type SqlRow,
} from "../src/db/invidious-db.ts";

// ============================================================================
// Mock SQL Executor
// ============================================================================

function createMockExecutor(
  rows: SqlRow[] = [],
  shouldThrow?: Error,
): SqlExecutor {
  return {
    async queryRows<T extends SqlRow>(): Promise<T[]> {
      if (shouldThrow) throw shouldThrow;
      return rows as T[];
    },
    async queryOne<T extends SqlRow>(): Promise<T | null> {
      if (shouldThrow) throw shouldThrow;
      return (rows[0] as T) ?? null;
    },
    async close(): Promise<void> {},
  };
}

// ============================================================================
// parseSubscriptions Tests
// ============================================================================

describe("parseSubscriptions", () => {
  it("should parse array of strings", () => {
    const result = parseSubscriptions(["UC123", "UC456", "UC789"]);
    assertEquals(result, ["UC123", "UC456", "UC789"]);
  });

  it("should parse PostgreSQL array string format", () => {
    const result = parseSubscriptions("{UC123,UC456,UC789}");
    assertEquals(result, ["UC123", "UC456", "UC789"]);
  });

  it("should handle empty PostgreSQL array", () => {
    const result = parseSubscriptions("{}");
    assertEquals(result, []);
  });

  it("should handle JSON array string", () => {
    const result = parseSubscriptions('["UC123","UC456"]');
    assertEquals(result, ["UC123", "UC456"]);
  });

  it("should filter empty strings", () => {
    const result = parseSubscriptions(["UC123", "", "UC456"]);
    assertEquals(result, ["UC123", "UC456"]);
  });

  it("should return empty array for invalid input", () => {
    assertEquals(parseSubscriptions(null), []);
    assertEquals(parseSubscriptions(undefined), []);
    assertEquals(parseSubscriptions(123), []);
    assertEquals(parseSubscriptions("not an array"), []);
  });

  it("should handle PostgreSQL array with spaces", () => {
    const result = parseSubscriptions("{ UC123 , UC456 , UC789 }");
    assertEquals(result, ["UC123", "UC456", "UC789"]);
  });
});

// ============================================================================
// Row Mapper Tests
// ============================================================================

describe("mapUserRow", () => {
  it("should map user row correctly", () => {
    const row = {
      email: "test@example.com",
      subscriptions: ["UC123", "UC456"],
    };
    const result = mapUserRow(row);
    assertEquals(result.email, "test@example.com");
    assertEquals(result.subscriptions, ["UC123", "UC456"]);
  });

  it("should handle missing fields", () => {
    const row = {};
    const result = mapUserRow(row);
    assertEquals(result.email, "");
    assertEquals(result.subscriptions, []);
  });
});

describe("mapChannelVideoRow", () => {
  it("should map channel video row correctly", () => {
    const row = {
      id: "dQw4w9WgXcQ",
      ucid: "UCuAXFkgsw1L7xaCfnd5JJOw",
      title: "Test Video",
      published: new Date("2024-01-01"),
      length_seconds: 212,
      live_now: false,
      premiere_timestamp: null,
      views: 1000000,
    };
    const result = mapChannelVideoRow(row);
    assertEquals(result.id, "dQw4w9WgXcQ");
    assertEquals(result.ucid, "UCuAXFkgsw1L7xaCfnd5JJOw");
    assertEquals(result.title, "Test Video");
    assertEquals(result.lengthSeconds, 212);
    assertEquals(result.liveNow, false);
    assertEquals(result.premiere, false);
    assertEquals(result.views, 1000000);
  });

  it("should detect premieres", () => {
    const row = {
      id: "test",
      ucid: "UC123",
      title: "Premiere",
      published: new Date(),
      length_seconds: 0,
      live_now: false,
      premiere_timestamp: new Date(),
      views: 0,
    };
    const result = mapChannelVideoRow(row);
    assertEquals(result.premiere, true);
  });

  it("should handle string dates", () => {
    const row = {
      id: "test",
      ucid: "UC123",
      title: "Test",
      published: "2024-01-01T00:00:00Z",
      length_seconds: 100,
      live_now: false,
      premiere_timestamp: null,
      views: 0,
    };
    const result = mapChannelVideoRow(row);
    assertEquals(result.published instanceof Date, true);
  });
});

describe("mapChannelRow", () => {
  it("should map channel row correctly", () => {
    const row = {
      id: "UCuAXFkgsw1L7xaCfnd5JJOw",
      author: "Rick Astley",
      updated: new Date("2024-01-01"),
    };
    const result = mapChannelRow(row);
    assertEquals(result.id, "UCuAXFkgsw1L7xaCfnd5JJOw");
    assertEquals(result.author, "Rick Astley");
  });
});

// ============================================================================
// Query Builder Tests
// ============================================================================

describe("buildGetUserQuery", () => {
  it("should build correct query", () => {
    const { sql, params } = buildGetUserQuery("test@example.com");
    assertEquals(sql, "SELECT email, subscriptions FROM users WHERE email = $1");
    assertEquals(params, ["test@example.com"]);
  });
});

describe("buildGetAllUsersQuery", () => {
  it("should build correct query", () => {
    const { sql, params } = buildGetAllUsersQuery();
    assertEquals(
      sql,
      "SELECT email, subscriptions FROM users WHERE array_length(subscriptions, 1) > 0",
    );
    assertEquals(params, []);
  });
});

describe("buildLatestVideosQuery", () => {
  it("should build basic query with channel filter", () => {
    const { sql, params } = buildLatestVideosQuery({
      channelIds: ["UC123", "UC456"],
    });
    assertEquals(params[0], ["UC123", "UC456"]);
    assertEquals(sql.includes("ucid = ANY($1)"), true);
    assertEquals(sql.includes("ORDER BY published DESC"), true);
  });

  it("should return empty query for empty channel list", () => {
    const { sql } = buildLatestVideosQuery({ channelIds: [] });
    assertEquals(sql.includes("WHERE false"), true);
  });

  it("should add publishedAfter filter", () => {
    const date = new Date("2024-01-01");
    const { sql, params } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      publishedAfter: date,
    });
    assertEquals(params[1], date);
    assertEquals(sql.includes("published > $2"), true);
  });

  it("should add excludeLive filter", () => {
    const { sql } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      excludeLive: true,
    });
    assertEquals(sql.includes("live_now = false"), true);
  });

  it("should add excludePremieres filter", () => {
    const { sql } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      excludePremieres: true,
    });
    assertEquals(sql.includes("premiere_timestamp IS NULL"), true);
  });

  it("should add minDurationSeconds filter", () => {
    const { sql, params } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      minDurationSeconds: 60,
    });
    assertEquals(sql.includes("length_seconds >= $2"), true);
    assertEquals(params[1], 60);
  });

  it("should add limit clause", () => {
    const { sql, params } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      limit: 50,
    });
    assertEquals(sql.includes("LIMIT"), true);
    assertEquals(params[params.length - 1], 50);
  });

  it("should combine multiple filters", () => {
    const { sql, params } = buildLatestVideosQuery({
      channelIds: ["UC123"],
      publishedAfter: new Date("2024-01-01"),
      excludeLive: true,
      minDurationSeconds: 60,
      limit: 100,
    });
    assertEquals(sql.includes("ucid = ANY($1)"), true);
    assertEquals(sql.includes("published > $2"), true);
    assertEquals(sql.includes("live_now = false"), true);
    assertEquals(sql.includes("length_seconds >= $3"), true);
    assertEquals(sql.includes("LIMIT $4"), true);
    assertEquals(params.length, 4);
  });
});

describe("buildGetChannelQuery", () => {
  it("should build correct query", () => {
    const { sql, params } = buildGetChannelQuery("UC123");
    assertEquals(sql, "SELECT id, author, updated FROM channels WHERE id = $1");
    assertEquals(params, ["UC123"]);
  });
});

describe("buildGetChannelsQuery", () => {
  it("should build correct query", () => {
    const { sql, params } = buildGetChannelsQuery(["UC123", "UC456"]);
    assertEquals(
      sql,
      "SELECT id, author, updated FROM channels WHERE id = ANY($1)",
    );
    assertEquals(params, [["UC123", "UC456"]]);
  });
});

describe("buildGetMaxPublishedQuery", () => {
  it("should build correct query with channel IDs", () => {
    const { sql, params } = buildGetMaxPublishedQuery(["UC123", "UC456"]);
    assertEquals(
      sql,
      "SELECT MAX(published) as max_published FROM channel_videos WHERE ucid = ANY($1)",
    );
    assertEquals(params, [["UC123", "UC456"]]);
  });

  it("should return NULL query for empty channel list", () => {
    const { sql, params } = buildGetMaxPublishedQuery([]);
    assertEquals(sql, "SELECT NULL as max_published");
    assertEquals(params, []);
  });
});

// ============================================================================
// InvidiousDb Client Tests
// ============================================================================

describe("createInvidiousDb", () => {
  describe("getUser", () => {
    it("should return user when found", async () => {
      const executor = createMockExecutor([
        { email: "test@example.com", subscriptions: ["UC123"] },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getUser("test@example.com");
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.email, "test@example.com");
        assertEquals(result.data.subscriptions, ["UC123"]);
      }
    });

    it("should return not_found when user missing", async () => {
      const executor = createMockExecutor([]);
      const db = createInvidiousDb(executor);

      const result = await db.getUser("missing@example.com");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "not_found");
      }
    });

    it("should return query_error on exception", async () => {
      const executor = createMockExecutor([], new Error("Connection failed"));
      const db = createInvidiousDb(executor);

      const result = await db.getUser("test@example.com");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "query_error");
        assertEquals(result.error.message.includes("Connection failed"), true);
      }
    });
  });

  describe("getAllUsers", () => {
    it("should return all users with subscriptions", async () => {
      const executor = createMockExecutor([
        { email: "user1@example.com", subscriptions: ["UC123"] },
        { email: "user2@example.com", subscriptions: ["UC456", "UC789"] },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getAllUsers();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.length, 2);
        assertEquals(result.data[0].email, "user1@example.com");
        assertEquals(result.data[1].subscriptions.length, 2);
      }
    });
  });

  describe("getSubscriptions", () => {
    it("should return subscriptions for user", async () => {
      const executor = createMockExecutor([
        { email: "test@example.com", subscriptions: ["UC123", "UC456"] },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getSubscriptions("test@example.com");
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data, ["UC123", "UC456"]);
      }
    });
  });

  describe("getLatestVideos", () => {
    it("should return videos from channels", async () => {
      const executor = createMockExecutor([
        {
          id: "video1",
          ucid: "UC123",
          title: "Test Video",
          published: new Date(),
          length_seconds: 300,
          live_now: false,
          premiere_timestamp: null,
          views: 1000,
        },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getLatestVideos({ channelIds: ["UC123"] });
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.length, 1);
        assertEquals(result.data[0].id, "video1");
        assertEquals(result.data[0].title, "Test Video");
      }
    });
  });

  describe("getChannel", () => {
    it("should return channel when found", async () => {
      const executor = createMockExecutor([
        { id: "UC123", author: "Test Channel", updated: new Date() },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getChannel("UC123");
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.id, "UC123");
        assertEquals(result.data.author, "Test Channel");
      }
    });

    it("should return not_found when channel missing", async () => {
      const executor = createMockExecutor([]);
      const db = createInvidiousDb(executor);

      const result = await db.getChannel("UC_MISSING");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "not_found");
      }
    });
  });

  describe("getChannels", () => {
    it("should return multiple channels", async () => {
      const executor = createMockExecutor([
        { id: "UC123", author: "Channel 1", updated: new Date() },
        { id: "UC456", author: "Channel 2", updated: new Date() },
      ]);
      const db = createInvidiousDb(executor);

      const result = await db.getChannels(["UC123", "UC456"]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.length, 2);
      }
    });

    it("should return empty array for empty input", async () => {
      const executor = createMockExecutor([]);
      const db = createInvidiousDb(executor);

      const result = await db.getChannels([]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data, []);
      }
    });
  });

  describe("getMaxPublishedTimestamp", () => {
    it("should return max timestamp when videos exist", async () => {
      const testDate = new Date("2024-06-15T12:00:00Z");
      const executor = createMockExecutor([{ max_published: testDate }]);
      const db = createInvidiousDb(executor);

      const result = await db.getMaxPublishedTimestamp(["UC123", "UC456"]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data instanceof Date, true);
        assertEquals(result.data?.getTime(), testDate.getTime());
      }
    });

    it("should return null when no videos exist", async () => {
      const executor = createMockExecutor([{ max_published: null }]);
      const db = createInvidiousDb(executor);

      const result = await db.getMaxPublishedTimestamp(["UC123"]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data, null);
      }
    });

    it("should return null for empty channel list", async () => {
      const executor = createMockExecutor([]);
      const db = createInvidiousDb(executor);

      const result = await db.getMaxPublishedTimestamp([]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data, null);
      }
    });

    it("should handle string date format", async () => {
      const executor = createMockExecutor([{ max_published: "2024-06-15T12:00:00Z" }]);
      const db = createInvidiousDb(executor);

      const result = await db.getMaxPublishedTimestamp(["UC123"]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data instanceof Date, true);
      }
    });

    it("should return query_error on exception", async () => {
      const executor = createMockExecutor([], new Error("Connection failed"));
      const db = createInvidiousDb(executor);

      const result = await db.getMaxPublishedTimestamp(["UC123"]);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "query_error");
        assertEquals(result.error.message.includes("max published timestamp"), true);
      }
    });
  });
});
