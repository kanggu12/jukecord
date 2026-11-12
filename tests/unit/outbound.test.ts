/**
 * jukecord's own requests outside go through the address guard: a public name is reached, a private one refused
 * before any byte is sent to it, HTTPS runs inside the guard's tunnel with the site's own certificate, and every
 * request has a time limit and a size limit.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import { type EgressGuard, startEgressGuard } from '../../src/media/egress.ts';
import { OutboundError, outbound } from '../../src/media/outbound.ts';

// Names as the guard resolves them here: "public.test" is this machine, let through in place of the internet;
// "inside.test" is on a private network.
const NAMES: Record<string, string[]> = { 'public.test': ['127.0.0.1'], 'inside.test': ['10.0.0.1'] };

// A made-up site's certificate, made with openssl when it is there (the HTTPS test is skipped without it).
function certificate(): { key: string; cert: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=public.test',
        '-addext',
        'subjectAltName=DNS:public.test,DNS:localhost',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// What both sites answer: a small JSON, a big one, or nothing at all.
function answer(request: http.IncomingMessage, response: http.ServerResponse): void {
  if (request.url === '/never') return;
  if (request.url === '/big') {
    response.end('x'.repeat(5000));
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ path: request.url, agent: request.headers['user-agent'] }));
}

describe('outbound requests', () => {
  let guard: EgressGuard;
  let site: http.Server;
  let secure: https.Server | null = null;
  const tls = certificate();
  let port = 0;
  let securePort = 0;

  before(async () => {
    site = http.createServer(answer);
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    port = (site.address() as net.AddressInfo).port;
    if (tls) {
      secure = https.createServer(tls, answer);
      await new Promise<void>((resolve) => secure?.listen(0, '127.0.0.1', resolve));
      securePort = (secure.address() as net.AddressInfo).port;
    }
    guard = await startEgressGuard({
      log: createLogger({ level: 'error', sinks: [] }),
      lookup: async (host) => {
        const found = NAMES[host];
        if (!found) throw new Error('ENOTFOUND');
        return found;
      },
      allowed: (address) => address === '127.0.0.1',
    });
  });

  after(async () => {
    await guard.close();
    site.closeAllConnections();
    site.close();
    secure?.closeAllConnections();
    secure?.close();
  });

  it('reaches a public name through the guard, with the headers asked for', async () => {
    const get = outbound({ proxy: guard.url });
    const answered = await get(new URL(`http://public.test:${port}/api/get?x=1`), { 'user-agent': 'jukecord/test' });
    assert.equal(answered.status, 200);
    assert.deepEqual(JSON.parse(answered.body), { path: '/api/get?x=1', agent: 'jukecord/test' });
  });

  it('is refused for a name on a private network, over HTTP and HTTPS alike', async () => {
    const get = outbound({ proxy: guard.url });
    // Plain HTTP gets the guard's own answer.
    assert.equal((await get(new URL(`http://inside.test:${port}/`), {})).status, 403);
    // HTTPS never gets a tunnel.
    await assert.rejects(get(new URL('https://inside.test/api/get'), {}), OutboundError);
    await assert.rejects(get(new URL('https://nowhere.test/'), {}), /did not connect/);
  });

  it("runs HTTPS inside the tunnel, checking the site's certificate against its name", { skip: !tls }, async () => {
    const trusted = outbound({ proxy: guard.url, ca: tls?.cert ?? '' });
    const answered = await trusted(new URL(`https://public.test:${securePort}/api/search`), {});
    assert.equal(JSON.parse(answered.body).path, '/api/search');
    // A certificate nobody vouches for is refused.
    await assert.rejects(outbound({ proxy: guard.url })(new URL(`https://public.test:${securePort}/`), {}));
    // Straight out, without a guard, the same.
    const straight = outbound({ proxy: null, ca: tls?.cert ?? '' });
    assert.equal((await straight(new URL(`https://localhost:${securePort}/x`), {})).status, 200);
  });

  it('gives up on a site that takes too long or answers too much', async () => {
    const get = outbound({ proxy: guard.url, timeoutMs: 300, maxBytes: 1000 });
    await assert.rejects(get(new URL(`http://public.test:${port}/never`), {}), /took longer than/);
    await assert.rejects(get(new URL(`http://public.test:${port}/big`), {}), /more than 1000 bytes/);
    await assert.rejects(get(new URL('ftp://public.test/'), {}), /only http and https/);
  });
});
