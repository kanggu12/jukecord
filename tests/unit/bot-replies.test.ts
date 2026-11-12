/**
 * What the bot answers, with made-up interactions (nothing reaches Discord): the words, where they show (in the channel
 * or to the person alone), and the now-playing card's keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Events } from 'discord.js';
import { fakeBot, handlers, interaction } from '../support/discord.ts';
import { flush } from '../support/fakes.ts';
import { addTracks } from '../support/store.ts';

describe('the bot answers', () => {
  it('draws an old card again from what plays now when its key would do nothing, instead of refusing', async () => {
    const { store, queue, players, media, bot } = fakeBot();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    queue.add('100000000000000001', [track.id], 'end', null);
    players.get('100000000000000001').play();
    media.finish(180_000);
    await flush();
    players.get('100000000000000001').pause();
    // A card made while it played still shows Pause; someone presses it now that the music is paused.
    const press = interaction('button', 'jukecord:pause:en');
    await handlers(bot).onButton(press.interaction);
    assert.equal(press.shown.length, 1);
    assert.equal(press.shown[0]?.kind, 'update');
    assert.match(press.shown[0]?.text ?? '', /^Paused \| /);
    assert.match(press.shown[0]?.text ?? '', /\[Resume jukecord:resume:en\]/);
    // Someone without the DJ role is still told why, privately, and the card is left as it is.
    store.settings.setDjRole('100000000000000001', '500000000000000001');
    const refused = interaction('button', 'jukecord:resume:en');
    await handlers(bot).onButton(refused.interaction);
    assert.equal(refused.shown[0]?.kind, 'reply');
    assert.equal(refused.shown[0]?.ephemeral, true);
    assert.match(refused.shown[0]?.text ?? '', /DJ role/);
    await bot.client.destroy();
  });
});

describe('the bot answers commands', () => {
  // A bot with two tracks to find, one of them playing.
  async function playing() {
    const made = fakeBot();
    const tracks = addTracks(made.store, 3);
    made.queue.add(
      '100000000000000001',
      tracks.map((track) => track.id),
      'end',
      null,
    );
    made.players.get('100000000000000001').play();
    made.media.finish(180_000);
    await flush();
    return made;
  }

  it('says a playlist saved over one of the same name replaced it', async () => {
    const { bot } = await playing();
    const first = interaction('command', 'playlist', { sub: 'save', name: 'Mix' });
    await handlers(bot).onCommand(first.interaction);
    assert.equal(first.shown[0]?.text, 'Saved "Mix" (3)');
    const again = interaction('command', 'playlist', { sub: 'save', name: 'Mix' });
    await handlers(bot).onCommand(again.interaction);
    assert.equal(again.shown[0]?.text, 'Replaced "Mix" (3)');
    const korean = interaction('command', 'playlist', { sub: 'save', name: 'Mix' }, { locale: 'ko' });
    await handlers(bot).onCommand(korean.interaction);
    assert.equal(korean.shown[0]?.text, '"Mix" 덮어씀(3곡)');
    await bot.client.destroy();
  });

  it('says a page past the end of the queue is not there, and shows the last one', async () => {
    const { bot } = await playing();
    const past = interaction('command', 'queue', { page: 9 });
    await handlers(bot).onCommand(past.interaction);
    assert.match(past.shown[0]?.text ?? '', /^Queue \(2\) \| There is no page 9: the queue has 1 page\n/);
    const korean = interaction('command', 'queue', { page: 9 }, { locale: 'ko' });
    await handlers(bot).onCommand(korean.interaction);
    assert.match(korean.shown[0]?.text ?? '', /\| 9페이지는 없음: 대기열은 1페이지까지 있음\n/);
    await bot.client.destroy();
  });

  it('answers look-ups to the person alone, the history and the statistics too, and a command gone from this version', async () => {
    const { bot } = await playing();
    for (const name of ['history', 'stats', 'queue', 'version', 'karaoke']) {
      const asked = interaction('command', name);
      await handlers(bot).onCommand(asked.interaction);
      assert.equal(asked.shown[0]?.ephemeral, true, name);
    }
    // What changes the music, and the now-playing card, stay in the channel for everyone.
    for (const name of ['np', 'shuffle']) {
      const asked = interaction('command', name);
      await handlers(bot).onCommand(asked.interaction);
      assert.equal(asked.shown[0]?.ephemeral, false, name);
    }
    await bot.client.destroy();
  });

  it("counts the statistics' days in the host's time zone for everyone but Korean", async () => {
    const { bot, actions } = await playing();
    const offsets: number[] = [];
    const stats = actions.stats.bind(actions);
    actions.stats = (context, days, offsetMinutes, now) => {
      offsets.push(offsetMinutes ?? 0);
      return stats(context, days, offsetMinutes, now);
    };
    const zone = process.env.TZ;
    try {
      // The host in India (UTC+5:30); an English reader there, and a Korean one (in Korea, almost always).
      process.env.TZ = 'Asia/Kolkata';
      await handlers(bot).onCommand(interaction('command', 'stats').interaction);
      await handlers(bot).onCommand(interaction('command', 'stats', {}, { locale: 'ko' }).interaction);
      assert.deepEqual(offsets, [330, 540]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
      await bot.client.destroy();
    }
  });
});

describe('the now-playing card in the channel', () => {
  it('is drawn again as the player changes, wherever the change came from', async () => {
    const made = fakeBot();
    const tracks = addTracks(made.store, 2);
    made.queue.add(
      '100000000000000001',
      tracks.map((track) => track.id),
      'end',
      null,
    );
    made.players.get('100000000000000001').play();
    made.media.finish(180_000);
    await flush();
    const asked = interaction('command', 'np');
    await handlers(made.bot).onCommand(asked.interaction);
    assert.match(asked.shown.at(-1)?.text ?? '', /^Playing now \| /);
    // Paused from the panel (or the API, the command line): the card in the channel says so, with Resume.
    made.players.get('100000000000000001').pause();
    await made.clock.advance(0);
    assert.match(asked.shown.at(-1)?.text ?? '', /^Paused \| /);
    assert.match(asked.shown.at(-1)?.text ?? '', /\[Resume jukecord:resume:en\]/);
    // Skipped there too: once more, five seconds after the last edit, with the next track.
    made.players.get('100000000000000001').resume();
    made.players.get('100000000000000001').skip();
    await made.clock.advance(5000);
    assert.match(asked.shown.at(-1)?.text ?? '', /^Getting it ready \| \[Track 2\]/);
    await made.bot.client.destroy();
  });

  it('catches up with a change made while its answer was on its way to Discord', async () => {
    const made = fakeBot();
    const tracks = addTracks(made.store, 2);
    made.queue.add(
      '100000000000000001',
      tracks.map((track) => track.id),
      'end',
      null,
    );
    made.players.get('100000000000000001').play();
    made.media.finish(180_000);
    await flush();
    // /skip answers "Getting it ready"; Discord takes its time to show the answer, and meanwhile the next track (in the
    // cache, the usual case with the prefetch) starts.
    const asked = interaction('command', 'skip');
    const answer = asked.interaction.editReply;
    let arrive = (): void => {};
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    let first = true;
    asked.interaction.editReply = async (payload: unknown) => {
      if (first) {
        first = false;
        await arrived;
      }
      return answer(payload);
    };
    const answering = handlers(made.bot).onCommand(asked.interaction);
    await flush();
    made.media.finish(180_000, true);
    await flush();
    arrive();
    await answering;
    assert.match(asked.shown.at(-1)?.text ?? '', /^Getting it ready \| \[Track 2\]/);
    // The card says what plays now, with Pause, rather than "Getting it ready" until the track ends.
    await made.clock.advance(0);
    assert.match(asked.shown.at(-1)?.text ?? '', /^Playing now \| \[Track 2\]/);
    assert.match(asked.shown.at(-1)?.text ?? '', /\[Pause jukecord:pause:en\]/);
    await made.bot.client.destroy();
  });
});

describe('the alerts channel in Discord', () => {
  it('shows it to the person alone, and lets only managers choose it', async () => {
    const { bot } = fakeBot();
    const shown = interaction('command', 'alerts', { sub: 'show' }, { manage: true });
    await handlers(bot).onCommand(shown.interaction);
    assert.equal(shown.shown[0]?.ephemeral, true);
    assert.equal(shown.shown[0]?.text, 'Alerts channel | jukecord tells this server about trouble nowhere');
    const refused = interaction('command', 'alerts', { sub: 'clear' }, { locale: 'ko' });
    await handlers(bot).onCommand(refused.interaction);
    assert.equal(refused.shown.at(-1)?.ephemeral, true);
    assert.equal(refused.shown.at(-1)?.text, '서버 관리 권한이 있어야 알림 채널을 정할 수 있음');
    await bot.client.destroy();
  });

  it("posts an alert in the server's language once Discord is there, trouble in a problem's colour", async () => {
    const { bot } = fakeBot();
    const sent: { embeds: { toJSON(): { description?: string; color?: number } }[] }[] = [];
    const channel = { isSendable: () => true, send: async (payload: (typeof sent)[number]) => sent.push(payload) };
    (bot.client.guilds.cache as unknown as Map<string, unknown>).set('100000000000000001', {
      id: '100000000000000001',
      preferredLocale: 'ko',
      channels: { cache: new Map([['600000000000000001', channel]]) },
    });
    // Just started: it waits for Discord before posting.
    const posting = bot.post('100000000000000001', '600000000000000001', {
      kind: 'disk',
      guildId: null,
      en: "The disk of jukecord's data has 812 MiB free",
      ko: 'jukecord 데이터 디스크에 남은 공간: 812 MiB',
    });
    await flush();
    assert.equal(sent.length, 0);
    bot.client.emit(Events.ClientReady as never, bot.client as never);
    await posting;
    const embed = sent[0]?.embeds[0]?.toJSON();
    assert.equal(embed?.description, 'jukecord 데이터 디스크에 남은 공간: 812 MiB');
    assert.equal(embed?.color, 0xd0473f);
    await bot.client.destroy();
  });

  it('waits for Discord with one listener, however many alerts wait (a full disk at the start, in every server)', async () => {
    const { bot } = fakeBot();
    const sent: unknown[] = [];
    const channel = { isSendable: () => true, send: async (payload: unknown) => sent.push(payload) };
    const servers = Array.from({ length: 12 }, (_, index) => `1000000000000000${String(index + 10)}`);
    for (const id of servers)
      (bot.client.guilds.cache as unknown as Map<string, unknown>).set(id, {
        id,
        preferredLocale: 'en-US',
        channels: { cache: new Map([['600000000000000001', channel]]) },
      });
    const alert = { kind: 'disk' as const, guildId: null, en: 'The disk is nearly full', ko: '디스크가 거의 꽉 참' };
    const posting = servers.map((id) => bot.post(id, '600000000000000001', alert));
    await flush();
    // Twelve servers' alerts, one wait for Discord: Node warns from eleven listeners on (MaxListenersExceededWarning).
    assert.equal(bot.client.listenerCount(Events.ClientReady), 1);
    bot.client.emit(Events.ClientReady as never, bot.client as never);
    await Promise.all(posting);
    assert.equal(sent.length, 12);
    await bot.client.destroy();
  });
});
