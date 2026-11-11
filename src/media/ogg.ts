/**
 * Reading the length of an Ogg Opus file from the file itself, without starting ffprobe.
 *
 * Every Ogg page carries a granule position; in Opus it counts 48 kHz samples from the start of the stream,
 * including the decoder's "pre-skip" (samples to drop before the audio starts), which the first packet (OpusHead)
 * states. The length is therefore (last granule position - pre-skip) / 48000. Reading the head and the last 64 KiB of
 * the file is enough: an Ogg page is at most about 64 KiB.
 */
import fs from 'node:fs/promises';

// Every Ogg page starts with these four bytes.
const CAPTURE = Buffer.from('OggS', 'latin1');
// The first packet of an Opus stream starts with this, followed by version, channels and the pre-skip (LE16 at 10).
const OPUS_HEAD = Buffer.from('OpusHead', 'latin1');
// Ogg page header: "OggS"(4) version(1) type(1) granule(8, at offset 6) ...
const GRANULE_OFFSET = 6;

/** The playable length of an Ogg Opus file in milliseconds. */
export async function oggOpusDurationMs(file: string): Promise<number> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    // The OpusHead packet sits in the first page, well inside the first 4 KiB.
    const head = Buffer.alloc(Math.min(4096, size));
    await handle.read(head, 0, head.length, 0);
    const at = head.indexOf(OPUS_HEAD);
    if (at === -1 || at + 12 > head.length) throw new Error(`${file} is not an Ogg Opus file`);
    const preSkip = head.readUInt16LE(at + 10);
    // The last page holds the final granule position; scan back from the end for the last capture pattern.
    const length = Math.min(65_536 + 27, size);
    const end = Buffer.alloc(length);
    await handle.read(end, 0, length, size - length);
    // The last capture pattern whose header fits in what we read is the last page's header.
    let page = end.lastIndexOf(CAPTURE);
    while (page !== -1 && page + GRANULE_OFFSET + 8 > end.length) page = end.lastIndexOf(CAPTURE, page - 1);
    if (page === -1) throw new Error(`${file} has no Ogg page near its end`);
    const granule = end.readBigUInt64LE(page + GRANULE_OFFSET);
    // An all-ones granule means "no packet ends on this page"; a file that ends that way is cut short.
    if (granule === 0xffffffffffffffffn) throw new Error(`${file} ends in the middle of a packet`);
    const samples = Number(granule) - preSkip;
    return Math.max(0, Math.round(samples / 48));
  } finally {
    await handle.close();
  }
}
