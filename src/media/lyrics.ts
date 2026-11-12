/**
 * Lyrics for the track playing, from LRCLIB (lrclib.net: free, open, no key), kept in the database so each track is
 * asked about once.
 *
 * What jukecord sends LRCLIB is the song's title, its artist, its album when known, and its length: what YouTube says
 * the recording is when it says (yt-dlp's `track`, `artist` and `album`), else what the video's title and channel
 * give once the usual decorations ("(Official Video)", "[MV]", "feat. ...") are taken off. LRCLIB matches a length
 * within two seconds, which keeps a guess from finding another song's words.
 *
 * LRCLIB is a free service that asks its clients to go gently: to say who they are, to ask one thing at a time with a
 * short pause between, and to wait as long as a 429 or a 503 says. So every request goes through one line here, a
 * third of a second apart, and a "wait" pauses the line for everyone. A lookup is made only for a track that is
 * playing, once however many ask at the same moment, and at most a few wait for their turn; a lookup that failed
 * (LRCLIB down, too slow) is not made again for that track for two minutes. What was found is kept for good; that
 * nothing was found is kept for a week and then asked again, as LRCLIB fills in missing songs over time.
 */
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { LyricsKind, LyricsRepository, LyricsRow, MusicRepository, TrackMusic } from '../store/store.ts';
import type { OutboundGet } from './outbound.ts';

/** Where lyrics come from, as the panel, the API and Discord credit it. */
export const LYRICS_SOURCE = { name: 'LRCLIB', url: 'https://lrclib.net' } as const;

/** One timed line: when it starts, in milliseconds from the track's start, and its words ('' for a pause). */
export interface LyricLine {
  readonly atMs: number;
  readonly text: string;
}

/** A track's lyrics as they are shown: timed lines (for kind synced) and the words without timings. */
export interface LyricsAnswer {
  readonly trackId: number;
  readonly kind: LyricsKind;
  readonly lines: readonly LyricLine[];
  readonly text: string | null;
}

/**
 * Lyrics that cannot be had right now (LRCLIB down, slow or asking to wait, or too many lookups waiting), and how long
 * until asking again may work: a failed track is not asked of LRCLIB again for two minutes.
 */
export class LyricsUnavailable extends Error {
  override name = 'LyricsUnavailable';
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** What gives a track its lyrics: the actions ask this. */
export interface LyricsSource {
  forTrack(track: Track): Promise<LyricsAnswer>;
}

// ---- the song a track is ----------------------------------------------------------------------------------------

/** A song to look up: its title and artist, its album when known, its length in seconds, and how it was known. */
export interface Song {
  readonly artist: string;
  readonly title: string;
  readonly album: string | null;
  /** The length, rounded, when it is one LRCLIB takes (1 to 3600 s); null otherwise. */
  readonly seconds: number | null;
  /** True when the site said what the recording is; false when it was read from the title and the channel. */
  readonly tagged: boolean;
}

// What a video's title carries besides the song: words of these kinds in brackets go, with the brackets.
const DECORATION =
  /\b(official|video|audio|lyrics?|visuali[sz]er|m\/?v|hd|hq|4k|8k|remaster(?:ed)?|color coded|explicit|clean|teaser|clip|performance|full ver(?:sion)?|topic)\b|가사|뮤직\s?비디오|뮤비|공식|자막|번역/i;
// The same words at the very end of a title, outside any brackets ("Neon Rain M/V", "Low Tide official video").
const TRAILING = /\s+(?:official\s+)?(?:music\s+video|lyric\s+video|video|audio|m\/?v|mv|visuali[sz]er)\s*$/i;
// A featured artist: not part of the song's name as LRCLIB keeps it most often.
const FEATURING = /\s*(?:[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]|\s(?:feat\.?|ft\.?|featuring)\s.*$)/i;
// Between an artist and a song: a spaced hyphen or dash, or the underscore of some channels' "[MV] Artist _ Song".
const SEPARATOR = /\s+[-–—_]\s+/;
// A song's name in quotes after its artist ("Artist 'Song' MV"), as some channels write it.
const QUOTED = /^(.+?)\s+['"‘“「『](.+?)['"’”」』](?:\s|$)/;
// What channels add to an artist's name: " - Topic" (YouTube's own channels for a release), VEVO, "Official".
const CHANNEL = /\s*(?:-\s*topic|vevo|official(?:\s+youtube)?(?:\s+channel)?|공식\s*채널)\s*$/i;

// Takes the decorated brackets out of a title, and the featured artist, and tidies the spaces.
function plainTitle(title: string): string {
  let text = title;
  // Any bracket pair whose words are decorations, as many times as there are (round, square, the wide ones).
  for (const pattern of [/\(([^()]*)\)/g, /\[([^[\]]*)\]/g, /【([^【】]*)】/g]) {
    text = text.replace(pattern, (whole, inside: string) => (DECORATION.test(inside) ? ' ' : whole));
  }
  // "Song | Official Video": the parts after a bar that are decorations go.
  const parts = text.split(/\s+\|\s+/);
  text = parts.filter((part, index) => index === 0 || !DECORATION.test(part)).join(' | ');
  return text.replace(FEATURING, '').replace(TRAILING, '').replace(/\s+/g, ' ').trim();
}

/**
 * The song a track is: what the site said when it said it (`music`), else the title read as "Artist - Song" or
 * "Artist 'Song'", else the title as the song and the channel as its artist. Null when nothing usable is left.
 */
export function songOf(track: Pick<Track, 'title' | 'uploader' | 'durationMs'>, music: TrackMusic | null): Song | null {
  const rounded = track.durationMs === null ? null : Math.round(track.durationMs / 1000);
  const seconds = rounded !== null && rounded >= 1 && rounded <= 3600 ? rounded : null;
  if (music) {
    const title = music.title.replace(FEATURING, '').trim();
    if (title && music.artist.trim()) {
      return { artist: music.artist.trim(), title, album: music.album?.trim() || null, seconds, tagged: true };
    }
  }
  const cleaned = plainTitle(track.title);
  let artist = '';
  let title = cleaned;
  const split = cleaned.split(SEPARATOR);
  const quoted = QUOTED.exec(cleaned);
  if (split.length >= 2 && split[0] && split.slice(1).join(' - ')) {
    artist = split[0];
    title = plainTitle(split.slice(1).join(' - '));
  } else if (quoted?.[1] && quoted[2]) {
    artist = quoted[1];
    title = quoted[2];
  } else if (track.uploader) {
    artist = track.uploader.replace(CHANNEL, '');
  }
  artist = artist.replace(FEATURING, '').trim();
  title = title.trim();
  if (!artist || !title) return null;
  return { artist, title, album: null, seconds, tagged: false };
}

// ---- LRC ----------------------------------------------------------------------------------------------------------

// A time stamp at the start of a line: [mm:ss], [mm:ss.xx] or [mm:ss.xxx] (a colon before the fraction also seen).
const STAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
// The most lines kept of one song: a song has dozens; past this it is not a song's.
const LINES_MAX = 2000;

/**
 * Timed lines from LRC text ("[01:02.30] words"): a line with several stamps is that line at each of them, an
 * [offset:±ms] tag moves them all (positive: sooner), anything else without a stamp ([ar:...], words with no time) is
 * left out. In the order they are sung.
 */
export function parseLrc(text: string): LyricLine[] {
  let offset = 0;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const shift = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (shift) {
      offset = Number(shift[1]);
      continue;
    }
    // Every stamp at the start, then the words after them.
    const times: number[] = [];
    let rest = line;
    for (let stamp = STAMP.exec(rest); stamp; stamp = STAMP.exec(rest)) {
      // Hundredths or thousandths, read as milliseconds ("12" is 120 ms, "123" 123 ms).
      const fraction = Number((stamp[3] ?? '0').padEnd(3, '0'));
      times.push(Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + fraction);
      rest = rest.slice(stamp[0].length);
    }
    for (const at of times) lines.push({ atMs: Math.max(0, at - offset), text: rest.trim() });
  }
  // Stable: lines at the same time keep the order they were written in.
  return lines.sort((a, b) => a.atMs - b.atMs).slice(0, LINES_MAX);
}

// ---- LRCLIB -------------------------------------------------------------------------------------------------------

/** A record as LRCLIB answers it, the fields jukecord reads. */
export interface LrclibRecord {
  readonly id: number;
  readonly trackName: string;
  readonly artistName: string;
  readonly albumName: string;
  readonly duration: number;
  readonly instrumental: boolean;
  readonly plainLyrics: string | null;
  readonly syncedLyrics: string | null;
}

/** LRCLIB asked to wait (429, 503): for how long. */
export class LrclibWait extends Error {
  override name = 'LrclibWait';
  readonly waitMs: number;
  constructor(waitMs: number) {
    super(`LRCLIB asked to wait ${Math.round(waitMs / 1000)} s`);
    this.waitMs = waitMs;
  }
}

// One record read with care: what a field is not is not trusted (a newer LRCLIB, or something that is not LRCLIB).
function recordOf(value: unknown): LrclibRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const words = (field: unknown) => (typeof field === 'string' && field.trim() !== '' ? field : null);
  if (typeof entry.id !== 'number' || typeof entry.duration !== 'number') return null;
  return {
    id: entry.id,
    trackName: typeof entry.trackName === 'string' ? entry.trackName : '',
    artistName: typeof entry.artistName === 'string' ? entry.artistName : '',
    albumName: typeof entry.albumName === 'string' ? entry.albumName : '',
    duration: entry.duration,
    instrumental: entry.instrumental === true,
    plainLyrics: words(entry.plainLyrics),
    syncedLyrics: words(entry.syncedLyrics),
  };
}

/** LRCLIB's API: one exact lookup by a song's signature, and a search. */
export class LrclibClient {
  private readonly get: OutboundGet;
  private readonly userAgent: string;
  private readonly base: string;

  constructor(options: { get: OutboundGet; userAgent: string; base?: string }) {
    this.get = options.get;
    this.userAgent = options.userAgent;
    this.base = options.base ?? LYRICS_SOURCE.url;
  }

  // A request to LRCLIB, with the answer read as JSON: a wait asked for is thrown as one, anything but 200 and 404
  // is a failure.
  private async ask(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    // LRCLIB asks every client to say what it is: the program, its version and where it lives.
    const answer = await this.get(url, { 'user-agent': this.userAgent, accept: 'application/json' });
    if (answer.status === 429 || answer.status === 503) {
      // The wait it asks for, in seconds; at least a second, at most ten minutes (a nonsense header is a minute).
      const said = Number(answer.headers['retry-after']);
      throw new LrclibWait(Math.min(600_000, Math.max(1000, Number.isFinite(said) ? said * 1000 : 60_000)));
    }
    if (answer.status === 404) return null;
    // Anything else but JSON is not an answer (a page from the network's edge, a proxy's): its status says enough.
    if (answer.status !== 200 || !String(answer.headers['content-type'] ?? '').includes('json')) {
      throw new Error(`LRCLIB answered ${answer.status}`);
    }
    try {
      return JSON.parse(answer.body) as unknown;
    } catch {
      throw new Error('LRCLIB answered with something that is not JSON');
    }
  }

  /** The record matching a song's signature (title, artist, album, length within 2 s), or null when there is none. */
  async match(song: Song): Promise<LrclibRecord | null> {
    const query: Record<string, string> = { track_name: song.title, artist_name: song.artist };
    if (song.album) query.album_name = song.album;
    if (song.seconds !== null) query.duration = String(song.seconds);
    return recordOf(await this.ask('/api/get', query));
  }

  /** Records for a search: by title and artist, or by any words (`q`); at most twenty, as LRCLIB gives. */
  async search(query: { track_name: string; artist_name: string } | { q: string }): Promise<LrclibRecord[]> {
    const found = await this.ask('/api/search', query);
    if (!Array.isArray(found)) return [];
    return found.map(recordOf).filter((record): record is LrclibRecord => record !== null);
  }
}

// Letters and digits only, lower case, for comparing names written differently ("Paper Boats!" and "paper boats").
function folded(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The record of a search that is this song, or null: as long as the track (within 2 s) when its length is known,
 * named like it (one name inside the other, as LRCLIB's names add or drop a "(feat. ...)"), and of those the one
 * with timed lines first, then the one with words, then an instrumental.
 */
export function bestRecord(song: Song, records: readonly LrclibRecord[]): LrclibRecord | null {
  const title = folded(song.title);
  const fits = records.filter((record) => {
    if (song.seconds !== null && Math.abs(record.duration - song.seconds) > 2) return false;
    const name = folded(record.trackName);
    return name !== '' && title !== '' && (name.includes(title) || title.includes(name));
  });
  const rank = (record: LrclibRecord) =>
    record.syncedLyrics ? 0 : record.plainLyrics ? 1 : record.instrumental ? 2 : 3;
  const ranked = [...fits].filter((record) => rank(record) < 3).sort((a, b) => rank(a) - rank(b));
  return ranked[0] ?? null;
}

// ---- the lyrics of a track -----------------------------------------------------------------------------------------

/** What lyrics are looked up with: the client (or a stand-in in tests). */
export interface LyricsLookup {
  match(song: Song): Promise<LrclibRecord | null>;
  search(query: { track_name: string; artist_name: string } | { q: string }): Promise<LrclibRecord[]>;
}

export interface LyricsOptions {
  readonly lyrics: LyricsRepository;
  readonly music: MusicRepository;
  readonly lookup: LyricsLookup;
  readonly log: Logger;
  readonly now?: () => number;
  /** Waits for a time; tests make it instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The pause between two requests to LRCLIB (default 300 ms). */
  readonly gapMs?: number;
}

// "Nothing found" is asked again after a week: LRCLIB fetches songs it lacked in the background.
const NONE_AGAIN_MS = 7 * 86_400_000;
// A track whose lookup failed is not looked up again for this long; asking meanwhile is answered at once.
const FAILED_WAIT_MS = 2 * 60_000;
// The most lookups waiting for their turn; one more is told to come back (lookups happen only for tracks playing,
// so even many servers rarely have this many at once).
const WAITING_MAX = 8;
// Answers ready to send, the newest few: a crowd of panels asking when a track starts reads the database once.
const ANSWERS_KEPT = 64;

/** The lyrics of tracks, from the database or from LRCLIB. */
export class Lyrics implements LyricsSource {
  private readonly options: LyricsOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gapMs: number;
  // Lookups under way or waiting, by track: a second question for the same track waits for the same answer.
  private readonly pending = new Map<number, Promise<LyricsAnswer>>();
  // When each track's last lookup failed (at most a few hundred: entries older than the wait are dropped).
  private readonly failed = new Map<number, number>();
  // The answers kept ready, oldest first.
  private readonly answers = new Map<number, LyricsAnswer>();
  // The line every request to LRCLIB waits in, and the earliest moment the next one may go.
  private line: Promise<unknown> = Promise.resolve();
  private nextAt = 0;

  constructor(options: LyricsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.gapMs = options.gapMs ?? 300;
  }

  /** A track's lyrics: what is kept when it is fresh, else looked up (once, however many ask). */
  async forTrack(track: Track): Promise<LyricsAnswer> {
    const kept = this.options.lyrics.get(track.id);
    if (kept && (kept.kind !== 'none' || this.now() - kept.fetchedAt < NONE_AGAIN_MS)) return this.answer(kept);
    const pending = this.pending.get(track.id);
    if (pending) return pending;
    const failedAt = this.failed.get(track.id);
    if (failedAt !== undefined && this.now() - failedAt < FAILED_WAIT_MS) {
      // Asked again only once the wait after the failure is over.
      throw new LyricsUnavailable(
        'LRCLIB did not answer; try again in a moment',
        FAILED_WAIT_MS - (this.now() - failedAt),
      );
    }
    if (this.pending.size >= WAITING_MAX) {
      throw new LyricsUnavailable('jukecord is looking up other lyrics right now; try again in a moment', 2000);
    }
    const lookup = this.lookUp(track).finally(() => this.pending.delete(track.id));
    this.pending.set(track.id, lookup);
    return lookup;
  }

  // Asks LRCLIB for a track's lyrics and keeps what it says, or that it found nothing. A failure is remembered (see
  // FAILED_WAIT_MS) and said as "unavailable"; it is not kept as "nothing found".
  private async lookUp(track: Track): Promise<LyricsAnswer> {
    const song = songOf(track, this.options.music.get(track.id));
    try {
      const record = song ? await this.find(song) : null;
      const row = this.options.lyrics.save(
        record
          ? {
              trackId: track.id,
              // Timed lines first; LRCLIB marks a song without words as instrumental, with neither text.
              kind: record.syncedLyrics ? 'synced' : record.plainLyrics ? 'plain' : 'instrumental',
              synced: record.syncedLyrics,
              plain: record.plainLyrics,
              sourceId: record.id,
            }
          : { trackId: track.id, kind: 'none', synced: null, plain: null, sourceId: null },
      );
      this.failed.delete(track.id);
      this.options.log.info('looked up lyrics', {
        track: track.title,
        found: row.kind,
        by: song?.tagged ? 'tags' : 'title',
      });
      return this.answer(row);
    } catch (error) {
      const now = this.now();
      this.failed.set(track.id, now);
      // Old failures are forgotten as new ones come, so the map holds only the last two minutes' worth.
      for (const [id, at] of this.failed) if (now - at >= FAILED_WAIT_MS) this.failed.delete(id);
      this.options.log.info('could not look up lyrics', {
        track: track.title,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new LyricsUnavailable('LRCLIB did not answer; try again in a moment', FAILED_WAIT_MS);
    }
  }

  // The record for a song: the exact lookup when the artist is known for sure or guessed, then a search by title and
  // artist, then (for a guess from a title) a search by the title's words. Three requests at most.
  private async find(song: Song): Promise<LrclibRecord | null> {
    const exact = await this.turn(() => this.options.lookup.match(song));
    // The exact lookup already holds the length to 2 s; an instrumental there is an answer too.
    if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) return exact;
    const searched = await this.turn(() =>
      this.options.lookup.search({ track_name: song.title, artist_name: song.artist }),
    );
    const best = bestRecord(song, searched);
    if (best || song.tagged) return best;
    return bestRecord(song, await this.turn(() => this.options.lookup.search({ q: `${song.artist} ${song.title}` })));
  }

  // Runs one request in the line: after the one before it has finished and the pause has passed. A wait LRCLIB asks
  // for holds the line for that long, with up to a third more at random (so clients told to wait together do not
  // come back together).
  private turn<T>(request: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await request();
      } catch (error) {
        if (error instanceof LrclibWait) this.nextAt = this.now() + error.waitMs * (1 + Math.random() / 3);
        throw error;
      } finally {
        this.nextAt = Math.max(this.nextAt, this.now() + this.gapMs);
      }
    };
    const result = this.line.then(run, run);
    // The line goes on whatever this request's end: a failure is its asker's, not the next one's.
    this.line = result.catch(() => {});
    return result;
  }

  // A kept row as it is shown, made once and kept ready for the next ones asking.
  private answer(row: LyricsRow): LyricsAnswer {
    const ready = this.answers.get(row.trackId);
    if (ready && ready.kind === row.kind) return ready;
    const lines = row.kind === 'synced' && row.synced ? parseLrc(row.synced) : [];
    const made: LyricsAnswer = {
      trackId: row.trackId,
      kind: row.kind,
      lines,
      // The words without timings: LRCLIB's own, else the timed lines' words.
      text:
        row.plain ??
        (lines.length > 0
          ? lines
              .map((line) => line.text)
              .join('\n')
              .trim()
          : null),
    };
    this.answers.delete(row.trackId);
    this.answers.set(row.trackId, made);
    while (this.answers.size > ANSWERS_KEPT) {
      const oldest = this.answers.keys().next().value;
      if (oldest === undefined) break;
      this.answers.delete(oldest);
    }
    return made;
  }
}
