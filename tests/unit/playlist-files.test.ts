/**
 * Playlists as files and back: the three kinds written, each read again, a pasted list, an M3U from a music player,
 * and what a file cannot make jukecord keep (another scheme, a picture over http, values too long).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileName, PlaylistFileError, readPlaylist, writePlaylist } from '../../src/app/playlist-files.ts';
import type { Track } from '../../src/core/types.ts';

const TRACKS: Track[] = [
  {
    id: 1,
    source: 'https://example.com/watch?v=a',
    url: 'https://example.com/watch?v=a',
    title: 'Paper Boats',
    uploader: 'Example Band',
    durationMs: 215_000,
    thumbnail: 'https://example.com/a.jpg',
    loudness: null,
  },
  {
    id: 2,
    source: 'https://example.com/watch?v=b',
    url: 'https://example.com/watch?v=b',
    title: 'Low Tide, live',
    uploader: null,
    durationMs: null,
    thumbnail: null,
    loudness: null,
  },
];

describe('playlist files', () => {
  it('write the addresses, an M3U and jukecord’s JSON', () => {
    assert.equal(
      writePlaylist('Mix', TRACKS, 'text'),
      'https://example.com/watch?v=a\nhttps://example.com/watch?v=b\n',
    );
    assert.equal(
      writePlaylist('Mix', TRACKS, 'm3u'),
      [
        '#EXTM3U',
        '#PLAYLIST:Mix',
        '#EXTINF:215,Example Band - Paper Boats',
        'https://example.com/watch?v=a',
        '#EXTINF:-1,Low Tide, live',
        'https://example.com/watch?v=b',
        '',
      ].join('\n'),
    );
    const json = JSON.parse(writePlaylist('Mix', TRACKS, 'json', new Date(Date.UTC(2026, 10, 13))));
    assert.deepEqual(json, {
      kind: 'jukecord playlist',
      version: 1,
      name: 'Mix',
      exported: '2026-11-13T00:00:00.000Z',
      tracks: [
        {
          url: 'https://example.com/watch?v=a',
          title: 'Paper Boats',
          uploader: 'Example Band',
          durationMs: 215_000,
          thumbnail: 'https://example.com/a.jpg',
        },
        {
          url: 'https://example.com/watch?v=b',
          title: 'Low Tide, live',
          uploader: null,
          durationMs: null,
          thumbnail: null,
        },
      ],
    });
  });

  it('read each kind back, with what it says about each track', () => {
    const json = readPlaylist(writePlaylist('Mix', TRACKS, 'json'));
    assert.equal(json.format, 'json');
    assert.equal(json.name, 'Mix');
    assert.deepEqual(json.entries[0], {
      url: 'https://example.com/watch?v=a',
      words: null,
      title: 'Paper Boats',
      uploader: 'Example Band',
      durationMs: 215_000,
      thumbnail: 'https://example.com/a.jpg',
    });
    const m3u = readPlaylist(writePlaylist('Mix', TRACKS, 'm3u'));
    assert.equal(m3u.format, 'm3u');
    assert.equal(m3u.name, 'Mix');
    assert.deepEqual(
      m3u.entries.map((entry) => [entry.url, entry.title, entry.durationMs]),
      [
        ['https://example.com/watch?v=a', 'Example Band - Paper Boats', 215_000],
        ['https://example.com/watch?v=b', 'Low Tide, live', null],
      ],
    );
    const text = readPlaylist(writePlaylist('Mix', TRACKS, 'text'));
    assert.equal(text.format, 'text');
    assert.deepEqual(
      text.entries.map((entry) => entry.url),
      ['https://example.com/watch?v=a', 'https://example.com/watch?v=b'],
    );
  });

  it('read a pasted list: addresses with or without their scheme, and words for the rest', () => {
    const pasted = readPlaylist(
      '\uFEFF# my list\r\nexample.com/watch?v=c\r\n\r\nExample Band - Velvet Hours\r\nhttps://example.com/x y\r\n',
    );
    assert.deepEqual(
      pasted.entries.map((entry) => [entry.url, entry.words]),
      [
        ['https://example.com/watch?v=c', null],
        [null, 'Example Band - Velvet Hours'],
        [null, 'https://example.com/x y'],
      ],
    );
  });

  it("read a music player's M3U: files named after their songs become words", () => {
    const m3u = readPlaylist(
      [
        '#EXTM3U',
        '#EXTINF:183 tvg-id="x",Demo Orchestra - Static Bloom',
        'C:\\Music\\Demo Orchestra\\01 Static Bloom.mp3',
        '/home/someone/Music/Sample_Sound_-_Lanterns.flac',
      ].join('\n'),
    );
    assert.deepEqual(
      m3u.entries.map((entry) => entry.words),
      ['Demo Orchestra - Static Bloom', 'Sample Sound - Lanterns'],
    );
  });

  it('keep only what a track may hold, and refuse a JSON that is not a playlist', () => {
    const file = readPlaylist(
      JSON.stringify({
        kind: 'jukecord playlist',
        version: 1,
        name: 'x'.repeat(300),
        tracks: [
          { url: 'javascript:alert(1)', title: 'Bad' },
          {
            url: 'https://example.com/ok',
            title: 'Line\nbreak',
            thumbnail: 'http://example.com/p.jpg',
            durationMs: -5,
          },
        ],
      }),
    );
    assert.equal(file.name?.length, 100);
    assert.equal(file.entries[0]?.url, null);
    assert.deepEqual(file.entries[1], {
      url: 'https://example.com/ok',
      words: null,
      title: 'Line break',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    assert.throws(() => readPlaylist('{ not json'), PlaylistFileError);
    assert.throws(() => readPlaylist('{"tracks": []}'), /not a jukecord playlist/);
  });

  it('name a file after its playlist, without the characters file systems refuse', () => {
    assert.equal(fileName('Friday: night/late?', 'm3u'), 'Friday_ night_late_.m3u');
    assert.equal(fileName('드라이브', 'json'), '드라이브.json');
    assert.equal(fileName('***', 'text'), '___.txt');
    assert.equal(fileName('  ', 'text'), 'playlist.txt');
  });
});
