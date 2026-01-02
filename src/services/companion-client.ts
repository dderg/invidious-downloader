/**
 * Invidious Companion API client.
 * Handles communication with Companion to get video stream URLs.
 *
 * Design:
 * - Pure functions for parsing/selection (testable without mocks)
 * - HTTP logic isolated and injectable for testing
 */

import type {
  AdaptiveFormat,
  CombinedFormat,
  CompanionError,
  CompanionResult,
  PlayerResponse,
  SelectedStreams,
  VideoInfo,
} from "./companion-types.ts";

/**
 * Configuration for Companion client.
 */
export interface CompanionClientConfig {
  companionUrl: string;
  companionSecret: string;
}

/**
 * HTTP fetcher interface for dependency injection.
 * Allows mocking in tests.
 */
export interface HttpFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Default HTTP fetcher using global fetch.
 */
export const defaultFetcher: HttpFetcher = {
  fetch: (url, init) => fetch(url, init),
};

/**
 * Create a Companion API client.
 */
export function createCompanionClient(
  config: CompanionClientConfig,
  fetcher: HttpFetcher = defaultFetcher,
) {
  const baseUrl = config.companionUrl.replace(/\/+$/, "");

  /**
   * Get video information from Companion API.
   */
  async function getVideoInfo(
    videoId: string,
  ): Promise<CompanionResult<VideoInfo>> {
    const url = `${baseUrl}/companion/youtubei/v1/player`;

    try {
      const response = await fetcher.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.companionSecret}`,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20231219.04.00",
            },
          },
        }),
      });

      if (!response.ok) {
        return handleHttpError(response);
      }

      const data = await response.json();
      return parsePlayerResponse(data, videoId);
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "network_error",
          message: error instanceof Error ? error.message : "Network error",
        },
      };
    }
  }

  return {
    getVideoInfo,
  };
}

/**
 * Handle HTTP error responses.
 * Pure function.
 */
function handleHttpError(response: Response): CompanionResult<never> {
  const error: CompanionError = {
    type: "unknown",
    message: `HTTP ${response.status}: ${response.statusText}`,
    statusCode: response.status,
  };

  switch (response.status) {
    case 401:
    case 403:
      error.type = "auth_error";
      error.message = "Authentication failed - check COMPANION_SECRET";
      break;
    case 404:
      error.type = "not_found";
      error.message = "Video not found";
      break;
    case 500:
    case 502:
    case 503:
      error.type = "unavailable";
      error.message = "Companion service unavailable";
      break;
  }

  return { ok: false, error };
}

/**
 * Parse player response from Companion API.
 * Pure function - extracts and validates the response data.
 */
export function parsePlayerResponse(
  data: unknown,
  videoId: string,
): CompanionResult<VideoInfo> {
  try {
    const response = data as PlayerResponse;

    // Check playability
    if (response.playabilityStatus?.status !== "OK") {
      return {
        ok: false,
        error: {
          type: "unavailable",
          message:
            response.playabilityStatus?.reason ||
            "Video is not available for playback",
        },
      };
    }

    // Validate required fields
    if (!response.videoDetails) {
      return {
        ok: false,
        error: {
          type: "parse_error",
          message: "Missing videoDetails in response",
        },
      };
    }

    const details = response.videoDetails;
    const streaming = response.streamingData;

    // Separate video and audio streams from adaptive formats
    const adaptiveFormats = streaming?.adaptiveFormats || [];
    const videoStreams = adaptiveFormats.filter((f) =>
      f.mimeType.startsWith("video/")
    );
    const audioStreams = adaptiveFormats.filter((f) =>
      f.mimeType.startsWith("audio/")
    );

    // Get best thumbnail
    const thumbnails = details.thumbnail?.thumbnails || [];
    const bestThumbnail = thumbnails.sort((a, b) => b.width - a.width)[0];

    const videoInfo: VideoInfo = {
      videoId: details.videoId || videoId,
      title: details.title || "Unknown Title",
      author: details.author || "Unknown Author",
      channelId: details.channelId || "",
      lengthSeconds: parseInt(details.lengthSeconds, 10) || 0,
      viewCount: parseInt(details.viewCount, 10) || 0,
      description: details.shortDescription || "",
      isLive: details.isLiveContent || false,
      thumbnailUrl: bestThumbnail?.url || null,
      videoStreams,
      audioStreams,
      combinedStreams: streaming?.formats || [],
      expiresInSeconds: parseInt(streaming?.expiresInSeconds || "0", 10) || 0,
    };

    return { ok: true, data: videoInfo };
  } catch (error) {
    return {
      ok: false,
      error: {
        type: "parse_error",
        message: error instanceof Error ? error.message : "Failed to parse response",
      },
    };
  }
}

/**
 * Quality preference for stream selection.
 */
export type QualityPreference = "best" | "1080p" | "720p" | "480p" | "360p";

/**
 * Parse quality string to height value.
 */
export function qualityToHeight(quality: QualityPreference): number {
  switch (quality) {
    case "best":
      return Infinity;
    case "1080p":
      return 1080;
    case "720p":
      return 720;
    case "480p":
      return 480;
    case "360p":
      return 360;
    default:
      return Infinity;
  }
}

/**
 * Select best streams based on quality preference.
 * Pure function - no side effects.
 *
 * Strategy:
 * 1. For "best" - select highest quality video + best audio
 * 2. For specific quality - select closest match at or below target
 * 3. Prefer MP4/webm for video, opus/mp4a for audio
 */
export function selectBestStreams(
  videoInfo: VideoInfo,
  quality: QualityPreference = "best",
): SelectedStreams {
  const targetHeight = qualityToHeight(quality);

  // Select video stream
  const video = selectBestVideoStream(videoInfo.videoStreams, targetHeight);

  // Select audio stream (always best quality)
  const audio = selectBestAudioStream(videoInfo.audioStreams);

  // Check for combined stream as fallback
  const combined = selectBestCombinedStream(
    videoInfo.combinedStreams,
    targetHeight,
  );

  return { video, audio, combined };
}

/**
 * Select best video stream at or below target height.
 * Pure function.
 */
export function selectBestVideoStream(
  streams: AdaptiveFormat[],
  targetHeight: number,
): AdaptiveFormat | null {
  if (streams.length === 0) return null;

  // Filter to video streams with height info
  const videoStreams = streams.filter(
    (s) => s.height !== undefined && s.mimeType.startsWith("video/"),
  );

  if (videoStreams.length === 0) return null;

  // Filter streams at or below target height (unless target is Infinity)
  const candidates =
    targetHeight === Infinity
      ? videoStreams
      : videoStreams.filter((s) => (s.height || 0) <= targetHeight);

  // If no candidates at target, fall back to lowest available
  const pool = candidates.length > 0 ? candidates : videoStreams;

  // Sort by height (desc), then bitrate (desc), prefer mp4/webm
  return pool.sort((a, b) => {
    // Height priority
    const heightDiff = (b.height || 0) - (a.height || 0);
    if (heightDiff !== 0) return heightDiff;

    // Container preference (mp4 > webm > others)
    const containerPriority = (mime: string) => {
      if (mime.includes("mp4")) return 2;
      if (mime.includes("webm")) return 1;
      return 0;
    };
    const containerDiff =
      containerPriority(b.mimeType) - containerPriority(a.mimeType);
    if (containerDiff !== 0) return containerDiff;

    // Bitrate (prefer higher)
    return b.bitrate - a.bitrate;
  })[0];
}

/**
 * Select best audio stream.
 * Pure function.
 *
 * Prefers M4A (AAC) over WebM (Opus) for DASH compatibility.
 * The DASH isoff-on-demand profile requires ISO Base Media File Format (MP4/M4A),
 * and WebM's EBML container format is not compatible with SegmentBase indexing.
 */
export function selectBestAudioStream(
  streams: AdaptiveFormat[],
): AdaptiveFormat | null {
  if (streams.length === 0) return null;

  // Filter to audio streams
  const audioStreams = streams.filter((s) => s.mimeType.startsWith("audio/"));

  if (audioStreams.length === 0) return null;

  // Sort by: 1) container format (m4a > webm for DASH), 2) bitrate (desc)
  return audioStreams.sort((a, b) => {
    // Prefer MP4/M4A container for DASH compatibility
    const containerPriority = (mime: string) => {
      if (mime.startsWith("audio/mp4")) return 2; // M4A - DASH compatible
      if (mime.startsWith("audio/webm")) return 1; // WebM - not DASH compatible
      return 0;
    };

    const containerDiff = containerPriority(b.mimeType) - containerPriority(a.mimeType);
    if (containerDiff !== 0) return containerDiff;

    // Same container: prefer higher bitrate
    return b.bitrate - a.bitrate;
  })[0];
}

/**
 * Select best combined stream as fallback.
 * Pure function.
 */
export function selectBestCombinedStream(
  streams: CombinedFormat[],
  targetHeight: number,
): CombinedFormat | null {
  if (streams.length === 0) return null;

  // Filter to target height
  const candidates =
    targetHeight === Infinity
      ? streams
      : streams.filter((s) => s.height <= targetHeight);

  const pool = candidates.length > 0 ? candidates : streams;

  // Sort by height (desc), then bitrate
  return pool.sort((a, b) => {
    const heightDiff = b.height - a.height;
    if (heightDiff !== 0) return heightDiff;
    return b.bitrate - a.bitrate;
  })[0];
}

/**
 * Check if a stream URL is still valid (not expired).
 * Parses the URL to extract expiration timestamp.
 */
export function isStreamUrlValid(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const expire = urlObj.searchParams.get("expire");
    if (!expire) return true; // No expiration, assume valid

    const expireTime = parseInt(expire, 10) * 1000; // Convert to ms
    return Date.now() < expireTime;
  } catch {
    return false;
  }
}

/**
 * Extract video ID from various YouTube URL formats.
 * Pure function.
 */
export function extractVideoId(input: string): string | null {
  // Already a video ID (11 characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);
    const hostname = url.hostname.replace("www.", "");

    // youtube.com/watch?v=VIDEO_ID
    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }
      // youtube.com/v/VIDEO_ID or youtube.com/embed/VIDEO_ID
      const match = url.pathname.match(/^\/(v|embed)\/([a-zA-Z0-9_-]{11})/);
      if (match) return match[2];
    }

    // youtu.be/VIDEO_ID
    if (hostname === "youtu.be") {
      const match = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})/);
      if (match) return match[1];
    }

    // Invidious instance URLs
    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }
  } catch {
    // Not a valid URL
  }

  return null;
}
