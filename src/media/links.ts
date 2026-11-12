/**
 * Links from music services that yt-dlp cannot play: Deezer, Spotify and Apple Music. jukecord reads what the link
 * holds (a track, an album, a playlist: each track's title, artists and length), finds each one on YouTube, and adds
 * the YouTube recordings in the link's order.
 *
 * - Deezer: its public API (api.deezer.com), no key; tracks, albums and playlists.
 * - Spotify: with the host's own Spotify app (JUKECORD_SPOTIFY_CLIENT_ID and _SECRET), its Web API for tracks, albums
 *   and playlists; without it, a single track from its page's public metadata.
 * - Apple Music: a single track, from its page's public metadata.
 *
 * Every request goes through publicFetch (public addresses only). A link gives at most a hundred tracks; each is
 * searched on YouTube in the turns of BatchLookups (three at a time across every list), and the recording kept is the
 * one whose length is within a few seconds of the track's, an official audio upload first. A match found once is kept
 * for a while, so the same album added again finds its tracks at once.
 */
import type { NewTrack, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { TrackRepository } from '../store/store.ts';
import { BATCH_MOST, type BatchLookups } from './batch.ts';
import type { FetchAnswer, PublicFetch } from './fetch.ts';
import type { YtDlp } from './ytdlp.ts';

/** The services whose links jukecord reads. */
export type LinkService = 'deezer' | 'spotify' | 'apple-music';

export const LINK_SERVICES: readonly LinkService[] = ['deezer', 'spotify', 'apple-music'];

/** One track a link holds, as its service describes it. */
export interface LinkTrack {
  /** The service and the track's ID there, for remembering its match. */
  readonly key: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly durationMs: number | null;
}

/** A link refused for what it is (not for a failure on the way): said to the person as it is. */
export class LinkError extends Error {
  override name = 'LinkError';
  readonly code: 'invalid' | 'not-found' | 'unavailable';
  constructor(code: 'invalid' | 'not-found' | 'unavailable', message: string) {
    super(message);
    this.code = code;
  }
}

// What a link points at: the service, the kind of thing, and its ID there.
interface Target {
  readonly service: LinkService;
  readonly kind: 'track' | 'album' | 'playlist' | 'short';
  readonly id: string;
  readonly url: URL;
}

/** The service a link is from, and what it points at; null for an address of none of them. */
export function linkTarget(text: string): Target | null {
  const trimmed = text.trim();
  // spotify:track:ID, as Spotify's own apps copy it.
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(trimmed);
  if (uri) {
    const kind = uri[1] as 'track' | 'album' | 'playlist';
    return { service: 'spotify', kind, id: uri[2] ?? '', url: new URL(`https://open.spotify.com/${kind}/${uri[2]}`) };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (/\s/.test(trimmed) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // A language before the kind, as Deezer and Spotify add for some countries ("/fr/album/...", "/intl-ko/track/...").
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'deezer.com') {
    const at = parts.findIndex((part) => part === 'track' || part === 'album' || part === 'playlist');
    const id = parts[at + 1];
    if (at >= 0 && id && /^\d+$/.test(id)) return { service: 'deezer', kind: parts[at] as Target['kind'], id, url };
    return null;
  }
  if (host === 'link.deezer.com' || host === 'deezer.page.link')
    return { service: 'deezer', kind: 'short', id: '', url };
  if (host === 'open.spotify.com') {
    const at = parts.findIndex((part) => part === 'track' || part === 'album' || part === 'playlist');
    const id = parts[at + 1];
    if (at >= 0 && id && /^[A-Za-z0-9]{22}$/.test(id))
      return { service: 'spotify', kind: parts[at] as Target['kind'], id, url };
    return null;
  }
  if (host === 'spotify.link') return { service: 'spotify', kind: 'short', id: '', url };
  if (host === 'music.apple.com' || host === 'geo.music.apple.com') {
    // A song's own page ("/us/song/name/ID"), or an album's page pointing at one of its songs ("?i=ID").
    const song = parts[1] === 'song' ? parts.at(-1) : null;
    const inAlbum = parts[1] === 'album' ? url.searchParams.get('i') : null;
    const id = song ?? inAlbum;
    if (id && /^\d+$/.test(id)) return { service: 'apple-music', kind: 'track', id, url };
    if (parts[1] === 'album' || parts[1] === 'playlist') return { service: 'apple-music', kind: 'album', id: '', url };
    return null;
  }
  return null;
}

// The words between parentheses or after a dash that mark a version (people search for the song, not the edition).
const VERSION =
  /\s*[([][^)\]]*(remaster|edition|version|mono|stereo|deluxe|anniversary)[^)\]]*[)\]]|\s+-\s+.*(remaster|edition|version).*$/gi;
// Words that make a recording another one than the track (unless the track's own title has them).
const OTHER = [
  'live',
  'cover',
  'remix',
  'karaoke',
  'instrumental',
  'sped up',
  'slowed',
  'reverb',
  'nightcore',
  '8d',
  'acapella',
  'a cappella',
];

// Words of a title or a name, without case, accents and punctuation, for comparing.
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The YouTube recording of a track among what a search found: within fifteen seconds of its length (when both are
 * known), most of its title's words, none of the words of another version (live, cover, remix ...) the track does
 * not have, and among those the closest in length and official audio first (a "Topic" channel, "official audio").
 * Null when none will do.
 */
export function bestMatch(track: LinkTrack, found: readonly NewTrack[]): NewTrack | null {
  const title = words(track.title.replace(VERSION, ''));
  const own = words(`${track.title} ${track.artists.join(' ')}`);
  const artist = words(track.artists[0] ?? '');
  let best: { candidate: NewTrack; score: number } | null = null;
  for (const [rank, candidate] of found.entries()) {
    const theirs = words(`${candidate.title} ${candidate.uploader ?? ''}`);
    const seen = new Set(theirs);
    // Most of the title's words, or the recording is another song.
    const shared = title.filter((word) => seen.has(word)).length;
    if (title.length > 0 && shared / title.length < 0.6) continue;
    // Another version the track is not.
    const joined = ` ${theirs.join(' ')} `;
    if (OTHER.some((word) => joined.includes(` ${word} `) && !` ${own.join(' ')} `.includes(` ${word} `))) continue;
    let score = 0;
    if (track.durationMs !== null && candidate.durationMs !== null) {
      const off = Math.abs(track.durationMs - candidate.durationMs);
      if (off > 15_000) continue;
      score += off <= 3_000 ? 4 : off <= 7_000 ? 2 : 0;
    }
    if (/ - topic$/i.test(candidate.uploader ?? '')) score += 3;
    else if (/official audio/i.test(candidate.title)) score += 2;
    if (artist.length > 0 && artist.every((word) => seen.has(word))) score += 1;
    // YouTube's own order breaks ties (its first results are the likeliest).
    score -= rank * 0.1;
    if (!best || score > best.score) best = { candidate, score };
  }
  return best?.candidate ?? null;
}

export interface LinksOptions {
  readonly fetch: PublicFetch;
  readonly ytdlp: Pick<YtDlp, 'search'>;
  readonly tracks: TrackRepository;
  readonly batch: BatchLookups;
  readonly log: Logger;
  /** The services read (JUKECORD_LINK_SERVICES); a link of another is refused as not read here. */
  readonly services: ReadonlySet<LinkService>;
  /** The host's Spotify app, for albums and playlists (and tracks without their pages). */
  readonly spotify?: { readonly clientId: string; readonly clientSecret: string } | null;
  /** The clock the matches and the Spotify token are kept by (tests set it). */
  readonly now?: () => number;
}

/** What a link added: its tracks found on YouTube, in order, and how many were not. */
export interface LinkResult {
  readonly tracks: Track[];
  readonly notFound: number;
}

// The names the services go by, in what jukecord says.
const NAMES: Readonly<Record<LinkService, string>> = {
  deezer: 'Deezer',
  spotify: 'Spotify',
  'apple-music': 'Apple Music',
};
// How long a match is kept, and how many.
const MATCH_KEEP_MS = 24 * 3_600_000;
const MATCHES_KEPT = 5000;

export class Links {
  private readonly options: LinksOptions;
  private readonly now: () => number;
  // Matches by the track's key, oldest first.
  private readonly matches = new Map<string, { at: number; track: NewTrack }>();
  // The Spotify app's token, and when it stops working.
  private spotifyToken: { token: string; until: number } | null = null;

  constructor(options: LinksOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Whether an input is a link of one of the services (turned off or not: one turned off is refused when added). */
  handles(text: string): boolean {
    return linkTarget(text) !== null;
  }

  /**
   * The tracks of a link, each found on YouTube and stored, in the link's order. `each` hears the tracks as soon as
   * they and every track before them are decided (found or not), so the first can play while the rest are searched.
   */
  async resolve(
    text: string,
    ask: { who?: string | null; signal?: AbortSignal; each?: (tracks: Track[]) => void } = {},
  ): Promise<LinkResult> {
    let target = linkTarget(text);
    if (!target) throw new LinkError('invalid', 'that is not a link jukecord reads');
    if (!this.options.services.has(target.service))
      throw new LinkError('unavailable', `jukecord does not read ${NAMES[target.service]} links here`);
    if (target.kind === 'short') target = await this.unshorten(target, ask.signal);
    const listed = (await this.list(target, ask.signal)).slice(0, BATCH_MOST);
    if (listed.length === 0)
      throw new LinkError('not-found', `there are no tracks at that ${NAMES[target.service]} link`);
    // Decided so far, in order, and how far the tracks handed on have reached.
    const decided: (Track | null | undefined)[] = listed.map(() => undefined);
    let handed = 0;
    const handOn = () => {
      const ready: Track[] = [];
      while (handed < decided.length && decided[handed] !== undefined) {
        const track = decided[handed];
        if (track) ready.push(track);
        handed += 1;
      }
      if (ready.length > 0) ask.each?.(ready);
    };
    await this.options.batch.map(ask.who ?? null, listed, (track, signal) => this.match(track, signal), {
      ...(ask.signal ? { signal: ask.signal } : {}),
      each: (index, result) => {
        decided[index] = result instanceof Error ? null : result;
        if (result instanceof Error && !(ask.signal?.aborted ?? false))
          this.options.log.debug('a track of a link was not found on YouTube', { reason: result.message });
        handOn();
      },
    });
    const tracks = decided.filter((track): track is Track => Boolean(track));
    return { tracks, notFound: decided.length - tracks.length };
  }

  // A track's YouTube recording, from what was found before or from a search; stored as a track.
  private async match(track: LinkTrack, signal: AbortSignal): Promise<Track> {
    const kept = this.matches.get(track.key);
    if (kept && this.now() - kept.at < MATCH_KEEP_MS) return this.options.tracks.upsert(kept.track);
    const query = `${track.artists.slice(0, 2).join(' ')} ${track.title}`.trim();
    const found = await this.options.ytdlp.search(query, 6, signal);
    const best = bestMatch(track, found);
    if (!best) throw new Error(`no recording of "${query}" fits`);
    this.matches.delete(track.key);
    this.matches.set(track.key, { at: this.now(), track: best });
    while (this.matches.size > MATCHES_KEPT) {
      const oldest = this.matches.keys().next().value;
      if (oldest === undefined) break;
      this.matches.delete(oldest);
    }
    return this.options.tracks.upsert(best);
  }

  // Where a short link leads (its redirects, followed and checked like any address).
  private async unshorten(target: Target, signal?: AbortSignal): Promise<Target> {
    const answer = await this.get(target.url.href, signal, { until: '<head' });
    const real = linkTarget(answer.url);
    if (!real || real.kind === 'short' || real.service !== target.service)
      throw new LinkError('not-found', `that ${NAMES[target.service]} link leads to nothing jukecord reads`);
    return real;
  }

  // The tracks a link holds, as its service lists them.
  private async list(target: Target, signal?: AbortSignal): Promise<LinkTrack[]> {
    if (target.service === 'deezer') return this.deezer(target, signal);
    if (target.service === 'spotify') return this.spotify(target, signal);
    if (target.kind !== 'track')
      throw new LinkError('invalid', 'jukecord reads single Apple Music tracks, not albums or playlists');
    return [await this.applePage(target, signal)];
  }

  // Deezer's public API: a track, or the first hundred tracks of an album or a playlist.
  private async deezer(target: Target, signal?: AbortSignal): Promise<LinkTrack[]> {
    const path =
      target.kind === 'track' ? `track/${target.id}` : `${target.kind}/${target.id}/tracks?limit=${BATCH_MOST}`;
    const data = this.json(await this.get(`https://api.deezer.com/${path}`, signal)) as {
      error?: unknown;
      data?: unknown[];
    };
    // Deezer answers 200 with an error inside for what it does not have.
    if (data.error) throw new LinkError('not-found', 'Deezer has nothing at that link');
    const items = target.kind === 'track' ? [data] : Array.isArray(data.data) ? data.data : [];
    return items.flatMap((raw) => {
      const item = raw as { id?: unknown; title?: unknown; duration?: unknown; artist?: { name?: unknown } };
      if (typeof item.title !== 'string' || !item.title.trim()) return [];
      return [
        {
          key: `deezer:${String(item.id)}`,
          title: item.title.trim(),
          artists: typeof item.artist?.name === 'string' ? [item.artist.name] : [],
          durationMs: typeof item.duration === 'number' && item.duration > 0 ? item.duration * 1000 : null,
        },
      ];
    });
  }

  // Spotify: its Web API with the host's app; without one, a track from its page.
  private async spotify(target: Target, signal?: AbortSignal): Promise<LinkTrack[]> {
    if (!this.options.spotify) {
      if (target.kind === 'track') return [await this.spotifyPage(target, signal)];
      throw new LinkError(
        'unavailable',
        'Spotify albums and playlists need the host’s Spotify app (JUKECORD_SPOTIFY_CLIENT_ID and JUKECORD_SPOTIFY_CLIENT_SECRET)',
      );
    }
    const token = await this.spotifyAuth(signal);
    const call = async (path: string) => {
      const answer = await this.get(`https://api.spotify.com/v1/${path}`, signal, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (answer.status === 404) throw new LinkError('not-found', 'Spotify has nothing at that link');
      return this.json(answer);
    };
    type Item = { id?: unknown; name?: unknown; duration_ms?: unknown; artists?: { name?: unknown }[]; type?: unknown };
    const read = (item: Item | null | undefined): LinkTrack[] => {
      if (!item || typeof item.name !== 'string' || (item.type !== undefined && item.type !== 'track')) return [];
      return [
        {
          key: `spotify:${String(item.id)}`,
          title: item.name,
          artists: (item.artists ?? []).flatMap((artist) => (typeof artist.name === 'string' ? [artist.name] : [])),
          durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : null,
        },
      ];
    };
    if (target.kind === 'track') return read((await call(`tracks/${target.id}`)) as Item);
    if (target.kind === 'album') {
      // Fifty to a page: two pages make the hundred.
      const tracks: LinkTrack[] = [];
      for (let offset = 0; offset < BATCH_MOST; offset += 50) {
        const page = (await call(`albums/${target.id}/tracks?limit=50&offset=${offset}`)) as {
          items?: Item[];
          next?: unknown;
        };
        tracks.push(...(page.items ?? []).flatMap(read));
        if (!page.next) break;
      }
      return tracks;
    }
    const page = (await call(
      `playlists/${target.id}/tracks?limit=${BATCH_MOST}&fields=items(track(id,name,duration_ms,type,artists(name)))`,
    )) as { items?: { track?: Item | null }[] };
    return (page.items ?? []).flatMap((entry) => read(entry.track));
  }

  // The app's token (client credentials), kept until a minute before it stops working.
  private async spotifyAuth(signal?: AbortSignal): Promise<string> {
    const kept = this.spotifyToken;
    if (kept && this.now() < kept.until) return kept.token;
    const app = this.options.spotify;
    if (!app) throw new LinkError('unavailable', 'Spotify is not set up here');
    const answer = await this.get('https://accounts.spotify.com/api/token', signal, {
      method: 'POST',
      body: 'grant_type=client_credentials',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    if (answer.status === 400 || answer.status === 401)
      throw new LinkError('unavailable', 'Spotify refused the host’s Spotify app (JUKECORD_SPOTIFY_CLIENT_ID)');
    const data = this.json(answer) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string') throw new Error('Spotify gave no token');
    const seconds = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.spotifyToken = { token: data.access_token, until: this.now() + Math.max(60, seconds - 60) * 1000 };
    return data.access_token;
  }

  // A Spotify track from its page: the title, the artists and the length its head says.
  private async spotifyPage(target: Target, signal?: AbortSignal): Promise<LinkTrack> {
    const page = await this.get(`https://open.spotify.com/track/${target.id}`, signal, { until: '</head>' });
    if (page.status === 404) throw new LinkError('not-found', 'Spotify has nothing at that link');
    const meta = metaTags(page.text);
    const title = meta.get('og:title')?.[0];
    if (!title) throw new LinkError('not-found', 'the Spotify page does not say what the track is');
    // "Artist · Album · Song · Year" when the page names no musician of its own.
    const artists = meta.get('music:musician_description') ?? [meta.get('og:description')?.[0]?.split(' · ')[0] ?? ''];
    const seconds = Number(meta.get('music:duration')?.[0]);
    return {
      key: `spotify:${target.id}`,
      title,
      artists: artists.filter(Boolean),
      durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    };
  }

  // An Apple Music track from its page: the facts its head gives, the structured ones first.
  private async applePage(target: Target, signal?: AbortSignal): Promise<LinkTrack> {
    const page = await this.get(target.url.href, signal, { until: '</head>' });
    if (page.status === 404) throw new LinkError('not-found', 'Apple Music has nothing at that link');
    const meta = metaTags(page.text);
    const data = structured(page.text);
    const title = data?.name ?? meta.get('apple:title')?.[0];
    if (!title) throw new LinkError('not-found', 'the Apple Music page does not say what the track is');
    // "Title by Artist on Apple Music" when the structured facts name nobody.
    const byOg = /^.+ by (.+) on Apple Music$/.exec(meta.get('og:title')?.[0] ?? '')?.[1];
    const artists = data?.artists.length ? data.artists : byOg ? [byOg] : [];
    const duration = isoDuration(data?.duration ?? meta.get('music:song:duration')?.[0] ?? '');
    return { key: `apple-music:${target.id}`, title, artists, durationMs: duration };
  }

  // A GET (or the POST asked for) through the public fetch, a failure of the network said plainly.
  private async get(
    address: string,
    signal: AbortSignal | undefined,
    options: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; until?: string } = {},
  ): Promise<FetchAnswer> {
    try {
      return await this.options.fetch(address, { ...options, ...(signal ? { signal } : {}), timeoutMs: 15_000 });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.options.log.info('a request to a music service failed', {
        address: new URL(address).origin,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new LinkError('unavailable', `${new URL(address).hostname} did not answer`);
    }
  }

  // An answer read as JSON; anything else is a failure of the service.
  private json(answer: FetchAnswer): unknown {
    if (answer.status >= 500 || answer.status === 429) throw new LinkError('unavailable', 'the music service is busy');
    try {
      return JSON.parse(answer.text);
    } catch {
      throw new LinkError('unavailable', 'the music service answered something that is not JSON');
    }
  }
}

/** The meta tags of a page's head, by their property or name (a tag may come more than once: every value is kept). */
export function metaTags(html: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of html.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attributes = match[1] ?? '';
    const key = /(?:property|name)\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
    const content = /content\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
    if (!key || content === undefined) continue;
    const values = found.get(key) ?? [];
    values.push(entities(content));
    found.set(key, values);
  }
  return found;
}

// The structured facts of a song's page (its ld+json MusicRecording, alone or inside a MusicComposition).
function structured(html: string): { name: string | null; artists: string[]; duration: string | null } | null {
  for (const match of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1] ?? '');
    } catch {
      continue;
    }
    const root = data as { audio?: unknown };
    const recording = (root.audio ?? root) as { name?: unknown; duration?: unknown; byArtist?: unknown };
    const artists = (Array.isArray(recording.byArtist) ? recording.byArtist : [recording.byArtist]).flatMap((artist) =>
      typeof (artist as { name?: unknown })?.name === 'string' ? [(artist as { name: string }).name] : [],
    );
    if (typeof recording.name === 'string')
      return {
        name: recording.name,
        artists,
        duration: typeof recording.duration === 'string' ? recording.duration : null,
      };
  }
  return null;
}

// An ISO 8601 length ("PT3M33S") in milliseconds, or null.
function isoDuration(text: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text.trim());
  if (!match || !(match[1] || match[2] || match[3])) return null;
  return Math.round(((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000);
}

// The few character references pages write in their attributes.
function entities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}
