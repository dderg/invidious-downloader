import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  parseMP4ForDASH,
  parseWebMForDASH,
  getMediaByteRanges,
  clearByteRangeCache,
  type MediaFileSystem,
} from "../src/services/media-parser.ts";

// ============================================================================
// Mock File System
// ============================================================================

/**
 * Create a mock file with specified binary content.
 */
function createMockFile(data: Uint8Array): Deno.FsFile {
  let position = 0;

  return {
    read(buffer: Uint8Array): Promise<number | null> {
      if (position >= data.length) return Promise.resolve(null);
      const bytesToRead = Math.min(buffer.length, data.length - position);
      buffer.set(data.subarray(position, position + bytesToRead));
      position += bytesToRead;
      return Promise.resolve(bytesToRead);
    },
    seek(offset: number, _whence: Deno.SeekMode): Promise<number> {
      position = offset;
      return Promise.resolve(position);
    },
    close(): void {
      // No-op
    },
    // Required properties for Deno.FsFile interface
    readable: new ReadableStream(),
    writable: new WritableStream(),
    rid: 0,
    write: () => Promise.resolve(0),
    stat: () => Promise.resolve({} as Deno.FileInfo),
    truncate: () => Promise.resolve(),
    sync: () => Promise.resolve(),
    syncData: () => Promise.resolve(),
    datasync: () => Promise.resolve(),
    utime: () => Promise.resolve(),
    isTerminal: () => false,
    setRaw: () => {},
    lock: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    [Symbol.dispose]: () => {},
  } as unknown as Deno.FsFile;
}

function createMockFileSystem(files: Map<string, Uint8Array>): MediaFileSystem {
  return {
    open: (path: string) => {
      const data = files.get(path);
      if (!data) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve(createMockFile(data));
    },
    stat: (path: string) => {
      const data = files.get(path);
      if (!data) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve({ size: data.length });
    },
  };
}

// ============================================================================
// MP4 Test Helpers
// ============================================================================

/**
 * Build a simple MP4 atom header.
 * size: 4 bytes big-endian
 * type: 4 bytes ASCII
 */
function buildAtom(type: string, content: Uint8Array): Uint8Array {
  const size = 8 + content.length;
  const atom = new Uint8Array(size);
  // Size (big-endian)
  atom[0] = (size >> 24) & 0xff;
  atom[1] = (size >> 16) & 0xff;
  atom[2] = (size >> 8) & 0xff;
  atom[3] = size & 0xff;
  // Type
  atom[4] = type.charCodeAt(0);
  atom[5] = type.charCodeAt(1);
  atom[6] = type.charCodeAt(2);
  atom[7] = type.charCodeAt(3);
  // Content
  atom.set(content, 8);
  return atom;
}

/**
 * Build a minimal MP4 file with ftyp, moov, and optional sidx atoms.
 */
function buildMinimalMP4(options: { includeSidx?: boolean } = {}): Uint8Array {
  const ftyp = buildAtom("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])); // "isom"
  const moov = buildAtom("moov", new Uint8Array(100)); // 108 bytes total
  const sidx = options.includeSidx
    ? buildAtom("sidx", new Uint8Array(20)) // 28 bytes total
    : new Uint8Array(0);
  const mdat = buildAtom("mdat", new Uint8Array(500));

  const total = ftyp.length + moov.length + sidx.length + mdat.length;
  const mp4 = new Uint8Array(total);

  let offset = 0;
  mp4.set(ftyp, offset);
  offset += ftyp.length;
  mp4.set(moov, offset);
  offset += moov.length;
  mp4.set(sidx, offset);
  offset += sidx.length;
  mp4.set(mdat, offset);

  return mp4;
}

// ============================================================================
// WebM/EBML Test Helpers
// ============================================================================

/**
 * Encode a number as VINT (variable integer).
 */
function encodeVINT(value: number, minBytes = 1): Uint8Array {
  // Simple VINT encoding for small values
  if (value < 127 && minBytes <= 1) {
    return new Uint8Array([0x80 | value]);
  } else if (value < 16383 && minBytes <= 2) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  } else if (value < 2097151 && minBytes <= 3) {
    return new Uint8Array([
      0x20 | (value >> 16),
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  } else {
    return new Uint8Array([
      0x10 | (value >> 24),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
}

/**
 * Build an EBML element.
 */
function buildEBMLElement(id: number, content: Uint8Array): Uint8Array {
  // Encode element ID
  let idBytes: Uint8Array;
  if (id < 0x80) {
    idBytes = new Uint8Array([id]);
  } else if (id < 0x4000) {
    idBytes = new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  } else if (id < 0x200000) {
    idBytes = new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  } else {
    idBytes = new Uint8Array([
      (id >> 24) & 0xff,
      (id >> 16) & 0xff,
      (id >> 8) & 0xff,
      id & 0xff,
    ]);
  }

  const sizeBytes = encodeVINT(content.length);
  const element = new Uint8Array(idBytes.length + sizeBytes.length + content.length);

  element.set(idBytes, 0);
  element.set(sizeBytes, idBytes.length);
  element.set(content, idBytes.length + sizeBytes.length);

  return element;
}

/**
 * Build a minimal WebM file structure.
 */
function buildMinimalWebM(): Uint8Array {
  // EBML IDs (from spec)
  const EBML_ID = 0x1a45dfa3;
  const SEGMENT_ID = 0x18538067;
  const TRACKS_ID = 0x1654ae6b;
  const CUES_ID = 0x1c53bb6b;
  const CLUSTER_ID = 0x1f43b675;

  // Build inner elements
  const tracks = buildEBMLElement(TRACKS_ID, new Uint8Array(50));
  const cues = buildEBMLElement(CUES_ID, new Uint8Array(30));
  const cluster = buildEBMLElement(CLUSTER_ID, new Uint8Array(100));

  // Combine into segment content
  const segmentContent = new Uint8Array(tracks.length + cues.length + cluster.length);
  let offset = 0;
  segmentContent.set(tracks, offset);
  offset += tracks.length;
  segmentContent.set(cues, offset);
  offset += cues.length;
  segmentContent.set(cluster, offset);

  // Build segment (use unknown size encoding for simplicity: 0x01FFFFFFFFFFFFFF)
  const segmentIdBytes = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
  // For testing, use a concrete size
  const segmentSizeBytes = encodeVINT(segmentContent.length, 4);
  const segment = new Uint8Array(
    segmentIdBytes.length + segmentSizeBytes.length + segmentContent.length
  );
  segment.set(segmentIdBytes, 0);
  segment.set(segmentSizeBytes, segmentIdBytes.length);
  segment.set(segmentContent, segmentIdBytes.length + segmentSizeBytes.length);

  // Build EBML header
  const ebmlHeader = buildEBMLElement(EBML_ID, new Uint8Array(20));

  // Combine all
  const webm = new Uint8Array(ebmlHeader.length + segment.length);
  webm.set(ebmlHeader, 0);
  webm.set(segment, ebmlHeader.length);

  return webm;
}

// ============================================================================
// Tests
// ============================================================================

describe("parseMP4ForDASH", () => {
  it("should parse MP4 with moov atom", async () => {
    const mp4Data = buildMinimalMP4({ includeSidx: false });
    const files = new Map([["/test.mp4", mp4Data]]);
    const fs = createMockFileSystem(files);

    const result = await parseMP4ForDASH("/test.mp4", fs);

    assertEquals(result.ok, true);
    if (result.ok) {
      // ftyp is 12 bytes, moov is 108 bytes
      // Init range should be 0 to end of moov (12 + 108 - 1 = 119)
      assertEquals(result.ranges.initRange, "0-119");
      // No sidx, so indexRange should be the moov range
      assertEquals(result.ranges.indexRange, "12-119");
    }
  });

  it("should parse MP4 with sidx atom", async () => {
    const mp4Data = buildMinimalMP4({ includeSidx: true });
    const files = new Map([["/test.mp4", mp4Data]]);
    const fs = createMockFileSystem(files);

    const result = await parseMP4ForDASH("/test.mp4", fs);

    assertEquals(result.ok, true);
    if (result.ok) {
      // ftyp is 12 bytes, moov is 108 bytes
      assertEquals(result.ranges.initRange, "0-119");
      // sidx starts at 120, is 28 bytes
      assertEquals(result.ranges.indexRange, "120-147");
    }
  });

  it("should return error for invalid file", async () => {
    const files = new Map<string, Uint8Array>();
    const fs = createMockFileSystem(files);

    const result = await parseMP4ForDASH("/nonexistent.mp4", fs);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("not found") || result.error.includes("Failed"), true);
    }
  });

  it("should return error for file without moov", async () => {
    // Build MP4 with only ftyp and mdat (no moov)
    const ftyp = buildAtom("ftyp", new Uint8Array(4));
    const mdat = buildAtom("mdat", new Uint8Array(100));
    const badMp4 = new Uint8Array(ftyp.length + mdat.length);
    badMp4.set(ftyp, 0);
    badMp4.set(mdat, ftyp.length);

    const files = new Map([["/bad.mp4", badMp4]]);
    const fs = createMockFileSystem(files);

    const result = await parseMP4ForDASH("/bad.mp4", fs);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("moov"), true);
    }
  });
});

describe("parseWebMForDASH", () => {
  it("should parse WebM with tracks and cues", async () => {
    const webmData = buildMinimalWebM();
    const files = new Map([["/test.webm", webmData]]);
    const fs = createMockFileSystem(files);

    const result = await parseWebMForDASH("/test.webm", fs);

    assertEquals(result.ok, true);
    if (result.ok) {
      // Should have valid ranges
      assertExists(result.ranges.initRange);
      assertExists(result.ranges.indexRange);
      // initRange should start at 0
      assertEquals(result.ranges.initRange.startsWith("0-"), true);
    }
  });

  it("should return error for non-EBML file", async () => {
    // Random data that doesn't start with EBML header
    const badData = new Uint8Array(100);
    badData.fill(0x42);

    const files = new Map([["/bad.webm", badData]]);
    const fs = createMockFileSystem(files);

    const result = await parseWebMForDASH("/bad.webm", fs);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("valid") || result.error.includes("EBML"), true);
    }
  });
});

describe("getMediaByteRanges", () => {
  it("should detect MP4 by extension", async () => {
    const mp4Data = buildMinimalMP4();
    const files = new Map([["/video.mp4", mp4Data]]);
    const fs = createMockFileSystem(files);

    const result = await getMediaByteRanges("/video.mp4", fs);

    assertEquals(result.ok, true);
  });

  it("should detect M4A by extension", async () => {
    const mp4Data = buildMinimalMP4();
    const files = new Map([["/audio.m4a", mp4Data]]);
    const fs = createMockFileSystem(files);

    const result = await getMediaByteRanges("/audio.m4a", fs);

    assertEquals(result.ok, true);
  });

  it("should detect WebM by extension", async () => {
    const webmData = buildMinimalWebM();
    const files = new Map([["/video.webm", webmData]]);
    const fs = createMockFileSystem(files);

    const result = await getMediaByteRanges("/video.webm", fs);

    assertEquals(result.ok, true);
  });

  it("should return error for unsupported extension", async () => {
    const files = new Map([["/video.avi", new Uint8Array(100)]]);
    const fs = createMockFileSystem(files);

    const result = await getMediaByteRanges("/video.avi", fs);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("Unsupported"), true);
    }
  });
});

describe("clearByteRangeCache", () => {
  it("should clear the cache without error", () => {
    // Just verify it doesn't throw
    clearByteRangeCache();
  });
});
