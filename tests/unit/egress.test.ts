import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import { type EgressGuard, startEgressGuard } from '../../src/media/egress.ts';

// Names as the guard resolves them in these tests: "public" points at this machine, which the tests let through
// in place of the internet; "inside" is a private address; "mixed" has one of each.
const NAMES: Record<string, string[]> = {
  'public.test': ['127.0.0.1'],
  'inside.test': ['10.0.0.1'],
  'mixed.test': ['10.9.9.9', '127.0.0.1'],
};

describe('the egress guard', () => {
  let guard: EgressGuard;
  let site: http.Server;
  let echo: net.Server;
  let sitePort = 0;
  let echoPort = 0;
  let guardPort = 0;
  // The headers the site received last.
  let seen: http.IncomingHttpHeaders = {};

  before(async () => {
    site = http.createServer((request, response) => {
      seen = request.headers;
      response.end(`hello ${request.url}`);
    });
    echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as net.AddressInfo).port;
    echoPort = (echo.address() as net.AddressInfo).port;
    guard = await startEgressGuard({
      log: createLogger({ level: 'error', sinks: [] }),
      lookup: async (host) => {
        const found = NAMES[host];
        if (!found) throw new Error('ENOTFOUND');
        return found;
      },
      allowed: (address) => address === '127.0.0.1',
    });
    guardPort = Number(new URL(guard.url).port);
  });

  after(async () => {
    await guard.close();
    site.close();
    echo.close();
  });

  // A plain HTTP request through the guard, as yt-dlp sends one: the full address on the request line.
  const get = (address: string) =>
    new Promise<{ status: number; message: string; body: string }>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: guardPort, path: address, headers: { 'proxy-connection': 'keep-alive' } },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, message: response.statusMessage ?? '', body }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });

  // A CONNECT through the guard; resolves with the answer's status and, when it is 200, the open tunnel.
  const connect = (authority: string) =>
    new Promise<{ status: number; socket: net.Socket }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: guardPort, method: 'CONNECT', path: authority });
      request.on('connect', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }));
      request.on('error', reject);
      request.end();
    });

  it('passes a plain request to an allowed address, with the name in Host and its own headers removed', async () => {
    const answer = await get(`http://public.test:${sitePort}/watch?v=1`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body, 'hello /watch?v=1');
    assert.equal(seen.host, `public.test:${sitePort}`);
    assert.equal(seen['proxy-connection'], undefined);
  });

  it('refuses a private address, a name that points inside and an IPv6 spelling of this machine, all with the same words', async () => {
    for (const address of ['http://inside.test/', 'http://10.1.2.3/', 'http://[::ffff:7f00:1]/']) {
      const answer = await get(address);
      assert.equal(answer.status, 403, address);
      assert.equal(answer.message, 'jukecord does not fetch from private networks');
    }
  });

  it('says a name that does not resolve is no such site, which is not a refusal', async () => {
    const answer = await get(`http://nowhere.test:${sitePort}/`);
    assert.equal(answer.status, 502);
    assert.equal(answer.message, 'no such site');
  });

  it('connects a name with private and public answers to the public one only', async () => {
    const answer = await get(`http://mixed.test:${sitePort}/`);
    assert.equal(answer.status, 200);
  });

  it('opens a tunnel to an allowed address and carries bytes both ways', async () => {
    const { status, socket } = await connect(`public.test:${echoPort}`);
    assert.equal(status, 200);
    const back = new Promise<string>((resolve) => socket.once('data', (data) => resolve(String(data))));
    socket.write('ping');
    assert.equal(await back, 'ping');
    socket.destroy();
  });

  it('refuses a tunnel to a private address, also one spelled as IPv6', async () => {
    for (const authority of ['inside.test:443', '[::ffff:7f00:1]:443', '[::1]:443']) {
      const { status, socket } = await connect(authority);
      assert.equal(status, 403, authority);
      socket.destroy();
    }
  });

  it('tries the next address of a name when one does not take the connection', async () => {
    // A second guard where all of 127/8 counts as public: 127.0.0.2 refuses (nothing listens there), 127.0.0.1 answers.
    const second = await startEgressGuard({
      log: createLogger({ level: 'error', sinks: [] }),
      lookup: async () => ['127.0.0.2', '127.0.0.1'],
      allowed: (address) => address.startsWith('127.'),
      connectMs: 2000,
    });
    try {
      const reply = await new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: Number(new URL(second.url).port),
          method: 'CONNECT',
          path: `two.test:${echoPort}`,
        });
        request.on('connect', (response, tunnel) => {
          tunnel.destroy();
          resolve(response.statusCode ?? 0);
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(reply, 200);
    } finally {
      await second.close();
    }
  });

  it('answers 502 when the allowed address does not take the connection', async () => {
    // A port nothing listens on: taken and released again at once.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const closed = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { status, socket } = await connect(`public.test:${closed}`);
    assert.equal(status, 502);
    socket.destroy();
  });
});
