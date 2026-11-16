/**
 * Where a Wrapped picture's cards go (picture.ts draws them there): the cards' heights at a scale, and the scale that
 * makes them one block filling the room between the time's words and the foot. Kept apart from the drawing, with no
 * page or canvas in it, so the layout is tested as it is (tests/unit/picture-layout.test.ts).
 */

// A list card's parts at its scale: its head's baseline, where its first row starts, a row's height, and the room
// under its last row. A card of moments beside a list sets its own rows on the same lines (momentsCard).
export const LIST = { head: 62, top: 86, row: 56, foot: 18 } as const;

// How tall a card listing `rows` is, at a scale, its rows `pitch` apart (a row's height at the scale unless said).
function listHeight(rows: number, scale: number, pitch = LIST.row * scale): number {
  return Math.round((LIST.top + LIST.foot) * scale + rows * pitch);
}

/** A card's place in a picture: its top and its height, in the picture's pixels. */
export interface Place {
  readonly y: number;
  readonly h: number;
}

/**
 * Where a picture's cards go, top to bottom, and the scale they are drawn at (1 is the year's): the cards are one
 * block, as large as fills the room between the time's words and the foot, so a time with a few plays shows its few
 * things larger and sits as a full year does (set in the middle of the room at the year's size, the first month's
 * cards had 150 px of nothing over them and under them, the year's 33). At most 1.4 times the year's size; past that,
 * in the middle of the room.
 */
export interface Block {
  readonly scale: number;
  /** The song of the time (or with none the first track) on its record; null when there is neither. */
  readonly song: Place | null;
  /** The totals side by side. */
  readonly totals: Place;
  /** The story's most played; the square has none of its own (its lists share the low row). */
  readonly tracks: Place | null;
  /** The last row: the story's whose picks played most beside the moments, the square's two lists side by side. */
  readonly low: Place;
}

// What a picture's block is made of, as its content has it (only whether there is a song, and how many of the rest).
export interface Parts {
  /** The song of the time, or with none its first track (a time with plays has one), or null. */
  readonly song: unknown;
  readonly tracks: readonly unknown[];
  readonly people: readonly unknown[];
  readonly moments: readonly unknown[];
}

// The largest a block is made, in times the year's size.
const MOST = 1.4;

// A block's cards one under another from a top, `gap` apart, each as tall as said (0: no such card).
function stack(top: number, gap: number, heights: readonly number[]): (Place | null)[] {
  let y = top;
  return heights.map((h) => {
    if (h === 0) return null;
    const place = { y: Math.round(y), h };
    y += h + gap;
    return place;
  });
}

// The scale that fills a room with a block whose height at a scale is `height(scale)`: up to MOST, and found again at
// the rounded heights so the block's foot meets the room's within a pixel or two.
function filling(room: number, height: (scale: number) => number): number {
  const scale = Math.min(MOST, room / height(1));
  return Math.min(MOST, scale * (room / height(scale)));
}

/**
 * The story's block under the time's words (`top`, where the room begins) down to the foot: the song, the totals, the
 * five most played, and whose picks played most beside the moments, those two sharing their head and their rows'
 * lines, as many rows as the longer has.
 */
export function storyBlock(content: Parts, top: number): Block {
  const rows = Math.max(1, Math.min(3, content.people.length), content.moments.length);
  const heights = (scale: number) => ({
    song: content.song ? Math.round(360 * scale) : 0,
    totals: Math.round(156 * scale),
    tracks: listHeight(Math.min(5, content.tracks.length), scale),
    low: listHeight(rows, 0.88 * scale, 70 * scale),
    gap: Math.round(28 * scale),
  });
  const tall = (scale: number) => {
    const part = heights(scale);
    return (part.song ? part.song + part.gap : 0) + part.totals + part.gap + part.tracks + part.gap + part.low;
  };
  const room = STORY.bottom - top;
  const scale = filling(room, tall);
  const part = heights(scale);
  // In the middle of the room, which it fills unless it is at its largest.
  const [song, totals, tracks, low] = stack(top + Math.max(0, (room - tall(scale)) / 2), part.gap, [
    part.song,
    part.totals,
    part.tracks,
    part.low,
  ]);
  return { scale, song: song ?? null, totals: totals as Place, tracks: tracks ?? null, low: low as Place };
}

/** The square's block under its title: the song, the totals, and the three most played beside whose picks did. */
export function squareBlock(content: Parts): Block {
  // The two lists' cards as tall as the longer one's rows, three at most (always three tall, two rows of a time with
  // few plays had 80 px of nothing under them).
  const rows = Math.max(1, Math.min(3, content.tracks.length), Math.min(3, content.people.length));
  const heights = (scale: number) => ({
    song: content.song ? Math.round(316 * scale) : 0,
    totals: Math.round(140 * scale),
    low: listHeight(rows, 0.8 * scale),
    gap: Math.round(24 * scale),
  });
  const tall = (scale: number) => {
    const part = heights(scale);
    return (part.song ? part.song + part.gap : 0) + part.totals + part.gap + part.low;
  };
  const room = SQUARE.bottom - SQUARE.top;
  const scale = filling(room, tall);
  const part = heights(scale);
  const [song, totals, low] = stack(SQUARE.top + Math.max(0, (room - tall(scale)) / 2), part.gap, [
    part.song,
    part.totals,
    part.low,
  ]);
  return { scale, song: song ?? null, totals: totals as Place, tracks: null, low: low as Place };
}

// The story's frame: its margin, the server's row, the time's words (its big line's top a little under the server's
// row, whatever size the words fit at), where the cards' room ends, and the foot's baseline.
export const STORY = { margin: 72, server: 128, bigTop: 250, bottom: 1784, foot: 1846 } as const;
// The square's: its margin, the server's row, the title's baseline, the cards' room and the foot's baseline.
export const SQUARE = { margin: 56, server: 48, title: 194, top: 228, bottom: 988, foot: 1036 } as const;
