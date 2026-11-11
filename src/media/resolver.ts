/**
 * Turning what someone typed into stored tracks, ready to be queued.
 *
 * An address already in the database is answered from it without asking the site again, which makes re-adding a
 * song instant. Everything else goes through yt-dlp.
 */
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { TrackRepository } from '../store/store.ts';
import { canonicalSource, isPlaylistAddress, parseInput } from './source.ts';
import type { YtDlp } from './ytdlp.ts';

export interface ResolverOptions {
  readonly ytdlp: YtDlp;
  readonly tracks: TrackRepository;
  readonly log: Logger;
}

export class Resolver {
  private readonly options: ResolverOptions;

  constructor(options: ResolverOptions) {
    this.options = options;
  }

  /** The tracks an input adds (one for a video or a search, several for a playlist), stored in the database. */
  async resolve(text: string, signal?: AbortSignal): Promise<Track[]> {
    const input = parseInput(text);
    if (input.kind === 'url' && !isPlaylistAddress(input.url)) {
      // A single address seen before: no lookup needed.
      const known = this.options.tracks.bySource(canonicalSource(input.url));
      if (known) return [known];
    }
    const found = await this.options.ytdlp.lookup(input, signal);
    const tracks = found.map((track) => this.options.tracks.upsert(track));
    this.options.log.info('looked up', {
      input: input.kind === 'search' ? `search: ${input.query}` : input.url.href,
      tracks: tracks.length,
    });
    return tracks;
  }
}
