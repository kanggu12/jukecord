/**
 * Turning what someone typed into stored tracks, ready to be queued.
 *
 * An address already in the database is answered from it without asking the site again, which makes re-adding a
 * song instant. Everything else goes through yt-dlp, a few lookups at a time: each one is a process of its own with a
 * Node child for YouTube, and twenty at once would use more memory than a small server has.
 */
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { TrackRepository } from '../store/store.ts';
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
}

export class Resolver {
  private readonly options: ResolverOptions;
  // Lookups running now, in all and per person.
  private active = 0;
  private readonly byPerson = new Map<string, number>();

  constructor(options: ResolverOptions) {
    this.options = options;
  }

  /**
   * The tracks an input adds (one for a video or a search, several for a playlist), stored in the database. `who` is
   * the person asking (a Discord user ID), counted against the per-person limit; the host has none.
   */
  async resolve(text: string, signal?: AbortSignal, who: string | null = null): Promise<Track[]> {
    const input = parseInput(text);
    if (input.kind === 'url' && !isPlaylistAddress(input.url)) {
      // A single address seen before: answered from the database, with nothing fetched now (playing it later goes
      // through yt-dlp and its address guard like any other track).
      const known = this.options.tracks.bySource(canonicalSource(input.url));
      if (known) return [known];
    }
    const mine = who ? (this.byPerson.get(who) ?? 0) : 0;
    if (this.active >= (this.options.concurrency ?? 4) || (who && mine >= (this.options.perPerson ?? 2))) {
      throw new BusyError('jukecord is looking up other tracks right now; try again in a moment');
    }
    // The slot is taken before anything touches the network, the address check's DNS question included.
    this.active += 1;
    if (who) this.byPerson.set(who, mine + 1);
    let found: Awaited<ReturnType<YtDlp['lookup']>>;
    try {
      // An address on a private network is refused before yt-dlp starts (address.ts), which says so more plainly
      // than the guard yt-dlp would meet.
      if (input.kind === 'url') await this.options.checkAddress?.(input.url);
      found = await this.options.ytdlp.lookup(input, signal);
    } catch (error) {
      // The full text for the log; people get a short reason from the actions (core/reasons.ts).
      this.options.log.info('a lookup failed', {
        input: input.kind === 'search' ? `search: ${input.query}` : input.url.href,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.active -= 1;
      if (who) {
        const left = (this.byPerson.get(who) ?? 1) - 1;
        if (left > 0) this.byPerson.set(who, left);
        else this.byPerson.delete(who);
      }
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
    const tracks = allowed.map((track) => this.options.tracks.upsert(track));
    this.options.log.info('looked up', {
      input: input.kind === 'search' ? `search: ${input.query}` : input.url.href,
      tracks: tracks.length,
    });
    return tracks;
  }
}
