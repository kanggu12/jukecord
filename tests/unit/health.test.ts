/**
 * Readiness by parts: which parts decide it, a part that fails or hangs, the answer kept for a second, the media
 * programs looked for again only now and then, and `/readyz` with what it says for a healthy jukecord and a broken one.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { discordPart, Health, type HealthPart, type PartState, toolPart } from '../../src/app/health.ts';
import { ToolWatch } from '../../src/metrics/media.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { parseExposition } from '../support/exposition.ts';
import { type TestServer, testServer } from '../support/web.ts';

// A part whose state a test sets, counting how often it is asked.
function part(name: string, required: boolean, state: PartState | (() => Promise<PartState>) = 'ok') {
  const counted = { asked: 0, state };
  const made: HealthPart = {
    name,
    required,
    check: () => {
      counted.asked += 1;
      return typeof counted.state === 'function' ? counted.state() : counted.state;
    },
  };
  return { part: made, counted };
}

describe('Health', () => {
  it('is ready when every part it cannot serve without works, whatever the others say', async () => {
    const database = part('database', true);
    const discord = part('discord', false, 'connecting');
    const ffmpeg = part('ffmpeg', false, 'down');
    let now = 0;
    const health = new Health({
      parts: [database.part, discord.part, ffmpeg.part],
      discord: () => false,
      now: () => now,
    });
    assert.deepEqual(await health.read(), {
      ready: true,
      discord: false,
      parts: {
        database: { state: 'ok', required: true },
        discord: { state: 'connecting', required: false },
        ffmpeg: { state: 'down', required: false },
      },
    });
    // A second later, the database down: not ready.
    database.counted.state = 'down';
    now = 1000;
    assert.equal((await health.read()).ready, false);
  });

  it('counts a part that throws or does not answer in time as down', async () => {
    const throwing = part('bus', true, async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
    });
    const hanging = part('database', true, () => new Promise<PartState>(() => {}));
    const health = new Health({ parts: [throwing.part, hanging.part], discord: () => false, waitMs: 30 });
    const readiness = await health.read();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.parts.bus?.state, 'down');
    assert.equal(readiness.parts.database?.state, 'down');
    // Nothing of the error reaches the answer: no address, no text.
    assert.doesNotMatch(JSON.stringify(readiness), /ECONNREFUSED|10\.0\.0\.5/);
  });

  it('checks once a second at most, however many ask, and once for those asking at the same time', async () => {
    const database = part('database', true);
    let now = 0;
    const health = new Health({ parts: [database.part], discord: () => false, now: () => now });
    await Promise.all([health.read(), health.read(), health.read()]);
    assert.equal(database.counted.asked, 1);
    now = 999;
    await health.read();
    assert.equal(database.counted.asked, 1);
    now = 1000;
    await health.read();
    assert.equal(database.counted.asked, 2);
  });

  it('reports readiness and each part in the metrics, from the same answer', async () => {
    const registry = new MetricsRegistry();
    const database = part('database', true);
    const ffmpeg = part('ffmpeg', false, 'down');
    new Health({ parts: [database.part, ffmpeg.part], discord: () => false, metrics: registry });
    const text = await registry.scrape();
    parseExposition(text);
    assert.match(text, /^jukecord_ready 1$/m);
    assert.match(text, /^jukecord_part_up\{part="database"\} 1$/m);
    assert.match(text, /^jukecord_part_up\{part="ffmpeg"\} 0$/m);
    assert.equal(database.counted.asked, 1);
  });

  it("names Discord's state: connected, on its way, or down", () => {
    const states: [string | null, PartState][] = [
      ['ready', 'ok'],
      ['connecting', 'connecting'],
      ['resuming', 'connecting'],
      ['waiting-for-guilds', 'connecting'],
      ['disconnected', 'down'],
      [null, 'down'],
    ];
    for (const [state, expected] of states) {
      const made = discordPart(() => (state === null ? null : { state: state as 'ready' }));
      assert.equal(made.check(), expected, String(state));
    }
  });

  it('says what the runs say of a program, and runs it again only when it is not known or missing, once a minute', async () => {
    const tools = new ToolWatch();
    let probes = 0;
    // The probe: a version check whose run the watch hears, missing this time.
    const ffmpeg = toolPart('ffmpeg', tools, async () => {
      probes += 1;
      tools.start('ffmpeg', 'about')('missing');
    });
    assert.equal(ffmpeg.check(), 'unknown');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1);
    assert.equal(ffmpeg.check(), 'down');
    // Missing still: not run again within the minute.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1);
    // A run that started (someone played a track) says it is there.
    tools.start('ffmpeg', 'encode')('failed');
    assert.equal(ffmpeg.check(), 'ok');
  });
});

describe('/readyz', () => {
  const servers: TestServer[] = [];
  after(async () => {
    for (const server of servers) await server.close();
  });

  it('answers 200 with every part for a healthy jukecord, and not to be kept by anything between', async () => {
    const server = await testServer({ browserOnly: true });
    servers.push(server);
    const answer = await server.web.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.deepEqual(answer.json(), {
      ready: true,
      discord: false,
      parts: {
        database: { state: 'ok', required: true, kind: 'sqlite' },
        bus: { state: 'ok', required: true, kind: 'in-process' },
        cache: { state: 'ok', required: true, kind: 'memory' },
      },
    });
  });

  it('answers 503 naming the part that does not work, while /healthz stays alive', async () => {
    const core = part('core', true, 'down');
    const server = await testServer({ parts: [core.part] });
    servers.push(server);
    const answer = await server.web.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(answer.statusCode, 503);
    const body = answer.json() as { ready: boolean; parts: Record<string, { state: string }> };
    assert.equal(body.ready, false);
    assert.equal(body.parts.core?.state, 'down');
    assert.equal(body.parts.database?.state, 'ok');
    assert.equal((await server.web.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  });

  it('answers 503 when the database is closed', async () => {
    const server = await testServer({ browserOnly: true });
    servers.push(server);
    await server.store.close();
    const answer = await server.web.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(answer.statusCode, 503);
    assert.equal((answer.json() as { parts: Record<string, { state: string }> }).parts.database?.state, 'down');
  });
});
