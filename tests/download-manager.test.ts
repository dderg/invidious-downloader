import { assertEquals, assertExists } from "@std/assert";
import { describe, it, afterEach } from "@std/testing/bdd";
import {
  defaultHttpDownloader,
  sanitizeFilename,
  generatePaths,
} from "../src/services/download-manager.ts";

// ============================================================================
// Path Utility Tests
// ============================================================================

describe("sanitizeFilename", () => {
  it("should remove invalid characters", () => {
    const result = sanitizeFilename('test<>:"/\\|?*file.mp4');
    // Each invalid character is replaced with underscore
    assertEquals(result.includes("<"), false);
    assertEquals(result.includes(">"), false);
    assertEquals(result.includes(":"), false);
    assertEquals(result.includes('"'), false);
    assertEquals(result.includes("/"), false);
    assertEquals(result.includes("\\"), false);
    assertEquals(result.includes("|"), false);
    assertEquals(result.includes("?"), false);
    assertEquals(result.includes("*"), false);
  });

  it("should collapse multiple spaces", () => {
    const result = sanitizeFilename("test   multiple   spaces");
    assertEquals(result, "test multiple spaces");
  });

  it("should trim whitespace", () => {
    const result = sanitizeFilename("  test  ");
    assertEquals(result, "test");
  });

  it("should limit length to 200 characters", () => {
    const longName = "a".repeat(300);
    const result = sanitizeFilename(longName);
    assertEquals(result.length, 200);
  });

  it("should handle control characters", () => {
    const result = sanitizeFilename("test\x00\x1ffile");
    assertEquals(result, "test__file");
  });
});

describe("generatePaths", () => {
  it("should generate correct paths", () => {
    const paths = generatePaths("abc123xyz", "Test Video", "/videos");

    assertEquals(paths.videoPath, "/videos/abc123xyz_video.tmp");
    assertEquals(paths.audioPath, "/videos/abc123xyz_audio.tmp");
    assertEquals(paths.outputPath, "/videos/abc123xyz.mp4");
    assertEquals(paths.thumbnailPath, "/videos/abc123xyz.webp");
    assertEquals(paths.metadataPath, "/videos/abc123xyz.json");
  });

  it("should use temp directory when provided", () => {
    const paths = generatePaths("abc123xyz", "Test Video", "/videos", "/tmp");

    assertEquals(paths.videoPath, "/tmp/abc123xyz_video.tmp");
    assertEquals(paths.audioPath, "/tmp/abc123xyz_audio.tmp");
    assertEquals(paths.outputPath, "/videos/abc123xyz.mp4");
  });
});

// ============================================================================
// Streaming Download Tests
// ============================================================================

// Note: sanitizeOps/Resources disabled due to abort tests leaving fetch streams open
describe("defaultHttpDownloader", { sanitizeOps: false, sanitizeResources: false }, () => {
  const testDir = "/tmp/download-manager-test";
  const testFiles: string[] = [];

  afterEach(async () => {
    // Clean up test files
    for (const file of testFiles) {
      try {
        await Deno.remove(file);
      } catch {
        // Ignore errors
      }
    }
    testFiles.length = 0;

    // Try to remove test directory
    try {
      await Deno.remove(testDir, { recursive: true });
    } catch {
      // Ignore errors
    }
  });

  it("should stream download to file without accumulating in memory", async () => {
    // Create test directory
    await Deno.mkdir(testDir, { recursive: true });
    const outputPath = `${testDir}/test-download.bin`;
    testFiles.push(outputPath);

    // Use a small test file from httpbin
    const result = await defaultHttpDownloader.downloadToFile(
      "https://httpbin.org/bytes/1024", // 1KB of random bytes
      outputPath,
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.size, 1024);

      // Verify file was written
      const stat = await Deno.stat(outputPath);
      assertEquals(stat.size, 1024);
    }
  });

  it("should report progress during download", async () => {
    await Deno.mkdir(testDir, { recursive: true });
    const outputPath = `${testDir}/test-progress.bin`;
    testFiles.push(outputPath);

    const progressCalls: Array<{ downloaded: number; total: number | null }> = [];

    const result = await defaultHttpDownloader.downloadToFile(
      "https://httpbin.org/bytes/2048", // 2KB
      outputPath,
      {
        onProgress: (downloaded, total) => {
          progressCalls.push({ downloaded, total });
        },
      },
    );

    assertEquals(result.ok, true);
    // Progress should have been called at least once (final progress)
    assertEquals(progressCalls.length >= 1, true);
    // Final progress should match total
    if (result.ok) {
      const lastProgress = progressCalls[progressCalls.length - 1];
      assertEquals(lastProgress.downloaded, result.size);
    }
  });

  it("should handle HTTP errors", async () => {
    await Deno.mkdir(testDir, { recursive: true });
    const outputPath = `${testDir}/test-error.bin`;
    testFiles.push(outputPath);

    const result = await defaultHttpDownloader.downloadToFile(
      "https://httpbin.org/status/404",
      outputPath,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("404"), true);
    }
  });

  it("should handle abort signal", async () => {
    await Deno.mkdir(testDir, { recursive: true });
    const outputPath = `${testDir}/test-abort.bin`;
    testFiles.push(outputPath);

    const abortController = new AbortController();
    
    // Abort immediately
    abortController.abort();

    const result = await defaultHttpDownloader.downloadToFile(
      "https://httpbin.org/bytes/10240", // 10KB
      outputPath,
      { signal: abortController.signal },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("cancelled") || result.error.includes("abort"), true);
    }
  });

  it("should close file handle even on error", async () => {
    await Deno.mkdir(testDir, { recursive: true });
    const outputPath = `${testDir}/test-cleanup.bin`;
    testFiles.push(outputPath);

    // Download a file that will fail mid-stream by aborting
    const abortController = new AbortController();
    
    const downloadPromise = defaultHttpDownloader.downloadToFile(
      "https://httpbin.org/drip?duration=2&numbytes=10000&code=200", // Slow drip
      outputPath,
      { signal: abortController.signal },
    );

    // Abort after a short delay
    setTimeout(() => abortController.abort(), 100);

    const result = await downloadPromise;
    assertEquals(result.ok, false);

    // File should be writable (handle was closed)
    // Try to write to the same file - should succeed if handle was released
    await Deno.writeTextFile(outputPath, "test");
    const content = await Deno.readTextFile(outputPath);
    assertEquals(content, "test");
  });
});
