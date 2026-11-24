/**
 * Per-server lanes: every change to one server's state takes its turn in that server's lane, one at a time and in the
 * order asked, while the lanes of different servers run side by side.
 *
 * While the database answered synchronously, every change ran to its end in one go, so two changes of one server could
 * never interleave. Now a change can wait halfway (for a write to be answered), and another change of the same server
 * would run in that gap: a skip between an add's look at the queue and its insert. In the lane it waits instead.
 *
 * A turn is reentrant: a task holding a server's lane that calls something asking for the same lane (an action calling
 * the player) runs it at once, inside its own turn, instead of waiting for itself. The holder is found through
 * AsyncLocalStorage, so nothing is passed down. Work a turn starts without waiting for it (a timer, a fetch's callback)
 * must not run inside the turn: it asks with `later`, which always takes a turn of its own. And a turn that has ended
 * no longer counts as held where its context lingers (a timer it set inherits it).
 *
 * One rule keeps lanes from waiting on each other forever: a turn never waits for a turn of another server's lane.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// One turn: the server it is for, and whether it is still running (its context outlives it in timers it set).
interface Turn {
  readonly guildId: string;
  running: boolean;
}

// Settles a lane's end whether the turn worked or failed: the next turn starts either way.
const ignore = (): void => {};

// The outcome of a task run now as a promise: its value, or its error (a throw included) as a rejection.
function settled<T>(task: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(task());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Throws a failure out of the event loop, as an uncaught exception: what a timer's own throw was before its work
 * became asynchronous. main.ts logs it, saves where every server is and exits, and the restart policy starts jukecord
 * again; a test hears it as the failure of the test running.
 */
export function throwFromTimer(error: unknown): void {
  process.nextTick(() => {
    throw error;
  });
}

export class GuildLanes {
  // The end of each server's lane: settles when the last turn asked for is over. None for a server with nothing to do.
  private readonly tails = new Map<string, Promise<void>>();
  // The turn the code running now is inside, if any.
  private readonly current = new AsyncLocalStorage<Turn>();

  /**
   * Runs `task` in the server's lane: at once when the caller holds a turn of that lane (it is part of that turn),
   * otherwise in a turn of its own after every turn asked for before. Settles with what the task returns or throws.
   */
  run<T>(guildId: string, task: () => T | Promise<T>): Promise<T> {
    if (this.holds(guildId)) return settled(task);
    return this.later(guildId, task);
  }

  /**
   * Runs `task` in a turn of its own after every turn asked for before, even when the caller holds the lane: for work
   * that a timer, an event or a callback starts, which is never part of the turn that set it up. A caller holding the
   * lane must not wait for it (that turn would wait for itself).
   */
  later<T>(guildId: string, task: () => T | Promise<T>): Promise<T> {
    const turn: Turn = { guildId, running: false };
    const before = this.tails.get(guildId);
    // The lane's new end is set before the task starts: whatever the task asks for of this lane meanwhile (a later()
    // of its own) waits behind it.
    let over: () => void = ignore;
    const tail = new Promise<void>((resolve) => {
      over = resolve;
    });
    this.tails.set(guildId, tail);
    // Forgotten once idle again: a server nobody changes keeps nothing here.
    void tail.then(() => {
      if (this.tails.get(guildId) === tail) this.tails.delete(guildId);
    });
    // The turn itself: the task runs with the turn as its context, which ends with the task.
    const start = async (): Promise<T> => {
      turn.running = true;
      try {
        return await this.current.run(turn, task);
      } finally {
        turn.running = false;
        // The next turn may start, whether this one worked or failed.
        over();
      }
    };
    // An idle lane starts the task at once (as a change ran before there were lanes); a busy one after its last turn.
    return before !== undefined ? before.then(start) : start();
  }

  /** Whether the code running now holds a turn of the server's lane (inside a turn still running). */
  holds(guildId: string): boolean {
    const turn = this.current.getStore();
    return turn?.running === true && turn.guildId === guildId;
  }

  /**
   * Settles once the server's lane has no turn running or waiting (every server's lane, when none is named): for
   * shutting down after the last change, and for tests.
   */
  async idle(guildId?: string): Promise<void> {
    // Turns can ask for more turns as they run (a timer's turn, a callback's): looked at again until none is left.
    for (;;) {
      const waiting = guildId === undefined ? [...this.tails.values()] : [this.tails.get(guildId)];
      const tails = waiting.filter((tail): tail is Promise<void> => tail !== undefined);
      if (tails.length === 0) return;
      await Promise.all(tails);
    }
  }
}
