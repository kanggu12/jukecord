/**
 * Taking turns in a queue. With a server's turns on, a track added goes after the last track of the first round in
 * which its person has none yet, so people take turns instead of waiting behind one person's long run of tracks.
 *
 * A round is everyone's n-th track: an item is in round k when its person has k items before it in the queue, and the
 * track playing counts as its person's first (that turn is under way). A person with k tracks waiting, the one playing
 * included, adds into round k: after its last item, and never before a track of their own; when nobody has a track in
 * that round yet, at the end. Who added a track is a Discord ID, or null for the host, who counts as one person.
 *
 * Pure functions over who added each item, in queue order: the queue service turns their answers into places.
 */

/** Who added a queue item: a Discord user ID, or null for the host (and a panel without a Discord login). */
export type Owner = string | null;

/** Who added the track playing, which counts as that person's turn under way; null when nothing plays. */
export type Playing = { readonly owner: Owner } | null;

/** Where a track of `owner` goes, in turns, in a queue whose items were added by `owners` (0 is next; the length is the end). */
export function turnIndex(owners: readonly Owner[], playing: Playing, owner: Owner): number {
  // The person's round: how many of their tracks wait, and the one playing when it is theirs.
  let round = playing !== null && playing.owner === owner ? 1 : 0;
  for (const other of owners) if (other === owner) round += 1;
  // Each person's count so far, walking the queue: an item's round is its person's count before it.
  const seen = new Map<Owner, number>();
  // The track playing is the first item of round 0 (just before the queue): a newcomer goes in after it at the latest.
  let lastOfRound = Number.NEGATIVE_INFINITY;
  if (playing !== null) {
    seen.set(playing.owner, 1);
    if (round === 0) lastOfRound = -1;
  }
  // The person's own last track: theirs never move behind a newer one of theirs.
  let lastOwn = -1;
  owners.forEach((other, index) => {
    const its = seen.get(other) ?? 0;
    seen.set(other, its + 1);
    if (its === round) lastOfRound = index;
    if (other === owner) lastOwn = index;
  });
  // Nobody has a track in that round yet: a round of its own, at the end.
  if (lastOfRound === Number.NEGATIVE_INFINITY) return owners.length;
  return Math.max(lastOfRound, lastOwn) + 1;
}

/**
 * A queue put in turns, as the indexes of its items in their new order: each item placed in turn, in the order the
 * queue has them now, so each person's tracks keep their own order and the rounds go in the order people first come.
 */
export function inTurns(owners: readonly Owner[], playing: Playing): number[] {
  const order: number[] = [];
  const placed: Owner[] = [];
  owners.forEach((owner, index) => {
    const at = turnIndex(placed, playing, owner);
    order.splice(at, 0, index);
    placed.splice(at, 0, owner);
  });
  return order;
}
