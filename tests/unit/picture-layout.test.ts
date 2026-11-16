/**
 * Wrapped's pictures (panel/src/views/picture.ts) set their cards as one block that fills the room between the time's
 * words and the foot: a time with a few plays shows its few things larger and sits as a full year does. Set in the
 * middle of the room at the year's size, the first month's story had 150 px of nothing over its cards and under them
 * while the year's kept 33.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Block, squareBlock, storyBlock } from '../../panel/src/views/picture-layout.ts';

// What the layout reads of a picture's content: whether there is a song (or a first track), and how many tracks,
// people and moments it lists. The words themselves do not matter here.
const content = (tracks: number, people: number, moments: number) => ({
  song: { label: '', title: '', artist: null, facts: '', factsApart: [], cover: null },
  tracks: Array.from({ length: tracks }, (_, index) => ({ title: '', plays: '', rank: index + 1, cover: null })),
  people: Array.from({ length: people }, (_, index) => ({ name: '', picture: null, plays: '', rank: index + 1 })),
  moments: Array.from({ length: moments }, () => ({ label: '', value: '', main: '', sub: '' })),
});

// The cards of a block from top to bottom, and where the first begins and the last ends.
function span(block: Block): { top: number; bottom: number; places: { y: number; h: number }[] } {
  const places = [block.song, block.totals, block.tracks, block.low].filter((place) => place !== null);
  const last = places.at(-1) ?? block.low;
  return { top: places[0]?.y ?? 0, bottom: last.y + last.h, places };
}

// The times the walk draws, and the fewest a time with plays can have: a year (a song, five tracks, three people and
// three moments), the server's first month (its first track, two tracks, two people and the longest day alone), and a
// single play (its first track, one track, no person, the longest day). A time with plays always has a first track,
// which takes the song's place when no song played twice.
const TIMES = {
  'a year': content(5, 3, 3),
  'the first month': content(2, 2, 1),
  'a single play': content(1, 0, 1),
};

describe("a Wrapped picture's cards", () => {
  for (const [name, parts] of Object.entries(TIMES)) {
    it(`fill the story's room for ${name}, from under the time's words to the foot`, () => {
      // The room's top as the story's words leave it for a year (the words' height does not change the rule).
      const block = storyBlock(parts, 498);
      const { top, bottom, places } = span(block);
      assert.ok(Math.abs(top - 498) <= 1, `the first card starts at ${top}, not under the words at 498`);
      assert.ok(Math.abs(bottom - 1784) <= 2, `the last card ends at ${bottom}, not over the foot at 1784`);
      // One after another, each the block's gap under the one before (no card laid over another).
      for (const [index, place] of places.entries()) {
        const before = places[index - 1];
        if (before) assert.ok(place.y >= before.y + before.h, `card ${index} starts inside the one before it`);
      }
      // Never smaller than a year's, nor more than 1.4 times it.
      assert.ok(block.scale >= 0.99 && block.scale <= 1.4, `drawn at ${block.scale.toFixed(3)} times the year's size`);
    });

    it(`fill the square's room for ${name}`, () => {
      const block = squareBlock(parts);
      const { top, bottom } = span(block);
      assert.ok(Math.abs(top - 228) <= 1, `the first card starts at ${top}, not under the title at 228`);
      assert.ok(Math.abs(bottom - 988) <= 2, `the last card ends at ${bottom}, not over the foot at 988`);
      assert.ok(block.scale >= 0.99 && block.scale <= 1.4, `drawn at ${block.scale.toFixed(3)} times the year's size`);
    });
  }

  it("draw a year's story at the year's own size", () => {
    // The year's cards are what fill the room at scale 1: its picture is as it was.
    assert.ok(Math.abs(storyBlock(TIMES['a year'], 498).scale - 1) < 0.005);
  });

  it('draw a time with fewer things larger, up to 1.4 times', () => {
    const year = storyBlock(TIMES['a year'], 498).scale;
    const month = storyBlock(TIMES['the first month'], 498).scale;
    assert.ok(month > year, `the first month at ${month.toFixed(3)}, the year at ${year.toFixed(3)}`);
    // A room far taller than a block of one row of each: at most 1.4 times, in the middle of the room.
    const small = storyBlock(TIMES['a single play'], 200);
    const { top, bottom } = span(small);
    assert.equal(small.scale, 1.4);
    assert.ok(Math.abs(top - 200 - (1784 - bottom)) <= 2, 'the block at its largest is not in the middle of the room');
  });
});
