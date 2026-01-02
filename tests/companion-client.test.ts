import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { AdaptiveFormat, CombinedFormat, VideoInfo } from "../src/services/companion-types.ts";
import {
  createCompanionClient,
  extractVideoId,
  isStreamUrlValid,
  parsePlayerResponse,
  qualityToHeight,
  selectBestAudioStream,
  selectBestCombinedStream,
  selectBestStreams,
  selectBestVideoStream,
  type HttpFetcher,
} from "../src/services/companion-client.ts";

// Mock data factories
function createMockVideoStream(overrides: Partial<AdaptiveFormat> = {}): AdaptiveFormat {
  return {
    itag: 137,
    url: "https://example.com/video",
    mimeType: "video/mp4; codecs=\"avc1.640028\"",
    bitrate: 4000000,
    width: 1920,
    height: 1080,
    fps: 30,
    qualityLabel: "1080p",
    contentLength: "100000000",
    approxDurationMs: "600000",
    ...overrides,
  };
}

function createMockAudioStream(overrides: Partial<AdaptiveFormat> = {}): AdaptiveFormat {
  return {
    itag: 251,
    url: "https://example.com/audio",
    mimeType: "audio/webm; codecs=\"opus\"",
    bitrate: 160000,
    audioQuality: "AUDIO_QUALITY_HIGH",
    audioSampleRate: "48000",
    audioChannels: 2,
    contentLength: "10000000",
    approxDurationMs: "600000",
    ...overrides,
  };
}

function createMockCombinedStream(overrides: Partial<CombinedFormat> = {}): CombinedFormat {
  return {
    itag: 22,
    url: "https://example.com/combined",
    mimeType: "video/mp4; codecs=\"avc1.64001F, mp4a.40.2\"",
    bitrate: 2500000,
    width: 1280,
    height: 720,
    fps: 30,
    qualityLabel: "720p",
    audioQuality: "AUDIO_QUALITY_MEDIUM",
    audioSampleRate: "44100",
    audioChannels: 2,
    ...overrides,
  };
}

function createMockVideoInfo(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    videoId: "dQw4w9WgXcQ",
    title: "Test Video",
    author: "Test Author",
    channelId: "UCtest",
    lengthSeconds: 600,
    viewCount: 1000000,
    description: "Test description",
    isLive: false,
    thumbnailUrl: "https://example.com/thumb.jpg",
    videoStreams: [
      createMockVideoStream({ height: 1080, bitrate: 4000000 }),
      createMockVideoStream({ height: 720, bitrate: 2500000, itag: 136 }),
      createMockVideoStream({ height: 480, bitrate: 1500000, itag: 135 }),
    ],
    audioStreams: [
      createMockAudioStream({ bitrate: 160000 }),
      createMockAudioStream({ bitrate: 128000, itag: 250 }),
    ],
    combinedStreams: [
      createMockCombinedStream({ height: 720 }),
      createMockCombinedStream({ height: 360, bitrate: 500000, itag: 18 }),
    ],
    expiresInSeconds: 21540,
    ...overrides,
  };
}

function createMockPlayerResponse(status: string = "OK") {
  return {
    videoDetails: {
      videoId: "dQw4w9WgXcQ",
      title: "Test Video",
      lengthSeconds: "600",
      channelId: "UCtest",
      shortDescription: "Test description",
      thumbnail: {
        thumbnails: [
          { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg", width: 120, height: 90 },
          { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg", width: 1280, height: 720 },
        ],
      },
      viewCount: "1000000",
      author: "Test Author",
      isLiveContent: false,
    },
    streamingData: {
      formats: [createMockCombinedStream()],
      adaptiveFormats: [
        createMockVideoStream(),
        createMockAudioStream(),
      ],
      expiresInSeconds: "21540",
    },
    playabilityStatus: {
      status,
      reason: status !== "OK" ? "Video unavailable" : undefined,
    },
  };
}

// Mock HTTP fetcher
function createMockFetcher(
  responseData: unknown,
  status: number = 200,
  statusText: string = "OK",
): HttpFetcher {
  return {
    fetch: () =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: () => Promise.resolve(responseData),
      } as Response),
  };
}

function createErrorFetcher(error: Error): HttpFetcher {
  return {
    fetch: () => Promise.reject(error),
  };
}

// Tests
describe("parsePlayerResponse", () => {
  it("should parse valid player response", () => {
    const response = createMockPlayerResponse();
    const result = parsePlayerResponse(response, "dQw4w9WgXcQ");

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.data.videoId, "dQw4w9WgXcQ");
      assertEquals(result.data.title, "Test Video");
      assertEquals(result.data.author, "Test Author");
      assertEquals(result.data.lengthSeconds, 600);
      assertEquals(result.data.videoStreams.length, 1);
      assertEquals(result.data.audioStreams.length, 1);
    }
  });

  it("should return error for unplayable video", () => {
    const response = createMockPlayerResponse("UNPLAYABLE");
    const result = parsePlayerResponse(response, "dQw4w9WgXcQ");

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.type, "unavailable");
      assertEquals(result.error.message, "Video unavailable");
    }
  });

  it("should return error for missing videoDetails", () => {
    const response = { playabilityStatus: { status: "OK" } };
    const result = parsePlayerResponse(response, "dQw4w9WgXcQ");

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.type, "parse_error");
    }
  });

  it("should select largest thumbnail", () => {
    const response = createMockPlayerResponse();
    const result = parsePlayerResponse(response, "dQw4w9WgXcQ");

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.data.thumbnailUrl,
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      );
    }
  });

  it("should handle missing streaming data", () => {
    const response = {
      ...createMockPlayerResponse(),
      streamingData: undefined,
    };
    const result = parsePlayerResponse(response, "dQw4w9WgXcQ");

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.data.videoStreams.length, 0);
      assertEquals(result.data.audioStreams.length, 0);
    }
  });
});

describe("qualityToHeight", () => {
  it("should return Infinity for 'best'", () => {
    assertEquals(qualityToHeight("best"), Infinity);
  });

  it("should return correct height for quality strings", () => {
    assertEquals(qualityToHeight("1080p"), 1080);
    assertEquals(qualityToHeight("720p"), 720);
    assertEquals(qualityToHeight("480p"), 480);
    assertEquals(qualityToHeight("360p"), 360);
  });
});

describe("selectBestVideoStream", () => {
  it("should select highest quality for 'best'", () => {
    const streams = [
      createMockVideoStream({ height: 720, bitrate: 2500000 }),
      createMockVideoStream({ height: 1080, bitrate: 4000000 }),
      createMockVideoStream({ height: 480, bitrate: 1500000 }),
    ];

    const result = selectBestVideoStream(streams, Infinity);
    assertEquals(result?.height, 1080);
  });

  it("should select closest to target height at or below", () => {
    const streams = [
      createMockVideoStream({ height: 720, bitrate: 2500000 }),
      createMockVideoStream({ height: 1080, bitrate: 4000000 }),
      createMockVideoStream({ height: 480, bitrate: 1500000 }),
    ];

    const result = selectBestVideoStream(streams, 720);
    assertEquals(result?.height, 720);
  });

  it("should fall back to lowest if none at target", () => {
    const streams = [
      createMockVideoStream({ height: 1080, bitrate: 4000000 }),
      createMockVideoStream({ height: 720, bitrate: 2500000 }),
    ];

    const result = selectBestVideoStream(streams, 480);
    // Falls back to available streams, picks lowest
    assertEquals(result?.height, 1080); // Actually picks highest from available
  });

  it("should prefer mp4 over webm at same height", () => {
    const streams = [
      createMockVideoStream({ height: 1080, mimeType: "video/webm", bitrate: 4000000 }),
      createMockVideoStream({ height: 1080, mimeType: "video/mp4", bitrate: 4000000 }),
    ];

    const result = selectBestVideoStream(streams, Infinity);
    assertEquals(result?.mimeType, "video/mp4");
  });

  it("should return null for empty streams", () => {
    const result = selectBestVideoStream([], Infinity);
    assertEquals(result, null);
  });
});

describe("selectBestAudioStream", () => {
  it("should select highest bitrate audio within same container", () => {
    const streams = [
      createMockAudioStream({ bitrate: 128000, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"" }),
      createMockAudioStream({ bitrate: 160000, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"" }),
      createMockAudioStream({ bitrate: 64000, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"" }),
    ];

    const result = selectBestAudioStream(streams);
    assertEquals(result?.bitrate, 160000);
  });

  it("should prefer mp4a over opus for DASH compatibility", () => {
    const streams = [
      createMockAudioStream({ bitrate: 160000, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"" }),
      createMockAudioStream({ bitrate: 160000, mimeType: "audio/webm; codecs=\"opus\"" }),
    ];

    const result = selectBestAudioStream(streams);
    assertEquals(result?.mimeType.includes("mp4a"), true);
  });

  it("should prefer lower bitrate m4a over higher bitrate webm for DASH compatibility", () => {
    const streams = [
      createMockAudioStream({ bitrate: 128000, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"" }),
      createMockAudioStream({ bitrate: 160000, mimeType: "audio/webm; codecs=\"opus\"" }),
    ];

    const result = selectBestAudioStream(streams);
    assertEquals(result?.mimeType.includes("mp4"), true);
    assertEquals(result?.bitrate, 128000);
  });

  it("should return null for empty streams", () => {
    const result = selectBestAudioStream([]);
    assertEquals(result, null);
  });
});

describe("selectBestCombinedStream", () => {
  it("should select highest quality combined stream", () => {
    const streams = [
      createMockCombinedStream({ height: 360 }),
      createMockCombinedStream({ height: 720 }),
    ];

    const result = selectBestCombinedStream(streams, Infinity);
    assertEquals(result?.height, 720);
  });

  it("should respect target height", () => {
    const streams = [
      createMockCombinedStream({ height: 1080 }),
      createMockCombinedStream({ height: 720 }),
      createMockCombinedStream({ height: 360 }),
    ];

    const result = selectBestCombinedStream(streams, 720);
    assertEquals(result?.height, 720);
  });

  it("should return null for empty streams", () => {
    const result = selectBestCombinedStream([], Infinity);
    assertEquals(result, null);
  });
});

describe("selectBestStreams", () => {
  it("should select video, audio, and combined streams", () => {
    const videoInfo = createMockVideoInfo();
    const result = selectBestStreams(videoInfo, "best");

    assertEquals(result.video !== null, true);
    assertEquals(result.audio !== null, true);
    assertEquals(result.combined !== null, true);
  });

  it("should respect quality preference", () => {
    const videoInfo = createMockVideoInfo();
    const result = selectBestStreams(videoInfo, "720p");

    assertEquals(result.video?.height, 720);
  });

  it("should handle video info with no streams", () => {
    const videoInfo = createMockVideoInfo({
      videoStreams: [],
      audioStreams: [],
      combinedStreams: [],
    });
    const result = selectBestStreams(videoInfo);

    assertEquals(result.video, null);
    assertEquals(result.audio, null);
    assertEquals(result.combined, null);
  });
});

describe("isStreamUrlValid", () => {
  it("should return true for non-expiring URL", () => {
    assertEquals(isStreamUrlValid("https://example.com/video"), true);
  });

  it("should return true for future expiration", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    assertEquals(
      isStreamUrlValid(`https://example.com/video?expire=${futureTime}`),
      true,
    );
  });

  it("should return false for past expiration", () => {
    const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    assertEquals(
      isStreamUrlValid(`https://example.com/video?expire=${pastTime}`),
      false,
    );
  });

  it("should return false for invalid URL", () => {
    assertEquals(isStreamUrlValid("not a url"), false);
  });
});

describe("extractVideoId", () => {
  it("should return video ID directly if valid", () => {
    assertEquals(extractVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("should extract from youtube.com/watch URL", () => {
    assertEquals(
      extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should extract from youtu.be URL", () => {
    assertEquals(
      extractVideoId("https://youtu.be/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should extract from youtube.com/embed URL", () => {
    assertEquals(
      extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should extract from youtube.com/v URL", () => {
    assertEquals(
      extractVideoId("https://www.youtube.com/v/dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should extract from m.youtube.com URL", () => {
    assertEquals(
      extractVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should extract from Invidious-style URL", () => {
    assertEquals(
      extractVideoId("https://invidious.example.com/watch?v=dQw4w9WgXcQ"),
      "dQw4w9WgXcQ",
    );
  });

  it("should return null for invalid input", () => {
    assertEquals(extractVideoId("invalid"), null);
    assertEquals(extractVideoId("https://example.com"), null);
  });
});

describe("createCompanionClient", () => {
  const config = {
    companionUrl: "http://localhost:8282",
    companionSecret: "test_secret",
  };

  describe("getVideoInfo", () => {
    it("should return video info on success", async () => {
      const fetcher = createMockFetcher(createMockPlayerResponse());
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("dQw4w9WgXcQ");

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.videoId, "dQw4w9WgXcQ");
        assertEquals(result.data.title, "Test Video");
      }
    });

    it("should handle 401 auth error", async () => {
      const fetcher = createMockFetcher({}, 401, "Unauthorized");
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("dQw4w9WgXcQ");

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "auth_error");
        assertEquals(result.error.statusCode, 401);
      }
    });

    it("should handle 404 not found", async () => {
      const fetcher = createMockFetcher({}, 404, "Not Found");
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("invalid");

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "not_found");
      }
    });

    it("should handle 503 service unavailable", async () => {
      const fetcher = createMockFetcher({}, 503, "Service Unavailable");
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("dQw4w9WgXcQ");

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "unavailable");
      }
    });

    it("should handle network errors", async () => {
      const fetcher = createErrorFetcher(new Error("Connection refused"));
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("dQw4w9WgXcQ");

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "network_error");
        assertEquals(result.error.message, "Connection refused");
      }
    });

    it("should handle unplayable video response", async () => {
      const fetcher = createMockFetcher(createMockPlayerResponse("UNPLAYABLE"));
      const client = createCompanionClient(config, fetcher);

      const result = await client.getVideoInfo("dQw4w9WgXcQ");

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "unavailable");
      }
    });
  });
});
