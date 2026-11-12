/**
 * Taking turns: where a track goes in a queue whose people take turns, and a queue put in turns at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inTurns, type Owner, type Playing, turnIndex } from '../../src/core/turns.ts';

// A queue written as its owners ("aab" is two of a's then b's), and a track of `owner` put where turns put it.
function add(queue: string, owner: string, playing: Playing = null): string {
  const owners = [...queue];
  owners.splice(turnIndex(owners, playing, owner), 0, owner);
  return owners.join('');
}

// A queue written as its owners, put in turns.
function arrange(queue: string, playing: Playing = null): string {
  const owners = [...queue];
  return inTurns(owners, playing)
    .map((index) => owners[index])
    .join('');
}

describe('taking turns', () => {
  it("puts a newcomer's track after everyone's first, and each next one after everyone's next", () => {
    assert.equal(add('', 'a'), 'a');
    assert.equal(add('aaa', 'b'), 'abaa');
    assert.equal(add('abaa', 'b'), 'ababa');
    assert.equal(add('ababa', 'c'), 'abcaba');
    assert.equal(add('abcaba', 'c'), 'abcabca');
    // Someone with the most tracks adds at the end: a round of their own.
    assert.equal(add('abcabca', 'a'), 'abcabcaa');
  });

  it("counts the track playing as its person's turn under way", () => {
    // a's track plays: b goes first, and a's next comes after b's.
    assert.equal(add('', 'b', { owner: 'a' }), 'b');
    assert.equal(add('b', 'a', { owner: 'a' }), 'ba');
    assert.equal(add('ba', 'c', { owner: 'a' }), 'bca');
    // A newcomer to a queue of the playing person's tracks goes next.
    assert.equal(add('aa', 'b', { owner: 'a' }), 'baa');
  });

  it("never puts a person's track before one of their own, whatever order the queue was left in", () => {
    // Moved by hand: a's second track before b's first. b's second still goes after b's first.
    assert.equal(add('aab', 'b'), 'aabb');
  });

  it('treats the host (no Discord ID) as one person', () => {
    // Two of the host's tracks: someone else's goes between them, the host's third at the end.
    const owners: Owner[] = [null, null];
    assert.equal(turnIndex(owners, null, 'y'), 1);
    assert.equal(turnIndex(owners, null, null), 2);
    // The host's track playing is the host's turn.
    assert.equal(turnIndex(['y'], { owner: null }, null), 1);
  });

  it("puts a queue in turns once, each person's tracks in their own order", () => {
    assert.equal(arrange('aaabbc'), 'abcaba');
    assert.equal(arrange('abcabc'), 'abcabc');
    // With b's track playing, b's first waiting track is already in the second round.
    assert.equal(arrange('aaabbc', { owner: 'b' }), 'acabab');
    // Each person's tracks keep their own order.
    const owners: Owner[] = ['a', 'a', 'b'];
    assert.deepEqual(inTurns(owners, null), [0, 2, 1]);
  });
});
