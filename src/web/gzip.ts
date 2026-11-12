/**
 * gzip for the live updates: a big message is compressed once and the same bytes go to every panel showing that
 * server, instead of being compressed again for each connection.
 *
 * A message whose start is shared by many panels (a server's whole queue) and whose end is each panel's own (its voice
 * channels, when it subscribes) is compressed in two pieces: the start once, the end for each panel. That works
 * because deflate data can be cut where a piece ends on a byte boundary (a "sync flush"), and pieces compressed on
 * their own can be laid end to end; only the last is marked as the last. The gzip frame around them needs the CRC-32
 * of all the bytes, which is carried on from the start to the end, and their length.
 */
import zlib from 'node:zlib';

// Level 6, zlib's usual: a thousand-track queue (about 350 KB of JSON) becomes about 40 KB in about 2 ms. Made once
// per change and sent to every panel, so the smaller result is worth the time (level 1 is twice as fast, 20 % bigger).
const LEVEL = 6;

// The gzip header (RFC 1952): its magic number, deflate, no flags, no time, no extra flags, an unknown system.
const HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);

/** The start of a message, compressed on its own up to a byte boundary, ready for an end to follow it. */
export interface Start {
  /** Raw deflate data, not marked as the last. */
  readonly deflated: Buffer;
  /** The CRC-32 of the bytes it holds. */
  readonly crc: number;
  /** How many bytes it holds. */
  readonly length: number;
}

/** A whole message as one gzip member, the way the panel's DecompressionStream('gzip') reads it. */
export function gzip(bytes: Buffer): Buffer {
  return zlib.gzipSync(bytes, { level: LEVEL });
}

/** Compresses the start of a message so that endings can be put after it later (see gzipJoined). */
export function compressStart(bytes: Buffer): Start {
  // The CRC first: Node 24's crc32 answers 0 for an empty buffer that deflate has been given (seen in 24.11).
  const crc = zlib.crc32(bytes);
  return {
    // The sync flush ends the data on a byte boundary without marking it the last, so more can follow.
    deflated: zlib.deflateRawSync(bytes, { level: LEVEL, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    crc,
    length: bytes.length,
  };
}

/** One gzip member holding `start` and then `end`: only `end` is compressed now. */
export function gzipJoined(start: Start, end: Buffer): Buffer {
  // The CRC-32 of everything, carried on from the start's (and worked out before deflate sees `end`, see above).
  const crc = end.length === 0 ? start.crc : zlib.crc32(end, start.crc);
  // A whole deflate stream of its own, ending with the block marked as the last.
  const ending = zlib.deflateRawSync(end, { level: LEVEL });
  const trailer = Buffer.alloc(8);
  // The CRC and the length modulo 2^32, both little-endian.
  trailer.writeUInt32LE(crc >>> 0, 0);
  trailer.writeUInt32LE((start.length + end.length) >>> 0, 4);
  return Buffer.concat([HEADER, start.deflated, ending, trailer]);
}
