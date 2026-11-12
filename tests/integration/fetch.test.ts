/**
 * jukecord's own requests over a real connection to a local server: names resolved by the fetch itself (a table
 * here), the connection made to the address checked, redirects checked again, private addresses refused before any
 * connection, and the limits of size and time.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AddressError } from '../../src/media/address.ts';
import { publicFetch } from '../../src/media/fetch.ts';

describe("jukecord's own requests", () => {
  let server: http.Server;
  let port = 0;
  // The Host header each request came with.
  const hosts: string[] = [];

  before(async () => {
    server = http.createServer((request, response) => {
      hosts.push(String(request.headers.host));
      const path = request.url ?? '/';
      if (path === '/page') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html><head><meta property="og:title" content="Made up"></head>');
        // The body never ends: a fetch that stops at </head> does not wait for it.
        return;
      }
      if (path === '/big') {
        response.writeHead(200);
        response.end('x'.repeat(64 * 1024));
        return;
      }
      if (path === '/moved') {
        response.writeHead(302, { location: `http://site.test:${port}/page` });
        response.end();
        return;
      }
      if (path === '/inside') {
        response.writeHead(301, { location: 'http://inside.test/secret' });
        response.end();
        return;
      }
      if (path === '/slow') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  // Names as a table; the local server's address counts as public here, 10.0.0.1 as private.
  const fetchHere = publicFetch({
    lookup: async (host) => (host === 'site.test' ? ['127.0.0.1'] : host === 'inside.test' ? ['10.0.0.1'] : []),
    allowed: (address) => address === '127.0.0.1',
  });

  it('connects to the address it checked, under the name it was asked for', async () => {
    const answer = await fetchHere(`http://site.test:${port}/json`);
    assert.equal(answer.status, 200);
    assert.equal(answer.text, '{"ok":true}');
    assert.equal(hosts.at(-1), `site.test:${port}`);
  });

  it('follows a redirect, and checks where it leads like the first address', async () => {
    const page = await fetchHere(`http://site.test:${port}/moved`, { until: '</head>' });
    assert.equal(page.url, `http://site.test:${port}/page`);
    assert.match(page.text, /og:title/);
    await assert.rejects(fetchHere(`http://site.test:${port}/inside`), AddressError);
  });

  it('refuses a private address before connecting, by default', async () => {
    const before = hosts.length;
    await assert.rejects(publicFetch()(`http://127.0.0.1:${port}/json`), AddressError);
    await assert.rejects(publicFetch()('http://[::1]:9/'), AddressError);
    assert.equal(hosts.length, before);
  });

  it('stops at its size and its time', async () => {
    await assert.rejects(fetchHere(`http://site.test:${port}/big`, { maxBytes: 1024 }), /larger than 1024 bytes/);
    const started = Date.now();
    await assert.rejects(fetchHere(`http://site.test:${port}/slow`, { timeoutMs: 100 }));
    assert.ok(Date.now() - started < 2000);
  });
});
