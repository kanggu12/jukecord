import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { oggOpusDurationMs } from '../../src/media/ogg.ts';

// One Ogg page: header (27 bytes + segment table) and its payload; only the fields the reader looks at are real.
function page(granule: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(27 + 1);
  header.write('OggS', 0, 'latin1');
  header.writeBigUInt64LE(granule, 6);
  header[26] = 1;
  header[27] = payload.length;
  return Buffer.concat([header, payload]);
}

// An OpusHead packet with the given pre-skip (bytes 10-11).
function opusHead(preSkip: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 2;
  head.writeUInt16LE(preSkip, 10);
  return head;
}

function withFile(content: Buffer, check: (file: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-ogg-'));
  const file = path.join(dir, 'a.opus');
  fs.writeFileSync(file, content);
  return check(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe('oggOpusDurationMs', () => {
  it('reads the last granule position minus the pre-skip', async () => {
    // 10 s of 48 kHz audio plus the usual 312-sample pre-skip; a filler page in between.
    const content = Buffer.concat([
      page(0n, opusHead(312)),
      page(48_000n, Buffer.alloc(200)),
      page(480_312n, Buffer.alloc(100)),
    ]);
    await withFile(content, async (file) => {
      assert.equal(await oggOpusDurationMs(file), 10_000);
    });
  });

  it('refuses a file that is not Ogg Opus', async () => {
    await withFile(Buffer.from('ID3 not an ogg file at all'), async (file) => {
      await assert.rejects(oggOpusDurationMs(file), /not an Ogg Opus file/);
    });
  });
});
