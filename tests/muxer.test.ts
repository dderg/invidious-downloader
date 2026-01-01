import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  buildConvertArgs,
  buildMuxArgs,
  buildProbeArgs,
  createMuxer,
  parseProbeOutput,
  type ProcessRunner,
} from "../src/services/muxer.ts";

// ============================================================================
// Mock Process Runner
// ============================================================================

function createMockRunner(
  outputs: Map<string, { success: boolean; code: number; stdout: string; stderr: string }>,
  existingFiles: Set<string> = new Set(),
): ProcessRunner {
  return {
    async run(cmd: string, args: string[]) {
      const key = `${cmd} ${args.join(" ")}`;
      // Check for specific command patterns
      for (const [pattern, output] of outputs) {
        if (key.includes(pattern) || cmd.includes(pattern)) {
          return output;
        }
      }
      return { success: false, code: 1, stdout: "", stderr: "Command not found" };
    },
    async exists(path: string) {
      return existingFiles.has(path);
    },
  };
}

// ============================================================================
// Command Builder Tests
// ============================================================================

describe("buildMuxArgs", () => {
  it("should build basic mux command", () => {
    const args = buildMuxArgs({
      videoPath: "/tmp/video.mp4",
      audioPath: "/tmp/audio.m4a",
      outputPath: "/output/final.mp4",
    });

    assertEquals(args.includes("-y"), true);
    assertEquals(args.includes("-i"), true);
    assertEquals(args.includes("/tmp/video.mp4"), true);
    assertEquals(args.includes("/tmp/audio.m4a"), true);
    assertEquals(args.includes("-map"), true);
    assertEquals(args.includes("0:v:0"), true);
    assertEquals(args.includes("1:a:0"), true);
    assertEquals(args.includes("-c"), true);
    assertEquals(args.includes("copy"), true);
    assertEquals(args.includes("-movflags"), true);
    assertEquals(args.includes("+faststart"), true);
    assertEquals(args[args.length - 1], "/output/final.mp4");
  });

  it("should exclude overwrite flag when disabled", () => {
    const args = buildMuxArgs({
      videoPath: "/tmp/video.mp4",
      audioPath: "/tmp/audio.m4a",
      outputPath: "/output/final.mp4",
      overwrite: false,
    });

    assertEquals(args.includes("-y"), false);
  });

  it("should exclude copy codec when disabled", () => {
    const args = buildMuxArgs({
      videoPath: "/tmp/video.mp4",
      audioPath: "/tmp/audio.m4a",
      outputPath: "/output/final.mp4",
      copyStreams: false,
    });

    assertEquals(args.includes("-c"), false);
    assertEquals(args.includes("copy"), false);
  });

  it("should exclude faststart when disabled", () => {
    const args = buildMuxArgs({
      videoPath: "/tmp/video.mp4",
      audioPath: "/tmp/audio.m4a",
      outputPath: "/output/final.mp4",
      faststart: false,
    });

    assertEquals(args.includes("-movflags"), false);
    assertEquals(args.includes("+faststart"), false);
  });
});

describe("buildConvertArgs", () => {
  it("should build basic convert command", () => {
    const args = buildConvertArgs({
      inputPath: "/tmp/input.webm",
      outputPath: "/output/output.mp4",
    });

    assertEquals(args.includes("-y"), true);
    assertEquals(args.includes("-i"), true);
    assertEquals(args.includes("/tmp/input.webm"), true);
    assertEquals(args.includes("-c"), true);
    assertEquals(args.includes("copy"), true);
    assertEquals(args[args.length - 1], "/output/output.mp4");
  });
});

describe("buildProbeArgs", () => {
  it("should build probe command", () => {
    const args = buildProbeArgs("/input/file.mp4");

    assertEquals(args.includes("-v"), true);
    assertEquals(args.includes("quiet"), true);
    assertEquals(args.includes("-print_format"), true);
    assertEquals(args.includes("json"), true);
    assertEquals(args.includes("-show_format"), true);
    assertEquals(args.includes("-show_streams"), true);
    assertEquals(args[args.length - 1], "/input/file.mp4");
  });
});

// ============================================================================
// Probe Parser Tests
// ============================================================================

describe("parseProbeOutput", () => {
  it("should parse valid ffprobe output", () => {
    const output = JSON.stringify({
      format: {
        duration: "123.456",
        bit_rate: "1500000",
      },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac" },
      ],
    });

    const result = parseProbeOutput(output);

    assertEquals(result !== null, true);
    assertEquals(result?.duration, 123.456);
    assertEquals(result?.hasVideo, true);
    assertEquals(result?.hasAudio, true);
    assertEquals(result?.videoCodec, "h264");
    assertEquals(result?.audioCodec, "aac");
    assertEquals(result?.width, 1920);
    assertEquals(result?.height, 1080);
    assertEquals(result?.bitrate, 1500000);
  });

  it("should handle video-only file", () => {
    const output = JSON.stringify({
      format: { duration: "60.0" },
      streams: [{ codec_type: "video", codec_name: "vp9" }],
    });

    const result = parseProbeOutput(output);

    assertEquals(result?.hasVideo, true);
    assertEquals(result?.hasAudio, false);
    assertEquals(result?.videoCodec, "vp9");
    assertEquals(result?.audioCodec, undefined);
  });

  it("should handle audio-only file", () => {
    const output = JSON.stringify({
      format: { duration: "180.0" },
      streams: [{ codec_type: "audio", codec_name: "opus" }],
    });

    const result = parseProbeOutput(output);

    assertEquals(result?.hasVideo, false);
    assertEquals(result?.hasAudio, true);
    assertEquals(result?.audioCodec, "opus");
  });

  it("should return null for invalid JSON", () => {
    const result = parseProbeOutput("not json");
    assertEquals(result, null);
  });

  it("should handle missing fields gracefully", () => {
    const output = JSON.stringify({});
    const result = parseProbeOutput(output);

    assertEquals(result !== null, true);
    assertEquals(result?.duration, 0);
    assertEquals(result?.hasVideo, false);
    assertEquals(result?.hasAudio, false);
  });
});

// ============================================================================
// Muxer Tests
// ============================================================================

describe("createMuxer", () => {
  describe("checkFfmpeg", () => {
    it("should return true when ffmpeg is available", async () => {
      const runner = createMockRunner(
        new Map([["ffmpeg", { success: true, code: 0, stdout: "ffmpeg version", stderr: "" }]]),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.checkFfmpeg();
      assertEquals(result, true);
    });

    it("should return false when ffmpeg is not available", async () => {
      const runner = createMockRunner(new Map());
      const muxer = createMuxer(runner);

      const result = await muxer.checkFfmpeg();
      assertEquals(result, false);
    });
  });

  describe("probe", () => {
    it("should return probe result for valid file", async () => {
      const probeOutput = JSON.stringify({
        format: { duration: "120.5" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
        ],
      });

      const runner = createMockRunner(
        new Map([["ffprobe", { success: true, code: 0, stdout: probeOutput, stderr: "" }]]),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.probe("/test.mp4");

      assertEquals(result !== null, true);
      assertEquals(result?.duration, 120.5);
      assertEquals(result?.hasVideo, true);
      assertEquals(result?.width, 1280);
    });

    it("should return null when probe fails", async () => {
      const runner = createMockRunner(new Map());
      const muxer = createMuxer(runner);

      const result = await muxer.probe("/nonexistent.mp4");
      assertEquals(result, null);
    });
  });

  describe("mux", () => {
    it("should return error when ffmpeg not found", async () => {
      const runner = createMockRunner(new Map());
      const muxer = createMuxer(runner);

      const result = await muxer.mux({
        videoPath: "/tmp/video.mp4",
        audioPath: "/tmp/audio.m4a",
        outputPath: "/output/final.mp4",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "ffmpeg_not_found");
      }
    });

    it("should return error when video file not found", async () => {
      const runner = createMockRunner(
        new Map([["ffmpeg", { success: true, code: 0, stdout: "ffmpeg version", stderr: "" }]]),
        new Set(), // No files exist
      );
      const muxer = createMuxer(runner);

      const result = await muxer.mux({
        videoPath: "/tmp/video.mp4",
        audioPath: "/tmp/audio.m4a",
        outputPath: "/output/final.mp4",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "input_not_found");
        assertEquals(result.error.message.includes("Video file"), true);
      }
    });

    it("should return error when audio file not found", async () => {
      const runner = createMockRunner(
        new Map([["ffmpeg", { success: true, code: 0, stdout: "ffmpeg version", stderr: "" }]]),
        new Set(["/tmp/video.mp4"]), // Only video exists
      );
      const muxer = createMuxer(runner);

      const result = await muxer.mux({
        videoPath: "/tmp/video.mp4",
        audioPath: "/tmp/audio.m4a",
        outputPath: "/output/final.mp4",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "input_not_found");
        assertEquals(result.error.message.includes("Audio file"), true);
      }
    });

    it("should return success when mux completes", async () => {
      const probeOutput = JSON.stringify({
        format: { duration: "120.0" },
        streams: [{ codec_type: "video" }],
      });

      const runner = createMockRunner(
        new Map([
          ["ffmpeg", { success: true, code: 0, stdout: "", stderr: "" }],
          ["ffprobe", { success: true, code: 0, stdout: probeOutput, stderr: "" }],
        ]),
        new Set(["/tmp/video.mp4", "/tmp/audio.m4a", "/output/final.mp4"]),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.mux({
        videoPath: "/tmp/video.mp4",
        audioPath: "/tmp/audio.m4a",
        outputPath: "/output/final.mp4",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.outputPath, "/output/final.mp4");
        assertEquals(result.duration, 120.0);
      }
    });

    it("should return error when ffmpeg process fails", async () => {
      const runner = createMockRunner(
        new Map([
          ["-version", { success: true, code: 0, stdout: "ffmpeg version", stderr: "" }],
          ["-i", { success: false, code: 1, stdout: "", stderr: "Error during muxing" }],
        ]),
        new Set(["/tmp/video.mp4", "/tmp/audio.m4a"]),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.mux({
        videoPath: "/tmp/video.mp4",
        audioPath: "/tmp/audio.m4a",
        outputPath: "/output/final.mp4",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "process_error");
      }
    });
  });

  describe("convert", () => {
    it("should return error when input file not found", async () => {
      const runner = createMockRunner(
        new Map([["ffmpeg", { success: true, code: 0, stdout: "ffmpeg version", stderr: "" }]]),
        new Set(),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.convert({
        inputPath: "/tmp/input.webm",
        outputPath: "/output/output.mp4",
      });

      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.type, "input_not_found");
      }
    });

    it("should return success when convert completes", async () => {
      const probeOutput = JSON.stringify({
        format: { duration: "60.0" },
        streams: [],
      });

      const runner = createMockRunner(
        new Map([
          ["ffmpeg", { success: true, code: 0, stdout: "", stderr: "" }],
          ["ffprobe", { success: true, code: 0, stdout: probeOutput, stderr: "" }],
        ]),
        new Set(["/tmp/input.webm", "/output/output.mp4"]),
      );
      const muxer = createMuxer(runner);

      const result = await muxer.convert({
        inputPath: "/tmp/input.webm",
        outputPath: "/output/output.mp4",
      });

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.outputPath, "/output/output.mp4");
        assertEquals(result.duration, 60.0);
      }
    });
  });
});
