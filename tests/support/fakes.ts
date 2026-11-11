/**
 * Stand-ins for time, media and outputs, so the player can be driven step by step in tests.
 */
import type { Clock, TimerHandle } from '../../src/core/clock.ts';
import type { MediaPreparer, PlayerOutput, PreparedMedia } from '../../src/core/player.ts';
import type { Track } from '../../src/core/types.ts';

/** Lets every pending promise callback run, the way the event loop would between two real events. */
export async function flush(): Promise<void> {
  // setImmediate runs after the microtask queue is empty; two rounds cover a callback that schedules another.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** A clock that only moves when a test moves it; timers run in order as time passes them. */
export class FakeClock implements Clock {
  private time: number;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  // A fixed, recognisable start (2026-11-11T00:00:00Z) so timestamps in failures are easy to read.
  constructor(start = Date.UTC(2026, 10, 11)) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.sequence += 1;
    this.timers.set(this.sequence, { at: this.time + Math.max(0, ms), fn });
    return this.sequence;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** How many timers are waiting (a stopped player must leave none behind). */
  pending(): number {
    return this.timers.size;
  }

  /** Moves time forward by `ms`, running each due timer at its own time, earliest (then oldest) first. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at > target) continue;
        if (!due || entry[1].at < due[1].at || (entry[1].at === due[1].at && entry[0] < due[0])) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = target;
    await flush();
  }
}

/** One call to prepare(), waiting for the test to decide how it ends. */
export interface PendingPrepare {
  readonly track: Track;
  readonly signal: AbortSignal;
  /** The progress callback the caller passed, if any. */
  readonly onProgress: ((fraction: number) => void) | undefined;
  /** Whether somebody waits for the track ('now') or it is fetched ahead of time ('ahead'). */
  readonly priority: 'now' | 'ahead';
  resolve(media: PreparedMedia): void;
  reject(error: Error): void;
}

/** A media preparer whose fetches finish only when the test says so. */
export class FakeMedia implements MediaPreparer {
  readonly calls: PendingPrepare[] = [];

  prepare(
    track: Track,
    signal: AbortSignal,
    onProgress?: (fraction: number) => void,
    priority: 'now' | 'ahead' = 'now',
  ): Promise<PreparedMedia> {
    return new Promise<PreparedMedia>((resolve, reject) => {
      this.calls.push({ track, signal, onProgress, priority, resolve, reject });
      // Like the real preparer: an abort ends the fetch with an error.
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }

  /** The newest call, which must exist. */
  last(): PendingPrepare {
    const call = this.calls.at(-1);
    if (!call) throw new Error('prepare() was not called');
    return call;
  }

  /** Finishes the newest fetch with a file of the given length. */
  finish(durationMs: number): void {
    const call = this.last();
    call.resolve({ file: `/cache/${call.track.id}.opus`, durationMs });
  }
}

/** One thing an output was asked to do. */
export type OutputCall =
  | { readonly kind: 'start'; readonly offsetMs: number; readonly session: number; readonly file: string }
  | { readonly kind: 'pause' | 'resume' | 'stop' };

/** An output that records what it was asked to do. */
export class FakeOutput implements PlayerOutput {
  readonly name: string;
  readonly calls: OutputCall[] = [];

  constructor(name = 'voice') {
    this.name = name;
  }

  start(media: PreparedMedia, offsetMs: number, session: number): void {
    this.calls.push({ kind: 'start', offsetMs, session, file: media.file });
  }

  pause(): void {
    this.calls.push({ kind: 'pause' });
  }

  resume(): void {
    this.calls.push({ kind: 'resume' });
  }

  stop(): void {
    this.calls.push({ kind: 'stop' });
  }

  /** The calls of one kind, in order. */
  of(kind: OutputCall['kind']): OutputCall[] {
    return this.calls.filter((call) => call.kind === kind);
  }

  /** The session of the newest start, which outputEnded must be called with. */
  lastSession(): number {
    const start = this.calls.findLast((call) => call.kind === 'start');
    if (start?.kind !== 'start') throw new Error('the output was never started');
    return start.session;
  }
}
