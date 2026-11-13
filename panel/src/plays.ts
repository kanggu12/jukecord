/**
 * When a play of a track ends, as the panel tells it from the player's snapshots (the sleep timer's "when this track
 * ends" waits for it). Without the browser: tests/unit/plays.test.ts runs it on the real player's snapshots.
 *
 * The track's number is not enough: a track repeated (repeat one) starts again under the same number, and so does the
 * same track queued twice in a row. A new play of the same track is told by where it is: back at the start when the
 * last play had reached its end, or being made ready again (a new play from the queue) after it had started.
 */
import type { Player } from './api.ts';

// How far apart two places must be to count as a move back, and how near the end the last play must have been: well
// over the time between the end and the snapshot that starts the track again, under any track's length.
const SLACK_MS = 1500;

/**
 * Whether the play `last` was a snapshot of has ended by the snapshot `next`: another track or none, or the same track
 * started again from the top (repeated at its end, or played again from the queue). A seek, a pause or a resume is
 * still the same play.
 */
export function playEnded(last: Player, next: Player | null): boolean {
  const track = last.track;
  if (!track || !next?.track || next.track.id !== track.id) return true;
  // Where the last play had got to when `next` was sent: both places are in the server's own time, so no clock of
  // this browser is in it. Never past the track's end (the player's place stops there too).
  const length = last.durationMs ?? track.durationMs ?? Number.POSITIVE_INFINITY;
  const since = last.status === 'playing' ? Math.max(0, next.at - last.at) : 0;
  const reached = Math.min(last.positionMs + since, length);
  // Not back at the start, or not moved back at all: the same play (a restart of jukecord brings the track back where
  // it was, made ready again: still the same play).
  if (next.positionMs > SLACK_MS || next.positionMs >= reached - SLACK_MS) return false;
  // Back at the start after the end (repeat one), or a new play being made ready (the same track next in the queue).
  // Anything else is a seek back, which plays on.
  return reached >= length - SLACK_MS || (next.status === 'loading' && last.status !== 'loading');
}
