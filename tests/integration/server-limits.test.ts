/**
 * What the web server's own limits end, over real connections: a request that arrives too slowly is answered 408, an
 * answer that takes long to send (audio to a slow reader) and a WebSocket are left alone, and connections beyond the
 * cap are closed as they arrive. The limits are shortened here; jukecord's are 30 s, 15 s and 4096.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MediaCache } from '../../src/media/cache.ts';
import { exampleTrack, GUILD, HOST_TOKEN, type TestServer, testServer } from '../support/web.ts';

// Sends what `write` sends on a raw connection and resolves with the first line of the answer and when it came.
function raw(port: number, write: (socket: net.Socket) => void): Promise<{ ms: number; first: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const started = Date.now();
    let got = '';
    socket.on('data', (data) => {
      got += data.toString('latin1');
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ ms: Date.now() - started, first: got.split('\r\n')[0] ?? '' }));
    write(socket);
    // Nothing here waits longer than this; the answer (or the close) comes well before.
    setTimeout(() => socket.destroy(), 3000).unref();
  });
}

describe('the web server times requests, not answers', () => {
  let server: TestServer;
  let port = 0;

  before(async () => {
    server = await testServer({ listen: true, timeouts: { requestMs: 400, headersMs: 300, checkEveryMs: 50 } });
    port = Number(new URL(server.url).port);
  });
  after(() => server.close());

  it('answers 408 to headers or a body that arrive too slowly', async () => {
    const headers = await raw(port, (socket) => socket.write('GET /api/v1/status HTTP/1.1\r\nHost: x\r\n'));
    assert.equal(headers.first, 'HTTP/1.1 408 Request Timeout');
    assert.ok(headers.ms < 1500, `${headers.ms} ms`);
    const body = await raw(port, (socket) =>
      socket.write(
        `POST /api/v1/guilds/${GUILD}/queue HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${HOST_TOKEN}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 30\r\n\r\n{"input":',
      ),
    );
    assert.equal(body.first, 'HTTP/1.1 408 Request Timeout');
  });

  it('sends a long answer to a slow reader for as long as it takes', async () => {
    // A queued, cached track of 4 MiB, read in small steps with pauses: about four times the request limit.
    const track = server.store.tracks.upsert(exampleTrack('slow-reader'));
    server.queue.add(GUILD, [track.id], 'end', null);
    const key = MediaCache.keyOf(track.source);
    const tmp = server.cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(4 * 1024 ** 2, 9));
    server.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
    const started = Date.now();
    const received = await new Promise<number>((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/guilds/${GUILD}/tracks/${track.id}/audio`,
          headers: { authorization: `Bearer ${HOST_TOKEN}` },
        },
        (response) => {
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            response.pause();
            setTimeout(() => response.resume(), 30);
          });
          response.on('end', () => resolve(bytes));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    assert.equal(received, 4 * 1024 ** 2);
    assert.ok(Date.now() - started > 400, 'the reader was not slow enough to test anything');
  });

  it('keeps a WebSocket open past the request limit', async () => {
    const socket = new WebSocket(`${server.url.replace('http://', 'ws://')}/api/v1/events`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    } as unknown as string[]);
    const messages: Record<string, unknown>[] = [];
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'ping', t: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(messages.some((message) => message.type === 'pong'));
    socket.close();
  });
});

describe('the web server caps its connections', () => {
  it('closes a connection beyond the cap as it arrives, and takes one again once there is room', async () => {
    const server = await testServer({ listen: true, timeouts: { maxConnections: 2 } });
    const port = Number(new URL(server.url).port);
    const open: net.Socket[] = [];
    try {
      // Two idle connections fill it.
      for (let i = 0; i < 2; i += 1) {
        const socket = net.connect(port, '127.0.0.1');
        await new Promise((resolve) => socket.once('connect', resolve));
        open.push(socket);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const third = await raw(port, (socket) => socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n'));
      assert.equal(third.first, '', 'the connection over the cap was answered');
      // One of the two leaves: the next one is served.
      open.pop()?.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fourth = await raw(port, (socket) =>
        socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
      );
      assert.equal(fourth.first, 'HTTP/1.1 200 OK');
    } finally {
      for (const socket of open) socket.destroy();
      await server.close();
    }
  });
});
