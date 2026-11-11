import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REASONS } from '../../src/core/reasons.ts';
import { sayError } from '../../src/discord/errors.ts';

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
    // The ones the bot never shows: browser-only and API-only refusals.
    const notInDiscord = new Set([
      'log in first',
      'only the host can use jukecord here',
      'there is no such server here',
      'there is no such token of yours',
      'days is 1 to 366',
      'the time zone offset is -720 to 840 minutes',
      'jukecord runs without a Discord bot here, so it cannot join voice',
      'jukecord runs without a Discord bot here, so there are no roles',
    ]);
    assert.ok(messages.size > 15, `only ${messages.size} messages were found; is the pattern still right?`);
    for (const message of messages) {
      if (notInDiscord.has(message)) continue;
      const korean = sayError(message, 'ko');
      assert.notEqual(korean, sayError(message, 'en'), `no Korean for "${message}"`);
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
});
