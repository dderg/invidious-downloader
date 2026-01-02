import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ConfigError,
  isValidUrl,
  normalizeUrl,
  parseConfig,
  type ConfigInput,
} from "../src/config.ts";

describe("parseConfig", () => {
  const validInput: ConfigInput = {
    INVIDIOUS_URL: "http://invidious:3000",
    INVIDIOUS_DB_URL: "postgres://kemal:kemal@postgres:5432/invidious",
    COMPANION_URL: "http://companion:8282",
    COMPANION_SECRET: "secret123",
    VIDEOS_PATH: "/videos",
  };

  describe("with valid required fields", () => {
    it("should return ok with config", () => {
      const result = parseConfig(validInput);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.invidiousUrl, "http://invidious:3000");
        assertEquals(
          result.config.invidiousDbUrl,
          "postgres://kemal:kemal@postgres:5432/invidious",
        );
        assertEquals(result.config.companionUrl, "http://companion:8282");
        assertEquals(result.config.companionSecret, "secret123");
        assertEquals(result.config.videosPath, "/videos");
      }
    });

    it("should use default values for optional fields", () => {
      const result = parseConfig(validInput);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.port, 3001);
        assertEquals(result.config.invidiousUser, null);
        assertEquals(result.config.downloadQuality, "best");
        assertEquals(result.config.downloadRateLimit, 0);
        assertEquals(result.config.maxConcurrentDownloads, 2);
        // checkIntervalMinutes has a default but we don't test the specific value
        assertEquals(typeof result.config.checkIntervalMinutes, "number");
        assertEquals(result.config.checkIntervalMinutes > 0, true);
      }
    });

    it("should parse optional fields when provided", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "8080",
        INVIDIOUS_USER: "user@example.com",
        DOWNLOAD_QUALITY: "1080p",
        DOWNLOAD_RATE_LIMIT: "5000000",
        CHECK_INTERVAL_MINUTES: "60",
        MAX_CONCURRENT_DOWNLOADS: "4",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.port, 8080);
        assertEquals(result.config.invidiousUser, "user@example.com");
        assertEquals(result.config.downloadQuality, "1080p");
        assertEquals(result.config.downloadRateLimit, 5000000);
        assertEquals(result.config.checkIntervalMinutes, 60);
        assertEquals(result.config.maxConcurrentDownloads, 4);
      }
    });

    it("should trim whitespace from values", () => {
      const result = parseConfig({
        INVIDIOUS_URL: "  http://invidious:3000  ",
        INVIDIOUS_DB_URL: " postgres://kemal:kemal@postgres:5432/invidious ",
        COMPANION_URL: "http://companion:8282 ",
        COMPANION_SECRET: " secret123",
        VIDEOS_PATH: "/videos ",
        INVIDIOUS_USER: " user@example.com ",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.invidiousUrl, "http://invidious:3000");
        assertEquals(result.config.invidiousUser, "user@example.com");
      }
    });
  });

  describe("with missing required fields", () => {
    it("should return error for missing INVIDIOUS_URL", () => {
      const result = parseConfig({
        ...validInput,
        INVIDIOUS_URL: undefined,
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find((e) => e.field === "INVIDIOUS_URL");
        assertExists(error);
        assertEquals(error instanceof ConfigError, true);
      }
    });

    it("should return error for empty INVIDIOUS_URL", () => {
      const result = parseConfig({
        ...validInput,
        INVIDIOUS_URL: "   ",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find((e) => e.field === "INVIDIOUS_URL");
        assertExists(error);
      }
    });

    it("should return multiple errors for multiple missing fields", () => {
      const result = parseConfig({});

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.errors.length, 5);
        const fields = result.errors.map((e) => e.field);
        assertEquals(fields.includes("INVIDIOUS_URL"), true);
        assertEquals(fields.includes("INVIDIOUS_DB_URL"), true);
        assertEquals(fields.includes("COMPANION_URL"), true);
        assertEquals(fields.includes("COMPANION_SECRET"), true);
        assertEquals(fields.includes("VIDEOS_PATH"), true);
      }
    });
  });

  describe("with invalid optional fields", () => {
    it("should return error for invalid PORT", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "not-a-number",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find((e) => e.field === "PORT");
        assertExists(error);
      }
    });

    it("should return error for PORT out of range", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "70000",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find((e) => e.field === "PORT");
        assertExists(error);
      }
    });

    it("should return error for negative PORT", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "-1",
      });

      assertEquals(result.ok, false);
    });

    it("should return error for negative DOWNLOAD_RATE_LIMIT", () => {
      const result = parseConfig({
        ...validInput,
        DOWNLOAD_RATE_LIMIT: "-100",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find(
          (e) => e.field === "DOWNLOAD_RATE_LIMIT",
        );
        assertExists(error);
      }
    });

    it("should return error for zero CHECK_INTERVAL_MINUTES", () => {
      const result = parseConfig({
        ...validInput,
        CHECK_INTERVAL_MINUTES: "0",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find(
          (e) => e.field === "CHECK_INTERVAL_MINUTES",
        );
        assertExists(error);
      }
    });

    it("should return error for non-numeric MAX_CONCURRENT_DOWNLOADS", () => {
      const result = parseConfig({
        ...validInput,
        MAX_CONCURRENT_DOWNLOADS: "abc",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        const error = result.errors.find(
          (e) => e.field === "MAX_CONCURRENT_DOWNLOADS",
        );
        assertExists(error);
      }
    });
  });

  describe("edge cases", () => {
    it("should accept DOWNLOAD_RATE_LIMIT of 0 (unlimited)", () => {
      const result = parseConfig({
        ...validInput,
        DOWNLOAD_RATE_LIMIT: "0",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.downloadRateLimit, 0);
      }
    });

    it("should accept minimum valid PORT (1)", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "1",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.port, 1);
      }
    });

    it("should accept maximum valid PORT (65535)", () => {
      const result = parseConfig({
        ...validInput,
        PORT: "65535",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.config.port, 65535);
      }
    });
  });
});

describe("isValidUrl", () => {
  it("should return true for valid HTTP URL", () => {
    assertEquals(isValidUrl("http://localhost:3000"), true);
  });

  it("should return true for valid HTTPS URL", () => {
    assertEquals(isValidUrl("https://example.com"), true);
  });

  it("should return true for URL with path", () => {
    assertEquals(isValidUrl("http://example.com/path/to/resource"), true);
  });

  it("should return false for invalid URL", () => {
    assertEquals(isValidUrl("not-a-url"), false);
  });

  it("should return false for empty string", () => {
    assertEquals(isValidUrl(""), false);
  });

  it("should return false for URL without protocol", () => {
    assertEquals(isValidUrl("example.com"), false);
  });
});

describe("normalizeUrl", () => {
  it("should remove single trailing slash", () => {
    assertEquals(normalizeUrl("http://example.com/"), "http://example.com");
  });

  it("should remove multiple trailing slashes", () => {
    assertEquals(normalizeUrl("http://example.com///"), "http://example.com");
  });

  it("should not modify URL without trailing slash", () => {
    assertEquals(normalizeUrl("http://example.com"), "http://example.com");
  });

  it("should preserve path without trailing slash", () => {
    assertEquals(
      normalizeUrl("http://example.com/path/"),
      "http://example.com/path",
    );
  });
});
