/**
 * Throwaway databases filled with made-up tracks, for tests.
 */
import type { Track } from '../../src/core/types.ts';
import { Store } from '../../src/store/store.ts';

/** An in-memory database at the latest schema; `now` fixes the timestamps it writes. */
export function memoryStore(now: () => number = () => Date.UTC(2026, 10, 11)): Store {
  return Store.open(':memory:', { now });
}

/** Stores `count` tracks named "Track 1".. with example.com addresses and a 3-minute length. */
export function addTracks(store: Store, count: number, prefix = 'v'): Track[] {
  return Array.from({ length: count }, (_, index) =>
    store.tracks.upsert({
      // example.com: test data must not point at real pages.
      source: `https://example.com/watch?v=${prefix}${index + 1}`,
      url: `https://example.com/watch?v=${prefix}${index + 1}`,
      title: `Track ${index + 1}`,
      uploader: 'Example',
      durationMs: 180_000,
      thumbnail: null,
    }),
  );
}
