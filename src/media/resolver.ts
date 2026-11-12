/**
 * Turning what someone typed into stored tracks, ready to be queued.
 *
 * An address already in the database is answered from it without asking the site again, which makes re-adding a
 * song instant. Everything else goes through yt-dlp, a few lookups at a time: each one is a process of its own with a
 * Node child for YouTube, and twenty at once would use more memory than a small server has.
 */

import type { FetchWatch } from '../app/alerts.ts';
import type { NewTrack, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { MusicRepository, TrackRepository } from '../store/store.ts';
import type { AddressCheck } from './address.ts';
import { BusyError } from './busy.ts';
import { canonicalSource, isPlaylistAddress, parseInput } from './source.ts';
import type { YtDlp } from './ytdlp.ts';

export interface ResolverOptions {
  readonly ytdlp: YtDlp;
  readonly tracks: TrackRepository;
  readonly log: Logger;
  /** Refuses addresses on private networks (see address.ts); none means every address is fetched. */
  readonly checkAddress?: AddressCheck;
  /** How many yt-dlp lookups may run at once (default 4). */
  readonly concurrency?: number;
  /** How many of those one person may have running (default 2), so one person cannot take them all. */
  readonly perPerson?: number;
  /** How many of those one server may have running (default 3), so one busy server leaves room for the others. */
  readonly perServer?: number;
  /** Hears how each lookup on a site went (for YouTube's check for bots, see app/alerts.ts). */
  readonly watch?: FetchWatch;
  /** Where what a site says a recording is gets kept (its song, artist and album, for its lyrics); none: not kept. */
  readonly music?: MusicRepository;
  /**
   * A track found by a recent search, by its canonical address (see Search.recent): picking a search result adds it
   * from what the search already learned, with nothing fetched now, as an address seen before is.
   */
  readonly recent?: (source: string) => NewTrack | null;
}

export class Resolver {
  private readonly options: ResolverOptions;
  // Lookups running now, in all, per person and per server.
  private active = 0;
  private readonly byPerson = new Map<string, number>();
  private readonly byServer = new Map<string, number>();

  constructor(options: ResolverOptions) {
    this.options = options;
  }

  /**
   * The tracks an input adds (one for a video or a search, several for a playlist), stored in the database. `who` is
   * the person asking (a Discord user ID), counted against the per-person limit (the host has none); `server` is the
   * Discord server it is for, counted against the per-server limit.
   */
  async resolve(
    text: string,
    signal?: AbortSignal,
    who: string | null = null,
    server: string | null = null,
  ): Promise<Track[]> {
    return this.resolveIn(text, signal, (work) => this.run(who, server, work));
  }

  /**
   * As resolve, outside the lookup slots: for the lookups that come in lists (an imported playlist's lines), which
   * take their turns in BatchLookups instead, so a long list never holds the slots people wait for.
   */
  async resolveListed(text: string, signal?: AbortSignal): Promise<Track[]> {
    return this.resolveIn(text, signal, (work) => work());
  }

  // Resolves an input, running the lookup (when one is needed) through `slot`.
  private async resolveIn(
    text: string,
    signal: AbortSignal | undefined,
    slot: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<Track[]> {
    const input = parseInput(text);
    if (input.kind === 'url' && !isPlaylistAddress(input.url)) {
      // A single address seen before: answered from the database, with nothing fetched now (playing it later goes
      // through yt-dlp and its address guard like any other track).
      const source = canonicalSource(input.url);
      const known = this.options.tracks.bySource(source);
      if (known) return [known];
      // A result of a recent search: stored from what the search learned, the same as a search that adds it would.
      const found = this.options.recent?.(source);
      if (found) return [this.store(found)];
    }
    let found: Awaited<ReturnType<YtDlp['lookup']>>;
    try {
      found = await slot(async () => {
        // An address on a private network is refused before yt-dlp starts (address.ts), which says so more plainly
        // than the guard yt-dlp would meet.
        if (input.kind === 'url') await this.options.checkAddress?.(input.url);
        return this.options.ytdlp.lookup(input, signal);
      });
      // The site answered (words are searched on YouTube).
      this.options.watch?.worked(input.kind === 'search' ? 'search' : input.url.href);
    } catch (error) {
      // The full text for the log; people get a short reason from the actions (core/reasons.ts). Slots all taken is
      // not a failed lookup: nothing was looked up.
      if (!(error instanceof BusyError)) {
        this.options.log.info('a lookup failed', {
          input: input.kind === 'search' ? `search: ${input.query}` : input.url.href,
          reason: error instanceof Error ? error.message : String(error),
        });
        // Nor is a lookup stopped by the person asking an answer from the site.
        if (!signal?.aborted)
          this.options.watch?.failed(
            input.kind === 'search' ? 'search' : input.url.href,
            error instanceof Error ? error.message : String(error),
          );
      }
      throw error;
    }
    // A playlist's entries point wherever the playlist says; each must pass the same check as a typed address.
    const allowed: typeof found = [];
    for (const track of found) {
      try {
        await this.options.checkAddress?.(new URL(track.url));
        allowed.push(track);
      } catch {
        this.options.log.info('left out a playlist entry on a private network', { title: track.title });
      }
    }
    const tracks = allowed.map((track) => this.store(track));
    this.options.log.info('looked up', {
      input: input.kind === 'search' ? `search: ${input.query}` : input.url.href,
      tracks: tracks.length,
    });
    return tracks;
  }

  // Stores a track found, and what the site said the recording is beside it, for finding its lyrics.
  private store(track: NewTrack): Track {
    const stored = this.options.tracks.upsert(track);
    if (track.music) this.options.music?.set(stored.id, track.music);
    return stored;
  }

  /**
   * Runs some yt-dlp work in one of the lookup slots: a lookup, a search, a mix for autoplay. `who` is the person
   * asking (a Discord user ID, counted against the per-person limit; the host and jukecord itself have none) and
   * `server` the Discord server it is for. All taken: BusyError at once, nothing waits.
   */
  async run<T>(who: string | null, server: string | null, work: () => Promise<T>): Promise<T> {
    const mine = who ? (this.byPerson.get(who) ?? 0) : 0;
    const ours = server ? (this.byServer.get(server) ?? 0) : 0;
    if (
      this.active >= (this.options.concurrency ?? 4) ||
      (who && mine >= (this.options.perPerson ?? 2)) ||
      (server && ours >= (this.options.perServer ?? 3))
    ) {
      throw new BusyError('jukecord is looking up other tracks right now; try again in a moment');
    }
    // The slot is taken before anything touches the network, an address check's DNS question included.
    this.active += 1;
    if (who) this.byPerson.set(who, mine + 1);
    if (server) this.byServer.set(server, ours + 1);
    try {
      return await work();
    } finally {
      this.active -= 1;
      if (who) {
        const left = (this.byPerson.get(who) ?? 1) - 1;
        if (left > 0) this.byPerson.set(who, left);
        else this.byPerson.delete(who);
      }
      if (server) {
        const left = (this.byServer.get(server) ?? 1) - 1;
        if (left > 0) this.byServer.set(server, left);
        else this.byServer.delete(server);
      }
    }
  }
}
