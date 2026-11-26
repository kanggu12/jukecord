/**
 * A TCP proxy in front of a test's database server, for what happens to a connection on the way: every connection is
 * passed through as it is until the test cuts them all (a reset, as a crashed server or a cut cable leaves them) or
 * silences them (bytes no longer passed on either way, with nobody told: what a NAT or a firewall that dropped a
 * connection does). Connections made after either are passed through again, so the test can show that the next
 * statement works.
 */
import net from 'node:net';

/** One connection through the proxy: the side jukecord opened, and the proxy's own to the server. */
interface Pair {
  readonly client: net.Socket;
  readonly server: net.Socket;
}

export class TcpProxy {
  private readonly listener: net.Server;
  // The connections passing through now.
  private readonly pairs = new Set<Pair>();

  private constructor(host: string, port: number) {
    this.listener = net.createServer((client) => this.pass(client, host, port));
  }

  /** Starts a proxy on a free port of 127.0.0.1 to `host`:`port`. */
  static async start(host: string, port: number): Promise<TcpProxy> {
    const proxy = new TcpProxy(host, port);
    await new Promise<void>((resolve) => proxy.listener.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  /** The port jukecord connects to instead of the server's. */
  get port(): number {
    const address = this.listener.address();
    if (address === null || typeof address === 'string') throw new Error('the proxy is not listening');
    return address.port;
  }

  /** Resets every connection open now: jukecord's side gets ECONNRESET, the server's side a close. */
  cut(): void {
    for (const pair of [...this.pairs]) {
      pair.client.resetAndDestroy();
      pair.server.destroy();
    }
  }

  /** Stops passing bytes on, either way, on every connection open now, telling neither side. */
  silence(): void {
    for (const pair of this.pairs) {
      pair.client.unpipe(pair.server);
      pair.server.unpipe(pair.client);
      // Nothing read any more: what jukecord sends stays in the proxy's buffers, as in a NAT that forgot the connection.
      pair.client.pause();
      pair.server.pause();
    }
  }

  /** Closes the proxy and every connection through it. */
  async close(): Promise<void> {
    for (const pair of [...this.pairs]) {
      pair.client.destroy();
      pair.server.destroy();
    }
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
  }

  // A connection jukecord opened: one of the proxy's own to the server, and bytes passed both ways as they come.
  private pass(client: net.Socket, host: string, port: number): void {
    const server = net.connect(port, host);
    const pair = { client, server };
    this.pairs.add(pair);
    client.pipe(server);
    server.pipe(client);
    // Either side going away ends the other; the errors of a reset or a close are the test's own doing.
    const end = () => {
      this.pairs.delete(pair);
      client.destroy();
      server.destroy();
    };
    client.on('error', end);
    server.on('error', end);
    client.on('close', end);
    server.on('close', end);
  }
}
