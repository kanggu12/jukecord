/**
 * Searching YouTube for words, to show what it found before anything is added (the panel's add field, the API, the
 * jukecord command, Discord's suggestions on /play and /add).
 *
 * Each search is one flat listing by yt-dlp (one request to YouTube, about a second and a half), run in one of the
 * resolver's lookup slots, so searches and lookups together stay within the same few processes. What it finds is
 * kept for a while, by its words: the same words again (typed back, or asked by two people at once) are answered
 * from memory, and a search already under way is shared. A search nobody waits for any more (the next key was
 * typed) is stopped, so it does not hold a slot the next one needs. Picking a result adds it from what the search
 * learned (see recent), with nothing fetched until it plays.
 */
import { steadyNow } from '../core/clock.ts';
import type { NewTrack } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { Resolver } from './resolver.ts';
import type { YtDlp } from './ytdlp.ts';

/** The most results a search gives (the panel shows eight, Discord's suggestions take up to ten). */
export const SEARCH_MAX = 10;

// How many yt-dlp is asked for: a few more than given, since live streams are left out of the results.
const FETCHED = SEARCH_MAX + 4;

export interface SearchOptions {
  readonly ytdlp: Pick<YtDlp, 'search'>;
  /** The lookup slots shared with the resolver (see Resolver.run). */
  readonly slots: Pick<Resolver, 'run'>;
  readonly log: Logger;
  /** How long found results are kept (default 30 minutes). */
  readonly keepMs?: number;
  /** How many searches are kept (default 300), the least recently asked forgotten first. */
  readonly size?: number;
  /** The clock results are kept by (tests set it); the steady clock by default. */
  readonly now?: () => number;
}

/** Who asks, for the per-person and per-server shares of the slots, and when the asker stops waiting. */
export interface SearchAsk {
  readonly limit?: number;
  readonly who?: string | null;
  readonly server?: string | null;
  readonly signal?: AbortSignal;
}

// One search under way: what it will find, the way to stop it, and how many wait for it.
interface Flight {
  readonly promise: Promise<NewTrack[]>;
  readonly stop: AbortController;
  waiters: number;
  done: boolean;
}

/** The words as a search uses them: trimmed, single spaces, at most 200 characters (as the add box cuts them). */
export function searchWords(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 200);
}

export class Search {
  private readonly options: SearchOptions;
  private readonly keepMs: number;
  private readonly size: number;
  private readonly now: () => number;
  // Found results by their words in lower case, oldest asked first (a Map keeps the order things were set in).
  private readonly found = new Map<string, { at: number; tracks: NewTrack[] }>();
  // Searches under way, by the same key.
  private readonly flights = new Map<string, Flight>();
  // Every track a recent search showed, by its canonical address, for picking it (see recent).
  private readonly shown = new Map<string, { at: number; track: NewTrack }>();

  constructor(options: SearchOptions) {
    this.options = options;
    this.keepMs = options.keepMs ?? 30 * 60_000;
    this.size = options.size ?? 300;
    this.now = options.now ?? steadyNow;
  }

  /** What a search found lately for these words, without asking YouTube (null when it is not known). */
  cached(text: string, limit = SEARCH_MAX): NewTrack[] | null {
    const key = searchWords(text).toLowerCase();
    const entry = this.found.get(key);
    if (!entry || this.now() - entry.at > this.keepMs) return null;
    return entry.tracks.slice(0, limit);
  }

  /**
   * What YouTube finds for the words, at most `limit` (1 to SEARCH_MAX): from memory when known, else from a search
   * (one already under way for the same words is shared). Rejects with the asker's own abort when it stops waiting,
   * and with BusyError when every lookup slot is taken.
   */
  async find(text: string, ask: SearchAsk = {}): Promise<NewTrack[]> {
    const words = searchWords(text);
    if (!words) throw new Error('nothing to search for');
    const limit = Math.max(1, Math.min(SEARCH_MAX, Math.floor(ask.limit ?? 8)));
    const key = words.toLowerCase();
    const known = this.cached(words, limit);
    if (known) {
      // Asked again: the most recently asked, so it is the last forgotten.
      const entry = this.found.get(key);
      if (entry) {
        this.found.delete(key);
        this.found.set(key, entry);
      }
      return known;
    }
    ask.signal?.throwIfAborted();
    const flight = this.flights.get(key) ?? this.start(key, words, ask.who ?? null, ask.server ?? null);
    flight.waiters += 1;
    try {
      return (await this.waitFor(flight.promise, ask.signal)).slice(0, limit);
    } finally {
      flight.waiters -= 1;
      // Nobody waits any more: the search stops, and its slot is free for the next one. It is no longer shared at once:
      // yt-dlp takes a moment to end, and the same words asked again meanwhile would wait for it and fail with it.
      if (flight.waiters === 0 && !flight.done) {
        flight.stop.abort();
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }
    }
  }

  /**
   * A track a recent search showed, by its canonical address: picking a result adds it with what the search learned
   * (title, channel, length, picture), as a search that adds its first result does.
   */
  recent(source: string): NewTrack | null {
    const entry = this.shown.get(source);
    if (!entry || this.now() - entry.at > this.keepMs) return null;
    return entry.track;
  }

  // Starts a search for the words, shared by everyone who asks for them while it runs.
  private start(key: string, words: string, who: string | null, server: string | null): Flight {
    const stop = new AbortController();
    const flight: Flight = {
      stop,
      waiters: 0,
      done: false,
      promise: this.options.slots
        .run(who, server, () => this.options.ytdlp.search(words, FETCHED, stop.signal))
        .then((tracks) => {
          const kept = tracks.slice(0, SEARCH_MAX);
          this.remember(key, kept);
          this.options.log.debug('searched', { words, found: kept.length });
          return kept;
        }),
    };
    this.flights.set(key, flight);
    // Done either way: no longer shared (a failure is not remembered, so the next ask tries again).
    const finish = () => {
      flight.done = true;
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    flight.promise.then(finish, (error: unknown) => {
      finish();
      // A search stopped because nobody waited is not worth a line; a failure is, in short.
      if (!stop.signal.aborted)
        this.options.log.info('a search failed', {
          words,
          reason: error instanceof Error ? error.message : String(error),
        });
    });
    return flight;
  }

  // Keeps what a search found, and each track it showed, within their bounds.
  private remember(key: string, tracks: NewTrack[]): void {
    const at = this.now();
    this.found.delete(key);
    this.found.set(key, { at, tracks });
    while (this.found.size > this.size) {
      const oldest = this.found.keys().next().value;
      if (oldest === undefined) break;
      this.found.delete(oldest);
    }
    // By the canonical address the lookup made, which is what the resolver asks with.
    for (const track of tracks) {
      this.shown.delete(track.source);
      this.shown.set(track.source, { at, track });
    }
    // Ten tracks a search, so ten times as many as the searches kept.
    while (this.shown.size > this.size * SEARCH_MAX) {
      const oldest = this.shown.keys().next().value;
      if (oldest === undefined) break;
      this.shown.delete(oldest);
    }
  }

  // The shared promise, or the asker's own abort, whichever comes first.
  private waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}
