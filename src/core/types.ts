/**
 * The things jukecord keeps and passes around: tracks, queue items, history entries and playlists.
 *
 * These are plain data, the same shape whether they come from the database, go out over the API or appear in the
 * panel, so every part of jukecord agrees on what a track is.
 */

/** Something that can be played: one video or sound page that yt-dlp can fetch. */
export interface Track {
  /** The database row ID; stable for the life of the data directory. */
  readonly id: number;
  /** The normalised address used as the cache key, so two spellings of one video share one cached file. */
  readonly source: string;
  /** The address of the page itself, for people to open. */
  readonly url: string;
  readonly title: string;
  /** The channel or account that published it, when the site says. */
  readonly uploader: string | null;
  /** Length in milliseconds; null for live streams and sites that do not say. */
  readonly durationMs: number | null;
  /** A picture for the queue and the disc in the panel, when the site has one. */
  readonly thumbnail: string | null;
  /** Integrated loudness in LUFS, measured once when the track is first prepared, so later plays skip measuring. */
  readonly loudness: number | null;
}

/** What is known about a track before it has a row: what metadata lookup returns. */
export interface NewTrack {
  readonly source: string;
  readonly url: string;
  readonly title: string;
  readonly uploader: string | null;
  readonly durationMs: number | null;
  readonly thumbnail: string | null;
}

/** One place in a server's queue. The same track can be queued twice; each gets its own item. */
export interface QueueItem {
  readonly id: number;
  /** The Discord server (guild) whose queue this is. */
  readonly guildId: string;
  /** Zero-based place in the queue, kept dense (0, 1, 2, ...) after every change. */
  readonly position: number;
  readonly track: Track;
  /** The Discord user who added it, or null when it came from the CLI or a panel without a login. */
  readonly addedBy: string | null;
  /** When it was added, in milliseconds since the epoch. */
  readonly addedAt: number;
}

/** A track that was played, for the history list, "play again" and the statistics. */
export interface HistoryEntry {
  readonly id: number;
  readonly guildId: string;
  readonly track: Track;
  readonly addedBy: string | null;
  /** When it started playing. */
  readonly playedAt: number;
  /** How long it actually played, so a skip after five seconds does not count as a full listen. */
  readonly playedMs: number;
}

/** A saved list of tracks that can be loaded back into a queue. */
export interface Playlist {
  readonly id: number;
  readonly guildId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** How many tracks it holds. */
  readonly size: number;
}

/**
 * Who added the tracks autoplay queues, in the place of a Discord user ID: a word no Discord ID can be (IDs are
 * digits), so the queue, the history and the player carry it as they carry a person, and every place that names who
 * added a track can say "Autoplay" instead.
 */
export const AUTOPLAY = 'autoplay';

/** A track someone liked, with when. */
export interface LikedTrack {
  readonly track: Track;
  readonly likedAt: number;
}
