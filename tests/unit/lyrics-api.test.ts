/**
 * The lyrics through the API and the command line: the track playing only, said as unavailable while LRCLIB cannot
 * answer and when lyrics are off, credited to their source, and printed with their times when asked.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { COMMANDS } from '../../src/cli/commands.ts';
import { parseLine } from '../../src/cli/main.ts';
import { lyricsCard } from '../../src/discord/cards.ts';
import { type LyricsAnswer, LyricsUnavailable } from '../../src/media/lyrics.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { asHost, exampleTrack, GUILD, type TestServer, testServer } from '../support/web.ts';

describe('the lyrics operation', () => {
  let server: TestServer;
  let off: TestServer;
  // What the stand-in for LRCLIB gives next: an answer, or a failure.
  let next: LyricsAnswer | Error = new LyricsUnavailable('LRCLIB did not answer; try again in a moment');
  const asked: number[] = [];

  before(async () => {
    server = await testServer({
      found: { one: [exampleTrack('a')] },
      lyrics: {
        forTrack: async (track) => {
          asked.push(track.id);
          if (next instanceof Error) throw next;
          return { ...next, trackId: track.id };
        },
      },
    });
    off = await testServer({ found: { one: [exampleTrack('a')] } });
  });
  after(async () => {
    await server.close();
    await off.close();
  });

  const lyrics = (target: TestServer) =>
    target.web.app.inject({ method: 'GET', url: `${API_PREFIX}/guilds/${GUILD}/lyrics`, headers: asHost });

  it('says when lyrics are off here, and the status says so too', async () => {
    const answer = await lyrics(off);
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.json().error.message, 'lyrics are turned off here');
    const status = await off.web.app.inject({ method: 'GET', url: `${API_PREFIX}/status` });
    assert.equal(status.json().lyrics, false);
    assert.equal((await server.web.app.inject({ method: 'GET', url: `${API_PREFIX}/status` })).json().lyrics, true);
  });

  it('answers for the track playing only, and says when nothing is', async () => {
    assert.equal((await lyrics(server)).statusCode, 409);
    assert.deepEqual(asked, []);
    await server.web.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/guilds/${GUILD}/queue`,
      headers: asHost,
      payload: { input: 'one' },
    });
    // LRCLIB down: a moment later may work.
    const down = await lyrics(server);
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().error.code, 'unavailable');
    next = {
      trackId: 0,
      kind: 'synced',
      lines: [
        { atMs: 12_400, text: 'Fold the morning into paper' },
        { atMs: 16_850, text: '' },
      ],
      text: 'Fold the morning into paper',
    };
    const found = await lyrics(server);
    assert.equal(found.statusCode, 200);
    const body = found.json();
    assert.equal(body.trackId, server.players.get(GUILD).snapshot().track?.id);
    assert.deepEqual(body.lines[1], { atMs: 16_850, text: '' });
    assert.deepEqual(body.source, { name: 'LRCLIB', url: 'https://lrclib.net' });
    // Nothing found has nothing to credit.
    next = { trackId: 0, kind: 'none', lines: [], text: null };
    assert.equal((await lyrics(server)).json().source, null);
  });
});

describe('jukecord lyrics', () => {
  const answer = {
    kind: 'synced',
    lines: [
      { atMs: 12_400, text: 'Fold the morning into paper' },
      { atMs: 21_100, text: '' },
      { atMs: 62_300, text: 'Every letter never ends' },
    ],
    text: 'Fold the morning into paper\n\nEvery letter never ends',
    source: { name: 'LRCLIB', url: 'https://lrclib.net' },
  };

  it('prints the words, or with --synced each line after its time, and the source', () => {
    assert.equal(
      COMMANDS.lyrics.show(answer, parseLine(['lyrics'])),
      'Fold the morning into paper\n\nEvery letter never ends\n\nLyrics from LRCLIB (https://lrclib.net)',
    );
    assert.equal(
      COMMANDS.lyrics.show(answer, parseLine(['lyrics', '--synced'])),
      '[0:12] Fold the morning into paper\n[0:21]\n[1:02] Every letter never ends\n\nLyrics from LRCLIB (https://lrclib.net)',
    );
    assert.equal(COMMANDS.lyrics.show({ ...answer, kind: 'none' }, parseLine([])), 'No lyrics found for this track');
    assert.equal(COMMANDS.lyrics.show({ ...answer, kind: 'instrumental' }, parseLine([])), 'Instrumental (LRCLIB)');
  });
});

describe('the Discord lyrics card', () => {
  it('pages the words by whole lines, credits LRCLIB, and says when there are none', () => {
    const line = 'Fold the morning into paper, set it down where the water bends';
    const text = Array.from({ length: 80 }, (_, index) => `${index + 1}. ${line}`).join('\n');
    const lyrics = { trackId: 1, kind: 'plain' as const, lines: [], text };
    const first = lyricsCard(lyrics, 'Paper Boats', 1, 'en').data;
    assert.match(first.footer?.text ?? '', /^page 1\/4 · Lyrics from LRCLIB$/);
    assert.ok((first.description ?? '').length <= 1800);
    assert.ok(first.description?.startsWith('1. Fold'));
    // No line is split between two pages.
    const second = lyricsCard(lyrics, 'Paper Boats', 2, 'en').data.description ?? '';
    assert.match(second, /^\d+\. Fold the morning/);
    // A page past the last shows the last.
    assert.match(
      lyricsCard(lyrics, 'Paper Boats', 9, 'ko').data.footer?.text ?? '',
      /^페이지 4\/4 · 가사 출처: LRCLIB$/,
    );
    assert.equal(
      lyricsCard({ ...lyrics, kind: 'none', text: null }, 'Paper Boats', 1, 'ko').data.description,
      '이 곡의 가사를 찾지 못함',
    );
  });
});
