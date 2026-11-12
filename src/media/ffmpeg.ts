/**
 * ffmpeg: turning downloaded audio into the cached Ogg Opus file, and making streams that start in the middle.
 *
 * The cached file is what the voice connection sends as it is (Discord speaks Opus, so nothing is re-encoded while
 * playing) and what browsers that play Ogg Opus fetch. Loudness is evened out once, when the file is made.
 */
import { spawn } from 'node:child_process';
import { childEnv, lastLines, ProcessError, run, watch } from './process.ts';
import { parseProgress, type YtDlp, ytdlpFailure } from './ytdlp.ts';

// The sound of every cached file: loudness -14 LUFS (streaming services' level) with true peaks under -1 dB and a
// loudness range of 11 LU, a 3 s fade in at the very start, 48 kHz stereo Opus at 128 kbit/s in 20 ms frames (what
// Discord expects), "audio" mode for music rather than speech. print_format=json makes loudnorm report the measured
// loudness, which is kept for the statistics.
const ENCODE = [
  '-vn',
  '-af',
  'loudnorm=I=-14:TP=-1:LRA=11:print_format=json,afade=t=in:d=3',
  '-ar',
  '48000',
  '-ac',
  '2',
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
];

/** What making a cached file measured. */
export interface EncodeResult {
  /** The track's integrated loudness before evening out, in LUFS; null when ffmpeg did not report it. */
  readonly loudness: number | null;
}

/** Finds loudnorm's JSON report at the end of ffmpeg's log and reads the measured input loudness from it. */
export function measuredLoudness(stderr: string): number | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    const report = JSON.parse(stderr.slice(start, end + 1)) as { input_i?: unknown };
    const value = Number(report.input_i);
    // Silence measures as -inf, which is not a loudness worth keeping.
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export class Ffmpeg {
  private readonly binary: string;

  constructor(binary: string) {
    this.binary = binary;
  }

  /** The installed ffmpeg's version line and whether it has the two encoders jukecord uses (for the doctor command). */
  async about(): Promise<{ version: string; opus: boolean; mp3: boolean }> {
    const version = await run(this.binary, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    const encoders = await run(this.binary, ['-hide_banner', '-encoders'], { timeoutMs: 15_000, maxStdout: 1024 ** 2 });
    return {
      // "ffmpeg version 7.1.5 Copyright ..." -> the part before "Copyright".
      version: (version.stdout.split('\n')[0] ?? '').replace(/\s+Copyright.*$/, '').trim(),
      opus: /\blibopus\b/.test(encoders.stdout),
      mp3: /\blibmp3lame\b/.test(encoders.stdout),
    };
  }

  /**
   * Downloads a track with yt-dlp and encodes it into `outFile`, both at once through a pipe.
   *
   * Both processes are watched: if yt-dlp fails halfway, ffmpeg sees the end of its input and would happily write a
   * short file, so yt-dlp's exit is checked as well and its error is the one reported.
   */
  async fromYtDlp(
    ytdlp: YtDlp,
    url: string,
    outFile: string,
    signal: AbortSignal,
    timeoutMs: number,
    onProgress?: (fraction: number) => void,
  ): Promise<EncodeResult> {
    const download = ytdlp.audio(url);
    // yt-dlp prints a progress line per update on stderr; each one is passed on as a fraction.
    if (onProgress && download.stderr) {
      let pending = '';
      download.stderr.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const fraction = parseProgress(line);
          if (fraction !== null) onProgress(fraction);
        }
      });
    }
    // info level (with -nostats) is needed for loudnorm's report; the progress line is left out.
    const encode = spawn(
      this.binary,
      ['-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin', '-i', 'pipe:0', ...ENCODE, '-y', outFile],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: childEnv(),
      },
    );
    // A broken pipe when ffmpeg stops early is expected; the exit codes below say what really happened.
    encode.stdin?.on('error', () => {});
    download.stdout?.on('error', () => {});
    if (download.stdout && encode.stdin) download.stdout.pipe(encode.stdin);
    const options = { signal, timeoutMs };
    const [downloaded, encoded] = await Promise.allSettled([
      watch(download, 'yt-dlp', options),
      watch(encode, 'ffmpeg', options),
    ]);
    // Cancelled or timed out: either rejection carries the reason.
    if (downloaded.status === 'rejected') throw downloaded.reason;
    if (encoded.status === 'rejected') throw encoded.reason;
    if (downloaded.value.code !== 0) {
      throw new ProcessError(ytdlpFailure(downloaded.value.stderr, downloaded.value.code), downloaded.value);
    }
    if (encoded.value.code !== 0) {
      throw new ProcessError(
        `ffmpeg failed: ${lastLines(encoded.value.stderr) || `exit ${encoded.value.code}`}`,
        encoded.value,
      );
    }
    return { loudness: measuredLoudness(encoded.value.stderr) };
  }

  /** Encodes a local file the same way (used by tests and by imports of files people already have). */
  async fromFile(inFile: string, outFile: string, signal: AbortSignal, timeoutMs: number): Promise<EncodeResult> {
    const encode = spawn(
      this.binary,
      ['-hide_banner', '-nostats', '-loglevel', 'info', '-nostdin', '-i', inFile, ...ENCODE, '-y', outFile],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: childEnv(),
      },
    );
    const result = await watch(encode, 'ffmpeg', { signal, timeoutMs });
    if (result.code !== 0)
      throw new ProcessError(`ffmpeg failed: ${lastLines(result.stderr) || `exit ${result.code}`}`, result);
    return { loudness: measuredLoudness(result.stderr) };
  }

  /**
   * Arguments for a stream of `file` starting at `offsetMs`, as Ogg Opus on stdout: what the voice connection plays
   * after a seek. A 0.12 s fade in hides the click of starting in the middle of a sound.
   */
  seekArgs(file: string, offsetMs: number): string[] {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      // -ss before -i seeks in the input (fast), which is exact for Opus because ffmpeg decodes from the page before.
      '-ss',
      (offsetMs / 1000).toFixed(3),
      '-i',
      file,
      '-af',
      'afade=t=in:d=0.12',
      '-ar',
      '48000',
      '-ac',
      '2',
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
      'pipe:1',
    ];
  }

  /** The ffmpeg program, for the outputs that start their own seek streams. */
  get program(): string {
    return this.binary;
  }

  /** Makes an MP3 copy for browsers that cannot play Ogg Opus (Safari's support is incomplete). */
  async toMp3(inFile: string, outFile: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const convert = spawn(
      this.binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        inFile,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-f',
        'mp3',
        '-y',
        outFile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv() },
    );
    const result = await watch(convert, 'ffmpeg', { signal, timeoutMs });
    if (result.code !== 0)
      throw new ProcessError(`ffmpeg failed: ${lastLines(result.stderr) || `exit ${result.code}`}`, result);
  }
}
