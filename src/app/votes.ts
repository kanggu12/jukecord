/**
 * Votes to skip. Where a server has a DJ role (and has not turned votes off), Skip from someone without the role is a
 * vote, and the track goes when half of the people listening have voted.
 *
 * The people listening are the people (not bots) in the bot's voice channel and the people whose browsers listen
 * along to that server, each counted once, the host as one person. Only they may vote, and a vote counts while its
 * person listens: one who leaves takes their vote out of the count, and brings it back by coming back during the same
 * play. It takes half of the people listening, rounded up, and at least one vote. The votes end with the play of the
 * track: a skip, its end, a stop, or the same track starting again by repeat.
 *
 * Who listens changes all the time. While a vote is open, the count is made again a moment after each change (at most
 * four times a second), and a vote that has enough then skips the track: four people listening and two votes is
 * enough the moment one of the other two leaves. A server without an open vote keeps nothing here and costs nothing.
 */
import type { Bus } from '../core/bus.ts';
import type { Clock, TimerHandle } from '../core/clock.ts';
import type { Players } from '../core/players.ts';
import type { Logger } from '../log.ts';
import { ActionError } from './actions.ts';

/** How the votes to skip a server's track stand, as the panels and the commands show them. */
export interface VotesView {
  /** Whether Skip from someone without the DJ role is a vote here: the server has a DJ role and votes are on. */
  readonly on: boolean;
  /** The votes to skip the current track that count: from people listening now. */
  readonly votes: number;
  /** How many votes skip it: half of the people listening, rounded up, and at least one (0 while votes are off). */
  readonly needed: number;
}

/** How a vote went: the votes that count, the votes needed, and whether it made the track go. */
export interface VoteResult {
  readonly votes: number;
  readonly needed: number;
  readonly skipped: boolean;
}

export interface SkipVotesOptions {
  readonly players: Players;
  readonly bus: Bus;
  readonly clock: Clock;
  readonly log: Logger;
  /** Whether Skip from someone without the DJ role is a vote in a server now. */
  readonly applies: (guildId: string) => boolean;
  /** Who listens in a server now, by Discord ID ("host" for the host): the bot's voice channel and the browsers. */
  readonly listening: (guildId: string) => ReadonlySet<string>;
  /** How long after a change of who listens an open vote is counted again (default 250 ms). */
  readonly recountMs?: number;
}

// A server's open vote: the play of the track it is about (Player.playNumber), and who voted.
interface Open {
  readonly play: number;
  readonly voters: Set<string>;
}

/** The refusal for a vote from someone who is not listening. */
export const NOT_LISTENING = 'only people listening can vote to skip';

export class SkipVotes {
  private readonly options: SkipVotesOptions;
  private readonly recountMs: number;
  // The open votes, by server: only servers where someone voted during the play now.
  private readonly open = new Map<string, Open>();
  // The counts waiting to be made again after a change of who listens, by server.
  private readonly recounts = new Map<string, TimerHandle>();

  constructor(options: SkipVotesOptions) {
    this.options = options;
    this.recountMs = options.recountMs ?? 250;
    // The end of a play ends its votes, and the panels are told: every snapshot of a server with an open vote is
    // checked against the play the vote is about (a Map lookup for the others).
    options.bus.on('player', (snapshot) => {
      if (this.open.has(snapshot.guildId) && !this.live(snapshot.guildId)) this.end(snapshot.guildId);
    });
    // Someone came or went in voice, or a browser started or stopped listening: an open vote is counted again soon.
    options.bus.on('people', ({ guildId }) => this.recountSoon(guildId));
  }

  /** How the votes of a server's current track stand. */
  view(guildId: string): VotesView {
    // Votes off: nothing to count, and nothing for anyone to show.
    if (!this.options.applies(guildId)) return { on: false, votes: 0, needed: 0 };
    const people = this.options.listening(guildId);
    const open = this.live(guildId);
    return { on: true, votes: open ? counted(open, people) : 0, needed: needed(people) };
  }

  /**
   * A vote to skip from `voter` (a Discord ID). Refused for someone who is not listening; a second vote of the same
   * person in the same play changes nothing. Enough votes skip the track at once.
   */
  vote(guildId: string, voter: string): VoteResult {
    const people = this.options.listening(guildId);
    if (!people.has(voter)) throw new ActionError('forbidden', NOT_LISTENING);
    // A vote of an ended play is no vote for this one: a new play starts its own.
    let open = this.live(guildId);
    if (!open) {
      open = { play: this.options.players.get(guildId).playNumber(), voters: new Set() };
      this.open.set(guildId, open);
    }
    open.voters.add(voter);
    return this.decide(guildId, open, people);
  }

  /** Ends a server's votes: votes were turned off or on, or the DJ role changed. The panels hear the new state. */
  reset(guildId: string): void {
    this.open.delete(guildId);
    this.cancelRecount(guildId);
    this.changed(guildId);
  }

  // Skips the track when the votes that count reach the votes needed; either way the panels hear the count.
  private decide(guildId: string, open: Open, people: ReadonlySet<string>): VoteResult {
    const votes = counted(open, people);
    const need = needed(people);
    if (votes < need) {
      this.changed(guildId);
      return { votes, needed: need, skipped: false };
    }
    // The vote is over before the skip, so the snapshot the skip sends finds nothing open to end.
    this.open.delete(guildId);
    this.cancelRecount(guildId);
    this.options.log.info('skipped the track by a vote', { guild: guildId, votes, needed: need });
    this.options.players.get(guildId).skip();
    this.changed(guildId);
    return { votes, needed: need, skipped: true };
  }

  // The open vote of a server while it is about the play now, or null (none, or its play has ended).
  private live(guildId: string): Open | null {
    const open = this.open.get(guildId);
    if (!open) return null;
    const player = this.options.players.existing(guildId);
    // A play of no track (idle) or another play (the next track, a repeat) is not the one the vote was about.
    if (!player || player.playNumber() !== open.play || player.snapshot().track === null) return null;
    return open;
  }

  // The play a vote was about has ended: its votes go, and the panels hear so.
  private end(guildId: string): void {
    this.open.delete(guildId);
    this.cancelRecount(guildId);
    this.changed(guildId);
  }

  // Counts an open vote again a moment after a change of who listens: a crowd starting to listen together is one
  // count, not one each. Servers without an open vote are left alone.
  private recountSoon(guildId: string): void {
    if (!this.open.has(guildId) || this.recounts.has(guildId)) return;
    this.recounts.set(
      guildId,
      this.options.clock.setTimeout(() => {
        this.recounts.delete(guildId);
        const open = this.live(guildId);
        if (!open) {
          // Ended meanwhile without a snapshot saying so (an idle player has none to send twice): nothing more to do.
          if (this.open.has(guildId)) this.end(guildId);
          return;
        }
        // Votes no longer apply (the DJ role deleted in Discord meanwhile): the open vote goes, and the panels hear so.
        if (!this.options.applies(guildId)) {
          this.end(guildId);
          return;
        }
        this.decide(guildId, open, this.options.listening(guildId));
      }, this.recountMs),
    );
  }

  private cancelRecount(guildId: string): void {
    const timer = this.recounts.get(guildId);
    if (timer !== undefined) this.options.clock.clearTimeout(timer);
    this.recounts.delete(guildId);
  }

  // The votes of a server changed: the live updates send its panels the new view (see web/events.ts).
  private changed(guildId: string): void {
    this.options.bus.emit('votes', { guildId });
  }
}

// The votes of an open vote that count: those of people listening now.
function counted(open: Open, people: ReadonlySet<string>): number {
  let votes = 0;
  for (const voter of open.voters) if (people.has(voter)) votes += 1;
  return votes;
}

// The votes it takes: half of the people listening, rounded up, and at least one.
function needed(people: ReadonlySet<string>): number {
  return Math.max(1, Math.ceil(people.size / 2));
}
