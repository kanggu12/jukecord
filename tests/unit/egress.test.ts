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

describe('the egress guard when a site stops halfway', () => {
  let guard: EgressGuard;
  let site: http.Server;
  let quiet: net.Server;
  let sitePort = 0;
  let quietPort = 0;
  let guardPort = 0;

  before(async () => {
    // A site that promises 1000 bytes and sends 10, then goes quiet ("/stall") or drops the connection ("/drop").
    site = http.createServer((request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('x'.repeat(10));
      if (request.url === '/drop') setTimeout(() => request.socket.destroy(), 50);
    });
    // A server that takes a tunnel's connection and then never says anything, or resets it at once ("reset" first).
    quiet = net.createServer((socket) => {
      socket.once('data', (data) => {
        if (data.toString().startsWith('reset')) socket.resetAndDestroy();
      });
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => quiet.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as net.AddressInfo).port;
    quietPort = (quiet.address() as net.AddressInfo).port;
    guard = await startEgressGuard({
      log: createLogger({ level: 'error', sinks: [] }),
      lookup: async () => ['127.0.0.1'],
      allowed: () => true,
      // A quiet connection is cut off after a fifth of a second here (two minutes in jukecord).
      idleMs: 200,
    });
    guardPort = Number(new URL(guard.url).port);
  });

  after(async () => {
    await guard.close();
    site.closeAllConnections();
    site.close();
    quiet.close();
  });

  // A plain request through the guard; how its answer ended, and after how long.
  const fetchThrough = (path: string) =>
    new Promise<{ ended: string; bytes: number; ms: number }>((resolve) => {
      const started = Date.now();
      const done = (ended: string, bytes: number) => resolve({ ended, bytes, ms: Date.now() - started });
      const request = http.request(
        { host: '127.0.0.1', port: guardPort, path: `http://site.test:${sitePort}${path}` },
        (response) => {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
          });
          response.on('end', () => done('end', bytes));
          response.on('aborted', () => done('aborted', bytes));
          response.on('error', () => done('error', bytes));
        },
      );
      request.on('error', () => done('request error', 0));
      request.end();
      setTimeout(() => done('still waiting', -1), 3000).unref();
    });

  it('closes the answer to yt-dlp when the site goes quiet or drops in the middle of a body', async () => {
    for (const path of ['/stall', '/drop']) {
      const result = await fetchThrough(path);
      // Cut short, never finished as if whole, and soon: yt-dlp is not left waiting for bytes that never come.
      assert.notEqual(result.ended, 'still waiting', path);
      assert.notEqual(result.ended, 'end', path);
      assert.equal(result.bytes, 10, path);
      assert.ok(result.ms < 2000, `${path}: ${result.ms} ms`);
    }
  });

  it('closes a tunnel when the far side goes quiet or resets', async () => {
    for (const first of ['hello', 'reset']) {
      const socket = net.connect(guardPort, '127.0.0.1');
      const started = Date.now();
      const closed = new Promise<number>((resolve) => socket.on('close', () => resolve(Date.now() - started)));
      socket.on('error', () => {});
      socket.write(`CONNECT public.test:${quietPort} HTTP/1.1\r\nHost: public.test:${quietPort}\r\n\r\n`);
      await new Promise((resolve) => socket.once('data', resolve));
      socket.write(first);
      const ms = await Promise.race([closed, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000))]);
      assert.ok(
        ms > 0 && ms < 2000,
        `${first}: the tunnel was ${ms < 0 ? 'still open after 3 s' : `closed after ${ms} ms`}`,
      );
      socket.destroy();
    }
  });
});
