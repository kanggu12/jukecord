/**
 * The host's settings in a split jukecord: the core keeps them, an edge carries the page's calls to it as commands,
 * a change is announced on the bus and every service takes it in from the database (each applying its own at once),
 * a refusal keeps its problems across the bus, what settings.json would hold comes from each service's environment
 * only, the Services section lists the core and each edge, and a restart is asked of every service.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eventually, testBuses } from '../support/bus.ts';
import { type Split, split, type TestCore, type TestEdge } from '../support/split.ts';
import { HOST_TOKEN } from '../support/web.ts';

const host = { authorization: `Bearer ${HOST_TOKEN}` };

// Waits until an answer that takes a request says yes (the bus's `eventually` takes a check that answers at once).
async function until(check: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Asks an edge over HTTP as the command line does (a token, JSON in and out).
async function ask(edge: TestEdge, method: string, path: string, body?: unknown) {
  const response = await fetch(`${edge.url}/api/v1${path}`, {
    method,
    headers: { ...host, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

for (const { name, make } of testBuses()) {
  describe(`the host's settings in a split jukecord on the ${name} bus`, () => {
    let pieces: Split;
    let core: TestCore;
    let one: TestEdge;
    let two: TestEdge;
    before(async () => {
      pieces = await split(await make(), { supervisor: 'docker' });
      core = await pieces.core();
      one = await pieces.edge(core);
      two = await pieces.edge(core);
      await eventually(() => one.edge.watch.seen && two.edge.watch.seen, 'the core heard by both edges');
    });
    after(() => pieces.close());

    it('answers the settings through an edge with the core’s, and lists the core and each edge', async () => {
      const view = await ask(one, 'GET', '/settings');
      assert.equal(view.status, 200);
      assert.equal(view.body.role, 'core');
      // Every service, each with its version and whether it is ready: the core's own, the edges' from their reports.
      await until(async () => {
        const services = (await ask(two, 'GET', '/settings')).body.services as { role: string; ready: boolean }[];
        return services.length === 3 && services.every((service) => service.ready === true);
      }, 'the core and both edges listed, ready');
      const services = (await ask(two, 'GET', '/settings')).body.services as { role: string; name: string }[];
      assert.deepEqual(services.map((service) => service.role).sort(), ['core', 'edge', 'edge']);
    });

    it('saves a change made through one edge at the core, and every service applies its own at once', async () => {
      const changed = await ask(one, 'PATCH', '/settings', {
        values: { JUKECORD_QUEUE_MAX: '20', JUKECORD_LIVE_MAX: '50' },
      });
      assert.equal(changed.status, 200);
      // The core's own (the queue's limit) at once; each edge's (its live connections' cap) once it took the change in.
      assert.equal(core.settings.config.queueMax, 20);
      await eventually(
        () => one.settings.config.liveMax === 50 && two.settings.config.liveMax === 50,
        'both edges took the change in',
      );
      // The other edge reads what the first saved.
      const read = await ask(two, 'GET', '/settings/JUKECORD_LIVE_MAX');
      assert.deepEqual([read.body.value, read.body.source], ['50', 'saved']);
    });

    it('keeps a refusal’s problems across the bus, and what settings.json would hold to the environment', async () => {
      const refused = await ask(two, 'PATCH', '/settings', { values: { JUKECORD_QUEUE_MAX: '5' } });
      assert.equal(refused.status, 400);
      assert.deepEqual((refused.body.error as { problems: { names: string[] }[] }).problems[0]?.names, [
        'JUKECORD_QUEUE_MAX',
      ]);
      // A bootstrap setting and a secret come from each service's environment in a split.
      const port = await ask(one, 'PATCH', '/settings', { values: { JUKECORD_PORT: '9000' } });
      assert.equal(port.status, 409);
      assert.match(
        (port.body.error as { message: string }).message,
        /comes from each service's environment in a split jukecord/,
      );
      const token = await ask(one, 'PATCH', '/settings', { values: { JUKECORD_METRICS_TOKEN: 'x'.repeat(20) } });
      assert.equal(token.status, 409);
      const view = (await ask(one, 'GET', '/settings')).body.settings as { name: string; locked: string | null }[];
      assert.equal(view.find((setting) => setting.name === 'JUKECORD_PORT')?.locked, 'split');
      // The authorities too: a bootstrap setting, shown as the environment has it, never saved from a page.
      const authorities = (await ask(one, 'GET', '/settings/authorities')).body;
      assert.deepEqual([authorities.locked, authorities.file], ['split', null]);
      const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
      assert.equal((await ask(two, 'PUT', '/settings/authorities', { pem })).status, 409);
    });

    it('asks every service to restart: the core, and each edge after it heard so', async () => {
      const asked = await ask(two, 'POST', '/restart');
      assert.equal(asked.status, 200);
      await eventually(() => core.restarts.length === 1, 'the core restarting');
      await eventually(() => one.restarts.length === 1 && two.restarts.length === 1, 'both edges told to restart');
    });
  });
}
