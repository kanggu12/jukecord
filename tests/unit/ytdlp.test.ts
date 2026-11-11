import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tracksFromInfo } from '../../src/media/ytdlp.ts';

// Shapes copied from yt-dlp's -J output (values made up, addresses on example.com where the site does not matter).
const VIDEO = {
  id: 'dQw4w9WgXcQ',
  title: 'A song',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  uploader: 'A channel',
  duration: 212.4,
  thumbnail: 'https://i.example.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  live_status: 'not_live',
};

const FLAT_PLAYLIST = {
  _type: 'playlist',
  title: 'A list',
  entries: [
    {
      _type: 'url',
      ie_key: 'Youtube',
      id: 'aaaaaaaaaaa',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      title: 'First',
      duration: 61,
      channel: 'Someone',
      thumbnails: [{ url: 'https://i.example.com/small.jpg' }, { url: 'https://i.example.com/large.jpg' }],
    },
    { _type: 'url', ie_key: 'Youtube', id: 'bbbbbbbbbbb', title: '[Private video]', duration: null },
    { _type: 'url', ie_key: 'Youtube', id: 'ccccccccccc', title: 'Live now', live_status: 'is_live' },
    { _type: 'url', ie_key: 'Youtube', id: 'ddddddddddd', title: 'Only an ID' },
  ],
};

describe('tracksFromInfo', () => {
  it('reads a single video', () => {
    assert.deepEqual(tracksFromInfo(VIDEO, 100), [
      {
        source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'A song',
        uploader: 'A channel',
        durationMs: 212_400,
        thumbnail: 'https://i.example.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      },
    ]);
  });

  it('reads a flat playlist, leaving out private, deleted and live entries', () => {
    const tracks = tracksFromInfo(FLAT_PLAYLIST, 100);
    assert.deepEqual(
      tracks.map((track) => [track.title, track.url, track.durationMs, track.uploader, track.thumbnail]),
      [
        ['First', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 61_000, 'Someone', 'https://i.example.com/large.jpg'],
        ['Only an ID', 'https://www.youtube.com/watch?v=ddddddddddd', null, null, null],
      ],
    );
  });

  it('stops at the playlist limit', () => {
    assert.equal(tracksFromInfo(FLAT_PLAYLIST, 1).length, 1);
  });

  it('gives nothing for output that is not a video or a list', () => {
    assert.deepEqual(tracksFromInfo(null, 10), []);
    assert.deepEqual(tracksFromInfo({ title: 'no address' }, 10), []);
  });
});
