import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { permanentFailure } from '../../src/core/reasons.ts';

describe('permanentFailure', () => {
  it('tells a track that is gone for good from a moment of trouble', () => {
    // What the track is: trying again will not change it, so a looping queue lets it go.
    for (const message of [
      'ERROR: [youtube] abc: Video unavailable',
      'ERROR: [youtube] abc: Private video. Sign in if you have been granted access',
      'ERROR: Unsupported URL: https://example.com/page',
      'ERROR: unable to download video data: HTTP Error 404: Not Found',
      'HTTP Error 410: Gone',
      'that address is on a private network',
    ]) {
      assert.equal(permanentFailure(message), true, message);
    }
    // What the moment is: the network, the site's servers, a refusal for now, a time limit.
    for (const message of [
      'HTTP Error 503: Service Unavailable',
      'HTTP Error 403: Forbidden',
      'HTTP Error 429: Too Many Requests',
      'Temporary failure in name resolution',
      'Sign in to confirm you’re not a bot',
      'ffmpeg took longer than 60 s',
      'yt-dlp failed: Connection reset by peer',
    ]) {
      assert.equal(permanentFailure(message), false, message);
    }
  });
});
