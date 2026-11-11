/**
 * The players of every server, created when a server is first used and restored after a restart.
 *
 * One Player per Discord server (guild). Everything that needs "the player of server X" asks this registry, so there
 * is never a second player for the same server with its own idea of what is playing.
 */
import type { PlayerStateRepository, TrackRepository } from '../store/store.ts';
import { Player, type PlayerOptions } from './player.ts';

/** What every player shares; the guild ID is added per player. */
export type SharedPlayerOptions = Omit<PlayerOptions, 'guildId'>;

export class Players {
  private readonly shared: SharedPlayerOptions;
  private readonly players = new Map<string, Player>();

  constructor(shared: SharedPlayerOptions) {
    this.shared = shared;
  }

  /** The player of a server, created on first use. */
  get(guildId: string): Player {
    let player = this.players.get(guildId);
    if (!player) {
      // Each player logs with its server's ID, so the log of a busy night can be read per server.
      player = new Player({ ...this.shared, guildId, log: this.shared.log.child(`player ${guildId}`) });
      this.players.set(guildId, player);
    }
    return player;
  }

  /** Every player created so far. */
  all(): Player[] {
    return [...this.players.values()];
  }

  /**
   * Brings back what each server had current before the restart, paused where it was (see Player.restore), and
   * returns how many servers had something to restore.
   */
  restoreAll(tracks: TrackRepository, states: PlayerStateRepository): number {
    let restored = 0;
    for (const saved of states.all()) {
      // The repeat mode comes back even for a server that was idle: it is a choice, not a state of the moment.
      if (saved.repeat !== 'off') this.get(saved.guildId).setRepeat(saved.repeat);
      // A server that was idle, or whose track has since disappeared from the database, has nothing to come back to.
      if (saved.status === 'idle' || saved.trackId === null) continue;
      const track = tracks.get(saved.trackId);
      if (!track) continue;
      this.get(saved.guildId).restore(track, saved.addedBy, saved.positionMs);
      restored += 1;
    }
    return restored;
  }

  /** Saves every player's position; called when jukecord shuts down. */
  checkpointAll(): void {
    for (const player of this.players.values()) player.checkpoint();
  }
}
