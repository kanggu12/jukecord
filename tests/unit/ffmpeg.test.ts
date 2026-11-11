import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ffmpeg, measuredLoudness } from '../../src/media/ffmpeg.ts';

describe('measuredLoudness', () => {
  it("reads the input loudness from loudnorm's report at the end of the log", () => {
    const log = `Input #0, matroska,webm, from 'pipe:0':\n  Duration: N/A\n[Parsed_loudnorm_0 @ 0x55]\n{\n\t"input_i" : "-9.87",\n\t"input_tp" : "-0.12",\n\t"target_offset" : "0.10"\n}\n`;
    assert.equal(measuredLoudness(log), -9.87);
  });

  it('gives null for silence and for a log without a report', () => {
    assert.equal(measuredLoudness('{ "input_i" : "-inf" }'), null);
    assert.equal(measuredLoudness('no report here'), null);
  });
});

describe('Ffmpeg.seekArgs', () => {
  it('seeks in the input, fades in briefly and writes Opus in Ogg to stdout', () => {
    const args = new Ffmpeg('ffmpeg').seekArgs('/cache/a.opus', 90_500);
    const at = args.indexOf('-ss');
    assert.equal(args[at + 1], '90.500');
    // -ss must come before -i to seek in the input.
    assert.ok(at < args.indexOf('-i'));
    assert.ok(args.includes('afade=t=in:d=0.12'));
    assert.deepEqual(args.slice(-3), ['-f', 'ogg', 'pipe:1']);
  });
});
