/**
 * The queue service: every change to a server's queue goes through here, whichever way it was asked for.
 *
 * The panel, the slash commands, the API and the CLI all call these methods, so they behave the same and each
 * change is announced once on the bus with a new version number.
 */
import type { QueueRepository } from '../store/store.ts';
import type { Bus } from './bus.ts';
import type { QueueItem } from './types.ts';

/** Where new tracks go: after the last one, right after the one playing, or at a position. */
export type InsertAt = 'end' | 'next' | number;

/** A random number in [0, 1); passed in so tests can shuffle predictably. */
export type Random = () => number;

export class QueueService {
  private readonly repo: QueueRepository;
  private readonly bus: Bus;
  // The change counter of each server, starting at 0 when jukecord starts. Clients compare it with the last one
  // they saw; a gap means they missed an event and should fetch the whole queue again.
  private readonly versions = new Map<string, number>();

  constructor(repo: QueueRepository, bus: Bus) {
    this.repo = repo;
    this.bus = bus;
  }

  /** A server's queue in play order. */
  list(guildId: string): QueueItem[] {
    return this.repo.list(guildId);
  }

  /** How many tracks wait. */
  size(guildId: string): number {
    return this.repo.count(guildId);
  }

  /** Whether a track waits in a server's queue (the audio route asks on every request, so the queue is not read). */
  contains(guildId: string, trackId: number): boolean {
    return this.repo.has(guildId, trackId);
  }

  /** The current change counter of a server's queue. */
  version(guildId: string): number {
    return this.versions.get(guildId) ?? 0;
  }

  /** Adds tracks (already stored as tracks) and returns the new queue items. */
  add(guildId: string, trackIds: readonly number[], at: InsertAt, addedBy: string | null): QueueItem[] {
    // Nothing to add is not an error (an empty playlist), but it is not a change either.
    if (trackIds.length === 0) return [];
    const index = at === 'end' ? Number.MAX_SAFE_INTEGER : at === 'next' ? 0 : at;
    const items = this.repo.insert(guildId, trackIds, index, addedBy);
    this.changed(guildId);
    return items;
  }

  /** Removes one item; false when it was not there (someone else removed it or it started playing). */
  remove(guildId: string, itemId: number): boolean {
    const removed = this.repo.remove(guildId, itemId);
    if (removed) this.changed(guildId);
    return removed;
  }

  /** Moves one item to a position in the queue. */
  move(guildId: string, itemId: number, index: number): void {
    this.repo.move(guildId, itemId, index);
    this.changed(guildId);
  }

  /** Puts the queue in a given order (drag and drop of several rows, or a client that reorders locally). */
  reorder(guildId: string, itemIds: readonly number[]): void {
    this.repo.reorder(guildId, itemIds);
    this.changed(guildId);
  }

  /**
   * Shuffles the queue with Fisher-Yates, so every order is equally likely.
   *
   * The common shortcut, sorting by a random key, favours some orders; people notice when the same songs keep
   * landing first.
   */
  shuffle(guildId: string, random: Random = Math.random): void {
    const ids = this.repo.list(guildId).map((item) => item.id);
    // Fewer than two items have only one order; skip the write and the event.
    if (ids.length < 2) return;
    for (let i = ids.length - 1; i > 0; i -= 1) {
      // Pick a place from 0..i and swap it into place i.
      const j = Math.floor(random() * (i + 1));
      const a = ids[i];
      const b = ids[j];
      if (a === undefined || b === undefined) continue;
      ids[i] = b;
      ids[j] = a;
    }
    this.repo.reorder(guildId, ids);
    this.changed(guildId);
  }

  /** Removes later copies of tracks that are queued more than once, keeping the first; returns how many went. */
  dedupe(guildId: string): number {
    const seen = new Set<number>();
    const extra: number[] = [];
    // The first copy keeps its place, which is what someone pressing "remove duplicates" expects.
    for (const item of this.repo.list(guildId)) {
      if (seen.has(item.track.id)) extra.push(item.id);
      else seen.add(item.track.id);
    }
    if (extra.length === 0) return 0;
    // All of them in one transaction with one renumbering (see QueueRepository.removeMany), and one event.
    const removed = this.repo.removeMany(guildId, extra);
    if (removed > 0) this.changed(guildId);
    return removed;
  }

  /** Empties a server's queue and returns how many tracks were in it. */
  clear(guildId: string): number {
    const count = this.repo.clear(guildId);
    if (count > 0) this.changed(guildId);
    return count;
  }

  /** Takes the next item out of the queue for the player, or null when the queue is empty. */
  shift(guildId: string): QueueItem | null {
    const item = this.repo.shift(guildId);
    if (item) this.changed(guildId);
    return item;
  }

  // Bumps the server's counter and tells listeners.
  private changed(guildId: string): void {
    const version = this.version(guildId) + 1;
    this.versions.set(guildId, version);
    this.bus.emit('queue', { guildId, version });
  }
}
