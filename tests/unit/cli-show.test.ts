/**
 * What the jukecord command prints for the API's answers, without a server: the shapes come from the API.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS } from '../../src/cli/commands.ts';

describe('the jukecord command shows', () => {
  it('listening time in whole minutes, with the hours made from them', () => {
    const stats = { span: 30, plays: 20, playedMs: 3_599_000, tracks: 20, topTracks: [], topPeople: [] };
    // 59 min 59 s is an hour, not "0 h 60 min"; under an hour, no hours at all.
    assert.equal(COMMANDS.stats.show(stats), 'The last 30 days: 20 plays, 1 h 0 min, 20 tracks');
    assert.equal(
      COMMANDS.stats.show({ ...stats, playedMs: 3 * 3_600_000 - 20_000 }),
      'The last 30 days: 20 plays, 3 h 0 min, 20 tracks',
    );
    assert.equal(
      COMMANDS.stats.show({ ...stats, playedMs: 45 * 60_000 }),
      'The last 30 days: 20 plays, 45 min, 20 tracks',
    );
  });
});
