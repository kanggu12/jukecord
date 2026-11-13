/**
 * The panel's words as people read them (panel/src/i18n.ts): a wrapped line never splits a number from its unit or
 * Korean's "쓸 수 있음" (core/say.ts together()), and one thing has one name wherever it is shown. The 0.3.2 review
 * found "within 10 / minutes", "쓸 / 수 있음", one autoplay mode and one sound under two names each, and "유튜브" beside
 * "YouTube" on one Korean screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { words } from '../../panel/src/i18n.ts';
import { sayError, together, translate } from '../../src/core/say.ts';

// Where a no-break space stands, an expected text writes "⍽", so it can be seen.
const NBSP = String.fromCharCode(0xa0);
const kept = (text: string) => text.replaceAll('⍽', NBSP);

// Every line a table holds: its strings, and what its functions give for made-up values. A function is tried with
// counts, then with words (a name, a time: "Mina", "5 min"), then with days' [year, month, day] (dayRange takes two).
function lines(value: unknown, where = 'words'): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item, at) => lines(item, `${where}[${at}]`));
  if (typeof value === 'function') {
    const call = value as (...args: unknown[]) => unknown;
    const tries: unknown[][] = [
      [10, 2, 3],
      ['Mina', '5 min', 'Night Owls'],
      [[2025, 11, 14], [2026, 1, 13], true],
    ];
    for (const args of tries) {
      try {
        return lines(call(...args), where);
      } catch {
        // Not values of this kind: the next try.
      }
    }
    throw new Error(`no made-up values fit ${where}`);
  }
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => lines(item, `${where}.${key}`));
  return [];
}

describe('lines that wrap keep what reads as one', () => {
  it('keeps a number with its unit, a month with its day, and "ago" with its time', () => {
    assert.equal(together('works once within 10 minutes'), kept('works once within 10⍽minutes'));
    assert.equal(together('15 h ago'), kept('15⍽h⍽ago'));
    assert.equal(together('59 h 22 min'), kept('59⍽h 22⍽min'));
    assert.equal(together('Works until Nov 14, 00:38'), kept('Works until Nov⍽14, 00:38'));
    assert.equal(together('November 2026 in music'), kept('November⍽2026⍽in music'));
    // A word that only starts like a month is not one.
    assert.equal(together('Marcus 2'), 'Marcus 2');
  });

  it("keeps Korean's bound words with the word before them, and leaves words that start like them alone", () => {
    assert.equal(together('10분 안에 한 번만 쓸 수 있음'), kept('10분⍽안에 한 번만 쓸⍽수⍽있음'));
    assert.equal(together('Mina 님이 5분 전 만듦'), kept('Mina⍽님이 5분⍽전 만듦'));
    assert.equal(together('가사를 찾는 중'), kept('가사를 찾는⍽중'));
    assert.equal(together('11곡 · 총 33분'), kept('11곡 · 총⍽33분'));
    assert.equal(together('2025년 11월 14일까지'), kept('2025년⍽11월⍽14일까지'));
    // "중복" and a count of tracks ("곡 수") are words of their own.
    assert.equal(together('중복 제거'), '중복 제거');
    assert.equal(together('한 사람당 곡 수'), '한 사람당 곡 수');
  });

  it('changes nothing the second time', () => {
    const once = together('A login link, which works once within 10 minutes: 쓸 수 있음');
    assert.equal(together(once), once);
  });

  it('holds for every line of the panel in both languages', () => {
    for (const lang of ['en', 'ko'] as const) {
      const all = lines(words(lang));
      assert.ok(all.length > 400, `only ${all.length} lines in ${lang}`);
      for (const line of all) assert.equal(together(line), line, `${lang}: "${line}" can break where it reads as one`);
    }
  });

  it('holds for the refusals people read, in both languages', () => {
    assert.equal(
      sayError('only people listening can vote to skip', 'ko'),
      kept('듣고 있는 사람만 건너뛰기에 투표할⍽수⍽있음'),
    );
    assert.equal(sayError('the queue is full (500 tracks)', 'en'), kept('The queue is full (500⍽tracks)'));
    // The message as it is, for the API and the command line, keeps its plain spaces.
    assert.equal(translate('the queue is full (500 tracks)', 'en'), 'the queue is full (500 tracks)');
  });

  it('keeps the friend invite\'s "10 minutes" and "쓸 수 있음" whole, as the review saw them split', () => {
    assert.ok(words('en').inviteFriendHint.includes(kept('within 10⍽minutes')));
    assert.ok(words('ko').inviteFriendHint.includes(kept('쓸⍽수⍽있음')));
  });
});

describe('one name for one thing', () => {
  it('names the autoplay mode from past plays the same on its key and in its dialog, and never repeats the name in its hint', () => {
    for (const lang of ['en', 'ko'] as const) {
      const said = words(lang);
      const name = said.autoplayHistory.toLowerCase();
      assert.ok(said.autoplayKey.history?.toLowerCase().endsWith(name), `${lang}: ${said.autoplayKey.history}`);
      assert.ok(!said.autoplayHistoryHint.toLowerCase().includes(name), `${lang}: ${said.autoplayHistoryHint}`);
    }
    // Off is a state beside the other states, not a verb ("끄기"); the key says it as "반복 끔" does.
    assert.equal(words('ko').autoplayOff, '끔');
    assert.equal(words('ko').autoplayKey.off, '자동 재생 끔');
    // What the 30 are.
    assert.ok(words('en').autoplayHistoryHint.includes(kept('the last 30⍽played')));
  });

  it('names the night sound the same on the voice card and in the sound dialog', () => {
    for (const lang of ['en', 'ko'] as const)
      assert.equal(words(lang).presets.night, words(lang).presetsShort.night, lang);
  });
});
