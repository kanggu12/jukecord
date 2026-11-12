/**
 * The walk in groups (tests/ui/groups.ts, the look workflow's matrix): together the groups walk every state once and
 * take everything else a whole walk takes, whatever states are added later.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { EXTRAS, groupOf, walkExtras, walkStates } from '../ui/groups.ts';

// The walk as it is now, read as the groups read it.
const walk = fs.readFileSync('tests/ui/walk.mjs', 'utf8');

describe('the walk in groups', () => {
  it('finds every state of the walk, the name on the line of sweep( or on the next', () => {
    const states = walkStates(walk);
    assert.ok(states.length > 60, `only ${states.length} states found`);
    // A state written each way: sweep('idle', ...) and sweep(\n  'invite-friend', ...).
    assert.ok(states.includes('idle') && states.includes('playing') && states.includes('search'));
    assert.deepEqual(walkStates("await sweep(\n  'two-lines',\n  SIZES);\nawait sweep('one-line', FEW);"), [
      'two-lines',
      'one-line',
    ]);
  });

  it('walks every state once and the extras in the last group, for any number of groups', () => {
    const states = walkStates(walk);
    for (const count of [1, 2, 3, 4, 6]) {
      const groups = Array.from({ length: count }, (_, index) => groupOf(states, index, count));
      const all = groups.flat();
      assert.deepEqual([...all].sort(), [...states, ...EXTRAS].sort(), `${count} groups`);
      assert.equal(new Set(all).size, all.length, `${count} groups: a name walked twice`);
      assert.ok(
        groups.every((group) => group.length > 0),
        `${count} groups: an empty group`,
      );
      assert.deepEqual(groups[count - 1]?.slice(-EXTRAS.length), EXTRAS);
    }
  });

  it('takes every name the walk knows besides its states, so no group leaves one out', () => {
    // A new ONLY.has('...') in the walk must be added to EXTRAS (or be a state), or no group would ever take it.
    const states = new Set(walkStates(walk));
    for (const name of walkExtras(walk)) assert.ok(EXTRAS.includes(name) || states.has(name), name);
  });

  it('refuses a group that is not one of them', () => {
    assert.throws(() => groupOf(['a'], 4, 4), /the group is 0 to 3/);
    assert.throws(() => groupOf(['a'], -1, 4), /the group is 0 to 3/);
    assert.throws(() => groupOf(['a'], 0, 0), /from 1/);
  });
});
