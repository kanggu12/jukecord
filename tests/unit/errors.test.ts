import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REASONS } from '../../src/core/reasons.ts';
import { sayError, sayFailure, translate } from '../../src/core/say.ts';
import { sayError as sayInDiscord } from '../../src/discord/errors.ts';

// Every file under src, for the messages the actions can give.
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('sayError', () => {
  it('has Korean for every fixed message an action can refuse with', () => {
    const messages = new Set<string>();
    for (const file of sources('src')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/new ActionError\(\s*'[a-z-]+',\s*'([^'$]+)'\s*\)/g)) {
        if (match[1]) messages.add(match[1]);
      }
    }
    assert.ok(messages.size > 15, `only ${messages.size} messages were found; is the pattern still right?`);
    // Every one of them: the panel shows the ones Discord never meets (browser-only and API-only refusals).
    for (const message of messages) {
      const korean = sayError(message, 'ko');
      assert.notEqual(korean, sayError(message, 'en'), `no Korean for "${message}"`);
    }
  });

  it('has Korean for why a live connection, a change or audio is turned away', () => {
    for (const reason of [
      'too many changes at once; try again in a moment',
      'too many skips at once; try again in a moment',
      'jukecord is busy; try again in a moment',
      'jukecord has as many live connections as it allows',
      'too many live connections for this login; close a tab or two',
      'too many live connections from this address; close a tab or two',
      'too many failed logins; wait ten minutes',
    ]) {
      assert.notEqual(sayError(reason, 'ko'), sayError(reason, 'en'), `no Korean for "${reason}"`);
    }
  });

  it('translates the messages with values, and every short reason', () => {
    assert.equal(sayError('the queue is full (1000 tracks)', 'ko'), '대기열이 가득 참(1000곡)');
    assert.equal(sayError('there is no playlist named "Road trip"', 'ko'), '"Road trip" 플레이리스트 없음');
    assert.equal(sayError('the site answered 404', 'ko'), '사이트가 404로 답함');
    assert.equal(sayError('position 9 is outside the queue (0-3)', 'ko'), '대기열 밖의 자리(마지막 자리 번호는 3)');
    assert.equal(sayError('Discord did not answer: timed out', 'ko'), '디스코드가 답하지 않음: 잠시 뒤 다시');
    for (const reason of Object.values(REASONS))
      assert.notEqual(sayError(reason, 'ko'), sayError(reason, 'en'), reason);
    // English is the message as a sentence; an unknown message stays English in Korean too.
    assert.equal(sayError('nothing is playing', 'en'), 'Nothing is playing');
    assert.equal(sayError('something new', 'ko'), 'Something new');
  });

  it('gives a reason as it is for the middle of a sentence, and the bot the same words as the panel', () => {
    // No capital: "Could not play: no such site".
    assert.equal(translate('no such site', 'en'), 'no such site');
    assert.equal(translate('no such site', 'ko'), '없는 사이트');
    assert.equal(translate('something new', 'ko'), 'something new');
    // The bot's door leads to the same table.
    assert.equal(sayInDiscord, sayError);
  });

  it('translates the reason of a failed track and leaves its title alone', () => {
    assert.equal(sayFailure('Neon Rain: the site answered 404', 'ko'), 'Neon Rain: 사이트가 404로 답함');
    // A title with a colon of its own: only what follows the last one is the reason.
    assert.equal(sayFailure('Part II: The Valley: no such site', 'ko'), 'Part II: The Valley: 없는 사이트');
    assert.equal(sayFailure('Neon Rain: no such site', 'en'), 'Neon Rain: no such site');
    // Every reason a player can give ends a failure this way.
    for (const reason of Object.values(REASONS))
      assert.notEqual(sayFailure(`A title: ${reason}`, 'ko'), `A title: ${reason}`, reason);
  });
});
