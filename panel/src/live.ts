/**
 * The live connection: a WebSocket to /api/v1/events that delivers every change of the server shown, and the clock
 * exchange that lets this browser play the same second as the voice channel.
 *
 * It reconnects by itself (about 1 s, then doubling up to about 10 s, each wait spread at random) and subscribes again
 * after each reconnect, so a laptop waking up or jukecord restarting needs nothing from the person. A jukecord that has just started may not know its
 * Discord servers yet and answers "unavailable"; the subscription is then asked again the same way, and the
 * connection counts as open only once the server's state has arrived. The server's clock is the one that counts: the
 * difference to this browser's clock is measured with pings and the fastest round trip of the last few wins, because
 * a slow answer says more about the network than about the clocks.
 */

/** The protocol version this panel understands (src/web/events.ts). */
const PROTOCOL = 1;

// 'refused': jukecord turned this page's connection away for good (its address is not the panel's); no retry.
export type LiveStatus = 'connecting' | 'open' | 'closed' | 'refused';

export interface LiveHandlers {
  message(message: Record<string, unknown>): void;
  status(status: LiveStatus): void;
  /** The server speaks a newer protocol: the panel must reload to understand it. */
  outdated(): void;
  /** The server ended the connection for good: 4401 the login is gone, 4403 this page's address is refused, 4410 the
   * server shown may not be opened any more. */
  ended(code: number): void;
}

export class Live {
  private socket: WebSocket | null = null;
  private guild: string | null = null;
  private listeningOn = false;
  private retry = 1000;
  private retryTimer = 0;
  private pingTimer = 0;
  private closedByUs = false;
  // Whether the server shown has sent its state on this socket, and the wait before asking again when it was not ready.
  private subscribed = false;
  private resubscribe = 1000;
  private resubscribeTimer = 0;
  // Clock samples: offset (server minus this browser) and the round trip it was measured over.
  private samples: { offset: number; rtt: number }[] = [];
  /** Milliseconds to add to this browser's clock to get the server's. */
  offset = 0;
  private readonly handlers: LiveHandlers;

  constructor(handlers: LiveHandlers) {
    this.handlers = handlers;
  }

  /** The server's time now, in milliseconds since the epoch. */
  now(): number {
    return Date.now() + this.offset;
  }

  /** Connects (once) and shows a server. */
  show(guild: string): void {
    this.guild = guild;
    this.subscribed = false;
    this.resubscribe = 1000;
    window.clearTimeout(this.resubscribeTimer);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.handlers.status('connecting');
      this.send({ type: 'subscribe', guild });
    } else if (this.socket?.readyState !== WebSocket.CONNECTING) {
      // No socket, or one waiting to retry: connect now (connect() cancels the retry, so no second socket opens), and
      // a person choosing a server starts the waits between retries from the shortest again.
      this.retry = 1000;
      this.connect();
    }
    // A socket still connecting subscribes to the server chosen meanwhile as soon as it opens (onopen).
  }

  /** Tells the others whether this browser plays along. */
  listening(on: boolean): void {
    this.listeningOn = on;
    this.send({ type: 'listening', on });
  }

  /** Closes for good (logging out). */
  close(): void {
    this.closedByUs = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.resubscribeTimer);
    window.clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    window.clearTimeout(this.retryTimer);
    this.subscribed = false;
    this.handlers.status('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = this.guild ? `?guild=${encodeURIComponent(this.guild)}` : '';
    const socket = new WebSocket(`${scheme}://${location.host}/api/v1/events${query}`);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 1000;
      // The server in the address may not be the one shown any more: it changed while the socket was connecting.
      const asked = new URL(socket.url).searchParams.get('guild');
      if (this.guild && this.guild !== asked) this.send({ type: 'subscribe', guild: this.guild });
      // With no server to show there is no state to wait for.
      if (!this.guild) this.handlers.status('open');
      if (this.listeningOn) this.send({ type: 'listening', on: true });
      // Three quick pings for a first estimate, then one every half minute to follow drift.
      this.samples = [];
      for (const delay of [0, 400, 800]) window.setTimeout(() => this.ping(), delay);
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 30_000);
    };
    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.v === 'number' && message.v > PROTOCOL) {
        this.handlers.outdated();
        return;
      }
      if (message.type === 'pong') this.pong(message);
      else if (message.type === 'hello' && typeof message.serverTime === 'number' && this.samples.length === 0) {
        // A first rough difference until the pings come back.
        this.offset = message.serverTime - Date.now();
      } else if (message.type === 'state' && message.guild === this.guild) {
        // Only the state of the server shown counts: one for a server left behind can still be on its way.
        this.subscribed = true;
        this.resubscribe = 1000;
        this.handlers.status('open');
      } else if (message.type === 'error' && !this.subscribed && this.guild) {
        if (message.code === 'unavailable') {
          // Just started and not connected to Discord yet: asked again shortly, without a message each time.
          const guild = this.guild;
          window.clearTimeout(this.resubscribeTimer);
          this.resubscribeTimer = window.setTimeout(() => {
            if (this.guild === guild && !this.subscribed) this.send({ type: 'subscribe', guild });
          }, this.resubscribe);
          this.resubscribe = Math.min(10_000, this.resubscribe * 2);
          return;
        }
        // Refused for good (the server cannot be opened): the connection itself works, the panel says why.
        this.handlers.status('open');
      }
      this.handlers.message(message);
    };
    socket.onclose = (event) => {
      // A socket replaced by a newer one says nothing about the connection any more, and the timers are the new one's.
      if (this.socket !== socket) return;
      window.clearInterval(this.pingTimer);
      window.clearTimeout(this.resubscribeTimer);
      this.socket = null;
      if (this.closedByUs) return;
      this.handlers.status('closed');
      // 4401 (the login is gone), 4403 (this page's address is refused) and 4410 (the server shown is closed to this
      // login now): retrying would not help.
      if (event.code === 4401 || event.code === 4403 || event.code === 4410) {
        this.handlers.ended(event.code);
        return;
      }
      // Each panel waits a different share of the delay (half to one and a half times it): after a restart of jukecord
      // a crowd of panels comes back spread over the seconds, not all in the same instant.
      this.retryTimer = window.setTimeout(() => this.connect(), this.retry * (0.5 + Math.random()));
      this.retry = Math.min(10_000, this.retry * 2);
    };
  }

  private ping(): void {
    this.send({ type: 'ping', t: Date.now() });
  }

  private pong(message: Record<string, unknown>): void {
    if (typeof message.t !== 'number' || typeof message.serverTime !== 'number') return;
    const now = Date.now();
    const rtt = now - message.t;
    // The server read its clock about halfway through the round trip.
    this.samples.push({ offset: message.serverTime - (message.t + now) / 2, rtt });
    this.samples = this.samples.slice(-8);
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
