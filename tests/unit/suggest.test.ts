/**
 * Discord's suggestions under /play's and /add's input: what a search finds within the time Discord waits, cut to
 * Discord's sizes, and nothing for an address, for a letter, or for a search too slow or refused.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewTrack } from '../../src/core/types.ts';
import { choiceOf, suggestions } from '../../src/discord/suggest.ts';

// A found track with an example.com address (tests never point at real pages).
function found(title: string, extra: Partial<NewTrack> = {}): NewTrack {
  return {
    source: `https://example.com/watch?v=${title.length}`,
    url: `https://example.com/watch?v=${title.length}`,
    title,
    uploader: 'Example Band',
    durationMs: 215_000,
    thumbnail: null,
    ...extra,
  };
}

describe('Discord suggestions', () => {
  it('name each track by its title, channel and length, with its address as the value', () => {
    assert.deepEqual(choiceOf(found('Paper Boats')), {
      name: 'Paper Boats · Example Band · 3:35',
      value: 'https://example.com/watch?v=11',
    });
    // Without a channel or a length, the title alone.
    assert.equal(choiceOf(found('Low Tide', { uploader: null, durationMs: null }))?.name, 'Low Tide');
  });

  it('cut a long title to fit Discord, keeping the channel and the length whole', () => {
    const choice = choiceOf(found('A very long title '.repeat(10)));
    assert.ok(choice);
    assert.ok(choice.name.length <= 100, `${choice.name.length} characters`);
    assert.ok(choice.name.endsWith('… · Example Band · 3:35'), choice.name);
    // An address Discord cannot carry as a value is no suggestion.
    assert.equal(choiceOf(found('x', { url: `https://example.com/${'a'.repeat(100)}` })), null);
  });

  it('search the words as typed, and suggest nothing for an address or a single letter', async () => {
    const asked: string[] = [];
    const search = async (words: string) => {
      asked.push(words);
      return [found('One'), found('Two words')];
    };
    assert.deepEqual(
      (await suggestions('  some words ', search)).map((choice) => choice.name),
      ['One · Example Band · 3:35', 'Two words · Example Band · 3:35'],
    );
    assert.deepEqual(await suggestions('https://example.com/watch?v=a', search), []);
    assert.deepEqual(await suggestions('example.com/watch?v=a', search), []);
    assert.deepEqual(await suggestions('a', search), []);
    assert.deepEqual(asked, ['some words']);
  });

  it('give up within the wait, and when the search is stopped or refused', async () => {
    // A search that only ends when it is stopped.
    let stopped = false;
    const slow = (_words: string, signal: AbortSignal) =>
      new Promise<NewTrack[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopped = true;
          reject(new Error('stopped'));
        });
      });
    const started = Date.now();
    assert.deepEqual(await suggestions('slow words', slow, undefined, 50), []);
    assert.ok(Date.now() - started < 1000);
    assert.equal(stopped, true);
    // The person typed on: the older question ends at once.
    const newer = new AbortController();
    const waiting = suggestions('older words', slow, newer.signal, 60_000);
    newer.abort();
    assert.deepEqual(await waiting, []);
    // Refused (no DJ role, every slot taken): nothing to suggest.
    assert.deepEqual(
      await suggestions('any words', async () => {
        throw new Error('only members with the DJ role can change the music here');
      }),
      [],
    );
  });
});
