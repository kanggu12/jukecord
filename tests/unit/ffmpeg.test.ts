import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ffmpeg, measuredLoudness, soundFilters } from '../../src/media/ffmpeg.ts';

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

describe('the voice sound as ffmpeg filters', () => {
  it('turns each preset into the cookbook filters ffmpeg shares with the browsers, then the volume', () => {
    assert.deepEqual(soundFilters({ volume: 100, preset: 'off' }), []);
    assert.deepEqual(soundFilters({ volume: 100, preset: 'bass' }), ['volume=-4dB', 'lowshelf=f=100:g=5:t=s:w=1']);
    assert.deepEqual(soundFilters({ volume: 100, preset: 'voices' }), [
      'volume=-3dB',
      'lowshelf=f=180:g=-3:t=s:w=1',
      'equalizer=f=2800:t=q:w=0.9:g=4',
    ]);
    assert.deepEqual(soundFilters({ volume: 80, preset: 'bright' }), [
      'volume=-3dB',
      'highshelf=f=5000:g=4:t=s:w=1',
      'volume=0.80',
    ]);
    // Above full volume, a limiter at -1 dB, without its own levelling.
    assert.deepEqual(soundFilters({ volume: 150, preset: 'off' }), ['volume=1.50', 'alimiter=limit=0.891:level=0']);
  });

  it('streams from the place asked, with the fade of a seek only when asked for it', () => {
    const ffmpeg = new Ffmpeg('ffmpeg');
    const fromMiddle = ffmpeg.soundArgs('/cache/a.opus', 61_250, { volume: 120, preset: 'night' }, true);
    assert.ok(fromMiddle.indexOf('-ss') < fromMiddle.indexOf('-i'));
    assert.equal(fromMiddle[fromMiddle.indexOf('-ss') + 1], '61.250');
    const chain = fromMiddle[fromMiddle.indexOf('-af') + 1] ?? '';
    assert.match(chain, /^afade=t=in:d=0\.12,lowshelf=f=200:g=-6/);
    assert.match(chain, /volume=1\.20,alimiter=/);
    assert.deepEqual(fromMiddle.slice(-3), ['-f', 'ogg', 'pipe:1']);
    // From the top: no seek, and no fade (the cached file fades in by itself).
    const fromStart = ffmpeg.soundArgs('/cache/a.opus', 0, { volume: 100, preset: 'bass' }, false);
    assert.equal(fromStart.includes('-ss'), false);
    assert.equal(fromStart[fromStart.indexOf('-af') + 1], 'volume=-4dB,lowshelf=f=100:g=5:t=s:w=1');
  });
});
