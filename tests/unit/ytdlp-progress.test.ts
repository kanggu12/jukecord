import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProgress, ytdlpFailure } from '../../src/media/ytdlp.ts';

describe('parseProgress', () => {
  it('reads the progress line with a total or an estimate', () => {
    assert.equal(parseProgress('[jukecord-progress] 512 1024 NA'), 0.5);
    assert.equal(parseProgress('[jukecord-progress] 300 NA 1200'), 0.25);
    // Never past 1, whatever the estimate said.
    assert.equal(parseProgress('[jukecord-progress] 2000 NA 1000'), 1);
  });

  it('ignores other lines and lines without a size', () => {
    assert.equal(parseProgress('[youtube] dQw4w9WgXcQ: Downloading webpage'), null);
    assert.equal(parseProgress('[jukecord-progress] 100 NA NA'), null);
  });
});

describe('ytdlpFailure', () => {
  it("says what to do when YouTube asks for a sign-in, and gives yt-dlp's last lines otherwise", () => {
    assert.match(
      ytdlpFailure("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser", 1),
      /JUKECORD_YTDLP_COOKIES/,
    );
    assert.equal(ytdlpFailure('ERROR: Video unavailable\n', 1), 'yt-dlp failed: ERROR: Video unavailable');
    assert.equal(ytdlpFailure('', 2), 'yt-dlp failed: exit 2');
  });
});
