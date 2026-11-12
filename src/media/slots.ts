/**
 * How many tracks are fetched and encoded at once, across every server jukecord plays in.
 *
 * Each fetch is a yt-dlp download and an ffmpeg encode that keep about one processor core busy while they last. A few
 * servers fetching their next tracks ahead of time could take a small machine over and hold up the one track somebody
 * is waiting for. So a fetch ahead of time ("ahead") starts only while fewer than `limit` fetches run, in the order
 * they asked, and a fetch somebody waits for ("now") starts at once while fewer than `nowLimit` of those run (twice
 * the limit), before any fetch ahead of time; an ahead fetch that somebody comes to wait for counts as one.
 *
 * The "now" limit is for skip storms: every skip starts a new fetch and cancels the last, and a cancelled fetch keeps
 * its place until its programs have exited. Without a limit, a crowd pressing skip ran a hundred programs at once.
 * With it the newest fetch waits a moment for a place, and one cancelled while waiting never starts. A fetch that no
 * person waits for any more but the prefetcher still wants stops counting as "now" (see demote).
 */

/** Whether somebody waits for the fetch ("now"), or it is made ahead of time ("ahead"). */
export type Priority = 'now' | 'ahead';

/** One fetch's place: given at once or later, taken back when the fetch ends. */
export interface Ticket {
  /** Settles when the fetch may start; rejects when the signal aborts before that. */
  readonly granted: Promise<void>;
  /** Whether the fetch still waits for its place (it did not get one at once, and has not started since). */
  readonly waiting: boolean;
  /** Somebody now waits for this fetch: it counts as "now", and starts at once if there is a place for one. */
  promote(): void;
  /** Nobody waits for this fetch any more (it is still wanted ahead of time): it no longer counts as "now". */
  demote(): void;
  /** The fetch ended (or never started): its place is free for the next one. Safe to call more than once. */
  release(): void;
}

/** The default limit: half the processors, between 2 and 6 (a Raspberry Pi gets 2). */
export function defaultLimit(processors: number): number {
  return Math.max(2, Math.min(6, Math.floor(processors / 2)));
}

// One ticket as the lines see it: what it counts as, and how it starts.
interface Entry {
  kind: Priority;
  start(): void;
}

export class Slots {
  readonly limit: number;
  /** How many fetches somebody waits for may run at once. */
  readonly nowLimit: number;
  // Fetches running now, of either kind, and of those the ones counted as "now".
  private running = 0;
  private runningNow = 0;
  // Fetches waiting for a place, oldest first, in two lines: "now" ones are started before any "ahead" one.
  private readonly waitingNow: Entry[] = [];
  private readonly waitingAhead: Entry[] = [];

  constructor(limit: number, nowLimit?: number) {
    // At least one, or ahead fetches would wait forever.
    this.limit = Math.max(1, Math.floor(limit));
    this.nowLimit = Math.max(1, Math.floor(nowLimit ?? this.limit * 2));
  }

  /** Fetches running at this moment (for the doctor and the tests). */
  get active(): number {
    return this.running;
  }

  /** Fetches waiting for a place (for the doctor and the tests). */
  get queued(): number {
    return this.waitingNow.length + this.waitingAhead.length;
  }

  /** A place for one fetch; `signal` ends the wait for it. */
  request(priority: Priority, signal: AbortSignal): Ticket {
    let state: 'waiting' | 'running' | 'done' = 'waiting';
    let grant: () => void = () => {};
    let refuse: (error: unknown) => void = () => {};
    const granted = new Promise<void>((resolve, reject) => {
      grant = resolve;
      refuse = reject;
    });
    // A wait that is given up is not an error anyone has to handle (the caller learns it from its own signal).
    granted.catch(() => {});
    const entry: Entry = {
      kind: priority,
      // Starting takes a place and leaves the line; it does nothing for a fetch that runs already or has ended.
      start: () => {
        if (state !== 'waiting') return;
        state = 'running';
        this.running += 1;
        if (entry.kind === 'now') this.runningNow += 1;
        this.leaveLine(entry);
        grant();
      },
    };
    const onAbort = (): void => {
      if (state !== 'waiting') return;
      state = 'done';
      this.leaveLine(entry);
      refuse(signal.reason ?? new Error('cancelled'));
    };
    if (this.hasRoom(priority)) {
      entry.start();
    } else {
      this.lineOf(priority).push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return {
      granted,
      get waiting() {
        return state === 'waiting';
      },
      promote: () => {
        if (entry.kind === 'now' || state === 'done') return;
        entry.kind = 'now';
        if (state === 'running') {
          // Running already: it counts as "now" from here, even past the limit (it is not stopped for that).
          this.runningNow += 1;
          return;
        }
        // Waiting: it moves to the "now" line, and starts at once if one of those has a place.
        this.leaveLine(entry);
        if (this.hasRoom('now')) entry.start();
        else this.waitingNow.push(entry);
      },
      demote: () => {
        if (entry.kind === 'ahead' || state === 'done') return;
        entry.kind = 'ahead';
        if (state === 'running') {
          // Its "now" place is free for the next fetch somebody waits for.
          this.runningNow -= 1;
        } else {
          this.leaveLine(entry);
          this.waitingAhead.push(entry);
        }
        this.next();
      },
      release: () => {
        signal.removeEventListener('abort', onAbort);
        if (state === 'running') {
          state = 'done';
          this.running -= 1;
          if (entry.kind === 'now') this.runningNow -= 1;
          this.next();
        } else if (state === 'waiting') {
          state = 'done';
          this.leaveLine(entry);
        }
      },
    };
  }

  // Whether a fetch of this kind may start now.
  private hasRoom(kind: Priority): boolean {
    return kind === 'now' ? this.runningNow < this.nowLimit : this.running < this.limit;
  }

  private lineOf(kind: Priority): Entry[] {
    return kind === 'now' ? this.waitingNow : this.waitingAhead;
  }

  // Takes an entry out of whichever line it waits in.
  private leaveLine(entry: Entry): void {
    for (const line of [this.waitingNow, this.waitingAhead]) {
      const index = line.indexOf(entry);
      if (index >= 0) line.splice(index, 1);
    }
  }

  // Starts waiting fetches while there is room: those somebody waits for first, then the rest, oldest first.
  private next(): void {
    for (const kind of ['now', 'ahead'] as const) {
      const line = this.lineOf(kind);
      while (this.hasRoom(kind)) {
        const entry = line[0];
        if (!entry) break;
        entry.start();
        // Only a waiting entry starts (and leaves the line by starting); one that is not, would block the line.
        if (line[0] === entry) line.shift();
      }
    }
  }
}
