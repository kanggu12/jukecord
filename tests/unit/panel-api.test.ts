/**
 * The panel's requests as they meet answers that are not jukecord's: a reverse proxy's own error page.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ApiError, request } from '../../panel/src/api.ts';
import { sayError } from '../../src/core/say.ts';

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

describe("the panel's requests", () => {
  it("say that jukecord did not answer when a proxy answers with its own page, not the parser's error", async () => {
    // nginx or an Ingress while jukecord restarts: an HTML 502.
    globalThis.fetch = (async () =>
      new Response('<html><head><title>502 Bad Gateway</title></head></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    await assert.rejects(
      request('GET', '/status'),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'no-answer' &&
        error.status === 502 &&
        error.message === 'jukecord did not answer (502)',
    );
    // In the panel's language, as every refusal is said.
    assert.equal(sayError('jukecord did not answer (502)', 'ko'), 'jukecord가 응답하지 않음(502)');
    assert.equal(sayError('jukecord did not answer (502)', 'en'), 'jukecord did not answer (502)');
  });

  it("still read jukecord's own refusals as they are", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: { code: 'conflict', message: 'nothing is playing' } }, { status: 409 })) as typeof fetch;
    await assert.rejects(
      request('POST', '/guilds/local/player/skip'),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'conflict' && error.message === 'nothing is playing',
    );
  });
});
