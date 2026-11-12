/**
 * The voice channel's sound with the real ffmpeg: each preset's curve as ffmpeg makes it is the Audio EQ Cookbook's,
 * which is what the browsers' BiquadFilterNode computes (so a browser listening along hears the same), and a stream
 * with a sound starts where it was asked, within moments.
 *
 * Skipped when ffmpeg is not installed; the container image and CI always have it.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { PRESET_STAGES, type SoundPreset, type SoundStage } from '../../src/core/sound.ts';
import { Ffmpeg, soundFilters } from '../../src/media/ffmpeg.ts';
import { oggOpusDurationMs } from '../../src/media/ogg.ts';

const FFMPEG = process.env.JUKECORD_FFMPEG ?? 'ffmpeg';
const run = promisify(execFile);

// Whether ffmpeg with the Opus encoder is here.
function haveFfmpeg(): boolean {
  try {
    return execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libopus');
  } catch {
    return false;
  }
}

// A step's gain at a frequency, in dB, by the Audio EQ Cookbook (shelves of slope 1, a peak by its Q), at 48 kHz.
function stageGain(stage: SoundStage, hz: number): number {
  if (stage.kind === 'gain') return stage.db;
  const rate = 48_000;
  const A = 10 ** (stage.db / 40);
  const w0 = (2 * Math.PI * stage.hz) / rate;
  const cos = Math.cos(w0);
  let b: [number, number, number];
  let a: [number, number, number];
  if (stage.kind === 'peaking') {
    const alpha = Math.sin(w0) / (2 * stage.q);
    b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
    a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else {
    const alpha = Math.sin(w0) / Math.SQRT2;
    const root = 2 * Math.sqrt(A) * alpha;
    if (stage.kind === 'lowshelf') {
      b = [A * (A + 1 - (A - 1) * cos + root), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - root)];
      a = [A + 1 + (A - 1) * cos + root, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - root];
    } else {
      b = [A * (A + 1 + (A - 1) * cos + root), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - root)];
      a = [A + 1 - (A - 1) * cos + root, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - root];
    }
  }
  // |H(e^jw)|² of a biquad at the frequency asked.
  const w = (2 * Math.PI * hz) / rate;
  const power = ([c0, c1, c2]: [number, number, number]) =>
    c0 * c0 + c1 * c1 + c2 * c2 + 2 * (c0 * c1 + c1 * c2) * Math.cos(w) + 2 * c0 * c2 * Math.cos(2 * w);
  return 10 * Math.log10(power(b) / power(a));
}

// The mean level of a tone after some filters, as ffmpeg measures it (the first second, where filters settle, left out).
async function level(hz: number, filters: readonly string[]): Promise<number> {
  const chain = [`sine=frequency=${hz}:sample_rate=48000:duration=3`, ...filters, 'atrim=start=1', 'volumedetect'];
  // A source filter, not -f lavfi, so the image's FFmpeg (built without devices) runs it too.
  const { stderr } = await run(FFMPEG, [
    '-hide_banner',
    '-nostats',
    '-filter_complex',
    chain.join(','),
    '-f',
    'null',
    '-',
  ]);
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1];
  if (mean === undefined) throw new Error(`no level for ${hz} Hz: ${stderr.slice(-300)}`);
  return Number(mean);
}

describe('the voice sound with the real ffmpeg', {
  skip: !haveFfmpeg() && 'ffmpeg with libopus is not installed',
}, () => {
  let dir = '';
  let track = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-sound-'));
    track = path.join(dir, 'track.opus');
    // Six seconds of noise as the cache keeps a track (Ogg Opus, 48 kHz stereo), made here so the repository carries
    // no audio file.
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-filter_complex',
      'anoisesrc=d=6:c=pink:a=0.3:sample_rate=48000',
      '-ac',
      '2',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-f',
      'ogg',
      '-y',
      track,
    ]);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("makes each preset's curve as the cookbook has it, which is the browsers' own, within a tenth of a dB", async () => {
    const frequencies = [50, 100, 200, 1000, 2800, 5000, 10_000];
    const plain = await Promise.all(frequencies.map((hz) => level(hz, [])));
    const presets = (Object.keys(PRESET_STAGES) as SoundPreset[]).filter((preset) => preset !== 'off');
    for (const preset of presets) {
      const measured = await Promise.all(frequencies.map((hz) => level(hz, soundFilters({ volume: 100, preset }))));
      frequencies.forEach((hz, index) => {
        const expected = PRESET_STAGES[preset].reduce((sum, stage) => sum + stageGain(stage, hz), 0);
        const got = (measured[index] ?? 0) - (plain[index] ?? 0);
        // volumedetect says a level to a tenth of a dB.
        assert.ok(
          Math.abs(got - expected) <= 0.15,
          `${preset} at ${hz} Hz: ${got.toFixed(2)} dB, the cookbook's ${expected.toFixed(2)}`,
        );
      });
    }
  });

  it('starts a stream with a sound at the place asked, its first sound within moments', async () => {
    const ffmpeg = new Ffmpeg(FFMPEG);
    const out = path.join(dir, 'out.opus');
    const started = performance.now();
    const child = spawn(FFMPEG, ffmpeg.soundArgs(track, 2500, { volume: 150, preset: 'bass' }, true), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    // The first page of sound is the third Ogg page (after the stream's two header pages).
    let firstSoundMs: number | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (firstSoundMs !== null) return;
      const pages = Buffer.concat(chunks).toString('latin1').split('OggS').length - 1;
      if (pages >= 3) firstSoundMs = performance.now() - started;
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    fs.writeFileSync(out, Buffer.concat(chunks));
    // The rest of the track from where it was asked: 6 s less 2.5 s.
    assert.ok(Math.abs((await oggOpusDurationMs(out)) - 3500) <= 60, `${await oggOpusDurationMs(out)} ms`);
    assert.ok(firstSoundMs !== null && firstSoundMs < 1000, `the first sound came after ${firstSoundMs} ms`);
  });
});
