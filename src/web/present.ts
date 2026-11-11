/**
 * Turns jukecord's own objects into what the API sends: tracks without their internal fields, and people's names
 * beside their Discord IDs.
 *
 * The response schemas drop anything they do not list, so these functions are about adding (names) and shaping
 * (mutable arrays for the schema types), not about hiding; hiding is the schemas' job.
 */
import type { StatsView } from '../app/actions.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import type { HistoryEntry, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Person, UserRepository } from '../store/store.ts';

/** A track as the API shows it. */
export function track(value: Track) {
  return {
    id: value.id,
    url: value.url,
    title: value.title,
    uploader: value.uploader,
    durationMs: value.durationMs,
    thumbnail: value.thumbnail,
  };
}

/** Looks up names for the IDs in a response, once per response. */
export class Presenter {
  private readonly users: UserRepository;

  constructor(users: UserRepository) {
    this.users = users;
  }

  // The display name of an ID, or null for the host (no ID) and people jukecord has not met.
  private nameOf(people: Map<string, Person>, id: string | null): string | null {
    return id === null ? null : (people.get(id)?.name ?? null);
  }

  items(values: readonly QueueItem[]) {
    const people = this.users.many(values.flatMap((item) => (item.addedBy ? [item.addedBy] : [])));
    return values.map((item) => ({
      id: item.id,
      position: item.position,
      track: track(item.track),
      addedBy: item.addedBy,
      addedByName: this.nameOf(people, item.addedBy),
      addedAt: item.addedAt,
    }));
  }

  queue(value: { items: readonly QueueItem[]; version: number }) {
    return { items: this.items(value.items), version: value.version };
  }

  player(snapshot: PlayerSnapshot) {
    const people = this.users.many(snapshot.addedBy ? [snapshot.addedBy] : []);
    return {
      guildId: snapshot.guildId,
      status: snapshot.status,
      track: snapshot.track ? track(snapshot.track) : null,
      addedBy: snapshot.addedBy,
      addedByName: this.nameOf(people, snapshot.addedBy),
      positionMs: snapshot.positionMs,
      at: snapshot.at,
      durationMs: snapshot.durationMs,
      error: snapshot.error,
      repeat: snapshot.repeat,
      progress: snapshot.progress,
      version: snapshot.version,
    };
  }

  history(entries: readonly HistoryEntry[]) {
    const people = this.users.many(entries.flatMap((entry) => (entry.addedBy ? [entry.addedBy] : [])));
    return entries.map((entry) => ({
      id: entry.id,
      track: track(entry.track),
      addedBy: entry.addedBy,
      addedByName: this.nameOf(people, entry.addedBy),
      playedAt: entry.playedAt,
      playedMs: entry.playedMs,
    }));
  }

  playlist(value: Playlist) {
    return {
      id: value.id,
      name: value.name,
      createdBy: value.createdBy,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      size: value.size,
    };
  }

  stats(view: StatsView) {
    const people = this.users.many(view.topPeople.flatMap((entry) => (entry.userId ? [entry.userId] : [])));
    return {
      span: view.span,
      from: view.from,
      plays: view.plays,
      playedMs: view.playedMs,
      tracks: view.tracks,
      people: view.people,
      days: view.days.map((day) => ({ ...day })),
      hours: [...view.hours],
      topTracks: view.topTracks.map((entry) => ({
        track: track(entry.track),
        plays: entry.plays,
        playedMs: entry.playedMs,
      })),
      topPeople: view.topPeople.map((entry) => ({
        userId: entry.userId,
        name: this.nameOf(people, entry.userId),
        avatar: entry.userId ? (people.get(entry.userId)?.avatar ?? null) : null,
        plays: entry.plays,
        playedMs: entry.playedMs,
      })),
    };
  }
}
