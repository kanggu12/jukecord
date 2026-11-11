/**
 * yt-dlp: looking tracks up (title, length, picture) and downloading their audio.
 *
 * yt-dlp needs a JavaScript runtime for YouTube's player code. The image has Node (jukecord runs on it), so yt-dlp is
 * told to use Node instead of Deno, which it would look for by default and which the image does not carry.
 * User and system yt-dlp config files are ignored, so a stray ~/.config/yt-dlp/config cannot change what jukecord does.
 */
import { type ChildProcess, spawn } from 'node:child_process';
// YouTube's bot check is shared with the reasons people are shown (core/reasons.ts).
import { BOT_CHECK } from '../core/reasons.ts';
import type { NewTrack } from '../core/types.ts';
import { lastLines, ProcessError, type RunOptions, type RunResult, run } from './process.ts';
import { canonicalSource, type Input, isPlaylistAddress, youtubeVideoId } from './source.ts';

// WebM/Opus is what YouTube serves best and ffmpeg reads it from a pipe; anything else as a fallback.
const AUDIO_FORMAT = 'bestaudio[ext=webm]/bestaudio/best';

export interface YtDlpOptions {
  /** The yt-dlp program. */
  readonly binary: string;
  /** The JavaScript runtime yt-dlp uses for YouTube ("node", or "node:/path/to/node"). */
  readonly jsRuntime: string;
  /** How long a lookup may take. */
  readonly timeoutMs: number;
  /** The most tracks one playlist adds; a 5,000-track playlist would bury the queue. */
  readonly maxPlaylist: number;
  /** A Netscape cookies file passed to yt-dlp (needed when YouTube asks the server to sign in), or null. */
  readonly cookies?: string | null;
  /**
   * Where yt-dlp keeps what it learns between runs (YouTube's player code and its solved challenges). Without it
   * yt-dlp looks under the home directory, which the image's user does not have, and fetches it all again each time.
   */
  readonly cacheDir?: string | null;
  /** The proxy every connection of yt-dlp goes through (the address guard, egress.ts), or null for none. */
  readonly proxy?: string | null;
}

// Titles YouTube gives entries that cannot be played; they are left out of an added playlist.
const UNPLAYABLE_TITLE = /^\[(private|deleted) video\]$/i;

// Narrowing helpers for yt-dlp's JSON, whose fields vary by site and by version.
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The largest thumbnail of a flat playlist entry (they come as a list, smallest first).
function lastThumbnail(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const url = text(record(value[index])?.url);
    if (url) return url;
  }
  return null;
}

/**
 * Turns one entry of yt-dlp's JSON (a video, or a flat playlist entry) into a track, or null when it cannot be
 * played: private or deleted, live or upcoming (a stream with no end would hold the queue), or without an address.
 */
export function trackFromEntry(entry: Record<string, unknown>): NewTrack | null {
  const id = text(entry.id);
  // A flat YouTube entry may have only an ID; build its address from it.
  const page =
    text(entry.webpage_url) ??
    text(entry.url) ??
    (entry.ie_key === 'Youtube' && id ? `https://www.youtube.com/watch?v=${id}` : null);
  if (!page) return null;
  const title = text(entry.title);
  if (!title || UNPLAYABLE_TITLE.test(title)) return null;
  if (entry.is_live === true || entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') return null;
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return null;
  }
  // Only web pages: an entry pointing at file:, data: or javascript: is not something to fetch or to link to.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const source = canonicalSource(url);
  const seconds = number(entry.duration);
  return {
    source,
    // YouTube addresses are shown in their clean form; other sites keep the page address they gave.
    url: youtubeVideoId(url) ? source : page,
    title: title.trim(),
    uploader: text(entry.uploader) ?? text(entry.channel) ?? text(entry.artist) ?? null,
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    thumbnail: text(entry.thumbnail) ?? lastThumbnail(entry.thumbnails),
  };
}

/** Turns yt-dlp's -J output (one video, a playlist, or search results) into tracks, at most `limit` of them. */
export function tracksFromInfo(info: unknown, limit: number): NewTrack[] {
  const root = record(info);
  if (!root) return [];
  // Playlists and searches have entries; a single video is the root itself.
  const entries = Array.isArray(root.entries) ? root.entries : [root];
  const tracks: NewTrack[] = [];
  for (const entry of entries) {
    const item = record(entry);
    const track = item ? trackFromEntry(item) : null;
    if (track) tracks.push(track);
    if (tracks.length >= limit) break;
  }
  return tracks;
}

// The progress line yt-dlp is asked to print: a marker, bytes so far, total bytes, and the estimate when the total is
// not known yet ("NA" for missing values).
export const PROGRESS_TEMPLATE =
  'download:[jukecord-progress] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s';

/** Reads one of those lines into a fraction from 0 to 1, or null for any other line. */
export function parseProgress(line: string): number | null {
  const match = /\[jukecord-progress\] (\S+) (\S+) (\S+)/.exec(line);
  if (!match) return null;
  const done = Number(match[1]);
  // The real total when the site gave one, otherwise yt-dlp's estimate.
  const total = Number(match[2]) || Number(match[3]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(1, done / total);
}

// What YouTube says when it wants this address to sign in before serving it.

/** The message for a failed yt-dlp run: its last lines, or what to do when YouTube is asking for a sign-in. */
export function ytdlpFailure(stderr: string, code: number | null): string {
  if (BOT_CHECK.test(stderr)) {
    return 'YouTube asks this server to sign in to prove it is not a bot; give jukecord a cookies file (JUKECORD_YTDLP_COOKIES)';
  }
  return `yt-dlp failed: ${lastLines(stderr) || `exit ${code}`}`;
}

// run() for yt-dlp, with its failures explained (see ytdlpFailure).
async function runExplained(binary: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  try {
    return await run(binary, args, options);
  } catch (error) {
    if (error instanceof ProcessError && error.result && error.result.code !== 0 && error.result.signal === null) {
      throw new ProcessError(ytdlpFailure(error.result.stderr, error.result.code), error.result);
    }
    throw error;
  }
}

export class YtDlp {
  private readonly options: YtDlpOptions;

  constructor(options: YtDlpOptions) {
    this.options = options;
  }

  // Arguments every run shares: no config files, no warnings in the output we parse, Node as the JS runtime.
  private common(): string[] {
    const args = ['--ignore-config', '--no-warnings', '--js-runtimes', this.options.jsRuntime];
    if (this.options.cacheDir) args.push('--cache-dir', this.options.cacheDir);
    // Redirects, playlist entries and the media itself go through the guard, which connects to public addresses only.
    if (this.options.proxy) args.push('--proxy', this.options.proxy);
    // The cookies of a signed-in browser get past YouTube's bot check on a server it distrusts.
    if (this.options.cookies) args.push('--cookies', this.options.cookies);
    return args;
  }

  /** The installed yt-dlp version, for the doctor command and the update check. */
  async version(signal?: AbortSignal): Promise<string> {
    const result = await run(this.options.binary, ['--version'], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
    return result.stdout.trim();
  }

  /**
   * Looks up what an input adds: one track for a video or a search, all of them (up to the limit) for a playlist.
   * Flat listing keeps a 300-track playlist to one request instead of 300.
   */
  async lookup(input: Input, signal?: AbortSignal): Promise<NewTrack[]> {
    const args = [...this.common(), '-J', '--flat-playlist', '--playlist-end', String(this.options.maxPlaylist)];
    if (input.kind === 'search') {
      // The first result only: a search that adds ten tracks surprises people.
      args.push(`ytsearch1:${input.query}`);
    } else {
      // A video address with list= is that one video; only real playlist pages add the whole list.
      if (!isPlaylistAddress(input.url)) args.push('--no-playlist');
      args.push(input.url.href);
    }
    const result = await runExplained(this.options.binary, args, {
      timeoutMs: this.options.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    let info: unknown;
    try {
      info = JSON.parse(result.stdout);
    } catch {
      throw new ProcessError('yt-dlp printed something that is not JSON', result);
    }
    const tracks = tracksFromInfo(info, this.options.maxPlaylist);
    if (tracks.length === 0) {
      throw new ProcessError(input.kind === 'search' ? 'nothing was found' : 'there is nothing playable there', result);
    }
    return tracks;
  }

  /**
   * Downloads a track's best audio (the same choice as audio()) into a file. For the few files ffmpeg cannot read as
   * they arrive, an MP4 whose index comes at its end: ffmpeg then reads it from the disk, where it can look ahead.
   */
  async audioToFile(url: string, file: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const args = [
      ...this.common(),
      '--format',
      AUDIO_FORMAT,
      '--no-playlist',
      // Straight into the file named, with no progress on stdout (which would only fill the output buffer).
      '--no-part',
      '--force-overwrites',
      '--quiet',
      '--no-progress',
      '--output',
      file,
      url,
    ];
    try {
      await run(this.options.binary, args, { signal, timeoutMs });
    } catch (error) {
      // The same short reason as a failed stream gives (a removed video, YouTube's bot check ...).
      if (error instanceof ProcessError && error.result) {
        throw new ProcessError(ytdlpFailure(error.result.stderr, error.result.code), error.result);
      }
      throw error;
    }
  }

  /**
   * Starts downloading a track's best audio to stdout. The caller pipes stdout into ffmpeg and watches both
   * processes (see ffmpeg.ts); keeping the download in a pipe means no second temporary file.
   */
  audio(url: string): ChildProcess {
    const args = [
      ...this.common(),
      '--format',
      AUDIO_FORMAT,
      '--no-playlist',
      // One progress line per update on stderr (stdout carries the audio), in a form parseProgress reads.
      '--progress',
      '--newline',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--output',
      '-',
      url,
    ];
    // Its own process group, so a kill ends what yt-dlp started too (ffmpeg, for sites that stream in pieces).
    return spawn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  }
}
