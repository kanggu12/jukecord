/**
 * The one error for "too much at once": lookups and MP3 copies run a few at a time, and a request past that limit is
 * refused at once (the caller tries again in a moment) rather than queued behind work it cannot see.
 */
export class BusyError extends Error {
  override name = 'BusyError';
}
