/**
 * What the panel knows, in one object, and who to tell when part of it changes.
 *
 * Views subscribe to the keys they draw. A change names its keys, so the queue redrawing does not redraw the disc,
 * and a snapshot that arrives twice does not repaint anything.
 */
import { sayError } from '../../src/core/say.ts';
import type { Guild, HistoryEntry, Liked, Listeners, Me, Player, Queue, Sound, Status, Voice, Votes } from './api.ts';
import { type Lang, pickLang, type Words, words } from './i18n.ts';
import type { LiveStatus } from './live.ts';

export interface State {
  me: Me | null;
  status: Status | null;
  guilds: Guild[];
  guild: Guild | null;
  player: Player | null;
  queue: Queue | null;
  voice: Voice | null;
  listeners: Listeners;
  history: HistoryEntry[];
  live: LiveStatus;
  /** Why jukecord asked the live connection to try again later (1013), while it waits ('' when it gave no reason);
   * null otherwise. */
  liveWaiting: string | null;
  lang: Lang;
  /** The menu's choices, kept in this browser. */
  theme: 'system' | 'light' | 'dark';
  langChoice: 'auto' | 'en' | 'ko';
  motion: boolean;
  /** Whether this browser plays along, and how loud (0 to 1). */
  listening: boolean;
  volume: number;
  /** How the votes to skip the current track stand in the server shown. */
  votes: Votes;
  /** The voice channel's sound in the server shown (this browser applies its preset while it listens). */
  sound: Sound;
  /** The tracks this login liked, newest first; null until they are known. */
  liked: Liked[] | null;
}

type Key = keyof State;
type Listener = (changed: ReadonlySet<Key>) => void;

// Settings kept in this browser, read with care: private windows can refuse storage.
function stored(name: string): string | null {
  try {
    return localStorage.getItem(`jukecord.${name}`);
  } catch {
    return null;
  }
}

/** Saves a setting in this browser (silently skipped where storage is refused). */
export function keep(name: string, value: string): void {
  try {
    localStorage.setItem(`jukecord.${name}`, value);
  } catch {
    // Not kept; it still applies until the page closes.
  }
}

/** No vote to skip: votes off, or none cast (the state before the server's own arrives, and after a switch). */
export const NO_VOTES: Votes = { on: false, votes: 0, needed: 0 };

/** The plain sound: the track as it is (before the server's own arrives, and after a switch). */
export const PLAIN: Sound = { volume: 100, preset: 'off' };

const langChoice = (stored('lang') ?? 'auto') as State['langChoice'];
const volume = Number(stored('volume') ?? '0.6');

export const state: State = {
  me: null,
  status: null,
  guilds: [],
  guild: null,
  player: null,
  queue: null,
  voice: null,
  listeners: { people: [], count: 0 },
  history: [],
  live: 'connecting',
  liveWaiting: null,
  lang: pickLang(langChoice === 'auto' ? null : langChoice),
  theme: (stored('theme') ?? 'system') as State['theme'],
  langChoice,
  motion: stored('motion') !== 'off',
  listening: false,
  volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.6,
  votes: NO_VOTES,
  sound: PLAIN,
  liked: null,
};

const listeners = new Set<Listener>();

// While a page is being built, the watches it makes are collected here, so leaving the page can stop them.
let collector: (() => void)[] | null = null;

/** Builds a page and returns it with a function that stops everything it watches. */
export function collect<T>(build: () => T): { value: T; dispose: () => void } {
  const previous = collector;
  const stops: (() => void)[] = [];
  collector = stops;
  try {
    return {
      value: build(),
      dispose: () => {
        for (const stop of stops) stop();
      },
    };
  } finally {
    collector = previous;
  }
}

/** Changes part of the state and tells the views that draw it. */
export function update(changes: Partial<State>): void {
  const changed = new Set<Key>();
  for (const [key, value] of Object.entries(changes) as [Key, unknown][]) {
    if (state[key] === value) continue;
    (state as unknown as Record<Key, unknown>)[key] = value;
    changed.add(key);
  }
  if (changed.size === 0) return;
  for (const listener of listeners) listener(changed);
}

/** Calls `fn` when any of `keys` changes; returns the way to stop. */
export function watch(keys: readonly Key[], fn: () => void): () => void {
  const listener: Listener = (changed) => {
    if (keys.some((key) => changed.has(key))) fn();
  };
  listeners.add(listener);
  const stop = () => {
    listeners.delete(listener);
  };
  collector?.push(stop);
  return stop;
}

/**
 * Why there are no live updates, in the person's language, while there are none for a reason: this page's address is
 * refused for good, or jukecord asked to be tried again later (its reason). Null while connected or just connecting.
 */
export function liveWhy(): string | null {
  if (state.live === 'refused') return t().wrongAddress;
  if (state.live === 'open' || state.liveWaiting === null) return null;
  return state.liveWaiting ? sayError(state.liveWaiting, state.lang) : t().liveLater;
}

/** The words of the language in use. */
export function t(): Words {
  return words(state.lang);
}

/** Whether the person may change the music in the server shown. */
export function mayControl(): boolean {
  return Boolean(state.guild?.mayControl) && state.me?.scope !== 'read';
}

/**
 * Why the person may not change the music: a login that may only look (a friend's View link, a read token), or a server
 * whose DJ role they lack. (A View login was told about the DJ role, even in a jukecord without Discord.)
 */
export function lookOnlyWhy(): string {
  return state.me?.scope === 'read' ? t().viewOnlyHint : t().lookOnlyHint;
}

/** Whether the person may press Skip: to skip, or (without the DJ role, where Skip is a vote) to vote. */
export function maySkip(): boolean {
  return mayControl() || (state.votes.on && state.me?.scope !== 'read');
}

/** The track's position now: the snapshot's place plus the time since, while playing (in the server's time). */
export function positionNow(player: Player, serverNow: number): number {
  const moving = player.status === 'playing' ? Math.max(0, serverNow - player.at) : 0;
  const position = player.positionMs + moving;
  return player.durationMs ? Math.min(position, player.durationMs) : position;
}

/** Whether this login liked a track. */
export function isLiked(trackId: number): boolean {
  return state.liked?.some((entry) => entry.track.id === trackId) ?? false;
}
