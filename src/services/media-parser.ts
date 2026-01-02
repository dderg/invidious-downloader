/**
 * Media Parser for DASH Byte Ranges
 *
 * Parses MP4 and WebM container files to extract byte ranges needed for DASH manifests.
 * These ranges tell DASH players where to find initialization data and segment indexes.
 *
 * MP4 Structure:
 * - ftyp atom: File type
 * - moov atom: Movie metadata (initialization data)
 * - sidx atom: Segment index (tells player where segments are)
 * - moof/mdat atoms: Actual media data
 *
 * WebM/EBML Structure:
 * - EBML header
 * - Segment containing:
 *   - SeekHead, Info, Tracks (initialization)
 *   - Cues (segment index)
 *   - Clusters (media data)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Byte ranges needed for DASH SegmentBase.
 */
export interface DASHByteRanges {
  /** Initialization range (e.g., "0-740") - contains moov/header data */
  initRange: string;
  /** Index range (e.g., "741-1200") - contains sidx/Cues for seeking */
  indexRange: string;
}

/**
 * Result of parsing a media file.
 */
export type MediaParseResult =
  | { ok: true; ranges: DASHByteRanges }
  | { ok: false; error: string };

/**
 * File system interface for dependency injection.
 */
export interface MediaFileSystem {
  open(path: string): Promise<Deno.FsFile>;
  stat(path: string): Promise<{ size: number }>;
}

/**
 * Default file system using Deno APIs.
 */
export const defaultMediaFileSystem: MediaFileSystem = {
  open: (path) => Deno.open(path, { read: true }),
  stat: async (path) => {
    const info = await Deno.stat(path);
    return { size: info.size };
  },
};

// ============================================================================
// MP4 Parsing
// ============================================================================

/**
 * MP4 atom (box) info.
 */
interface MP4Atom {
  type: string;
  offset: number;
  size: number;
}

/**
 * Read bytes from file at specific offset.
 */
async function readBytesAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  await file.seek(offset, Deno.SeekMode.Start);
  const buffer = new Uint8Array(length);
  const bytesRead = await file.read(buffer);
  if (bytesRead === null || bytesRead < length) {
    throw new Error(`Failed to read ${length} bytes at offset ${offset}`);
  }
  return buffer;
}

/**
 * Read a 32-bit big-endian unsigned integer.
 */
function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * Read a 64-bit big-endian unsigned integer (as number, may lose precision for very large files).
 */
function readUint64BE(data: Uint8Array, offset: number): number {
  const high = readUint32BE(data, offset);
  const low = readUint32BE(data, offset + 4);
  return high * 0x100000000 + low;
}

/**
 * Parse MP4 atom header at given offset.
 * Returns atom type, offset, and size.
 */
async function parseMP4AtomHeader(
  file: Deno.FsFile,
  offset: number,
  fileSize: number,
): Promise<MP4Atom | null> {
  if (offset >= fileSize) {
    return null;
  }

  // Read 8 bytes for standard atom header
  const header = await readBytesAt(file, offset, 8);
  let size = readUint32BE(header, 0);
  const type = String.fromCharCode(header[4], header[5], header[6], header[7]);

  // Handle extended size (size == 1 means 64-bit size follows)
  if (size === 1) {
    const extHeader = await readBytesAt(file, offset + 8, 8);
    size = readUint64BE(extHeader, 0);
  } else if (size === 0) {
    // Size 0 means atom extends to end of file
    size = fileSize - offset;
  }

  return { type, offset, size };
}

/**
 * Find all top-level atoms in an MP4 file.
 */
async function findMP4Atoms(
  file: Deno.FsFile,
  fileSize: number,
): Promise<MP4Atom[]> {
  const atoms: MP4Atom[] = [];
  let offset = 0;

  while (offset < fileSize) {
    const atom = await parseMP4AtomHeader(file, offset, fileSize);
    if (!atom || atom.size <= 0) break;

    atoms.push(atom);
    offset += atom.size;
  }

  return atoms;
}

/**
 * Parse an MP4 file to extract DASH byte ranges.
 *
 * For MP4:
 * - initRange: Start of file to end of moov atom
 * - indexRange: The sidx atom (if present)
 *
 * If sidx is not present (non-fragmented MP4), we return the moov range for both
 * as the player will need to parse moov for seeking info.
 */
export async function parseMP4ForDASH(
  filePath: string,
  fs: MediaFileSystem = defaultMediaFileSystem,
): Promise<MediaParseResult> {
  let file: Deno.FsFile | null = null;

  try {
    const stat = await fs.stat(filePath);
    file = await fs.open(filePath);

    const atoms = await findMP4Atoms(file, stat.size);

    // Find moov and sidx atoms
    let moovAtom: MP4Atom | undefined;
    let sidxAtom: MP4Atom | undefined;

    for (const atom of atoms) {
      if (atom.type === "moov") moovAtom = atom;
      if (atom.type === "sidx") sidxAtom = atom;
    }

    if (!moovAtom) {
      return { ok: false, error: "No moov atom found in MP4 file" };
    }

    // Calculate init range (from start to end of moov)
    const initEnd = moovAtom.offset + moovAtom.size - 1;
    const initRange = `0-${initEnd}`;

    // Calculate index range
    let indexRange: string;

    if (sidxAtom) {
      // Use sidx atom for index range
      const sidxEnd = sidxAtom.offset + sidxAtom.size - 1;
      indexRange = `${sidxAtom.offset}-${sidxEnd}`;
    } else {
      // No sidx - use moov for both (player will parse stbl/stco/stss for seeking)
      // For non-fragmented MP4, the moov contains all seek info
      indexRange = `${moovAtom.offset}-${initEnd}`;
    }

    return {
      ok: true,
      ranges: { initRange, indexRange },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to parse MP4: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (file) {
      try {
        file.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ============================================================================
// WebM/EBML Parsing
// ============================================================================

/**
 * EBML Element IDs we care about.
 * These are variable-length IDs encoded with VINT.
 */
const EBML_IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  Cues: 0x1c53bb6b,
  Cluster: 0x1f43b675,
};

/**
 * Read a variable-length integer (VINT) used in EBML.
 * Returns the value and number of bytes consumed.
 */
function readVINT(data: Uint8Array, offset: number): { value: number; length: number } {
  if (offset >= data.length) {
    throw new Error("VINT offset out of bounds");
  }

  const firstByte = data[offset];
  let length = 1;
  let mask = 0x80;

  // Find the length by counting leading zeros
  while ((firstByte & mask) === 0 && length < 8) {
    mask >>= 1;
    length++;
  }

  if (length > 8) {
    throw new Error("Invalid VINT: too many bytes");
  }

  // Read the value
  let value = firstByte & (mask - 1); // Remove the length marker bit

  for (let i = 1; i < length; i++) {
    if (offset + i >= data.length) {
      throw new Error("VINT extends beyond buffer");
    }
    value = (value << 8) | data[offset + i];
  }

  return { value, length };
}

/**
 * Read an EBML element ID (VINT with the marker bit retained for ID matching).
 */
function readEBMLElementID(data: Uint8Array, offset: number): { id: number; length: number } {
  if (offset >= data.length) {
    throw new Error("Element ID offset out of bounds");
  }

  const firstByte = data[offset];
  let length = 1;
  let mask = 0x80;

  while ((firstByte & mask) === 0 && length < 4) {
    mask >>= 1;
    length++;
  }

  // For element IDs, we keep the full bytes including marker
  let id = firstByte;
  for (let i = 1; i < length; i++) {
    if (offset + i >= data.length) {
      throw new Error("Element ID extends beyond buffer");
    }
    id = (id << 8) | data[offset + i];
  }

  return { id, length };
}

/**
 * EBML element info.
 */
interface EBMLElement {
  id: number;
  offset: number;
  headerSize: number;
  dataSize: number;
  totalSize: number;
}

/**
 * Parse an EBML element header.
 */
function parseEBMLElement(data: Uint8Array, offset: number, fileOffset: number): EBMLElement {
  const { id, length: idLength } = readEBMLElementID(data, offset);
  const { value: dataSize, length: sizeLength } = readVINT(data, offset + idLength);

  const headerSize = idLength + sizeLength;

  return {
    id,
    offset: fileOffset,
    headerSize,
    dataSize,
    totalSize: headerSize + dataSize,
  };
}

/**
 * Parse a WebM file to extract DASH byte ranges.
 *
 * For WebM:
 * - initRange: EBML header + Segment header + SeekHead + Info + Tracks
 * - indexRange: Cues element
 *
 * The initialization data must include everything needed to initialize the decoder.
 * The Cues element contains seek points for the Clusters.
 */
export async function parseWebMForDASH(
  filePath: string,
  fs: MediaFileSystem = defaultMediaFileSystem,
): Promise<MediaParseResult> {
  let file: Deno.FsFile | null = null;

  try {
    const stat = await fs.stat(filePath);
    file = await fs.open(filePath);

    // Read first chunk of file to parse headers
    // Most WebM files have their headers in the first 64KB
    const chunkSize = Math.min(256 * 1024, stat.size);
    const data = await readBytesAt(file, 0, chunkSize);

    let offset = 0;

    // Parse EBML header
    const ebmlElement = parseEBMLElement(data, offset, offset);
    if (ebmlElement.id !== EBML_IDS.EBML) {
      return { ok: false, error: "Not a valid WebM/EBML file" };
    }
    offset += ebmlElement.totalSize;

    // Parse Segment header
    const segmentElement = parseEBMLElement(data, offset, offset);
    if (segmentElement.id !== EBML_IDS.Segment) {
      return { ok: false, error: "No Segment element found" };
    }

    // Move into Segment content
    const segmentDataStart = offset + segmentElement.headerSize;
    offset = segmentDataStart;

    // Find SeekHead, Info, Tracks, and Cues within Segment
    let tracksEnd = 0;
    let cuesStart = 0;
    let cuesEnd = 0;

    // Scan for elements within segment
    const segmentEnd = Math.min(segmentDataStart + segmentElement.dataSize, chunkSize);

    while (offset < segmentEnd - 8) {
      try {
        const element = parseEBMLElement(data, offset, offset);

        if (element.id === EBML_IDS.Tracks) {
          tracksEnd = offset + element.totalSize;
        } else if (element.id === EBML_IDS.Cues) {
          cuesStart = offset;
          cuesEnd = offset + element.totalSize;
        } else if (element.id === EBML_IDS.Cluster) {
          // Stop when we hit first Cluster
          break;
        }

        offset += element.totalSize;
      } catch {
        // Parsing error, stop scanning
        break;
      }
    }

    if (tracksEnd === 0) {
      return { ok: false, error: "No Tracks element found in WebM" };
    }

    // initRange: From start to end of Tracks
    const initRange = `0-${tracksEnd - 1}`;

    // indexRange: Cues element (if found)
    let indexRange: string;
    if (cuesStart > 0 && cuesEnd > cuesStart) {
      indexRange = `${cuesStart}-${cuesEnd - 1}`;
    } else {
      // No Cues found - some WebM files don't have them
      // Use a range that includes up to where we stopped parsing
      indexRange = `${tracksEnd}-${offset - 1}`;
    }

    return {
      ok: true,
      ranges: { initRange, indexRange },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to parse WebM: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (file) {
      try {
        file.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Parse a media file (MP4 or WebM) to extract DASH byte ranges.
 * Automatically detects file type based on extension.
 */
export async function getMediaByteRanges(
  filePath: string,
  fs: MediaFileSystem = defaultMediaFileSystem,
): Promise<MediaParseResult> {
  const ext = filePath.split(".").pop()?.toLowerCase();

  if (ext === "mp4" || ext === "m4a" || ext === "m4v") {
    return parseMP4ForDASH(filePath, fs);
  } else if (ext === "webm") {
    return parseWebMForDASH(filePath, fs);
  } else {
    return { ok: false, error: `Unsupported file extension: ${ext}` };
  }
}

/**
 * Cache for parsed byte ranges to avoid re-parsing files.
 */
const byteRangeCache = new Map<string, DASHByteRanges>();

/**
 * Get byte ranges with caching.
 */
export async function getMediaByteRangesCached(
  filePath: string,
  fs: MediaFileSystem = defaultMediaFileSystem,
): Promise<MediaParseResult> {
  // Check cache first
  const cached = byteRangeCache.get(filePath);
  if (cached) {
    return { ok: true, ranges: cached };
  }

  // Parse file
  const result = await getMediaByteRanges(filePath, fs);

  // Cache successful results
  if (result.ok) {
    byteRangeCache.set(filePath, result.ranges);
  }

  return result;
}

/**
 * Clear the byte range cache (useful for testing or after file changes).
 */
export function clearByteRangeCache(): void {
  byteRangeCache.clear();
}
