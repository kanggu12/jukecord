/**
 * The media cache: one Ogg Opus file per track (plus an MP3 copy for Safari when one is asked for), with a size limit.
 *
 * Files are named by a hash of the track's canonical source, so the same track is fetched once however it was
 * added. A small JSON file beside each one keeps its measured length and loudness. When the cache grows past its
 * limit, the files used longest ago go first, except the ones pinned: the track playing and the next ones fetched
 * ahead. "Used" is the file's modification time, touched on every use, so the order survives a restart.
 *
 * A track's cover (covers.ts) is kept here too, as `<key>.cover.<type>` beside the audio. It counts towards the same
 * limit and goes by the same rule, on its own: the history and Wrapped show covers of tracks whose audio went long ago.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';

/** What the cache knows about one track's file. */
export interface CacheEntry {
  readonly key: string;
  readonly source: string;
  readonly durationMs: number;
  readonly loudness: number | null;
  /** Bytes on disk, the MP3 copy included. */
  bytes: number;
  /** When it was last used (milliseconds since the epoch). */
  lastUsed: number;
}

// The JSON beside each file: what a restart needs to rebuild the entry without reading the audio.
interface Sidecar {
  readonly source: string;
  readonly durationMs: number;
  readonly loudness: number | null;
}

/** The kinds of picture a cover may be, by the file name's ending (which also gives the type it is served as). */
export type CoverType = 'jpg' | 'png' | 'gif' | 'webp' | 'avif';

/** The kinds of cover, for checking a name read from the disk. */
export const COVER_TYPES: readonly CoverType[] = ['jpg', 'png', 'gif', 'webp', 'avif'];

/** What the cache knows about one track's cover. */
export interface CoverEntry {
  readonly key: string;
  readonly type: CoverType;
  readonly bytes: number;
  /**
   * When it was last used (milliseconds since the epoch): the file's access time on the disk, so the order survives a
   * restart while its modification time stays the time it was fetched (the ETag browsers check is made from that).
   */
  lastUsed: number;
  /** When it was fetched: the file's modification time. */
  readonly madeAt: number;
}

// A cover's file name on the disk: the track's key, then "cover" and the type, so it can never be taken for audio.
const COVER_NAME = /^([0-9a-f]{32})\.cover\.(jpg|png|gif|webp|avif)$/;

export interface MediaCacheOptions {
  readonly dir: string;
  readonly maxBytes: number;
  readonly log: Logger;
  readonly now?: () => number;
}

export class MediaCache {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  // The covers, by the same keys as the audio (a key may have a cover and no audio, or the other way round).
  private readonly covers = new Map<string, CoverEntry>();
  // How many holders pin each key; a key is safe from eviction while its count is above zero.
  private readonly pins = new Map<string, number>();

  constructor(options: MediaCacheOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  /** The cache key of a canonical source: 32 hex characters of its SHA-256. */
  static keyOf(source: string): string {
    return createHash('sha256').update(source).digest('hex').slice(0, 32);
  }

  opusPath(key: string): string {
    return path.join(this.dir, `${key}.opus`);
  }

  mp3Path(key: string): string {
    return path.join(this.dir, `${key}.mp3`);
  }

  // The sidecar's path.
  private metaPath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  /** Where a track's cover of a type is kept. */
  coverPath(key: string, type: CoverType): string {
    return path.join(this.dir, `${key}.cover.${type}`);
  }

  /** A fresh temporary path for a file being made; it never collides with a finished file or another download. */
  tmpPath(key: string, extension = 'opus'): string {
    return path.join(this.dir, `${key}.${randomUUID()}.tmp.${extension}`);
  }

  /**
   * Reads the cache directory: rebuilds the entries, removes temporary files left by a crash, and removes audio
   * without its sidecar (or the other way round), which a crash between the two writes can leave.
   */
  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const names = fs.readdirSync(this.dir);
    const files = new Set(names);
    let removed = 0;
    for (const name of names) {
      const full = path.join(this.dir, name);
      if (name.includes('.tmp.')) {
        fs.rmSync(full, { force: true });
        removed += 1;
        continue;
      }
      const match = /^([0-9a-f]{32})\.json$/.exec(name);
      if (!match) continue;
      const key = match[1] ?? '';
      if (!files.has(`${key}.opus`)) {
        fs.rmSync(full, { force: true });
        removed += 1;
        continue;
      }
      try {
        const sidecar = JSON.parse(fs.readFileSync(full, 'utf8')) as Sidecar;
        const opus = fs.statSync(this.opusPath(key));
        const mp3 = files.has(`${key}.mp3`) ? fs.statSync(this.mp3Path(key)).size : 0;
        this.entries.set(key, {
          key,
          source: sidecar.source,
          durationMs: sidecar.durationMs,
          loudness: sidecar.loudness,
          bytes: opus.size + mp3,
          lastUsed: opus.mtimeMs,
        });
      } catch (error) {
        // An unreadable sidecar makes the file useless (no length); remove both and fetch again when needed.
        this.log.warn('dropping a cached file whose description cannot be read', { key, error });
        this.removeFiles(key);
        removed += 1;
      }
    }
    // Audio files with no sidecar at all.
    for (const name of names) {
      const match = /^([0-9a-f]{32})\.(opus|mp3)$/.exec(name);
      if (match && !this.entries.has(match[1] ?? '')) {
        fs.rmSync(path.join(this.dir, name), { force: true });
        removed += 1;
      }
    }
    // The covers: each is whole once it has its name (it was renamed into place), and needs nothing beside it.
    for (const name of names) {
      const match = COVER_NAME.exec(name);
      if (!match) continue;
      const key = match[1] ?? '';
      const type = match[2] as CoverType;
      try {
        const stat = fs.statSync(path.join(this.dir, name));
        // Two covers of one track (a crash between writing the new one and removing the old): the newer stays.
        const known = this.covers.get(key);
        if (known && known.madeAt >= stat.mtimeMs) {
          fs.rmSync(path.join(this.dir, name), { force: true });
          removed += 1;
          continue;
        }
        if (known) {
          fs.rmSync(this.coverPath(key, known.type), { force: true });
          removed += 1;
        }
        this.covers.set(key, {
          key,
          type,
          bytes: stat.size,
          lastUsed: Math.max(stat.atimeMs, stat.mtimeMs),
          madeAt: stat.mtimeMs,
        });
      } catch {
        // Gone between the listing and now: nothing to keep.
      }
    }
    if (removed > 0) this.log.info('cleaned up the media cache', { removed });
    this.evict();
  }

  /** The entry of a key, marked as used now; null when the track is not cached. */
  get(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.touch(entry);
    return entry;
  }

  /** Whether a key is cached, without marking it as used (for the prefetcher's planning). */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Total bytes in the cache, the covers included. */
  size(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    for (const entry of this.covers.values()) total += entry.bytes;
    return total;
  }

  /** How many tracks are cached. */
  count(): number {
    return this.entries.size;
  }

  /** How many covers are cached. */
  coverCount(): number {
    return this.covers.size;
  }

  /** A track's cover, marked as used now; null when it is not cached. */
  cover(key: string): { readonly path: string; readonly type: CoverType } | null {
    const entry = this.covers.get(key);
    if (!entry) return null;
    const now = this.now();
    entry.lastUsed = now;
    try {
      // The access time only: the modification time stays when it was fetched, so a browser's "is it the same picture"
      // (its ETag) is answered "not modified" instead of the whole picture each time.
      fs.utimesSync(this.coverPath(key, entry.type), now / 1000, entry.madeAt / 1000);
    } catch {
      // The order after a restart is a nicety; a failed touch must not fail a picture.
    }
    return { path: this.coverPath(key, entry.type), type: entry.type };
  }

  /**
   * Puts a fetched cover in place, through a temporary name (a half-written picture is never served), replacing a cover
   * the track had before, then trims the cache.
   */
  putCover(key: string, bytes: Uint8Array, type: CoverType): void {
    const tmp = this.tmpPath(key, 'cover');
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this.coverPath(key, type));
    const old = this.covers.get(key);
    // A cover of another type is another file: the old one goes, or it would stay on the disk uncounted.
    if (old && old.type !== type) fs.rmSync(this.coverPath(key, old.type), { force: true });
    const now = this.now();
    this.covers.set(key, { key, type, bytes: bytes.length, lastUsed: now, madeAt: now });
    try {
      // Both times as this cache's clock has them (the same clock as the audio's).
      fs.utimesSync(this.coverPath(key, type), now / 1000, now / 1000);
    } catch {
      // The file's own times then; the order after a restart is a nicety.
    }
    this.evict();
  }

  /**
   * Puts a finished file in place: the temporary file is renamed (atomic on one disk), then the sidecar is written,
   * then the cache is trimmed. A crash between the steps leaves pieces that init() removes.
   */
  commit(key: string, tmpFile: string, meta: Sidecar): CacheEntry {
    fs.renameSync(tmpFile, this.opusPath(key));
    // The sidecar is also written through a temporary name, so a half-written JSON is never read.
    const tmpMeta = this.tmpPath(key, 'json');
    fs.writeFileSync(tmpMeta, JSON.stringify(meta));
    fs.renameSync(tmpMeta, this.metaPath(key));
    const entry: CacheEntry = {
      key,
      source: meta.source,
      durationMs: meta.durationMs,
      loudness: meta.loudness,
      bytes: fs.statSync(this.opusPath(key)).size,
      lastUsed: this.now(),
    };
    this.entries.set(key, entry);
    this.evict();
    return entry;
  }

  /** Records that an MP3 copy now exists beside a cached file (it counts towards the limit). */
  addMp3(key: string, tmpFile: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      fs.rmSync(tmpFile, { force: true });
      return;
    }
    fs.renameSync(tmpFile, this.mp3Path(key));
    entry.bytes += fs.statSync(this.mp3Path(key)).size;
    this.evict();
  }

  /** Whether the MP3 copy of a cached track exists. */
  hasMp3(key: string): boolean {
    return this.entries.has(key) && fs.existsSync(this.mp3Path(key));
  }

  /** Keeps a key from being evicted until unpinned the same number of times. */
  pin(key: string): void {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  unpin(key: string): void {
    const count = (this.pins.get(key) ?? 0) - 1;
    if (count > 0) this.pins.set(key, count);
    else this.pins.delete(key);
  }

  /**
   * Removes the least recently used, unpinned files until the cache is under its limit: a track's audio and its cover
   * each by their own last use (a cover shown in the history stays while the audio of a track played once goes), and
   * neither while their key is pinned (the track playing keeps its cover too).
   */
  evict(): void {
    let total = this.size();
    if (total <= this.maxBytes) return;
    const candidates = [
      ...[...this.entries.values()].map((entry) => ({ kind: 'audio' as const, entry })),
      ...[...this.covers.values()].map((entry) => ({ kind: 'cover' as const, entry })),
    ]
      .filter((candidate) => !this.pins.has(candidate.entry.key))
      .sort((a, b) => a.entry.lastUsed - b.entry.lastUsed);
    for (const candidate of candidates) {
      if (total <= this.maxBytes) break;
      if (candidate.kind === 'audio') {
        this.removeFiles(candidate.entry.key);
        this.entries.delete(candidate.entry.key);
        this.log.debug('evicted a cached track', { key: candidate.entry.key, source: candidate.entry.source });
      } else {
        fs.rmSync(this.coverPath(candidate.entry.key, candidate.entry.type), { force: true });
        this.covers.delete(candidate.entry.key);
        this.log.debug('evicted a cached cover', { key: candidate.entry.key });
      }
      total -= candidate.entry.bytes;
    }
  }

  // Marks an entry as used: in memory for this run, and as the file's modification time for the next one.
  private touch(entry: CacheEntry): void {
    const now = this.now();
    entry.lastUsed = now;
    try {
      const seconds = now / 1000;
      fs.utimesSync(this.opusPath(entry.key), seconds, seconds);
    } catch {
      // The order after a restart is a nicety; a failed touch must not fail a play.
    }
  }

  // Deletes every file of a key; missing ones are fine.
  private removeFiles(key: string): void {
    for (const file of [this.opusPath(key), this.mp3Path(key), this.metaPath(key)]) fs.rmSync(file, { force: true });
  }
}
