/**
 * A lock for asynchronous work: one holder at a time, the others waiting their turn in the order they asked.
 *
 * The SQLite executor (src/store/sqlite.ts) keeps its one connection under one: a transaction holds it from BEGIN to
 * COMMIT, across every await in between, so a statement from anywhere else waits for the end instead of landing in the
 * middle of someone else's transaction.
 */

/** Gives the lock back; a second call does nothing, so a `finally` that runs twice cannot free someone else's turn. */
export type Release = () => void;

export class Lock {
  // Whether someone holds it now.
  private held = false;
  // Those waiting for it, oldest first; each is called with its turn.
  private readonly waiting: (() => void)[] = [];

  /** Whether someone holds the lock now (then whoever asks waits). */
  get locked(): boolean {
    return this.held;
  }

  /** How many are waiting for the lock (for tests). */
  get queued(): number {
    return this.waiting.length;
  }

  /** Waits for the lock and holds it until the release it resolves with is called. */
  acquire(): Promise<Release> {
    // Free: taken at once.
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.releaser());
    }
    // Held: in line, and handed the lock by the release before it (it is never free in between, so nobody jumps in).
    return new Promise((resolve) => {
      this.waiting.push(() => resolve(this.releaser()));
    });
  }

  // The release of one turn: hands the lock to the next one waiting, or frees it when nobody waits.
  private releaser(): Release {
    let done = false;
    return () => {
      // Released already: a second call must not take the turn of whoever holds the lock now.
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.held = false;
    };
  }
}
