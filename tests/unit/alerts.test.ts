/**
 * Alerts: said in each chosen channel at most once an hour per kind, the bot check once as it starts and once as it
 * ends, and nothing posted where no channel was chosen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Alert, Alerts } from '../../src/app/alerts.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { FakeClock } from '../support/fakes.ts';
import { memoryStore } from '../support/store.ts';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

function setup() {
  const clock = new FakeClock();
  const store = memoryStore();
  const sink = new MemorySink();
  const posted: { guildId: string; channelId: string; alert: Alert }[] = [];
  const alerts = new Alerts({
    settings: store.settings,
    sink: () => ({
      post: async (guildId, channelId, alert) => {
        posted.push({ guildId, channelId, alert });
      },
    }),
    log: createLogger({ level: 'debug', sinks: [sink] }),
    clock,
  });
  // Two servers chose a channel; the third did not.
  store.settings.setAlertsChannel(A, '600000000000000001');
  store.settings.setAlertsChannel(B, '600000000000000002');
  return { clock, store, sink, posted, alerts };
}

describe('Alerts', () => {
  it("tells every server that chose a channel about jukecord's own trouble, once an hour, and the log each time", async () => {
    const { clock, sink, posted, alerts } = setup();
    const restarted: Alert = { kind: 'restarted', guildId: null, en: 'jukecord restarted itself', ko: 'k' };
    alerts.raise(restarted);
    assert.deepEqual(
      posted.map((entry) => `${entry.guildId} ${entry.channelId}`),
      [`${A} 600000000000000001`, `${B} 600000000000000002`],
    );
    alerts.raise(restarted);
    assert.equal(posted.length, 2);
    await clock.advance(3_600_000);
    alerts.raise(restarted);
    assert.equal(posted.length, 4);
    assert.equal(sink.records.filter((record) => record.msg === 'jukecord restarted itself').length, 3);
  });

  it('tells one server about its own trouble, a lost track apart from another, and nobody without a channel', () => {
    const { posted, alerts } = setup();
    const lost = (guildId: string, title: string): Alert => ({
      kind: 'loop',
      guildId,
      about: title,
      en: `${title}: taken out of the looping queue`,
      ko: 'k',
      logged: true,
    });
    alerts.raise(lost(A, 'Track 1'));
    alerts.raise(lost(A, 'Track 2'));
    alerts.raise(lost(A, 'Track 1'));
    alerts.raise(lost(C, 'Track 1'));
    assert.deepEqual(
      posted.map((entry) => `${entry.guildId} ${entry.alert.en}`),
      [`${A} Track 1: taken out of the looping queue`, `${A} Track 2: taken out of the looping queue`],
    );
  });

  it("says YouTube's check for bots once as it starts and once as it ends, whatever the number of failures", () => {
    const { posted, alerts } = setup();
    const check = "ERROR: [youtube] abc: Sign in to confirm you're not a bot";
    alerts.failed('https://www.youtube.com/watch?v=abc', check);
    alerts.failed('search', check);
    // A fetch elsewhere working says nothing about YouTube; a failure that is not the check says nothing either.
    alerts.worked('https://soundcloud.com/example/track');
    alerts.failed('https://www.youtube.com/watch?v=def', 'HTTP Error 503: Service Unavailable');
    alerts.worked('https://music.youtube.com/watch?v=ghi');
    alerts.worked('https://www.youtube.com/watch?v=jkl');
    assert.deepEqual(
      posted.filter((entry) => entry.guildId === A).map((entry) => entry.alert.kind),
      ['bot-check', 'bot-check-over'],
    );
  });
});
