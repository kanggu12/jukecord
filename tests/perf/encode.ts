/**
 * How long one four-minute track takes to become a cached track: its loudness evened out and the sound encoded as
 * Opus, by jukecord's own ffmpeg command. The input is made here, a tone over pink noise in WebM Opus at 160 kbit/s
 * (what YouTube's best audio usually is), so nothing is fetched. The median of three runs. tests/perf/measure.sh runs
 * it inside the image.
 *
 *   node tests/perf/encode.ts <scratch directory>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Ffmpeg } from '../../src/media/ffmpeg.ts';

const scratch = path.resolve(process.argv[2] ?? '/tmp');
const input = path.join(scratch, 'four-minutes.webm');
// The image's FFmpeg has no input devices, so the sound comes from filter sources.
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-filter_complex',
  'anoisesrc=d=240:c=pink:a=0.2[n];sine=f=330:d=240[s];[n][s]amix=inputs=2,aformat=channel_layouts=stereo[a]',
  '-map',
  '[a]',
  '-c:a',
  'libopus',
  '-b:a',
  '160k',
  input,
]);
const ffmpeg = new Ffmpeg('ffmpeg');
const times: number[] = [];
for (let run = 0; run < 3; run += 1) {
  const output = path.join(scratch, `encoded-${run}.opus`);
  const started = performance.now();
  // The command every cached track goes through: loudness evened out, a fade in, Opus at 128 kbit/s.
  await ffmpeg.fromFile(input, output, new AbortController().signal, 600_000);
  times.push(performance.now() - started);
  fs.rmSync(output);
}
fs.rmSync(input);
times.sort((a, b) => a - b);
console.log(
  `a four-minute track, loudness evened out and encoded: ${((times[1] ?? 0) / 1000).toFixed(1)} s (median of 3)`,
);
