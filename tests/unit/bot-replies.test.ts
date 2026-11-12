/**
 * What the bot answers, with made-up interactions (nothing reaches Discord): the words, where they show (in the channel
 * or to the person alone), and the now-playing card's keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
