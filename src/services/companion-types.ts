/**
 * Types for Invidious Companion API responses.
 * These represent the data structures returned by the Companion.
 */

/**
 * Adaptive format (DASH) stream info from Companion API.
 */
export interface AdaptiveFormat {
  itag: number;
  url: string;
  mimeType: string;
  bitrate: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  contentLength?: string;
  approxDurationMs?: string;
}

/**
 * Combined format (video + audio) stream info.
 */
export interface CombinedFormat {
  itag: number;
  url: string;
  mimeType: string;
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  qualityLabel: string;
  audioQuality: string;
  audioSampleRate: string;
  audioChannels: number;
  contentLength?: string;
  approxDurationMs?: string;
}

/**
 * Video details from Companion API.
 */
export interface VideoDetails {
  videoId: string;
  title: string;
  lengthSeconds: string;
  channelId: string;
  shortDescription: string;
  thumbnail: {
    thumbnails: Array<{
      url: string;
      width: number;
      height: number;
    }>;
  };
  viewCount: string;
  author: string;
  isLiveContent: boolean;
}

/**
 * Full player response from Companion API.
 */
export interface PlayerResponse {
  videoDetails: VideoDetails;
  streamingData?: {
    formats?: CombinedFormat[];
    adaptiveFormats?: AdaptiveFormat[];
    expiresInSeconds?: string;
  };
  playabilityStatus?: {
    status: string;
    reason?: string;
  };
}

/**
 * Parsed video info with selected streams.
 */
export interface VideoInfo {
  videoId: string;
  title: string;
  author: string;
  channelId: string;
  lengthSeconds: number;
  viewCount: number;
  description: string;
  isLive: boolean;
  thumbnailUrl: string | null;
  videoStreams: AdaptiveFormat[];
  audioStreams: AdaptiveFormat[];
  combinedStreams: CombinedFormat[];
  expiresInSeconds: number;
}

/**
 * Stream selection result.
 */
export interface SelectedStreams {
  video: AdaptiveFormat | null;
  audio: AdaptiveFormat | null;
  combined: CombinedFormat | null;
}

/**
 * Error types for Companion client.
 */
export type CompanionErrorType =
  | "network_error"
  | "auth_error"
  | "not_found"
  | "unavailable"
  | "parse_error"
  | "unknown";

export interface CompanionError {
  type: CompanionErrorType;
  message: string;
  statusCode?: number;
}

export type CompanionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CompanionError };
