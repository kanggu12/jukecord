/**
 * Discord's suggestions under /play's and /add's input, as it is typed: what a search finds for the words, each
 * suggestion carrying the address that adds exactly that track.
 *
 * Discord shows suggestions only when they come within three seconds of the question, and asks again as the words
 * change. So a suggestion comes from what a search found lately, or from a search that finishes in time; anything
 * slower (or failing) is no suggestion at all, and the words typed are searched as they are when the command is sent.
 */
import type { NewTrack } from '../core/types.ts';
import { parseInput } from '../media/source.ts';
import { formatDuration } from '../util/time.ts';

/** One suggestion as Discord takes it: what it shows (1 to 100 characters) and what the option becomes. */
export interface Choice {
  readonly name: string;
  readonly value: string;
}

/** How long a suggestion may take: Discord gives three seconds, and the way there and back takes some of it. */
export const SUGGEST_WAIT_MS = 2000;

// Discord's bounds: 25 suggestions, 100 characters for each name and each value.
const MOST = 10;
const LONGEST = 100;

/** A suggestion for a found track: "Title · Channel · 3:45", cut to fit, with the track's address as its value. */
export function choiceOf(track: NewTrack): Choice | null {
  // An address longer than Discord allows cannot be the value; YouTube's are 43 characters.
  if (track.url.length > LONGEST) return null;
  const tail = [track.uploader, track.durationMs === null ? null : formatDuration(track.durationMs)]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  // The title gives way first, ending in an ellipsis; the channel and the length stay whole when they fit.
  const room = tail ? LONGEST - tail.length - 3 : LONGEST;
  const title = track.title.length > room ? `${track.title.slice(0, Math.max(1, room - 1)).trimEnd()}…` : track.title;
  const name = (tail && room > 10 ? `${title} · ${tail}` : track.title).slice(0, LONGEST);
  return { name, value: track.url };
}

/**
 * The suggestions for what is typed: none for an address (it is added as it is) or for fewer than two letters, else
 * what `search` finds within the wait. `signal` stops the search early (the same person typed on, and Discord asks
 * about the newer words).
 */
export async function suggestions(
  typed: string,
  search: (words: string, signal: AbortSignal) => Promise<NewTrack[]>,
  signal?: AbortSignal,
  waitMs = SUGGEST_WAIT_MS,
): Promise<Choice[]> {
  const words = typed.trim();
  if (words.length < 2) return [];
  let input: ReturnType<typeof parseInput>;
  try {
    input = parseInput(words);
  } catch {
    return [];
  }
  if (input.kind === 'url') return [];
  // The wait and the person's next words, whichever comes first, stop the search.
  const stop = AbortSignal.any([AbortSignal.timeout(waitMs), ...(signal ? [signal] : [])]);
  try {
    const found = await search(input.query, stop);
    return found
      .map(choiceOf)
      .filter((choice): choice is Choice => choice !== null)
      .slice(0, MOST);
  } catch {
    // Too slow, refused (no DJ role, every lookup slot taken) or failed: no suggestion; the command still works.
    return [];
  }
}
