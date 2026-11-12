/**
 * A saved playlist as a file, and back: a text file of addresses (one per line, for any tool), an M3U (what music
 * players read and write), and jukecord's own JSON (every track with its title, channel, length and picture, so a
 * playlist moves to another jukecord as it was). Reading takes any of the three, or a list pasted by hand: a line that
 * is an address is that track, any other line is words to search for (an M3U from a music player names files, read as
 * the song's name).
 *
 * Nothing in a file is trusted further than its shape: addresses must be http(s), values are cut to sizes a track may
 * have, and a picture must be https. What the file says is only kept for an address jukecord does not know yet; one it
 * knows keeps what it learned itself.
 */
import type { Track } from '../core/types.ts';

/** The kinds of file a playlist goes out as and comes in from. */
export type PlaylistFormat = 'text' | 'm3u' | 'json';

export const PLAYLIST_FORMATS: readonly PlaylistFormat[] = ['text', 'm3u', 'json'];

/** One entry of a file read back: an address (with what the file says about it), or words to search for. */
export interface FileEntry {
  readonly url: string | null;
  readonly words: string | null;
  readonly title: string | null;
  readonly uploader: string | null;
  readonly durationMs: number | null;
  readonly thumbnail: string | null;
}

/** What a file held: its kind, the playlist's name when it says one, and its entries in order. */
export interface PlaylistFile {
  readonly format: PlaylistFormat;
  readonly name: string | null;
  readonly entries: FileEntry[];
}

/** A file the reader cannot take (broken JSON, a JSON that is not a playlist). */
export class PlaylistFileError extends Error {
  override name = 'PlaylistFileError';
}

// The marker of jukecord's JSON, and the version of its shape.
const KIND = 'jukecord playlist';
const VERSION = 1;

// The extension of each kind of file.
const EXTENSION: Readonly<Record<PlaylistFormat, string>> = { text: 'txt', m3u: 'm3u', json: 'json' };

/** A file name for a playlist: its name without the characters file systems refuse, and the kind's extension. */
export function fileName(name: string, format: PlaylistFormat): string {
  // Each character a file system refuses (the separators, wildcards, quotes and control characters) becomes "_".
  const clean = [...name]
    .map((character) => (character < ' ' || '\\/:*?"<>|'.includes(character) ? '_' : character))
    .join('')
    .trim()
    .slice(0, 80);
  return `${clean || 'playlist'}.${EXTENSION[format]}`;
}

/** A playlist as a file of the kind asked for. */
export function writePlaylist(
  name: string,
  tracks: readonly Track[],
  format: PlaylistFormat,
  now = new Date(),
): string {
  if (format === 'text') return tracks.map((track) => `${track.url}\n`).join('');
  if (format === 'm3u') {
    const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`];
    for (const track of tracks) {
      // The length in whole seconds (-1: unknown, as M3U says it), then "channel - title" as players show it.
      const seconds = track.durationMs === null ? -1 : Math.round(track.durationMs / 1000);
      const label = track.uploader ? `${oneLine(track.uploader)} - ${oneLine(track.title)}` : oneLine(track.title);
      lines.push(`#EXTINF:${seconds},${label}`, track.url);
    }
    return `${lines.join('\n')}\n`;
  }
  return `${JSON.stringify(
    {
      kind: KIND,
      version: VERSION,
      name,
      exported: now.toISOString(),
      tracks: tracks.map((track) => ({
        url: track.url,
        title: track.title,
        uploader: track.uploader,
        durationMs: track.durationMs,
        thumbnail: track.thumbnail,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Reads a playlist file of any of the three kinds, or a list pasted by hand (which reads as the text kind). */
export function readPlaylist(content: string): PlaylistFile {
  // A byte order mark and Windows line ends, as files from elsewhere often have.
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const start = text.trimStart();
  if (start.startsWith('{')) return readJson(start);
  if (/^#EXTM3U\b/.test(start) || /^#EXTINF:/m.test(start)) return readM3u(text);
  return readText(text);
}

// jukecord's JSON: the name and the tracks, each with an address.
function readJson(text: string): PlaylistFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PlaylistFileError('the file is not valid JSON');
  }
  const root = data as { kind?: unknown; name?: unknown; tracks?: unknown };
  if (root === null || typeof root !== 'object' || root.kind !== KIND || !Array.isArray(root.tracks))
    throw new PlaylistFileError('the JSON is not a jukecord playlist');
  const entries: FileEntry[] = [];
  for (const raw of root.tracks) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const url = address(item.url);
    // An entry without a usable address is left out (it is counted as such by the import).
    entries.push({
      url,
      words: null,
      title: cut(item.title, 300),
      uploader: cut(item.uploader, 200),
      durationMs: length(item.durationMs),
      thumbnail: picture(item.thumbnail),
    });
  }
  return { format: 'json', name: cut(root.name, 100), entries };
}

// An M3U: #EXTINF lines say the next entry's length and name; an entry is an address, or a file named after its song.
function readM3u(text: string): PlaylistFile {
  let name: string | null = null;
  let pending: { seconds: number | null; label: string | null } | null = null;
  const entries: FileEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const playlist = /^#PLAYLIST:(.*)$/.exec(line);
    if (playlist) {
      name = cut(playlist[1], 100);
      continue;
    }
    // "#EXTINF:215 tvg-id="x",Name": the length, attributes before the comma, the name after it.
    const info = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)[^,]*,(.*)$/.exec(line);
    if (info) {
      const seconds = Number(info[1]);
      pending = { seconds: seconds >= 0 ? seconds : null, label: cut(info[2], 300) };
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = address(line);
    const durationMs =
      pending?.seconds === null || pending?.seconds === undefined ? null : Math.round(pending.seconds * 1000);
    if (url) {
      entries.push({
        url,
        words: null,
        title: pending?.label ?? null,
        uploader: null,
        durationMs: length(durationMs),
        thumbnail: null,
      });
    } else {
      // A file on someone's disk: its song by the name the list gave it, else by the file's own name.
      const fromFile = (line.split(/[\\/]/).pop() ?? line).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
      entries.push({
        url: null,
        words: cut(pending?.label ?? fromFile, 200),
        title: null,
        uploader: null,
        durationMs: null,
        thumbnail: null,
      });
    }
    pending = null;
  }
  return { format: 'm3u', name, entries };
}

// Lines of addresses, or words: one entry per line that is not empty or a # comment.
function readText(text: string): PlaylistFile {
  const entries: FileEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const url = looksLikeAddress(line) ? address(withScheme(line)) : null;
    entries.push({
      url,
      words: url ? null : cut(line, 200),
      title: null,
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
  }
  return { format: 'text', name: null, entries };
}

// An address as people paste it: with its scheme, or a bare host and path (as the add box reads it).
function looksLikeAddress(line: string): boolean {
  return !/\s/.test(line) && (/^https?:\/\//i.test(line) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(line));
}

function withScheme(line: string): string {
  return /^https?:\/\//i.test(line) ? line : `https://${line}`;
}

// An http(s) address, as written; anything else is none.
function address(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// A picture's address: https only (the panel shows pictures from https alone).
function picture(value: unknown): string | null {
  const url = address(value);
  return url?.startsWith('https://') ? url : null;
}

// A text on one line, cut to `most` characters; none when empty.
function cut(value: unknown, most: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = oneLine(value).slice(0, most).trim();
  return clean || null;
}

// A length in milliseconds, whole, from none to a day.
function length(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.round(value)
    : null;
}

// Line breaks and tabs as spaces, so a value cannot start a line of its own in a file.
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}
