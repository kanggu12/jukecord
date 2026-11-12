/**
 * Getting a track ready to play: from the cache when it is there, otherwise downloaded and encoded into the cache.
 *
 * Two callers asking for the same track (the player and the prefetcher, typically) share one download. The download
 * is cancelled only when every caller has given up on it, so a skipped track that the prefetcher still wants keeps
 * downloading, and a track nobody wants any more stops at once.
 *
 * Across every server, tracks fetched ahead of time take turns within a limit, and tracks somebody waits for within a
 * larger one, ahead of them (see slots.ts), so a few servers fetching ahead, or a crowd pressing skip, cannot take a
 * small machine over.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { steadyNow } from '../core/clock.ts';
import { fetchLimitMs, type MediaPreparer, type PreparedMedia } from '../core/player.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { TrackRepository } from '../store/store.ts';
import { BusyError } from './busy.ts';
import { MediaCache } from './cache.ts';
import type { Ffmpeg } from './ffmpeg.ts';
import { oggOpusDurationMs } from './ogg.ts';
import { defaultLimit, type Priority, Slots, type Ticket } from './slots.ts';
import type { YtDlp } from './ytdlp.ts';

export interface MediaOptions {
  readonly cache: MediaCache;
  readonly ytdlp: YtDlp;
  readonly ffmpeg: Ffmpeg;
  readonly tracks: TrackRepository;
  readonly log: Logger;
  /** How long one download and encode may take. */
  readonly timeoutMs: number;
  /** How many fetches ahead of time may run at once, across every server (default: half the processors, 2 to 6). */
  readonly fetchLimit?: number;
}

// A download in progress, shared by everyone waiting for the same track.
interface Job {
  promise: Promise<PreparedMedia>;
  readonly abort: AbortController;
  waiters: number;
  // Of those, the ones that need it now (a player); when none is left, the fetch stops counting as one somebody waits
  // for (see Slots), so it does not hold back the next one that somebody does.
  nowWaiters: number;
  /** Everyone who wants to hear about the download's progress. */
  readonly listeners: Set<(fraction: number) => void>;
  /** Everyone waiting for the fetch who wants to hear when it starts, after a wait for its place. */
  readonly starting: Set<(waiting: boolean) => void>;
  /** Its place among the fetches of every server. */
  readonly ticket: Ticket;
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
  private readonly slots: Slots;

  constructor(options: MediaOptions) {
    this.options = options;
    this.slots = new Slots(options.fetchLimit ?? defaultLimit(os.availableParallelism()));
  }

  /** The cache this preparer fills (the web layer serves files from it). */
  get cache(): MediaCache {
    return this.options.cache;
  }

  async prepare(
    track: Track,
    signal: AbortSignal,
    onProgress?: (fraction: number) => void,
    priority: Priority = 'now',
    onWaiting?: (waiting: boolean) => void,
  ): Promise<PreparedMedia> {
    const key = MediaCache.keyOf(track.source);
    const cached = this.options.cache.get(key);
    if (cached) return { file: this.options.cache.opusPath(key), durationMs: cached.durationMs };
    let job = this.jobs.get(key);
    // A download being stopped (everyone left it) is not joined: it can only end in "cancelled". A new one starts.
    if (!job || job.abort.signal.aborted) {
      job = this.start(track, key, priority);
      this.jobs.set(key, job);
    } else if (priority === 'now') {
      // A fetch ahead of time that somebody now waits for starts at once, if it was still waiting its turn.
      job.ticket.promote();
    }
    const shared = job;
    shared.waiters += 1;
    if (priority === 'now') shared.nowWaiters += 1;
    if (onProgress) shared.listeners.add(onProgress);
    // Still waiting for its place (a caller that joined it finds it waiting too): the caller hears so now, and hears
    // again when it starts.
    if (onWaiting && shared.ticket.waiting) {
      shared.starting.add(onWaiting);
      onWaiting(true);
    }
    // A caller that needed it now is gone: with only callers ahead of time left, it no longer counts as needed now.
    const lessNow = (): void => {
      if (priority !== 'now') return;
      shared.nowWaiters -= 1;
      if (shared.nowWaiters === 0 && shared.waiters > 0) shared.ticket.demote();
    };
    // When this caller gives up, it stops waiting; the download stops only if it was the last one waiting, and then
    // it leaves the list at once, so the next caller for the same track starts afresh instead of joining it.
    const leave = (): void => {
      shared.waiters -= 1;
      lessNow();
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
      if (onWaiting) shared.starting.delete(onWaiting);
      // A caller that got its answer is no longer waiting either.
      if (!signal.aborted) {
        shared.waiters -= 1;
        lessNow();
      }
    }
  }

  // Downloads and encodes one track into the cache, when its turn comes (at once for a track somebody waits for).
  private start(track: Track, key: string, priority: Priority): Job {
    const abort = new AbortController();
    const cache = this.options.cache;
    const tmp = cache.tmpPath(key);
    const listeners = new Set<(fraction: number) => void>();
    const starting = new Set<(waiting: boolean) => void>();
    const ticket = this.slots.request(priority, abort.signal);
    // The job exists before its work starts, so the work can tell whether the list still points at it when it ends.
    const job: Job = {
      promise: Promise.reject(new Error('not started')),
      abort,
      waiters: 0,
      nowWaiters: 0,
      listeners,
      starting,
      ticket,
    };
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
      let started = steadyNow();
      try {
        // Its turn among the fetches of every server; the time it took counts from here.
        await ticket.granted;
        started = steadyNow();
        // Those who were told it waits hear that it starts; one that throws must not break the fetch.
        for (const fn of starting) {
          try {
            fn(false);
          } catch {
            // A display, as progress is.
          }
        }
        starting.clear();
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
        let durationMs = await oggOpusDurationMs(tmp);
        if (durationMs < 500) {
          // An MP4 whose index comes at its end cannot be read as it arrives: ffmpeg finds no audio and still ends
          // well. Such a file is fetched whole and read from the disk; one that is empty there too is empty.
          const source = cache.tmpPath(key, 'source');
          const limit = fetchLimitMs(this.options.timeoutMs, track.durationMs);
          try {
            // Progress starts again for the second download.
            report(0);
            await this.options.ytdlp.audioToFile(track.url, source, abort.signal, limit, report);
            ({ loudness } = await this.options.ffmpeg.fromFile(source, tmp, abort.signal, limit));
          } finally {
            // The file and anything yt-dlp left beside it (its .ytdl state, fragments), whatever happened.
            const name = path.basename(source);
            for (const entry of fs.readdirSync(path.dirname(source))) {
              if (entry.startsWith(name)) fs.rmSync(path.join(path.dirname(source), entry), { force: true });
            }
          }
          durationMs = await oggOpusDurationMs(tmp);
          if (durationMs < 500) throw new Error('the downloaded audio is empty');
          this.options.log.info('read a track from a whole file', { title: track.title });
        }
        cache.commit(key, tmp, { source: track.source, durationMs, loudness });
        if (loudness !== null) this.options.tracks.setLoudness(track.id, loudness);
        this.options.log.info('cached a track', {
          title: track.title,
          seconds: Math.round(durationMs / 1000),
          took: `${((steadyNow() - started) / 1000).toFixed(1)} s`,
        });
        return { file: cache.opusPath(key), durationMs };
      } catch (error) {
        // A half-written file is useless and counts against the disk; remove it whatever went wrong.
        fs.rmSync(tmp, { force: true });
        throw error;
      } finally {
        // Its place goes to the next fetch waiting, if any.
        ticket.release();
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
      // The same time limit as getting the track, which grows with its length (see fetchLimitMs): a three-hour track
      // takes over a minute to convert on a small machine, and a fixed limit refused its copy every time. The length is
      // the cached file's own, measured when it was made.
      const durationMs = cache.get(key)?.durationMs ?? track.durationMs;
      job = this.options.ffmpeg
        .toMp3(cache.opusPath(key), tmp, signal, fetchLimitMs(this.options.timeoutMs, durationMs))
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
