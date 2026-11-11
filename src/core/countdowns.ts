/**
 * Countdowns by key: arm one, disarm it, and a callback runs for each that runs out.
 *
 * Used for "leave the voice channel after five minutes alone": arming an armed key keeps its original deadline (a
 * second person leaving does not restart the wait), disarming cancels it, and every countdown can be dropped at once.
 */
import type { Clock, TimerHandle } from './clock.ts';

export class Countdowns {
  private readonly clock: Clock;
  private readonly ms: number;
  private readonly expired: (key: string) => void;
  private readonly timers = new Map<string, TimerHandle>();

  constructor(clock: Clock, ms: number, expired: (key: string) => void) {
    this.clock = clock;
    this.ms = ms;
    this.expired = expired;
  }

  /** Starts the countdown for `key` unless one is running already. */
  arm(key: string): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      this.clock.setTimeout(() => {
        this.timers.delete(key);
        this.expired(key);
      }, this.ms),
    );
  }

  /** Cancels the countdown for `key`, if any. */
  disarm(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(key);
  }

  /** Whether `key` is counting down. */
  armed(key: string): boolean {
    return this.timers.has(key);
  }
}
