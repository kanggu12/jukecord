import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { compressStart, gzip, gzipJoined } from '../../src/web/gzip.ts';

// What the panel does with a binary frame: the browser's own gzip reader (Node has the same one).
async function unpack(bytes: Buffer): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

describe('gzip for live messages', () => {
  it('joins a start compressed once with endings compressed one by one into gzip a browser reads', async () => {
    // A queue-like start, large enough to span several deflate blocks, and two different endings after it.
    const start = Buffer.from(
      `{"v":1,"guild":"local","queue":${JSON.stringify({
        items: Array.from({ length: 2000 }, (_, index) => ({ id: index, title: `Track number ${index}` })),
        version: 7,
      })}`,
    );
    const compressed = compressStart(start);
    for (const ending of [',"type":"queue"}', ',"type":"state","voice":{"current":null,"channels":[]}}']) {
      const joined = gzipJoined(compressed, Buffer.from(ending));
      const whole = `${start.toString()}${ending}`;
      // zlib checks the CRC and the length in the trailer; the browser's reader gives the same text.
      assert.equal(zlib.gunzipSync(joined).toString(), whole);
      assert.equal(await unpack(joined), whole);
      assert.equal(JSON.parse(whole).queue.items.length, 2000);
      // Joining costs almost nothing in size against compressing the whole message at once.
      assert.ok(joined.length < gzip(Buffer.from(whole)).length * 1.05);
    }
  });

  it('handles an empty ending and a whole message', async () => {
    const compressed = compressStart(Buffer.from('{"a":1}'));
    assert.equal(zlib.gunzipSync(gzipJoined(compressed, Buffer.alloc(0))).toString(), '{"a":1}');
    assert.equal(await unpack(gzip(Buffer.from('{"b":2}'))), '{"b":2}');
  });
});
