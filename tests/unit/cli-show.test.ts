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

  it('how long jukecord has been up, in days and hours past a day', () => {
    const status = { version: '0.2.1', mode: 'discord', discord: true, uptimeMs: 9 * 86_400_000 };
    assert.equal(COMMANDS.status.show(status).split('\n')[2], 'Up for 9 d 0 h');
    assert.equal(
      COMMANDS.status.show({ ...status, uptimeMs: 86_400_000 + 5 * 3_600_000 + 59 * 60_000 }).split('\n')[2],
      'Up for 1 d 5 h',
    );
    assert.equal(COMMANDS.status.show({ ...status, uptimeMs: 3_723_000 }).split('\n')[2], 'Up for 1:02:03');
  });
});
