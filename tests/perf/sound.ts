/**
 * What the voice channel's sound costs: a four-minute track streamed as the voice output streams it, plain (the cached
 * file sent as it is, which runs no ffmpeg at all), from the middle (ffmpeg decodes and encodes it again, as after a
 * seek), and with a sound (ffmpeg decodes, filters and encodes: a preset, and a preset above full volume, the limiter
 * too). Each is timed twice: by ffmpeg's own -benchmark, the processor time it took for the four minutes as fast as
 * it goes, and for a minute read at the pace the voice channel takes it (see paced). Also how long a stream with a
 * sound takes from its start to its first sound (the gap a change of volume or preset leaves), the median of five. The
 * input is made here, a tone over pink noise encoded as the cache keeps a track (Ogg Opus, 128 kbit/s, 20 ms frames).
 *
 *   node tests/perf/sound.ts <scratch directory>
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import type { Sound } from '../../src/core/sound.ts';
import { Ffmpeg } from '../../src/media/ffmpeg.ts';

const scratch = path.resolve(process.argv[2] ?? '/tmp');
const program = process.env.JUKECORD_FFMPEG ?? 'ffmpeg';
const track = path.join(scratch, 'four-minutes.opus');
// The image's FFmpeg has no input devices, so the sound comes from filter sources.
execFileSync(program, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-filter_complex',
  'anoisesrc=d=240:c=pink:a=0.2[n];sine=f=330:d=240[s];[n][s]amix=inputs=2,aformat=channel_layouts=stereo[a]',
  '-map',
  '[a]',
  '-ar',
  '48000',
  '-c:a',
  'libopus',
  '-b:a',
  '128k',
  '-frame_duration',
  '20',
  '-application',
  'audio',
  '-f',
  'ogg',
  track,
]);
const ffmpeg = new Ffmpeg(program);
// The clock ticks /proc counts processor time in.
const TICKS = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());

// ffmpeg's -benchmark line, "bench: utime=1.234s stime=0.012s rtime=1.300s", as processor and real seconds.
function benchmark(args: string[]): { cpu: number; real: number } {
  const measured = [...args];
  const at = measured.indexOf('-loglevel');
  measured.splice(at, 2, '-loglevel', 'info', '-nostats', '-benchmark');
  // Encoded as for the voice channel, and thrown away.
  measured.splice(measured.length - 1, 1, '-y', '/dev/null');
  const child = spawnSyncText(measured);
  const line = /utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(child);
  if (!line) throw new Error(`no benchmark line: ${child.slice(-300)}`);
  return { cpu: Number(line[1]) + Number(line[2]), real: Number(line[3]) };
}

// Runs ffmpeg and returns what it wrote on stderr (where -benchmark writes).
function spawnSyncText(args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-300)}`);
  return result.stderr;
}

// The processor time ffmpeg takes for `seconds` of a stream read at the voice channel's pace: its Ogg pages split
// into packets by the same demuxer @discordjs/voice uses, one packet taken each 20 ms as its player takes them, the
// rest held back in the pipe (ffmpeg waits while it is full). Read from /proc, in seconds.
async function paced(args: string[], seconds: number): Promise<number> {
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const demuxer = new prism.opus.OggDemuxer();
  child.stdout.pipe(demuxer);
  const timer = setInterval(() => demuxer.read(), 20);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(timer);
  // utime and stime: the 14th and 15th fields, counted after the program's name in parentheses.
  const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  child.kill('SIGKILL');
  return ticks / TICKS;
}

// How long a stream takes from its start to its first sound: the third Ogg page (after the two header pages).
async function firstSound(args: string[]): Promise<number> {
  const started = performance.now();
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      if (text.split('OggS').length - 1 < 3) return;
      resolve(performance.now() - started);
      child.kill('SIGKILL');
    });
    child.on('error', reject);
  });
}

const cases: [string, string[]][] = [
  ['from the middle (a seek: decoded and encoded again)', ffmpeg.seekArgs(track, 60_000)],
  ['more bass', ffmpeg.soundArgs(track, 0, { volume: 100, preset: 'bass' } satisfies Sound, false)],
  ['softer at night at 80 %', ffmpeg.soundArgs(track, 0, { volume: 80, preset: 'night' }, false)],
  ['clearer voices at 150 % (the limiter too)', ffmpeg.soundArgs(track, 0, { volume: 150, preset: 'voices' }, false)],
];
console.log(`ffmpeg: ${execFileSync(program, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]}`);
console.log('plain from the top: the cached file as it is, no ffmpeg (0 % of a core)');
for (const [name, args] of cases) {
  const fast = benchmark(args);
  // Four minutes of sound (three for the seek) as fast as it goes, and a minute at the voice channel's pace.
  const seconds = name.startsWith('from the middle') ? 180 : 240;
  const minute = await paced(args, 60);
  console.log(
    `${name}: ${((fast.cpu / seconds) * 1000).toFixed(1)} ms of processor per second of sound as fast as it goes; ` +
      `${((minute / 60) * 100).toFixed(2)} % of one core at the voice channel's pace`,
  );
}
const gaps: number[] = [];
for (let run = 0; run < 5; run += 1)
  gaps.push(await firstSound(ffmpeg.soundArgs(track, 90_000, { volume: 120, preset: 'bass' }, true)));
gaps.sort((a, b) => a - b);
console.log(`a stream with a sound, from its start to its first sound: ${Math.round(gaps[2] ?? 0)} ms (median of 5)`);
fs.rmSync(track);
