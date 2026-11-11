/**
 * How many tracks are fetched and encoded at once, across every server jukecord plays in.
 *
 * Each fetch is a yt-dlp download and an ffmpeg encode that keep about one processor core busy while they last. A few
 * servers fetching their next tracks ahead of time could take a small machine over and hold up the one track somebody
 * is waiting for. So a fetch somebody waits for ("now") always starts at once, while a fetch ahead of time ("ahead")
 * starts only while fewer than `limit` fetches run, in the order they asked; an ahead fetch that somebody comes to wait
 * for starts at once.
 */

/** Whether somebody waits for the fetch ("now"), or it is made ahead of time ("ahead"). */
export type Priority = 'now' | 'ahead';

/** One fetch's place: given at once or later, taken back when the fetch ends. */
export interface Ticket {
  /** Settles when the fetch may start; rejects when the signal aborts before that. */
  readonly granted: Promise<void>;
  /** Somebody now waits for this fetch: it starts at once if it was still waiting. */
  promote(): void;
  /** The fetch ended (or never started): its place is free for the next one. Safe to call more than once. */
  release(): void;
}

/** The default limit: half the processors, between 2 and 6 (a Raspberry Pi gets 2). */
export function defaultLimit(processors: number): number {
  return Math.max(2, Math.min(6, Math.floor(processors / 2)));
}

export class Slots {
  readonly limit: number;
  // Fetches running now, of either kind.
  private running = 0;
  // Ahead fetches waiting for a place, oldest first; each entry starts its fetch.
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    // At least one, or ahead fetches would wait forever.
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Fetches running at this moment (for the doctor and the tests). */
  get active(): number {
    return this.running;
  }

  /** Fetches waiting for a place (for the doctor and the tests). */
  get queued(): number {
    return this.waiting.length;
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
    const leaveLine = (): void => {
      const index = this.waiting.indexOf(start);
      if (index >= 0) this.waiting.splice(index, 1);
    };
    // Starting takes a place and leaves the line; it does nothing for a fetch that runs already or has ended.
    const start = (): void => {
      if (state !== 'waiting') return;
      state = 'running';
      this.running += 1;
      leaveLine();
      grant();
    };
    const onAbort = (): void => {
      if (state !== 'waiting') return;
      state = 'done';
      leaveLine();
      refuse(signal.reason ?? new Error('cancelled'));
    };
    if (priority === 'now' || this.running < this.limit) {
      start();
    } else {
      this.waiting.push(start);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return {
      granted,
      promote: start,
      release: () => {
        signal.removeEventListener('abort', onAbort);
        if (state === 'running') {
          state = 'done';
          this.running -= 1;
          this.next();
        } else if (state === 'waiting') {
          state = 'done';
          leaveLine();
        }
      },
    };
  }

  // Starts waiting fetches while there is room, oldest first.
  private next(): void {
    while (this.running < this.limit) {
      const start = this.waiting[0];
      if (!start) return;
      start();
    }
  }
}
