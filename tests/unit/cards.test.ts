/**
 * The bot's cards where they say how people share the music: the vote to skip on the playing card, and the server's
 * settings on the DJ card, in both languages.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SettingsView } from '../../src/app/actions.ts';
import type { PlayerSnapshot } from '../../src/core/player.ts';
import { djCard, nowCard } from '../../src/discord/cards.ts';
import { COMMUNITY_DEFAULTS } from '../../src/store/store.ts';

// A track playing, as the player says it.
const playing: PlayerSnapshot = {
  guildId: '100000000000000001',
  status: 'playing',
  track: {
    id: 1,
    source: 'https://example.com/watch?v=a',
    url: 'https://example.com/watch?v=a',
    title: 'Neon Rain',
    uploader: 'Example',
    durationMs: 180_000,
    thumbnail: null,
    loudness: null,
  },
  addedBy: null,
  positionMs: 60_000,
  at: 0,
  durationMs: 180_000,
  error: null,
  repeat: 'off',
  progress: null,
  version: 3,
  notice: null,
  waiting: false,
  stopAfter: false,
  autoplay: 'off',
};

// The labels of a card's buttons.
function labels(card: ReturnType<typeof nowCard>): string[] {
  return card.components.flatMap((row) =>
    row.toJSON().components.map((button) => String('label' in button ? button.label : '')),
  );
}

describe('the playing card', () => {
  it('puts a vote under way on its Skip button and under the bar, and nothing when there is none', () => {
    const voting = nowCard(playing, 'en', null, { votes: 1, needed: 3 });
    assert.deepEqual(labels(voting), ['Pause', 'Skip (1 of 3)']);
    assert.equal(voting.embeds[0]?.toJSON().footer?.text, 'Votes to skip: 1 of 3');
    const korean = nowCard({ ...playing, repeat: 'queue' }, 'ko', null, { votes: 2, needed: 3 });
    assert.deepEqual(labels(korean), ['일시정지', '건너뛰기 (2/3)']);
    assert.equal(korean.embeds[0]?.toJSON().footer?.text, '대기열 반복 · 건너뛰기 투표: 3표 중 2표');
    const plain = nowCard(playing, 'en', null);
    assert.deepEqual(labels(plain), ['Pause', 'Skip']);
    // Skip carries the track the card shows, so a press after it has gone skips nothing more.
    const ids = plain.components.flatMap((row) =>
      row.toJSON().components.map((button) => ('custom_id' in button ? button.custom_id : '')),
    );
    assert.deepEqual(ids, ['jukecord:pause:en', 'jukecord:skip:en:1']);
    assert.equal(plain.embeds[0]?.toJSON().footer, undefined);
  });
});

describe('the DJ card', () => {
  it("shows the server's settings under the DJ role", () => {
    const settings: SettingsView = {
      djRoleId: null,
      roles: [],
      alertsChannelId: null,
      channels: [],
      ...COMMUNITY_DEFAULTS,
      personLimit: 3,
      stay: true,
      volume: 80,
      sound: 'night',
    };
    const text = djCard(settings, 'en').toJSON().description ?? '';
    assert.match(text, /^Everyone in the server may change the music\n\n/);
    assert.match(text, /Vote to skip: on\nTake turns: off\nTracks per person: 3\nStay in voice: on/);
    assert.match(text, /Voice volume: 80%\nSound: softer at night$/);
    const korean = djCard({ ...settings, personLimit: 0 }, 'ko').toJSON().description ?? '';
    assert.match(korean, /한 사람당 곡 수: 제한 없음/);
    assert.match(korean, /음색: 밤에 부드럽게$/);
  });
});
