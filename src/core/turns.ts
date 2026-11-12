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

// The round of each item: how many items of its person come before it, the track playing counted for its person.
function roundsOf(owners: readonly Owner[], playing: Playing): number[] {
  const seen = new Map<Owner, number>();
  if (playing !== null) seen.set(playing.owner, 1);
  return owners.map((owner) => {
    const round = seen.get(owner) ?? 0;
    seen.set(owner, round + 1);
    return round;
  });
}

/**
 * Where `count` tracks of `owner` go, in turns, one after another (as turnIndex places each, in one pass instead of
 * one per track: a playlist of a thousand into a queue of a thousand is two thousand steps, not a million). Returns
 * the new queue's order: an item already there by its index, a new track `j` as `-(j + 1)`. The items already there
 * keep their order.
 */
export function addInTurns(owners: readonly Owner[], playing: Playing, owner: Owner, count: number): number[] {
  const rounds = roundsOf(owners, playing);
  // The last item of each round (the track playing is round 0's first, before the queue: -1), and the person's last.
  const lastOf = new Map<number, number>();
  if (playing !== null) lastOf.set(0, -1);
  let lastOwn = -1;
  let mine = playing !== null && playing.owner === owner ? 1 : 0;
  owners.forEach((other, index) => {
    lastOf.set(rounds[index] ?? 0, index);
    if (other === owner) {
      lastOwn = index;
      mine += 1;
    }
  });
  // Each new track goes after an item already there (its anchor; the length for the end), never before the new track
  // before it: so the anchors only grow, and tracks on the same anchor keep their order.
  const after = new Map<number, number[]>();
  let anchor = lastOwn;
  for (let track = 0; track < count; track += 1) {
    const last = lastOf.get(mine + track);
    anchor = Math.max(anchor, last === undefined ? owners.length : last);
    const onIt = after.get(anchor) ?? [];
    onIt.push(-(track + 1));
    after.set(anchor, onIt);
  }
  // The queue with each new track after its anchor (pushed one by one: a spread of a hundred thousand would be too
  // many arguments for one call).
  const order: number[] = [];
  const place = (anchor: number) => {
    for (const track of after.get(anchor) ?? []) order.push(track);
  };
  place(-1);
  owners.forEach((_, index) => {
    order.push(index);
    place(index);
  });
  place(owners.length);
  return order;
}

/**
 * A queue put in turns, as the indexes of its items in their new order: each person's tracks in their own order, round
 * after round, and in each round in the order the queue has them now (what placing each in turn, one by one, gives).
 * A sort, so a long queue costs little: the order of the round, then of the place.
 */
export function inTurns(owners: readonly Owner[], playing: Playing): number[] {
  const rounds = roundsOf(owners, playing);
  return owners.map((_, index) => index).sort((a, b) => (rounds[a] ?? 0) - (rounds[b] ?? 0) || a - b);
}
