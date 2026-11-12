/**
 * Taking turns: where a track goes in a queue whose people take turns, and a queue put in turns at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addInTurns, inTurns, type Owner, type Playing, turnIndex } from '../../src/core/turns.ts';

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

// The rule placed one track at a time, as it reads (the reference the quick functions must agree with).
function oneByOne(owners: Owner[], playing: Playing, owner: Owner, count: number): number[] {
  const order = owners.map((_, index) => index);
  const placed = [...owners];
  for (let track = 0; track < count; track += 1) {
    const at = turnIndex(placed, playing, owner);
    order.splice(at, 0, -(track + 1));
    placed.splice(at, 0, owner);
  }
  return order;
}

// A queue of the same, put in turns one item at a time.
function arrangedOneByOne(owners: Owner[], playing: Playing): number[] {
  const order: number[] = [];
  const placed: Owner[] = [];
  owners.forEach((owner, index) => {
    const at = turnIndex(placed, playing, owner);
    order.splice(at, 0, index);
    placed.splice(at, 0, owner);
  });
  return order;
}

describe('taking turns, quickly', () => {
  it('places tracks as the rule placed one at a time does, on queues of every shape', () => {
    // A fixed sequence of numbers, so a failure can be run again.
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const people: Owner[] = ['a', 'b', 'c', 'd', null];
    for (let round = 0; round < 300; round += 1) {
      const owners = Array.from({ length: Math.floor(next() * 14) }, () => people[Math.floor(next() * 5)] ?? null);
      const playing: Playing = next() < 0.3 ? null : { owner: people[Math.floor(next() * 5)] ?? null };
      const owner = people[Math.floor(next() * 5)] ?? null;
      const count = 1 + Math.floor(next() * 4);
      assert.deepEqual(addInTurns(owners, playing, owner, count), oneByOne(owners, playing, owner, count));
      assert.deepEqual(inTurns(owners, playing), arrangedOneByOne(owners, playing));
    }
  });

  it('takes a hundred thousand tracks in turns in well under a second', () => {
    const owners: Owner[] = Array.from({ length: 100_000 }, (_, index) => `p${index % 37}`);
    const started = performance.now();
    assert.equal(inTurns(owners, { owner: 'p3' }).length, 100_000);
    assert.equal(addInTurns(owners, null, 'newcomer', 100_000).length, 200_000);
    assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`);
  });
});
