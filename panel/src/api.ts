/**
 * The panel's side of the API: one function per action it offers, all through one request function that adds the
 * CSRF header and turns errors into exceptions with jukecord's message.
 *
 * PANEL_ACTIONS lists what the panel can do; the parity test (tests/unit/panel-parity.test.ts) checks it against the
 * shared actions, so a feature cannot exist in Discord or the API and be missing here.
 */

import type { SoundPreset } from '../../src/core/sound.ts';

/** Every action the panel offers, by the shared action names. */
export const PANEL_ACTIONS = [
  'add',
  'play-now',
  'skip',
  'remove-current',
  'pause',
  'resume',
  'seek',
  'repeat',
  'stop',
  'now-playing',
  'queue',
  'remove',
  'move',
  'jump',
  'shuffle',
  'dedupe',
  'clear',
  'history',
  'playlists',
  'playlist-save',
  'playlist-load',
  'playlist-rename',
  'playlist-delete',
  'join',
  'leave',
  'voice-channels',
  'stats',
  'settings',
  'dj-role',
  'status',
  // The login's own operations the panel offers (logs and tokens for the menu and the log page).
  'me',
  'guilds',
  'tokens',
  'token-create',
  'token-revoke',
  'logs',
  'wrapped',
  'alerts-channel',
  'lyrics',
  'stop-after',
  'listen-links',
  'listen-link-create',
  'listen-link-revoke',
  // The host's login links, made in the Invite dialog for a friend (view or control).
  'login-link',
  // How a server's people share the music, and how its voice channel sounds.
  'stay',
  'vote-skip',
  'take-turns',
  'turns-now',
  'person-limit',
  'volume',
  'sound',
  'search',
  'likes',
  'like',
  'unlike',
  'likes-add',
  'autoplay',
  'playlist-export',
  'playlist-import',
] as const;

export type PanelAction = (typeof PANEL_ACTIONS)[number];

/**
 * The actions whose answers reach the panel over the live connection instead of a request: the player, the queue and
 * the voice channel arrive whole when a server is shown and again with every change (src/web/events.ts).
 */
export const LIVE_ACTIONS: Readonly<Partial<Record<PanelAction, string>>> = {
  'now-playing': 'player',
  queue: 'queue',
  'voice-channels': 'voice',
};

/** A refusal from jukecord, with its code (invalid, forbidden, conflict ...). */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The CSRF token of this login, from /me; sent with every change.
let csrf: string | null = null;

/** Remembers the CSRF token (after /me). */
export function setCsrf(token: string | null): void {
  csrf = token;
}

/** Called when a request finds the login gone (the panel shows the login page). */
let onLoggedOut: () => void = () => {};
export function whenLoggedOut(fn: () => void): void {
  onLoggedOut = fn;
}

/** Sends a request to /api/v1 and returns the JSON answer; `signal` drops it (a search typed over). */
export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET' && csrf) headers['x-jukecord-csrf'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Not jukecord's answer: a reverse proxy's or an Ingress's own page (an HTML 502 while jukecord restarts). Said
    // in the panel's words with the status, where the parser's own error was shown before ("Unexpected token '<'").
    if (response.status === 401) onLoggedOut();
    throw new ApiError('no-answer', `jukecord did not answer (${response.status})`, response.status);
  }
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401) onLoggedOut();
    throw new ApiError(
      error?.code ?? String(response.status),
      error?.message ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  return json as T;
}

// The API's shapes, as the panel reads them.
export interface Track {
  id: number;
  url: string;
  title: string;
  uploader: string | null;
  durationMs: number | null;
  thumbnail: string | null;
}
export interface QueueItem {
  id: number;
  position: number;
  track: Track;
  addedBy: string | null;
  addedByName: string | null;
  addedAt: number;
}
export interface Queue {
  items: QueueItem[];
  version: number;
}
export interface Player {
  guildId: string;
  status: 'idle' | 'loading' | 'playing' | 'paused';
  track: Track | null;
  addedBy: string | null;
  addedByName: string | null;
  positionMs: number;
  at: number;
  durationMs: number | null;
  error: string | null;
  repeat: 'off' | 'track' | 'queue';
  progress: number | null;
  version: number;
  /** What the player did by itself ("Title: taken out of the looping queue"), kept until a person changes it. */
  notice: string | null;
  /** Whether the loading track waits for its turn among the fetches of every server. */
  waiting: boolean;
  /** Whether the player stops when this track ends. */
  stopAfter: boolean;
  autoplay: 'off' | 'history' | 'related';
}
/** A skip's answer: the player after it, and how the vote stands when it was a vote the track did not go by. */
export interface SkipAnswer extends Player {
  votes: { votes: number; needed: number } | null;
}
/** The voice channel's sound: its volume in percent and its preset (sent live; browsers apply the preset). */
export interface Sound {
  volume: number;
  preset: SoundPreset;
}
/** How the votes to skip the current track stand (sent live). */
export interface Votes {
  on: boolean;
  votes: number;
  needed: number;
}
export interface AddResult {
  items: QueueItem[];
  skippedTooLong: number;
  skippedFull: number;
  skippedLimit: number;
  skippedNotFound: number;
}
export interface HistoryEntry {
  id: number;
  track: Track;
  addedBy: string | null;
  addedByName: string | null;
  playedAt: number;
  playedMs: number;
}
export interface Playlist {
  id: number;
  name: string;
  size: number;
}
export interface Voice {
  current: { channelId: string; name: string } | null;
  channels: { id: string; name: string; people: number }[];
}
export interface Listener {
  id: string | null;
  name: string;
  avatar: string | null;
  /** A guest of a listening link, and a friend the host let in: named in the panel's words. */
  guest?: boolean;
  friend?: boolean;
}
export interface Listeners {
  people: Listener[];
  count: number;
}
export interface Stats {
  span: number;
  from: string;
  plays: number;
  playedMs: number;
  tracks: number;
  people: number;
  days: { day: string; plays: number; playedMs: number }[];
  hours: number[];
  topTracks: { track: Track; plays: number; playedMs: number }[];
  topPeople: { userId: string | null; name: string | null; avatar: string | null; plays: number; playedMs: number }[];
}
export interface Wrapped {
  period: { kind: 'year' | 'month' | 'last-12-months'; key: string; from: string; to: string };
  plays: number;
  playedMs: number;
  tracks: number;
  people: number;
  days: number;
  topTracks: { track: Track; plays: number; playedMs: number }[];
  topPeople: { userId: string | null; name: string | null; avatar: string | null; plays: number; playedMs: number }[];
  weekdays: number[];
  hours: number[];
  longestDay: { day: string; plays: number; playedMs: number } | null;
  firstTrack: { track: Track; playedAt: number; addedBy: string | null; addedByName: string | null } | null;
  song: { track: Track; plays: number; playedMs: number; days: number } | null;
  keptFrom: string | null;
  years: string[];
  months: string[];
}
export interface Settings {
  djRoleId: string | null;
  roles: { id: string; name: string; color: number }[];
  /** The text channel where jukecord tells this server about trouble, or null for nowhere. */
  alertsChannelId: string | null;
  /** The text channels the bot may post in, to choose it from. */
  channels: { id: string; name: string }[];
  voteSkip: boolean;
  takeTurns: boolean;
  personLimit: number;
  stay: boolean;
  volume: number;
  sound: SoundPreset;
}
export interface Status {
  version: string;
  discord: boolean;
  mode: 'discord' | 'browser-only';
  uptimeMs: number;
  login: { discord: boolean };
  /** Whether lyrics are looked up here (JUKECORD_LYRICS). */
  lyrics: boolean;
}
export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  mayControl: boolean;
  mayManage: boolean;
}
export interface Me {
  kind: 'host' | 'user' | 'friend' | 'guest';
  id: string | null;
  name: string;
  avatar: string | null;
  scope: 'read' | 'control' | 'admin';
  csrf: string | null;
  bot: { id: string; name: string; avatar: string | null } | null;
  /** A guest's server, and when its listening link stops working. */
  guest: { guildId: string; expiresAt: number } | null;
}
export interface Token {
  id: number;
  name: string;
  scope: 'read' | 'control' | 'admin';
  createdAt: number;
  usedAt: number | null;
}
/** A listening link as it is listed (its code was shown once, when it was made). */
export interface ListenLink {
  id: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  expiresAt: number;
  guests: number;
  maxGuests: number;
}
/** The lyrics of the track playing: timed lines (kind synced) and the words without timings. */
export interface Lyrics {
  trackId: number;
  kind: 'synced' | 'plain' | 'instrumental' | 'none';
  lines: { atMs: number; text: string }[];
  text: string | null;
  source: { name: string; url: string } | null;
}
export interface LogRecord {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  msg: string;
  fields: Record<string, unknown>;
}
/** A track a search found, not added yet: its address adds it. */
export interface SearchResult {
  url: string;
  title: string;
  uploader: string | null;
  durationMs: number | null;
  thumbnail: string | null;
}
export interface Found {
  query: string;
  results: SearchResult[];
}
/** A track this login liked, with when. */
export interface Liked {
  track: Track;
  likedAt: number;
}
/** A saved playlist as a file. */
export interface PlaylistFile {
  name: string;
  format: 'text' | 'm3u' | 'json';
  filename: string;
  content: string;
}
/** What an import made. */
export interface Imported {
  playlist: Playlist;
  tracks: number;
  leftOut: number;
}

const g = (guild: string) => `/guilds/${encodeURIComponent(guild)}`;

/** The panel's actions, by name; each says which shared action it is (see PANEL_ACTIONS). */
export const api = {
  add: (guild: string, input: string, at: 'end' | 'next' = 'end') =>
    request<AddResult>('POST', `${g(guild)}/queue`, { input, at }),
  'play-now': (guild: string, input: string) => request<AddResult>('POST', `${g(guild)}/player/play`, { input }),
  // The track it is for, when known: a press that arrives after that track has gone skips nothing more.
  skip: (guild: string, track?: number) =>
    request<SkipAnswer>('POST', `${g(guild)}/player/skip${track === undefined ? '' : `?track=${track}`}`),
  'remove-current': (guild: string) => request<Player>('POST', `${g(guild)}/player/drop`),
  pause: (guild: string) => request<Player>('POST', `${g(guild)}/player/pause`),
  resume: (guild: string) => request<Player>('POST', `${g(guild)}/player/resume`),
  seek: (guild: string, positionMs: number) => request<Player>('POST', `${g(guild)}/player/seek`, { positionMs }),
  repeat: (guild: string, mode: Player['repeat']) => request<Player>('PUT', `${g(guild)}/player/repeat`, { mode }),
  stop: (guild: string) => request<Player>('POST', `${g(guild)}/player/stop`),
  'now-playing': (guild: string) => request<Player>('GET', `${g(guild)}/player`),
  queue: (guild: string) => request<Queue>('GET', `${g(guild)}/queue`),
  remove: (guild: string, item: number) => request<unknown>('DELETE', `${g(guild)}/queue/${item}`),
  move: (guild: string, item: number, index: number) =>
    request<unknown>('POST', `${g(guild)}/queue/${item}/move`, { index }),
  jump: (guild: string, item: number) => request<Player>('POST', `${g(guild)}/queue/${item}/play`),
  shuffle: (guild: string) => request<unknown>('POST', `${g(guild)}/queue/shuffle`),
  dedupe: (guild: string) => request<{ removed: number }>('POST', `${g(guild)}/queue/dedupe`),
  clear: (guild: string) => request<{ removed: number }>('DELETE', `${g(guild)}/queue`),
  history: (guild: string, limit = 50) => request<HistoryEntry[]>('GET', `${g(guild)}/history?limit=${limit}`),
  playlists: (guild: string) => request<Playlist[]>('GET', `${g(guild)}/playlists`),
  'playlist-save': (guild: string, name: string) => request<Playlist>('POST', `${g(guild)}/playlists`, { name }),
  'playlist-load': (guild: string, name: string) =>
    request<AddResult>('POST', `${g(guild)}/playlists/${encodeURIComponent(name)}/load`, { at: 'end' }),
  'playlist-rename': (guild: string, name: string, next: string) =>
    request<Playlist>('PATCH', `${g(guild)}/playlists/${encodeURIComponent(name)}`, { name: next }),
  'playlist-delete': (guild: string, name: string) =>
    request<unknown>('DELETE', `${g(guild)}/playlists/${encodeURIComponent(name)}`),
  join: (guild: string, channelId: string) => request<Voice>('PUT', `${g(guild)}/voice`, { channelId }),
  leave: (guild: string) => request<Voice>('DELETE', `${g(guild)}/voice`),
  'voice-channels': (guild: string) => request<Voice>('GET', `${g(guild)}/voice`),
  stats: (guild: string, days: number) =>
    request<Stats>('GET', `${g(guild)}/stats?days=${days}&tz=${-new Date().getTimezoneOffset()}`),
  settings: (guild: string) => request<Settings>('GET', `${g(guild)}/settings`),
  'dj-role': (guild: string, roleId: string | null) =>
    request<Settings>('PUT', `${g(guild)}/settings/dj-role`, { roleId }),
  status: () => request<Status>('GET', '/status'),
  me: () => request<Me>('GET', '/me'),
  guilds: () => request<Guild[]>('GET', '/guilds'),
  tokens: () => request<Token[]>('GET', '/tokens'),
  'token-create': (name: string, scope: Token['scope']) =>
    request<{ token: string; info: Token }>('POST', '/tokens', { name, scope }),
  'token-revoke': (id: number) => request<unknown>('DELETE', `/tokens/${id}`),
  logs: (query: { level?: string; component?: string; before?: string; limit?: number }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '') params.set(key, String(value));
    return request<LogRecord[]>('GET', `/logs?${params}`);
  },
  // This browser's time zone, so the days and hours are the ones here; no time is this year.
  wrapped: (guild: string, period?: string) =>
    request<Wrapped>(
      'GET',
      `${g(guild)}/wrapped?${new URLSearchParams({ ...(period ? { period } : {}), tz: String(-new Date().getTimezoneOffset()) })}`,
    ),
  'alerts-channel': (guild: string, channelId: string | null) =>
    request<Settings>('PUT', `${g(guild)}/settings/alerts-channel`, { channelId }),
  lyrics: (guild: string) => request<Lyrics>('GET', `${g(guild)}/lyrics`),
  'stop-after': (guild: string, on: boolean) => request<Player>('PUT', `${g(guild)}/player/stop-after`, { on }),
  'listen-links': (guild: string) => request<ListenLink[]>('GET', `${g(guild)}/listen-links`),
  'listen-link-create': (guild: string, days: 1 | 7 | 30) =>
    request<{ url: string; link: ListenLink }>('POST', `${g(guild)}/listen-links`, { days }),
  'listen-link-revoke': (guild: string, id: number) => request<unknown>('DELETE', `${g(guild)}/listen-links/${id}`),
  'login-link': (scope: 'read' | 'control') =>
    request<{ url: string; expiresAt: number; scope: string }>('POST', `/login-links?scope=${scope}`),
  stay: (guild: string, on: boolean) => request<Settings>('PUT', `${g(guild)}/settings/stay`, { on }),
  'vote-skip': (guild: string, on: boolean) => request<Settings>('PUT', `${g(guild)}/settings/vote-skip`, { on }),
  'take-turns': (guild: string, on: boolean) => request<Settings>('PUT', `${g(guild)}/settings/take-turns`, { on }),
  'turns-now': (guild: string) => request<{ moved: number }>('POST', `${g(guild)}/queue/turns`),
  'person-limit': (guild: string, tracks: number) =>
    request<Settings>('PUT', `${g(guild)}/settings/person-limit`, { tracks }),
  volume: (guild: string, percent: number) => request<Sound>('PUT', `${g(guild)}/voice/volume`, { percent }),
  sound: (guild: string, preset: SoundPreset) => request<Sound>('PUT', `${g(guild)}/voice/sound`, { preset }),
  search: (guild: string, words: string, limit: number, signal?: AbortSignal) =>
    request<Found>(
      'GET',
      `${g(guild)}/search?${new URLSearchParams({ q: words, limit: String(limit) })}`,
      undefined,
      signal,
    ),
  likes: (guild: string) => request<Liked[]>('GET', `${g(guild)}/likes`),
  like: (guild: string, track: number) => request<Liked>('PUT', `${g(guild)}/likes/${track}`),
  unlike: (guild: string, track: number) => request<unknown>('DELETE', `${g(guild)}/likes/${track}`),
  'likes-add': (guild: string, at: 'end' | 'next' = 'end') =>
    request<AddResult>('POST', `${g(guild)}/likes/queue`, { at }),
  autoplay: (guild: string, mode: Player['autoplay']) =>
    request<Player>('PUT', `${g(guild)}/player/autoplay`, { mode }),
  'playlist-export': (guild: string, name: string, format: PlaylistFile['format']) =>
    request<PlaylistFile>('GET', `${g(guild)}/playlists/${encodeURIComponent(name)}/export?format=${format}`),
  'playlist-import': (guild: string, name: string, content: string) =>
    request<Imported>('POST', `${g(guild)}/playlists/import`, { name, content }),
} satisfies Record<PanelAction, (...args: never[]) => Promise<unknown>>;

/** Ends the login (the cookie goes) and shows the login page. */
export async function logOut(): Promise<void> {
  await fetch('/auth/logout', {
    method: 'POST',
    headers: csrf ? { 'x-jukecord-csrf': csrf } : {},
    credentials: 'same-origin',
  });
}

/**
 * The address of a track's cover, which jukecord serves from its own cache (the browser never asks the image hosts,
 * and a canvas may draw it), or null when the site gave the track no picture.
 */
export function coverUrl(guild: string, track: Track): string | null {
  return track.thumbnail ? `/api/v1${g(guild)}/tracks/${track.id}/cover` : null;
}

/**
 * The address of a search result's picture, which jukecord serves as it serves a track's cover (the browser never asks
 * the image host), or null when the site gave the result no picture.
 */
export function searchCoverUrl(guild: string, result: SearchResult): string | null {
  return result.thumbnail ? `/api/v1${g(guild)}/search/cover?${new URLSearchParams({ url: result.url })}` : null;
}

/**
 * Comes in as a guest with a listening link's code (from the address's "#", which never reaches a server): the cookie
 * comes back with the answer. Throws ApiError with jukecord's reason when it does not work.
 */
export async function joinListen(code: string): Promise<void> {
  const response = await fetch('/auth/listen', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ code }),
  });
  if (response.ok) return;
  const json = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  throw new ApiError(json?.error?.code ?? String(response.status), json?.error?.message ?? '', response.status);
}
