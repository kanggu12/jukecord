/**
 * Getting a track ready to play: from the cache when it is there, otherwise downloaded and encoded into the cache.
 *
 * Two callers asking for the same track (the player and the prefetcher, typically) share one download. The download
 * is cancelled only when every caller has given up on it, so a skipped track that the prefetcher still wants keeps
 * downloading, and a track nobody wants any more stops at once.
 */
import fs from 'node:fs';
import { fetchLimitMs, type MediaPreparer, type PreparedMedia } from '../core/player.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { TrackRepository } from '../store/store.ts';
import { BusyError } from './busy.ts';
import { MediaCache } from './cache.ts';
import type { Ffmpeg } from './ffmpeg.ts';
import { oggOpusDurationMs } from './ogg.ts';
import type { YtDlp } from './ytdlp.ts';

export interface MediaOptions {
  readonly cache: MediaCache;
  readonly ytdlp: YtDlp;
  readonly ffmpeg: Ffmpeg;
  readonly tracks: TrackRepository;
  readonly log: Logger;
  /** How long one download and encode may take. */
  readonly timeoutMs: number;
}

// A download in progress, shared by everyone waiting for the same track.
interface Job {
  promise: Promise<PreparedMedia>;
  readonly abort: AbortController;
  waiters: number;
  /** Everyone who wants to hear about the download's progress. */
  readonly listeners: Set<(fraction: number) => void>;
}

// Failures worth one more try: the network or the site stumbled, not "this video does not exist".
const TRANSIENT =
  /HTTP Error 5\d\d|timed out|Connection reset|Temporary failure|Remote end closed|IncompleteRead|Read timed out/i;

// Waits `ms` unless the download is cancelled meanwhile.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      },
      { once: true },
    );
  });
}

// A promise that rejects when `signal` aborts, so one caller can stop waiting without stopping a shared download.
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('cancelled'));
    else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
}

export class Media implements MediaPreparer {
  private readonly options: MediaOptions;
  private readonly jobs = new Map<string, Job>();
  // MP3 copies being made, so two Safari listeners do not start two conversions.
  private readonly mp3Jobs = new Map<string, Promise<string>>();

  constructor(options: MediaOptions) {
    this.options = options;
  }

  /** The cache this preparer fills (the web layer serves files from it). */
  get cache(): MediaCache {
    return this.options.cache;
  }

  async prepare(track: Track, signal: AbortSignal, onProgress?: (fraction: number) => void): Promise<PreparedMedia> {
    const key = MediaCache.keyOf(track.source);
    const cached = this.options.cache.get(key);
    if (cached) return { file: this.options.cache.opusPath(key), durationMs: cached.durationMs };
    let job = this.jobs.get(key);
    // A download being stopped (everyone left it) is not joined: it can only end in "cancelled". A new one starts.
    if (!job || job.abort.signal.aborted) {
      job = this.start(track, key);
      this.jobs.set(key, job);
    }
    const shared = job;
    shared.waiters += 1;
    if (onProgress) shared.listeners.add(onProgress);
    // When this caller gives up, it stops waiting; the download stops only if it was the last one waiting, and then
    // it leaves the list at once, so the next caller for the same track starts afresh instead of joining it.
    const leave = (): void => {
      shared.waiters -= 1;
      if (shared.waiters > 0) return;
      shared.abort.abort();
      if (this.jobs.get(key) === shared) this.jobs.delete(key);
    };
    signal.addEventListener('abort', leave, { once: true });
    try {
      return await Promise.race([shared.promise, whenAborted(signal)]);
    } finally {
      signal.removeEventListener('abort', leave);
      if (onProgress) shared.listeners.delete(onProgress);
      // A caller that got its answer is no longer waiting either.
      if (!signal.aborted) shared.waiters -= 1;
    }
  }

  // Downloads and encodes one track into the cache.
  private start(track: Track, key: string): Job {
    const abort = new AbortController();
    const cache = this.options.cache;
    const tmp = cache.tmpPath(key);
    const listeners = new Set<(fraction: number) => void>();
    // The job exists before its work starts, so the work can tell whether the list still points at it when it ends.
    const job: Job = { promise: Promise.reject(new Error('not started')), abort, waiters: 0, listeners };
    job.promise.catch(() => {});
    // Progress goes to everyone waiting; a listener that throws must not break the download.
    const report = (fraction: number): void => {
      for (const listener of listeners) {
        try {
          listener(fraction);
        } catch {
          // Progress is a display; ignore.
        }
      }
    };
    const promise = (async (): Promise<PreparedMedia> => {
      const started = Date.now();
      try {
        // One retry after 2 s for a transient failure (see TRANSIENT); anything else fails at once.
        let loudness: number | null = null;
        for (let attempt = 1; ; attempt += 1) {
          try {
            ({ loudness } = await this.options.ffmpeg.fromYtDlp(
              this.options.ytdlp,
              track.url,
              tmp,
              abort.signal,
              // The same limit as the player's: longer for long tracks (see fetchLimitMs).
              fetchLimitMs(this.options.timeoutMs, track.durationMs),
              report,
            ));
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt > 1 || abort.signal.aborted || !TRANSIENT.test(message)) throw error;
            this.options.log.info('retrying a download after a transient failure', {
              title: track.title,
              reason: message,
            });
            await pause(2000, abort.signal);
          }
        }
        // The real length comes from the file: sites round, and some say nothing.
        const durationMs = await oggOpusDurationMs(tmp);
        if (durationMs < 500) throw new Error('the downloaded audio is empty');
        cache.commit(key, tmp, { source: track.source, durationMs, loudness });
        if (loudness !== null) this.options.tracks.setLoudness(track.id, loudness);
        this.options.log.info('cached a track', {
          title: track.title,
          seconds: Math.round(durationMs / 1000),
          took: `${((Date.now() - started) / 1000).toFixed(1)} s`,
        });
        return { file: cache.opusPath(key), durationMs };
      } catch (error) {
        // A half-written file is useless and counts against the disk; remove it whatever went wrong.
        fs.rmSync(tmp, { force: true });
        throw error;
      } finally {
        // Only this job's own entry: a newer download of the same track may have taken its place.
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      }
    })();
    // Nobody may be waiting when it fails (everyone left); the rejection is handled here so it is not "unhandled".
    promise.catch(() => {});
    job.promise = promise;
    return job;
  }

  /**
   * The path of the MP3 copy of a cached track, made on first request. Returns null when the track itself is not
   * cached (a browser asking for a track nobody prepared).
   */
  async mp3(track: Track, signal: AbortSignal): Promise<string | null> {
    const key = MediaCache.keyOf(track.source);
    const cache = this.options.cache;
    if (!cache.has(key)) return null;
    if (cache.hasMp3(key)) return cache.mp3Path(key);
    let job = this.mp3Jobs.get(key);
    if (!job) {
      // Two conversions at a time: each is an ffmpeg process, and requests for many tracks at once would start many.
      if (this.mp3Jobs.size >= 2)
        throw new BusyError('jukecord is making other MP3 copies right now; try again in a moment');
      const tmp = cache.tmpPath(key, 'mp3');
      job = this.options.ffmpeg
        .toMp3(cache.opusPath(key), tmp, signal, this.options.timeoutMs)
        .then(() => {
          cache.addMp3(key, tmp);
          return cache.mp3Path(key);
        })
        .catch((error: unknown) => {
          fs.rmSync(tmp, { force: true });
          throw error;
        })
        .finally(() => this.mp3Jobs.delete(key));
      this.mp3Jobs.set(key, job);
    }
    return job;
  }
}
