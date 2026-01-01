/**
 * FFmpeg muxer for combining video and audio streams into a single MP4 file.
 *
 * Design:
 * - Pure configuration functions (testable)
 * - Command builder for ffmpeg arguments
 * - Process runner interface for dependency injection
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Muxing options.
 */
export interface MuxOptions {
  /** Path to video stream file */
  videoPath: string;
  /** Path to audio stream file */
  audioPath: string;
  /** Output file path */
  outputPath: string;
  /** Optional: copy streams without re-encoding (default: true) */
  copyStreams?: boolean;
  /** Optional: add faststart for web playback (default: true) */
  faststart?: boolean;
  /** Optional: overwrite output if exists (default: true) */
  overwrite?: boolean;
  /** Optional: ffmpeg binary path (default: "ffmpeg") */
  ffmpegPath?: string;
}

/**
 * Single input conversion options.
 */
export interface ConvertOptions {
  /** Input file path */
  inputPath: string;
  /** Output file path */
  outputPath: string;
  /** Optional: copy streams without re-encoding (default: true) */
  copyStreams?: boolean;
  /** Optional: add faststart for web playback (default: true) */
  faststart?: boolean;
  /** Optional: overwrite output if exists (default: true) */
  overwrite?: boolean;
  /** Optional: ffmpeg binary path (default: "ffmpeg") */
  ffmpegPath?: string;
}

/**
 * Probe result for media file.
 */
export interface ProbeResult {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
}

/**
 * Mux/convert result.
 */
export type MuxResult =
  | { ok: true; outputPath: string; duration: number }
  | { ok: false; error: MuxError };

export interface MuxError {
  type: "ffmpeg_not_found" | "input_not_found" | "process_error" | "unknown";
  message: string;
  exitCode?: number;
  stderr?: string;
}

// ============================================================================
// Process Runner Interface
// ============================================================================

/**
 * Process runner output.
 */
export interface ProcessOutput {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Process runner interface for dependency injection.
 */
export interface ProcessRunner {
  run(cmd: string, args: string[]): Promise<ProcessOutput>;
  exists(path: string): Promise<boolean>;
}

/**
 * Default process runner using Deno.Command.
 */
export const defaultProcessRunner: ProcessRunner = {
  async run(cmd: string, args: string[]): Promise<ProcessOutput> {
    try {
      const command = new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await command.output();
      return {
        success: result.success,
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    } catch (error) {
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },

  async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

// ============================================================================
// Command Builders (pure functions)
// ============================================================================

/**
 * Build ffmpeg mux command arguments.
 */
export function buildMuxArgs(options: MuxOptions): string[] {
  const args: string[] = [];

  // Overwrite flag
  if (options.overwrite !== false) {
    args.push("-y");
  }

  // Input files
  args.push("-i", options.videoPath);
  args.push("-i", options.audioPath);

  // Stream mapping (take video from first input, audio from second)
  args.push("-map", "0:v:0");
  args.push("-map", "1:a:0");

  // Codec options
  if (options.copyStreams !== false) {
    args.push("-c", "copy");
  }

  // Faststart for web playback
  if (options.faststart !== false) {
    args.push("-movflags", "+faststart");
  }

  // Output file
  args.push(options.outputPath);

  return args;
}

/**
 * Build ffmpeg convert command arguments (single input).
 */
export function buildConvertArgs(options: ConvertOptions): string[] {
  const args: string[] = [];

  // Overwrite flag
  if (options.overwrite !== false) {
    args.push("-y");
  }

  // Input file
  args.push("-i", options.inputPath);

  // Codec options
  if (options.copyStreams !== false) {
    args.push("-c", "copy");
  }

  // Faststart for web playback
  if (options.faststart !== false) {
    args.push("-movflags", "+faststart");
  }

  // Output file
  args.push(options.outputPath);

  return args;
}

/**
 * Build ffprobe command arguments.
 */
export function buildProbeArgs(inputPath: string): string[] {
  return [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ];
}

// ============================================================================
// Probe Parser (pure function)
// ============================================================================

/**
 * Parse ffprobe JSON output.
 */
export function parseProbeOutput(output: string): ProbeResult | null {
  try {
    const data = JSON.parse(output);

    const videoStream = data.streams?.find(
      (s: { codec_type: string }) => s.codec_type === "video",
    );
    const audioStream = data.streams?.find(
      (s: { codec_type: string }) => s.codec_type === "audio",
    );

    return {
      duration: parseFloat(data.format?.duration ?? "0"),
      hasVideo: !!videoStream,
      hasAudio: !!audioStream,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      width: videoStream?.width,
      height: videoStream?.height,
      bitrate: data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : undefined,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Muxer Functions
// ============================================================================

/**
 * Create error result helper.
 */
function errorResult(
  type: MuxError["type"],
  message: string,
  exitCode?: number,
  stderr?: string,
): MuxResult {
  return { ok: false, error: { type, message, exitCode, stderr } };
}

/**
 * Create a muxer instance.
 */
export function createMuxer(runner: ProcessRunner = defaultProcessRunner) {
  /**
   * Check if ffmpeg is available.
   */
  async function checkFfmpeg(ffmpegPath: string = "ffmpeg"): Promise<boolean> {
    const result = await runner.run(ffmpegPath, ["-version"]);
    return result.success;
  }

  /**
   * Probe a media file.
   */
  async function probe(
    inputPath: string,
    ffprobePath: string = "ffprobe",
  ): Promise<ProbeResult | null> {
    const args = buildProbeArgs(inputPath);
    const result = await runner.run(ffprobePath, args);

    if (!result.success) {
      return null;
    }

    return parseProbeOutput(result.stdout);
  }

  /**
   * Mux video and audio streams into a single MP4 file.
   */
  async function mux(options: MuxOptions): Promise<MuxResult> {
    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";

    // Check ffmpeg exists
    const ffmpegAvailable = await checkFfmpeg(ffmpegPath);
    if (!ffmpegAvailable) {
      return errorResult("ffmpeg_not_found", `ffmpeg not found at: ${ffmpegPath}`);
    }

    // Check input files exist
    if (!(await runner.exists(options.videoPath))) {
      return errorResult("input_not_found", `Video file not found: ${options.videoPath}`);
    }
    if (!(await runner.exists(options.audioPath))) {
      return errorResult("input_not_found", `Audio file not found: ${options.audioPath}`);
    }

    // Build and run command
    const args = buildMuxArgs(options);
    const result = await runner.run(ffmpegPath, args);

    if (!result.success) {
      return errorResult(
        "process_error",
        `ffmpeg failed with code ${result.code}`,
        result.code,
        result.stderr,
      );
    }

    // Probe output to get duration
    const probeResult = await probe(options.outputPath);
    const duration = probeResult?.duration ?? 0;

    return { ok: true, outputPath: options.outputPath, duration };
  }

  /**
   * Convert a single file (e.g., combined stream to MP4).
   */
  async function convert(options: ConvertOptions): Promise<MuxResult> {
    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";

    // Check ffmpeg exists
    const ffmpegAvailable = await checkFfmpeg(ffmpegPath);
    if (!ffmpegAvailable) {
      return errorResult("ffmpeg_not_found", `ffmpeg not found at: ${ffmpegPath}`);
    }

    // Check input file exists
    if (!(await runner.exists(options.inputPath))) {
      return errorResult("input_not_found", `Input file not found: ${options.inputPath}`);
    }

    // Build and run command
    const args = buildConvertArgs(options);
    const result = await runner.run(ffmpegPath, args);

    if (!result.success) {
      return errorResult(
        "process_error",
        `ffmpeg failed with code ${result.code}`,
        result.code,
        result.stderr,
      );
    }

    // Probe output to get duration
    const probeResult = await probe(options.outputPath);
    const duration = probeResult?.duration ?? 0;

    return { ok: true, outputPath: options.outputPath, duration };
  }

  return {
    checkFfmpeg,
    probe,
    mux,
    convert,
  };
}

/**
 * Type for the muxer instance.
 */
export type Muxer = ReturnType<typeof createMuxer>;
