/**
 * Live updates over WebSocket: what the panel hears instead of asking again and again.
 *
 * A browser connects to /api/v1/events, says which server it shows ({"type":"subscribe","guild":...}), and gets that
 * server's whole state once, then every change as it happens: the player (every snapshot, at most four a second while
 * a track loads), the queue (all of it), the voice channel, and who is listening in a browser. Every message carries
 * `v`, the protocol version, so an old panel left open across an upgrade can tell it must reload.
 *
 * A crowd costs little more than one panel. The queue of a server goes out at most four times a second, each message
 * carrying the latest queue (a burst of changes becomes one message), and who is listening at most once a second.
 * Each message is made once for everyone showing that server: a panel that can decompress (it says so with `gzip=1`
 * when it connects) gets a big one as one gzip binary frame, the same bytes for every panel; the others get the JSON
 * as text. Nothing is compressed per connection.
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
import { compressStart, gzip, gzipJoined, type Start } from './gzip.ts';
import type { Presenter } from './present.ts';

/** The protocol version; raised when a message changes in a way an older panel would misread. */
export const EVENTS_VERSION = 1;

// A browser that has not answered two pings (60 s) is gone, even if its connection never said so.
const HEARTBEAT_MS = 30_000;
// A browser that reads so slowly that 8 MiB waits for it is cut off rather than allowed to use up memory. Nothing is
// compressed per connection, so this counts the bytes really waiting to go out: a thousand-track queue is about 40 KB
// as gzip and 350 KB as text, at most four times a second.
const MAX_BUFFERED = 8 * 1024 ** 2;
// The fewest milliseconds between two queue messages of one server; the second carries every change made meanwhile.
const QUEUE_EVERY_MS = 250;
// The same for who is listening: a crowd pressing "listen here" together is one message a second, not one each.
const LISTENERS_EVERY_MS = 1000;
// How many people a listeners message names (the panel shows a few faces and a count); the count covers everyone.
const LISTENERS_NAMED = 20;
// Messages bigger than this go as gzip to a panel that takes it; smaller ones are not worth the work on either side.
const GZIP_OVER = 2048;

/** Someone listening in a browser, as the panel shows them. */
export interface Listener {
  /** The Discord user ID; null for the host. */
  readonly id: string | null;
  readonly name: string;
  readonly avatar: string | null;
}

/** Who listens in a server: the first people (up to twenty), and how many browsers play along in all. */
export interface Listeners {
  readonly people: Listener[];
  readonly count: number;
}

// One open connection.
interface Client {
  readonly socket: WebSocket;
  readonly caller: Caller;
  readonly principal: Principal;
  readonly who: Listener;
  // Whether its browser can decompress gzip (it said so when it connected).
  readonly gzip: boolean;
  // The server it shows, once subscribed.
  guild: string | null;
  // Whether its browser is playing along.
  listening: boolean;
  // Set by every pong; cleared by every ping. Still clear at the next ping means the browser is gone.
  alive: boolean;
  // Counts subscribes: one that finishes after a newer one began is dropped, so the last server asked for wins.
  asking: number;
  // The newest queue version it has, so a combined queue message is not sent to a panel whose state already had it.
  queueVersion: number;
}

// A server's queue as the start of a message, `{"v":1,"guild":"…","queue":{…}`, made once per version of the queue:
// both the queue messages and every subscribe's state are this start and an ending. Its compressed form is made the
// first time a panel that takes gzip needs it.
interface QueueStart {
  readonly version: number;
  readonly bytes: Buffer;
  compressed: Start | null;
}

// Everything kept per server that some connection shows: those connections, the queue start, who listens, and the
// timers that hold back the queue and listener messages.
interface Room {
  readonly clients: Set<Client>;
  queue: QueueStart | null;
  queueTimer: NodeJS.Timeout | null;
  queueSentAt: number;
  listeners: Listeners | null;
  listenersTimer: NodeJS.Timeout | null;
  listenersSentAt: number;
}

// What one connection is sent: bytes, as a binary frame (gzip) or a text frame (JSON).
interface Frame {
  readonly data: Buffer;
  readonly binary: boolean;
}

export interface EventHubOptions {
  readonly bus: Bus;
  readonly actions: Actions;
  readonly access: Access;
  readonly presenter: Presenter;
  readonly users: UserRepository;
  readonly log: Logger;
  /** A server's queue version without reading the queue, so a cached queue can be told current or not. */
  readonly queueVersion: (guildId: string) => number;
  readonly now?: () => number;
  /** Whether a caller's login still exists (logged out, expired and revoked logins end their connections). */
  readonly stillValid?: (caller: Caller) => boolean;
  /** The fewest milliseconds between queue messages and between listener messages of a server (tests shorten them). */
  readonly queueEveryMs?: number;
  readonly listenersEveryMs?: number;
}

/** What a new connection asks for and what its browser can take. */
export interface AttachOptions {
  /** The server to subscribe to at once. */
  readonly guild?: string | undefined;
  /** Whether the browser can decompress gzip messages. */
  readonly gzip?: boolean;
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

// A message as JSON bytes, with the protocol version first.
function json(message: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ v: EVENTS_VERSION, ...message }));
}

// A message for several connections: as text for those that read text, and as gzip, made once the first time a
// connection that takes gzip needs it (a big message only). Both forms are made only if someone needs them.
function outgoing(size: number, text: () => Buffer, packed: () => Buffer): (client: Client) => Frame {
  let asText: Buffer | null = null;
  let asGzip: Buffer | null = null;
  return (client) => {
    if (client.gzip && size > GZIP_OVER) {
      asGzip ??= packed();
      return { data: asGzip, binary: true };
    }
    asText ??= text();
    return { data: asText, binary: false };
  };
}

export class EventHub {
  private readonly options: EventHubOptions;
  private readonly now: () => number;
  private readonly queueEveryMs: number;
  private readonly listenersEveryMs: number;
  private readonly clients = new Set<Client>();
  // The servers some connection shows, each with its connections and what is kept for them.
  private readonly rooms = new Map<string, Room>();
  private readonly heartbeat: NodeJS.Timeout;
  // The bus listeners, kept to remove them on close.
  private readonly off: (() => void)[] = [];

  constructor(options: EventHubOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.queueEveryMs = options.queueEveryMs ?? QUEUE_EVERY_MS;
    this.listenersEveryMs = options.listenersEveryMs ?? LISTENERS_EVERY_MS;
    const { bus, presenter, actions } = options;
    const onPlayer = (snapshot: Parameters<typeof presenter.player>[0]) => {
      const room = this.rooms.get(snapshot.guildId);
      // Built only if someone is there to get it; small, so sent at once (the browsers follow the clock with it).
      if (!room) return;
      const bytes = json({ type: 'player', guild: snapshot.guildId, player: presenter.player(snapshot) });
      this.broadcast(
        room,
        outgoing(
          bytes.length,
          () => bytes,
          () => gzip(bytes),
        ),
      );
    };
    const onQueue = ({ guildId }: { guildId: string }) => {
      const room = this.rooms.get(guildId);
      if (room) this.queueSoon(guildId, room);
    };
    const onVoice = ({ guildId }: { guildId: string }) => {
      const room = this.rooms.get(guildId);
      if (!room) return;
      // Each connection gets the channels its own person can see, worked out once per person.
      const lists = new Map<string, unknown>();
      for (const client of room.clients) {
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
  attach(socket: WebSocket, caller: Caller, options: AttachOptions = {}): void {
    const principal = caller.principal;
    const person = principal.kind === 'user' ? this.options.users.get(principal.userId) : null;
    const who: Listener =
      principal.kind === 'host'
        ? { id: null, name: 'Host', avatar: null }
        : { id: principal.userId, name: person?.name ?? principal.userId, avatar: person?.avatar ?? null };
    const client: Client = {
      socket,
      caller,
      principal,
      who,
      gzip: options.gzip === true,
      guild: null,
      listening: false,
      alive: true,
      asking: 0,
      queueVersion: -1,
    };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => void this.onMessage(client, String(data)));
    socket.on('close', () => this.drop(client));
    socket.on('error', (error) => this.options.log.debug('a panel connection failed', { error }));
    this.send(client, { type: 'hello', serverTime: this.now(), you: who });
    if (options.guild) void this.subscribe(client, options.guild);
  }

  /** The people listening in a browser to a server (the first twenty), and how many browsers that is. */
  listeners(guildId: string): Listeners {
    const room = this.rooms.get(guildId);
    return room ? this.listenersOf(room) : { people: [], count: 0 };
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
    for (const room of this.rooms.values()) this.stopTimers(room);
    this.rooms.clear();
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
      if (client.guild) this.listenersChanged(client.guild);
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
    // Asked again later, or closed while Discord answered: this answer is not needed.
    if (client.asking !== mine || !this.clients.has(client)) return;
    const before = client.guild;
    if (before !== guildId) {
      this.leaveRoom(client);
      client.guild = guildId;
      this.roomOf(guildId).clients.add(client);
    }
    const room = this.roomOf(guildId);
    const { actions, presenter } = this.options;
    // The queue, the big part, is the start made once per version; only the end is this connection's own.
    const start = this.queueStart(guildId, room);
    client.queueVersion = start.version;
    const ending = Buffer.from(
      `,"type":"state","player":${JSON.stringify(presenter.player(actions.nowPlaying(reader(guildId))))},` +
        `"voice":${JSON.stringify(actions.voiceChannels(viewer(client, guildId)))},` +
        `"listeners":${JSON.stringify(this.listenersOf(room))}}`,
    );
    this.write(
      client,
      outgoing(
        start.bytes.length + ending.length,
        () => Buffer.concat([start.bytes, ending]),
        () => gzipJoined(this.compressedStart(start), ending),
      )(client),
    );
    // A listener who switches servers stops counting in the old one and starts in the new one.
    if (client.listening && before !== guildId) {
      if (before) this.listenersChanged(before);
      this.listenersChanged(guildId);
    }
  }

  // The room of a server, made when the first connection shows it.
  private roomOf(guildId: string): Room {
    let room = this.rooms.get(guildId);
    if (!room) {
      room = {
        clients: new Set(),
        queue: null,
        queueTimer: null,
        queueSentAt: 0,
        listeners: null,
        listenersTimer: null,
        listenersSentAt: 0,
      };
      this.rooms.set(guildId, room);
    }
    return room;
  }

  // Takes a connection out of the room of the server it showed; the last one out closes the room and what it kept.
  private leaveRoom(client: Client): void {
    const guildId = client.guild;
    const room = guildId === null ? undefined : this.rooms.get(guildId);
    if (!room || guildId === null) return;
    room.clients.delete(client);
    if (room.clients.size > 0) return;
    this.stopTimers(room);
    this.rooms.delete(guildId);
  }

  private stopTimers(room: Room): void {
    if (room.queueTimer) clearTimeout(room.queueTimer);
    if (room.listenersTimer) clearTimeout(room.listenersTimer);
    room.queueTimer = null;
    room.listenersTimer = null;
  }

  // The start of every message with this server's queue, made again only when the queue has changed since.
  private queueStart(guildId: string, room: Room): QueueStart {
    const kept = room.queue;
    if (kept && kept.version === this.options.queueVersion(guildId)) return kept;
    const { actions, presenter } = this.options;
    const queue = presenter.queue(actions.queue(reader(guildId)));
    const bytes = Buffer.from(
      `{"v":${EVENTS_VERSION},"guild":${JSON.stringify(guildId)},"queue":${JSON.stringify(queue)}`,
    );
    const made: QueueStart = { version: queue.version, bytes, compressed: null };
    room.queue = made;
    return made;
  }

  private compressedStart(start: QueueStart): Start {
    start.compressed ??= compressStart(start.bytes);
    return start.compressed;
  }

  // Sends a server's queue soon: at once if none went lately, otherwise when QUEUE_EVERY_MS has passed since the last,
  // carrying every change made meanwhile. "At once" is the next turn of the event loop, so changes made together (a
  // track put back and the next one taken out) are one message.
  private queueSoon(guildId: string, room: Room): void {
    if (room.queueTimer) return;
    const wait = Math.max(0, room.queueSentAt + this.queueEveryMs - Date.now());
    room.queueTimer = setTimeout(() => {
      room.queueTimer = null;
      room.queueSentAt = Date.now();
      // The room may have closed meanwhile (its last connection left); then this is the old room, and nobody needs it.
      if (this.rooms.get(guildId) !== room) return;
      const start = this.queueStart(guildId, room);
      const ending = Buffer.from(',"type":"queue"}');
      const frame = outgoing(
        start.bytes.length + ending.length,
        () => Buffer.concat([start.bytes, ending]),
        () => gzipJoined(this.compressedStart(start), ending),
      );
      for (const client of room.clients) {
        // A state sent since (a subscribe) had this queue already.
        if (client.queueVersion >= start.version) continue;
        client.queueVersion = start.version;
        this.write(client, frame(client));
      }
    }, wait);
    room.queueTimer.unref();
  }

  // Who listens in a server: worked out when it changed, not for every message.
  private listenersOf(room: Room): Listeners {
    if (room.listeners) return room.listeners;
    const people = new Map<string, Listener>();
    let count = 0;
    for (const client of room.clients) {
      if (!client.listening) continue;
      count += 1;
      // The first twenty people are named; everyone counts.
      if (people.size < LISTENERS_NAMED) people.set(client.who.id ?? 'host', client.who);
    }
    room.listeners = { people: [...people.values()], count };
    return room.listeners;
  }

  // Someone started or stopped listening in a server: its panels hear about it, at most once a second.
  private listenersChanged(guildId: string): void {
    const room = this.rooms.get(guildId);
    if (!room) return;
    room.listeners = null;
    if (room.listenersTimer) return;
    const wait = Math.max(0, room.listenersSentAt + this.listenersEveryMs - Date.now());
    room.listenersTimer = setTimeout(() => {
      room.listenersTimer = null;
      room.listenersSentAt = Date.now();
      if (this.rooms.get(guildId) !== room) return;
      const bytes = json({ type: 'listeners', guild: guildId, listeners: this.listenersOf(room) });
      this.broadcast(
        room,
        outgoing(
          bytes.length,
          () => bytes,
          () => gzip(bytes),
        ),
      );
    }, wait);
    room.listenersTimer.unref();
  }

  // Sends one message, made once, to every connection showing a server.
  private broadcast(room: Room, frame: (client: Client) => Frame): void {
    for (const client of room.clients) this.write(client, frame(client));
  }

  // Sends a message of one connection's own.
  private send(client: Client, message: Record<string, unknown>): void {
    const bytes = json(message);
    this.write(
      client,
      outgoing(
        bytes.length,
        () => bytes,
        () => gzip(bytes),
      )(client),
    );
  }

  // Writes to one connection, cutting off one that has fallen too far behind.
  private write(client: Client, frame: Frame): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED) {
      this.options.log.info('closed a panel connection that could not keep up');
      client.socket.terminate();
      this.drop(client);
      return;
    }
    // The same bytes go to every connection (a Buffer is not copied per socket); nothing is compressed here.
    client.socket.send(frame.data, { binary: frame.binary, compress: false });
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
    const guildId = client.guild;
    this.leaveRoom(client);
    if (client.listening && guildId) this.listenersChanged(guildId);
  }
}
