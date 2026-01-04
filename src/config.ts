/**
 * Configuration types and parsing for Invidious Downloader.
 * All functions are pure and easily testable.
 */

export interface Config {
  // Required
  invidiousUrl: string;
  invidiousDbUrl: string;
  companionUrl: string;
  companionSecret: string;
  videosPath: string;

  // Optional with defaults
  port: number;
  invidiousUser: string | null;
  downloadQuality: string;
  downloadRateLimit: number; // bytes/sec, 0 = unlimited
  checkIntervalMinutes: number;
  maxConcurrentDownloads: number;
  maxRetryAttempts: number; // max automatic retries before permanent failure
  retryBaseDelayMinutes: number; // base delay for exponential backoff (1 → 4 → 16 min)
  
  // Cleanup settings
  cleanupEnabled: boolean;
  cleanupDays: number; // days after which watched subscription videos can be deleted
  cleanupIntervalHours: number; // how often to run cleanup check
  
  // Throttle detection
  throttleSpeedThreshold: number; // bytes/sec - abort if speed falls below this (default: 100KB/s)
  throttleDetectionWindow: number; // seconds to measure rolling average (default: 30)
  throttleMaxRetries: number; // separate retry counter for throttle failures (default: 5)
}

export interface ConfigInput {
  INVIDIOUS_URL?: string;
  INVIDIOUS_DB_URL?: string;
  COMPANION_URL?: string;
  COMPANION_SECRET?: string;
  VIDEOS_PATH?: string;
  PORT?: string;
  INVIDIOUS_USER?: string;
  DOWNLOAD_QUALITY?: string;
  DOWNLOAD_RATE_LIMIT?: string;
  CHECK_INTERVAL_MINUTES?: string;
  MAX_CONCURRENT_DOWNLOADS?: string;
  MAX_RETRY_ATTEMPTS?: string;
  RETRY_BASE_DELAY_MINUTES?: string;
  // Cleanup settings
  CLEANUP_ENABLED?: string;
  CLEANUP_DAYS?: string;
  CLEANUP_INTERVAL_HOURS?: string;
  // Throttle detection
  THROTTLE_SPEED_THRESHOLD?: string;
  THROTTLE_DETECTION_WINDOW?: string;
  THROTTLE_MAX_RETRIES?: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; errors: ConfigError[] };

/**
 * Parse and validate configuration from environment variables.
 * Pure function - no I/O, only transforms input to output.
 */
export function parseConfig(input: ConfigInput): ConfigResult {
  const errors: ConfigError[] = [];

  // Required fields
  const invidiousUrl = input.INVIDIOUS_URL?.trim();
  if (!invidiousUrl) {
    errors.push(new ConfigError("INVIDIOUS_URL is required", "INVIDIOUS_URL"));
  }

  const invidiousDbUrl = input.INVIDIOUS_DB_URL?.trim();
  if (!invidiousDbUrl) {
    errors.push(
      new ConfigError("INVIDIOUS_DB_URL is required", "INVIDIOUS_DB_URL"),
    );
  }

  const companionUrl = input.COMPANION_URL?.trim();
  if (!companionUrl) {
    errors.push(new ConfigError("COMPANION_URL is required", "COMPANION_URL"));
  }

  const companionSecret = input.COMPANION_SECRET?.trim();
  if (!companionSecret) {
    errors.push(
      new ConfigError("COMPANION_SECRET is required", "COMPANION_SECRET"),
    );
  }

  const videosPath = input.VIDEOS_PATH?.trim();
  if (!videosPath) {
    errors.push(new ConfigError("VIDEOS_PATH is required", "VIDEOS_PATH"));
  }

  // Optional fields with validation
  const port = parsePort(input.PORT);
  if (port.error) {
    errors.push(port.error);
  }

  const downloadRateLimit = parseNonNegativeInt(
    input.DOWNLOAD_RATE_LIMIT,
    "DOWNLOAD_RATE_LIMIT",
    0,
  );
  if (downloadRateLimit.error) {
    errors.push(downloadRateLimit.error);
  }

  const checkIntervalMinutes = parsePositiveInt(
    input.CHECK_INTERVAL_MINUTES,
    "CHECK_INTERVAL_MINUTES",
    5,
  );
  if (checkIntervalMinutes.error) {
    errors.push(checkIntervalMinutes.error);
  }

  const maxConcurrentDownloads = parsePositiveInt(
    input.MAX_CONCURRENT_DOWNLOADS,
    "MAX_CONCURRENT_DOWNLOADS",
    2,
  );
  if (maxConcurrentDownloads.error) {
    errors.push(maxConcurrentDownloads.error);
  }

  const maxRetryAttempts = parsePositiveInt(
    input.MAX_RETRY_ATTEMPTS,
    "MAX_RETRY_ATTEMPTS",
    3,
  );
  if (maxRetryAttempts.error) {
    errors.push(maxRetryAttempts.error);
  }

  const retryBaseDelayMinutes = parsePositiveInt(
    input.RETRY_BASE_DELAY_MINUTES,
    "RETRY_BASE_DELAY_MINUTES",
    1,
  );
  if (retryBaseDelayMinutes.error) {
    errors.push(retryBaseDelayMinutes.error);
  }

  // Cleanup settings
  const cleanupEnabled = parseBoolean(input.CLEANUP_ENABLED, false);
  
  const cleanupDays = parsePositiveInt(
    input.CLEANUP_DAYS,
    "CLEANUP_DAYS",
    14,
  );
  if (cleanupDays.error) {
    errors.push(cleanupDays.error);
  }

  const cleanupIntervalHours = parsePositiveInt(
    input.CLEANUP_INTERVAL_HOURS,
    "CLEANUP_INTERVAL_HOURS",
    24,
  );
  if (cleanupIntervalHours.error) {
    errors.push(cleanupIntervalHours.error);
  }

  // Throttle detection settings
  const throttleSpeedThreshold = parseNonNegativeInt(
    input.THROTTLE_SPEED_THRESHOLD,
    "THROTTLE_SPEED_THRESHOLD",
    102400, // 100KB/s default
  );
  if (throttleSpeedThreshold.error) {
    errors.push(throttleSpeedThreshold.error);
  }

  const throttleDetectionWindow = parsePositiveInt(
    input.THROTTLE_DETECTION_WINDOW,
    "THROTTLE_DETECTION_WINDOW",
    30,
  );
  if (throttleDetectionWindow.error) {
    errors.push(throttleDetectionWindow.error);
  }

  const throttleMaxRetries = parsePositiveInt(
    input.THROTTLE_MAX_RETRIES,
    "THROTTLE_MAX_RETRIES",
    5,
  );
  if (throttleMaxRetries.error) {
    errors.push(throttleMaxRetries.error);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      invidiousUrl: invidiousUrl!,
      invidiousDbUrl: invidiousDbUrl!,
      companionUrl: companionUrl!,
      companionSecret: companionSecret!,
      videosPath: videosPath!,
      port: port.value!,
      invidiousUser: input.INVIDIOUS_USER?.trim() || null,
      downloadQuality: input.DOWNLOAD_QUALITY?.trim() || "best",
      downloadRateLimit: downloadRateLimit.value!,
      checkIntervalMinutes: checkIntervalMinutes.value!,
      maxConcurrentDownloads: maxConcurrentDownloads.value!,
      maxRetryAttempts: maxRetryAttempts.value!,
      retryBaseDelayMinutes: retryBaseDelayMinutes.value!,
      cleanupEnabled,
      cleanupDays: cleanupDays.value!,
      cleanupIntervalHours: cleanupIntervalHours.value!,
      throttleSpeedThreshold: throttleSpeedThreshold.value!,
      throttleDetectionWindow: throttleDetectionWindow.value!,
      throttleMaxRetries: throttleMaxRetries.value!,
    },
  };
}

/**
 * Load config from Deno.env (convenience wrapper).
 * This is the only impure function - it reads from environment.
 */
export function loadConfigFromEnv(): ConfigResult {
  return parseConfig({
    INVIDIOUS_URL: Deno.env.get("INVIDIOUS_URL"),
    INVIDIOUS_DB_URL: Deno.env.get("INVIDIOUS_DB_URL"),
    COMPANION_URL: Deno.env.get("COMPANION_URL"),
    COMPANION_SECRET: Deno.env.get("COMPANION_SECRET"),
    VIDEOS_PATH: Deno.env.get("VIDEOS_PATH"),
    PORT: Deno.env.get("PORT"),
    INVIDIOUS_USER: Deno.env.get("INVIDIOUS_USER"),
    DOWNLOAD_QUALITY: Deno.env.get("DOWNLOAD_QUALITY"),
    DOWNLOAD_RATE_LIMIT: Deno.env.get("DOWNLOAD_RATE_LIMIT"),
    CHECK_INTERVAL_MINUTES: Deno.env.get("CHECK_INTERVAL_MINUTES"),
    MAX_CONCURRENT_DOWNLOADS: Deno.env.get("MAX_CONCURRENT_DOWNLOADS"),
    MAX_RETRY_ATTEMPTS: Deno.env.get("MAX_RETRY_ATTEMPTS"),
    RETRY_BASE_DELAY_MINUTES: Deno.env.get("RETRY_BASE_DELAY_MINUTES"),
    CLEANUP_ENABLED: Deno.env.get("CLEANUP_ENABLED"),
    CLEANUP_DAYS: Deno.env.get("CLEANUP_DAYS"),
    CLEANUP_INTERVAL_HOURS: Deno.env.get("CLEANUP_INTERVAL_HOURS"),
    THROTTLE_SPEED_THRESHOLD: Deno.env.get("THROTTLE_SPEED_THRESHOLD"),
    THROTTLE_DETECTION_WINDOW: Deno.env.get("THROTTLE_DETECTION_WINDOW"),
    THROTTLE_MAX_RETRIES: Deno.env.get("THROTTLE_MAX_RETRIES"),
  });
}

// Helper functions (pure)

interface ParseResult<T> {
  value?: T;
  error?: ConfigError;
}

function parsePort(value: string | undefined): ParseResult<number> {
  if (!value || value.trim() === "") {
    return { value: 3001 };
  }

  const num = parseInt(value.trim(), 10);
  if (isNaN(num) || num < 1 || num > 65535) {
    return {
      error: new ConfigError(
        `PORT must be a valid port number (1-65535), got: ${value}`,
        "PORT",
      ),
    };
  }

  return { value: num };
}

function parseNonNegativeInt(
  value: string | undefined,
  field: string,
  defaultValue: number,
): ParseResult<number> {
  if (!value || value.trim() === "") {
    return { value: defaultValue };
  }

  const num = parseInt(value.trim(), 10);
  if (isNaN(num) || num < 0) {
    return {
      error: new ConfigError(
        `${field} must be a non-negative integer, got: ${value}`,
        field,
      ),
    };
  }

  return { value: num };
}

function parsePositiveInt(
  value: string | undefined,
  field: string,
  defaultValue: number,
): ParseResult<number> {
  if (!value || value.trim() === "") {
    return { value: defaultValue };
  }

  const num = parseInt(value.trim(), 10);
  if (isNaN(num) || num < 1) {
    return {
      error: new ConfigError(
        `${field} must be a positive integer, got: ${value}`,
        field,
      ),
    };
  }

  return { value: num };
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const lower = value.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

/**
 * Validate a URL string.
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize URL by removing trailing slash.
 */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
