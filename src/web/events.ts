/**
 * Live updates over WebSocket: what the panel hears instead of asking again and again.
 *
 * A browser connects to /api/v1/events, says which server it shows ({"type":"subscribe","guild":...}), and gets that
 * server's whole state once, then every change as it happens: the player (every snapshot, at most four a second while
 * a track loads), the queue (all of it, after every change), the voice channel, and who is listening in a browser.
 * Every message carries `v`, the protocol version, so an old panel left open across an upgrade can tell it must reload.
 *
 * The browser plays along by itself, from the snapshots: the player is the clock (see core/player.ts). To turn the
 * server's times into its own, it measures the difference between the two clocks with ping/pong.
 */
import type { WebSocket } from 'ws';
import type { Access, Principal } from '../app/access.ts';
import { type ActionContext, ActionError, type Actions } from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import type { Logger } from '../log.ts';
import type { UserRepository } from '../store/store.ts';
import type { Caller } from './auth.ts';
import type { Presenter } from './present.ts';

/** The protocol version; raised when a message changes in a way an older panel would misread. */
export const EVENTS_VERSION = 1;

// A browser that has not answered two pings (60 s) is gone, even if its connection never said so.
const HEARTBEAT_MS = 30_000;
// A browser that reads so slowly that 1 MiB waits for it is cut off rather than allowed to use up memory.
const MAX_BUFFERED = 1024 ** 2;

/** Someone listening in a browser, as the panel shows them. */
export interface Listener {
  /** The Discord user ID; null for the host. */
  readonly id: string | null;
  readonly name: string;
  readonly avatar: string | null;
}

// One open connection.
interface Client {
  readonly socket: WebSocket;
  readonly caller: Caller;
  readonly principal: Principal;
  readonly who: Listener;
  // The server it shows, once subscribed.
  guild: string | null;
  // Whether its browser is playing along.
  listening: boolean;
  // Set by every pong; cleared by every ping. Still clear at the next ping means the browser is gone.
  alive: boolean;
  // Counts subscribes: one that finishes after a newer one began is dropped, so the last server asked for wins.
  asking: number;
}

export interface EventHubOptions {
  readonly bus: Bus;
  readonly actions: Actions;
  readonly access: Access;
  readonly presenter: Presenter;
  readonly users: UserRepository;
  readonly log: Logger;
  readonly now?: () => number;
  /** Whether a caller's login still exists (logged out, expired and revoked logins end their connections). */
  readonly stillValid?: (caller: Caller) => boolean;
}

// The context for reading a server's state on behalf of everyone subscribed to it (reading needs no rights).
function reader(guildId: string): ActionContext {
  return { guildId, userId: null, mayControl: false, mayManage: false };
}

// The context for what one connection may see: its own person (voice channels are listed as they see them in
// Discord), or the host, who sees them all.
function viewer(client: Client, guildId: string): ActionContext {
  const principal = client.principal;
  return {
    guildId,
    userId: principal.kind === 'user' ? principal.userId : null,
    mayControl: false,
    mayManage: principal.kind === 'host',
  };
}

export class EventHub {
  private readonly options: EventHubOptions;
  private readonly now: () => number;
  private readonly clients = new Set<Client>();
  private readonly heartbeat: NodeJS.Timeout;
  // The bus listeners, kept to remove them on close.
  private readonly off: (() => void)[] = [];

  constructor(options: EventHubOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const { bus, presenter, actions } = options;
    const onPlayer = (snapshot: Parameters<typeof presenter.player>[0]) => {
      this.toGuild(snapshot.guildId, () => ({
        type: 'player',
        guild: snapshot.guildId,
        player: presenter.player(snapshot),
      }));
    };
    const onQueue = ({ guildId }: { guildId: string }) => {
      this.toGuild(guildId, () => ({
        type: 'queue',
        guild: guildId,
        queue: presenter.queue(actions.queue(reader(guildId))),
      }));
    };
    const onVoice = ({ guildId }: { guildId: string }) => {
      // Each connection gets the channels its own person can see, worked out once per person.
      const lists = new Map<string, unknown>();
      for (const client of this.clients) {
        if (client.guild !== guildId) continue;
        const context = viewer(client, guildId);
        const key = context.userId ?? (context.mayManage ? 'host' : 'anyone');
        if (!lists.has(key)) lists.set(key, actions.voiceChannels(context));
        this.send(client, { type: 'voice', guild: guildId, voice: lists.get(key) });
      }
    };
    bus.on('player', onPlayer);
    bus.on('queue', onQueue);
    bus.on('voice', onVoice);
    this.off.push(
      () => bus.off('player', onPlayer),
      () => bus.off('queue', onQueue),
      () => bus.off('voice', onVoice),
    );
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Takes over a new connection from a logged-in caller; `guild` subscribes at once when given. */
  attach(socket: WebSocket, caller: Caller, guild?: string): void {
    const principal = caller.principal;
    const person = principal.kind === 'user' ? this.options.users.get(principal.userId) : null;
    const who: Listener =
      principal.kind === 'host'
        ? { id: null, name: 'Host', avatar: null }
        : { id: principal.userId, name: person?.name ?? principal.userId, avatar: person?.avatar ?? null };
    const client: Client = { socket, caller, principal, who, guild: null, listening: false, alive: true, asking: 0 };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => void this.onMessage(client, String(data)));
    socket.on('close', () => this.drop(client));
    socket.on('error', (error) => this.options.log.debug('a panel connection failed', { error }));
    this.send(client, { type: 'hello', serverTime: this.now(), you: who });
    if (guild) void this.subscribe(client, guild);
  }

  /** The people listening in a browser to a server, each once, and how many browsers that is. */
  listeners(guildId: string): { people: Listener[]; count: number } {
    const people = new Map<string, Listener>();
    let count = 0;
    for (const client of this.clients) {
      if (client.guild !== guildId || !client.listening) continue;
      count += 1;
      people.set(client.who.id ?? 'host', client.who);
    }
    return { people: [...people.values()], count };
  }

  /** Open connections and, of those, how many are playing along (for /metrics). */
  counts(): { connections: number; listening: number } {
    let listening = 0;
    for (const client of this.clients) if (client.listening) listening += 1;
    return { connections: this.clients.size, listening };
  }

  /** Ends the connections of the logins that match (a logout ends that browser's live updates at once). */
  end(match: (caller: Caller) => boolean): void {
    for (const client of this.clients) {
      if (!match(client.caller)) continue;
      client.socket.close(4401, 'logged out');
      this.drop(client);
    }
  }

  /** Closes every connection (shutting down): the panels reconnect to the next jukecord. */
  close(): void {
    clearInterval(this.heartbeat);
    for (const off of this.off) off();
    for (const client of this.clients) client.socket.close(1001, 'jukecord is restarting');
    this.clients.clear();
  }

  // One message from a browser. Anything unexpected is ignored: a panel from a newer version may say more.
  private async onMessage(client: Client, text: string): Promise<void> {
    let message: { type?: unknown; guild?: unknown; on?: unknown; t?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.type === 'subscribe' && typeof message.guild === 'string') {
      await this.subscribe(client, message.guild);
    } else if (message.type === 'listening' && typeof message.on === 'boolean') {
      if (client.listening === message.on) return;
      client.listening = message.on;
      if (client.guild) this.announceListeners(client.guild);
    } else if (message.type === 'ping' && typeof message.t === 'number') {
      // The browser's own time comes back with the server's: the browser works out the difference of the clocks.
      this.send(client, { type: 'pong', t: message.t, serverTime: this.now() });
    }
  }

  // Switches a connection to a server and sends that server's whole state.
  private async subscribe(client: Client, guildId: string): Promise<void> {
    // The access check may wait for Discord; a subscribe that began later (another server chosen meanwhile) wins.
    client.asking += 1;
    const mine = client.asking;
    try {
      await this.options.access.context(client.principal, guildId);
    } catch (error) {
      if (client.asking !== mine) return;
      const code = error instanceof ActionError ? error.code : 'unavailable';
      this.send(client, { type: 'error', code, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (client.asking !== mine) return;
    const before = client.guild;
    client.guild = guildId;
    const { actions, presenter } = this.options;
    this.send(client, {
      type: 'state',
      guild: guildId,
      player: presenter.player(actions.nowPlaying(reader(guildId))),
      queue: presenter.queue(actions.queue(reader(guildId))),
      voice: actions.voiceChannels(viewer(client, guildId)),
      listeners: this.listeners(guildId),
    });
    // A listener who switches servers stops counting in the old one and starts in the new one.
    if (client.listening && before !== guildId) {
      if (before) this.announceListeners(before);
      this.announceListeners(guildId);
    }
  }

  // Tells a server's panels who is listening.
  private announceListeners(guildId: string): void {
    this.toGuild(guildId, () => ({ type: 'listeners', guild: guildId, listeners: this.listeners(guildId) }));
  }

  // Sends a message to every connection showing a server. The message is built only if someone is there to get it.
  private toGuild(guildId: string, build: () => Record<string, unknown>): void {
    let text: string | null = null;
    for (const client of this.clients) {
      if (client.guild !== guildId) continue;
      text ??= JSON.stringify({ v: EVENTS_VERSION, ...build() });
      this.write(client, text);
    }
  }

  private send(client: Client, message: Record<string, unknown>): void {
    this.write(client, JSON.stringify({ v: EVENTS_VERSION, ...message }));
  }

  // Writes to one connection, cutting off one that has fallen too far behind.
  private write(client: Client, text: string): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED) {
      this.options.log.info('closed a panel connection that could not keep up');
      client.socket.terminate();
      this.drop(client);
      return;
    }
    client.socket.send(text);
  }

  // Pings every connection and closes the ones that did not answer the last ping. The login behind each connection is
  // checked again too: a logout, an expired session, a revoked token or a person who left the server ends it.
  private beat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.drop(client);
        continue;
      }
      // Read from the database; if that fails this once, the connection stays and the next beat asks again.
      let valid = true;
      try {
        valid = this.options.stillValid?.(client.caller) ?? true;
      } catch (error) {
        this.options.log.debug('could not check a login', { error });
      }
      if (!valid) {
        client.socket.close(4401, 'the login has ended');
        this.drop(client);
        continue;
      }
      if (client.guild) {
        const guild = client.guild;
        // Membership answers are kept for a minute (Access), so this costs Discord at most one question a minute.
        this.options.access.context(client.principal, guild).catch((error: unknown) => {
          // Discord not answering (unavailable) is no reason to end anything; only a clear "not any more" is.
          const gone = error instanceof ActionError && (error.code === 'forbidden' || error.code === 'not-found');
          if (!gone || client.guild !== guild) return;
          client.socket.close(4410, 'no longer allowed in that server');
          this.drop(client);
        });
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  // Forgets a connection; a listener leaving is announced to the others.
  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (client.listening && client.guild) this.announceListeners(client.guild);
  }
}
