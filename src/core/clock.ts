/**
 * Time, behind an interface so the player can be tested without waiting.
 *
 * The player decides everything by the clock (where a track is, when it should end, when a seek may run again).
 * Tests pass a fake clock and move it forward by hand; jukecord itself uses the system clock below. How long ago
 * something happened is read from steady(), which only goes forward; now() is for dates (the history, a snapshot's
 * time), and moves when the system clock is set.
 */

/** A pending timer, as returned by setTimeout; only ever handed back to clearTimeout. */
export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the epoch: a date, which moves when the system clock is set back or forward. */
  now(): number;
  /** Milliseconds on a clock that only goes forward (see steadyNow), for how long ago something happened. */
  steady(): number;
  /** Runs `fn` once after `ms` milliseconds. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancels a timer; cancelling one that already ran does nothing. */
  clearTimeout(handle: TimerHandle): void;
}

/**
 * Milliseconds on a clock that only goes forward, from an arbitrary start: for how long ago something happened (a
 * message held back, a rate limit, the time a step took), never for a date. The system clock can be set back or
 * forward (by hand, or by NTP after a machine slept); a wait worked out from it would then last an hour, or not at all.
 */
export const steadyNow = (): number => performance.now();

/** The real clock. Timers are unref'd: a pending end-of-track timer must not keep a stopping process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  steady: steadyNow,
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
