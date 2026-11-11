/**
 * Time, behind an interface so the player can be tested without waiting.
 *
 * The player decides everything by the clock (where a track is, when it should end, when a seek may run again).
 * Tests pass a fake clock and move it forward by hand; jukecord itself uses the system clock below.
 */

/** A pending timer, as returned by setTimeout; only ever handed back to clearTimeout. */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Runs `fn` once after `ms` milliseconds. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancels a timer; cancelling one that already ran does nothing. */
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock. Timers are unref'd: a pending end-of-track timer must not keep a stopping process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
