import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalSource, isPlaylistAddress, parseInput, youtubeVideoId } from '../../src/media/source.ts';

const ID = 'dQw4w9WgXcQ';

describe('parseInput', () => {
  it('reads addresses with or without the scheme, and everything else as a search', () => {
    assert.equal(parseInput(`https://youtu.be/${ID}`).kind, 'url');
    const bare = parseInput(`youtu.be/${ID}`);
    assert.equal(bare.kind === 'url' && bare.url.href, `https://youtu.be/${ID}`);
    assert.deepEqual(parseInput('  lofi hip hop  '), { kind: 'search', query: 'lofi hip hop' });
    // A word with a dot but no slash is a search ("Mr. Brightside"), not an address.
    assert.equal(parseInput('Mr. Brightside').kind, 'search');
    assert.throws(() => parseInput('   '), /nothing to add/);
  });
});

describe('youtubeVideoId and canonicalSource', () => {
  it('gives every spelling of one YouTube video the same source', () => {
    const spellings = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42&list=PL123&si=share`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&feature=share`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ];
    for (const spelling of spellings) {
      assert.equal(canonicalSource(new URL(spelling)), `https://www.youtube.com/watch?v=${ID}`, spelling);
    }
    assert.equal(youtubeVideoId(new URL('https://www.youtube.com/watch?v=short')), null);
  });

  it('cleans other addresses without changing what they point at', () => {
    assert.equal(
      canonicalSource(new URL('https://SoundCloud.com/artist/song?utm_source=x&in=artist/sets/a#t=1:00')),
      'https://soundcloud.com/artist/song?in=artist%2Fsets%2Fa',
    );
    assert.equal(canonicalSource(new URL('https://example.com/a?si=1')), 'https://example.com/a');
  });
});

describe('isPlaylistAddress', () => {
  it('adds whole lists only from playlist pages', () => {
    assert.equal(isPlaylistAddress(new URL('https://www.youtube.com/playlist?list=PL123')), true);
    assert.equal(isPlaylistAddress(new URL(`https://www.youtube.com/watch?v=${ID}&list=PL123`)), false);
    assert.equal(isPlaylistAddress(new URL('https://soundcloud.com/artist/sets/album')), true);
    assert.equal(isPlaylistAddress(new URL('https://soundcloud.com/artist/song')), false);
  });
});
