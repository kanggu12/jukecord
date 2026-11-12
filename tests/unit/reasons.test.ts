import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { permanentFailure, plainReason, REASONS } from '../../src/core/reasons.ts';
import { ytdlpFailure } from '../../src/media/ytdlp.ts';

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

describe('the reason people see, from what yt-dlp says', () => {
  it('names each failure as it reaches the player, and says whether trying again will change it', () => {
    // yt-dlp's last line as the fetch passes it on (ytdlpFailure), the short reason, and whether it is for good.
    const cases: [string, string, boolean][] = [
      [
        'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
        REASONS.botCheck,
        false,
      ],
      [
        'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.',
        REASONS.unavailable,
        true,
      ],
      [
        "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video",
        REASONS.unavailable,
        true,
      ],
      [
        'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
        REASONS.unavailable,
        true,
      ],
      [
        'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video, and other exclusive perks.',
        REASONS.unavailable,
        true,
      ],
      ['ERROR: [youtube] abc: This video is only available to Music Premium members', REASONS.unavailable, true],
      ['ERROR: [youtube] abc: Premieres in 3 days', REASONS.notYet, false],
      ['ERROR: [youtube] abc: This live event will begin in 2 hours.', REASONS.notYet, false],
      ['ERROR: [generic] abc: This video is DRM protected', REASONS.nothingToPlay, true],
      [
        'ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats',
        REASONS.nothingToPlay,
        true,
      ],
      ['ERROR: Unsupported URL: https://example.com/page', REASONS.nothingToPlay, true],
      ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'the site answered 403', false],
      [
        'ERROR: [soundcloud] abc: Unable to download JSON metadata: HTTP Error 404: Not Found',
        'the site answered 404',
        true,
      ],
      [
        'ERROR: unable to download video data: HTTP Error 451: Unavailable For Legal Reasons',
        'the site answered 451',
        true,
      ],
      [
        'ERROR: Unable to download webpage: <urlopen error [Errno -2] Name or service not known>',
        REASONS.noSuchSite,
        false,
      ],
    ];
    for (const [stderr, reason, forGood] of cases) {
      const message = ytdlpFailure(stderr, 1);
      assert.equal(plainReason(message), reason, stderr);
      assert.equal(permanentFailure(message), forGood, stderr);
    }
    // jukecord's own: a direct file over what it fetches whole will not get smaller.
    const large = 'the file is larger than jukecord fetches whole (500MB)';
    assert.equal(plainReason(large), REASONS.tooLarge);
    assert.equal(permanentFailure(large), true);
  });
});
