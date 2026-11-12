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
    server = await testServer({
      listen: true,
      timeouts: { requestMs: 400, headersMs: 300, checkEveryMs: 50, idleMs: 600 },
    });
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

  it('closes an answer whose reader has stopped reading, so stalled readers cannot hold every connection', async () => {
    // A cached track larger than what the connection's buffers hold.
    const size = 32 * 1024 ** 2;
    const track = server.store.tracks.upsert(exampleTrack('stalled-reader'));
    server.queue.add(GUILD, [track.id], 'end', null);
    const key = MediaCache.keyOf(track.source);
    const tmp = server.cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(size, 7));
    server.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
    // The reader takes the first bytes and then nothing for 2 s (the idle limit is 600 ms here), then reads on to the
    // end of what it is given. A paused reader cannot see the server close until it reads again.
    const received = await new Promise<number>((resolve) => {
      let bytes = 0;
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `GET /api/v1/guilds/${GUILD}/tracks/${track.id}/audio HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${HOST_TOKEN}\r\n\r\n`,
        );
      });
      socket.once('data', () => {
        socket.pause();
        setTimeout(() => socket.resume(), 2000);
      });
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(bytes));
      setTimeout(() => socket.destroy(), 8000).unref();
    });
    // Cut off: only what the buffers held when the server closed it, not the whole track.
    assert.ok(received < size, `${received} bytes came, the whole track is ${size}`);
  });

  it('closes a connection that sends request after request without reading the answers', async () => {
    // A thousand requests for the API's description in one go (pipelining, which no browser does), nothing read: each
    // answer would be built and held in memory for a reader that never comes.
    const answers = await new Promise<number>((resolve) => {
      let got = '';
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.pause();
        socket.write('GET /api/v1/openapi.json HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(1000));
        setTimeout(() => socket.resume(), 300);
      });
      socket.on('data', (chunk: Buffer) => {
        got += chunk.toString('latin1');
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(got.split('HTTP/1.1 200').length - 1));
      setTimeout(() => socket.destroy(), 8000).unref();
    });
    // Closed after the first few, long before a thousand answers.
    assert.ok(answers <= 16, `${answers} answers came`);
    // And an ordinary client on a connection of its own is answered as ever.
    assert.equal((await fetch(`${server.url}/api/v1/openapi.json`)).status, 200);
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

describe('the web server stops in time', () => {
  it('cuts an audio answer still under way instead of waiting for it', async () => {
    const server = await testServer({ listen: true });
    const port = Number(new URL(server.url).port);
    const track = server.store.tracks.upsert(exampleTrack('stopping'));
    server.queue.add(GUILD, [track.id], 'end', null);
    const key = MediaCache.keyOf(track.source);
    const tmp = server.cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(16 * 1024 ** 2, 9));
    server.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
    // A browser in the middle of a track's audio, reading it slowly (a paused <audio>).
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/guilds/${GUILD}/tracks/${track.id}/audio`,
        headers: { authorization: `Bearer ${HOST_TOKEN}` },
      },
      (response) => {
        response.once('data', () => response.pause());
        response.on('error', () => {});
      },
    );
    request.on('error', () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    // jukecord gives its whole stop ten seconds; the web server's part ends within a few.
    const started = Date.now();
    await server.close();
    const took = Date.now() - started;
    request.destroy();
    assert.ok(took < 5000, `the web server took ${took} ms to close`);
  });
});

describe('the web server caps its connections', () => {
  it('takes at most so many connections from one address, unless it is told they come through a proxy', async () => {
    for (const trustProxy of [false, true]) {
      const server = await testServer({ listen: true, trustProxy, timeouts: { maxConnectionsPerAddress: 2 } });
      const port = Number(new URL(server.url).port);
      const open: net.Socket[] = [];
      try {
        // Two idle connections from this address (127.0.0.1) are its share.
        for (let i = 0; i < 2; i += 1) {
          const socket = net.connect(port, '127.0.0.1');
          await new Promise((resolve) => socket.once('connect', resolve));
          open.push(socket);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const third = await raw(port, (socket) =>
          socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
        );
        // Behind a trusted proxy every connection comes from the proxy: the cap per address would be the proxy's.
        assert.equal(third.first, trustProxy ? 'HTTP/1.1 200 OK' : '', `trustProxy ${trustProxy}`);
        // One of the two leaves: there is room for one more from this address again.
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
    }
  });

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
