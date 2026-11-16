import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REASONS } from '../../src/core/reasons.ts';
import { sayError, sayFailure, sayNotice, translate } from '../../src/core/say.ts';
import { sayError as sayInDiscord } from '../../src/discord/errors.ts';

// The words keep a no-break space where a wrapped line must not break (core/say.ts together(): a number with its unit,
// a month with its day, Korean's "할 수 있음"): an expected text writes it as "⍽", so it can be seen.
const kept = (text: string) => text.replaceAll('⍽', String.fromCharCode(0xa0));

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

  it('says what the player did by itself as a sentence, or after the title of the track it is about', () => {
    // Why it paused, beside the state that says "Paused": the word not said twice (the 0.3.3 review).
    assert.equal(sayNotice('paused with nobody listening', 'en'), 'Nobody was listening');
    assert.equal(sayNotice('paused with nobody listening', 'ko'), '듣는 사람이 없었음');
    // The notice's message as it is, for the API.
    assert.equal(translate('paused with nobody listening', 'ko'), '듣는 사람이 없었음');
    assert.equal(
      sayNotice('Neon Rain: taken out of the looping queue', 'en'),
      'Neon Rain: taken out of the looping queue',
    );
    assert.equal(sayNotice('Neon Rain: taken out of the looping queue', 'ko'), 'Neon Rain: 대기열 반복에서 뺌');
  });

  it('says a place in the track for a seek before its start, not a place in the queue', () => {
    assert.equal(sayError('the position must be 0 or more', 'ko'), kept('재생 위치는 0초⍽이상이어야 함'));
  });

  it('has Korean for pausing what is paused, playing on what gets ready, and the MP3 copy being made', () => {
    assert.equal(sayError('it is already paused', 'ko'), '이미 일시정지됨');
    assert.equal(sayError('the track is getting ready', 'ko'), kept('곡을 준비하는⍽중'));
    assert.equal(sayError('it is already paused', 'en'), 'It is already paused');
    assert.notEqual(
      sayError('jukecord is making the MP3 copy of this track; try again in a moment', 'ko'),
      'jukecord is making the MP3 copy of this track; try again in a moment',
    );
    // A track taken out of a loop, after its title.
    assert.equal(sayNotice('Neon Rain: taken out of the looping queue', 'ko'), 'Neon Rain: 대기열 반복에서 뺌');
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
    // A site's answer in words, not its number.
    assert.equal(sayError('the site answered 404', 'ko'), '사이트에 없음');
    assert.equal(sayError('position 9 is outside the queue (0-3)', 'ko'), '대기열 범위를 벗어난 위치(0~3)');
    assert.equal(
      sayError('Discord did not answer: timed out', 'ko'),
      kept('디스코드가 응답하지 않음: 잠시⍽뒤 다시 시도하세요'),
    );
    for (const reason of Object.values(REASONS))
      assert.notEqual(sayError(reason, 'ko'), sayError(reason, 'en'), reason);
    // A value goes where Korean needs no particle after it: "403으로" and "404로" cannot both follow one pattern.
    assert.equal(
      sayError('"half past" is not a time in the track (examples: 83, 1:23, 1m23s)', 'ko'),
      kept('시간으로 읽을⍽수⍽없음: "half past"(예: 83, 1:23, 1m23s)'),
    );
    // English is the message as a sentence; an unknown message stays English in Korean too.
    assert.equal(sayError('nothing is playing', 'en'), 'Nothing is playing');
    assert.equal(sayError('something new', 'ko'), 'Something new');
    // The refusals with a value that a panel can meet.
    assert.equal(sayError('this needs a control token', 'ko'), 'control 권한이 있는 토큰이 필요함');
    assert.equal(sayError('this needs an admin token', 'ko'), 'admin 권한이 있는 토큰이 필요함');
    assert.equal(
      sayError('a friend who may only look and listen cannot change the music', 'ko'),
      kept('보기만 하는 친구 로그인으로는 음악을 바꿀⍽수⍽없음'),
    );
    assert.equal(
      sayError("a friend cannot change the server's settings or tokens", 'ko'),
      kept('친구 로그인으로는 서버 설정이나 토큰을 바꿀⍽수⍽없음'),
    );
    assert.equal(sayError('no such address: GET /api/v1/nothing', 'ko'), '없는 주소: GET /api/v1/nothing');
    // jukecord's name keeps its small letter at the start of a sentence, as everywhere else.
    assert.equal(
      sayError('jukecord runs without a Discord bot here, so there are no roles', 'en'),
      kept('jukecord runs without a⍽Discord bot here, so there are no roles'),
    );
  });

  it('gives a reason as it is for the middle of a sentence, and the bot the same words as the panel', () => {
    // No capital: "Could not add: no such site".
    assert.equal(translate('no such site', 'en'), 'no such site');
    assert.equal(translate('no such site', 'ko'), kept('사이트를 찾을⍽수⍽없음'));
    assert.equal(translate('something new', 'ko'), 'something new');
    // The bot's door leads to the same table.
    assert.equal(sayInDiscord, sayError);
  });

  it('says a failed track in one sentence that names it and says why, in words', () => {
    // Not "Could not play: Neon Rain: the site answered 404" (two colons and a number, the 0.3.3 review).
    assert.equal(
      sayFailure('Neon Rain: the site answered 404', 'en'),
      'Could not play Neon Rain because the site does not have it',
    );
    // Korean says the cause first: no particle follows the title, whatever letters it ends in.
    assert.equal(sayFailure('Neon Rain: the site answered 404', 'ko'), '사이트에 없는 곡이라 Neon Rain 재생하지 못함');
    // A title with a colon of its own: only what follows the last one is the reason, and the sentence adds no colon.
    assert.equal(
      sayFailure('Part II: The Valley: no such site', 'en'),
      'Could not play Part II: The Valley because there is no such site',
    );
    assert.equal(
      sayFailure('Part II: The Valley: no such site', 'ko'),
      kept('사이트를 찾을⍽수⍽없어 Part II: The Valley 재생하지 못함'),
    );
    // Every reason a player can give, and a site's every kind of answer, reads so in both languages.
    const statuses = [400, 401, 403, 404, 410, 429, 451, 500, 502, 503].map((status) => `the site answered ${status}`);
    for (const reason of [...Object.values(REASONS), ...statuses]) {
      const english = sayFailure(`Neon Rain: ${reason}`, 'en');
      const korean = sayFailure(`Neon Rain: ${reason}`, 'ko');
      assert.ok(english.startsWith('Could not play Neon Rain because '), english);
      assert.ok(korean.endsWith(' Neon Rain 재생하지 못함'), korean);
      for (const sentence of [english, korean]) {
        assert.ok(!sentence.includes(':'), `a colon in "${sentence}"`);
        assert.ok(!/\d{3}/.test(sentence), `a status number in "${sentence}"`);
      }
    }
    // A reason with no words here yet is still said, after the track.
    assert.equal(sayFailure('Neon Rain: something new', 'en'), 'Could not play Neon Rain: something new');
    assert.equal(sayFailure('Neon Rain: something new', 'ko'), 'Neon Rain 재생하지 못함: something new');
  });

  it("says a site's answer in words wherever people read a reason, and leaves the API's message as it is", () => {
    for (const status of [403, 404, 410, 429, 451, 500, 503])
      for (const lang of ['en', 'ko'] as const)
        assert.ok(!/\d/.test(translate(`the site answered ${status}`, lang)), `${status} in ${lang}`);
    assert.equal(sayError('the site answered 404', 'en'), 'The site does not have it');
    assert.equal(translate('the site answered 503', 'en'), 'the site is having trouble');
    assert.equal(sayError('the site answered 403', 'ko'), '사이트가 거절함');
    // "This server" read as the Discord server beside its name: jukecord is the one YouTube refuses.
    assert.equal(sayError(REASONS.botCheck, 'en'), 'YouTube is refusing this jukecord for now');
  });
});
