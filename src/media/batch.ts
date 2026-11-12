/**
 * Lookups that come in lists: an imported playlist's lines, the tracks of a Deezer or Spotify link. A list of a hundred
 * runs three at a time, in turns shared by every list, apart from the lookups people wait for one at a time (those keep
 * the resolver's own slots, so a long list never holds up someone adding a song). One list per person at a time; the
 * second is refused at once, with the reason.
 */
import { BusyError } from './busy.ts';

/** How many of a list's lookups run at once, across every list. */
export const BATCH_AT_ONCE = 3;

/** The most lookups one list may make (an import's lines without what they are, a link's tracks to match). */
export const BATCH_MOST = 100;

export class BatchLookups {
  private readonly atOnce: number;
  private running = 0;
  // Lookups waiting for their turn, oldest first.
  private readonly waiting: (() => void)[] = [];
  // The people with a list under way (the host counts as one).
  private readonly people = new Set<string>();

  constructor(atOnce = BATCH_AT_ONCE) {
    this.atOnce = atOnce;
  }

  /**
   * Runs `work` for every item, at most `atOnce` at a time across every list, and gives each result (or its error) in
   * the items' order. `each` hears every result as it comes, with its place. `who` is the person the list is for
   * (null: the host): a second list of theirs while one runs is refused with BusyError.
   */
  async map<I, O>(
    who: string | null,
    items: readonly I[],
    work: (item: I, signal: AbortSignal) => Promise<O>,
    options: { signal?: AbortSignal; each?: (index: number, result: O | Error) => void } = {},
  ): Promise<(O | Error)[]> {
    const person = who ?? 'host';
    if (this.people.has(person))
      throw new BusyError('jukecord is still adding a list of yours; try again when it is done');
    this.people.add(person);
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const results: (O | Error)[] = new Array(items.length);
      await Promise.all(
        items.map(async (item, index) => {
          let result: O | Error;
          try {
            await this.turn(stop.signal);
            try {
              result = await work(item, stop.signal);
            } finally {
              this.done();
            }
          } catch (error) {
            result = error instanceof Error ? error : new Error(String(error));
          }
          results[index] = result;
          options.each?.(index, result);
        }),
      );
      return results;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.people.delete(person);
    }
  }

  // Waits for a turn (at once when one is free); rejects when the list is stopped meanwhile.
  private turn(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('stopped'));
    if (this.running < this.atOnce) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', give);
        this.running += 1;
        resolve();
      };
      // Stopped while waiting: out of the line, and its turn goes to the next.
      const give = () => {
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason ?? new Error('stopped'));
      };
      signal.addEventListener('abort', give, { once: true });
      this.waiting.push(go);
    });
  }

  // A lookup ended: the next one waiting takes its turn.
  private done(): void {
    this.running -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
