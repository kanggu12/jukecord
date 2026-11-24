/**
 * Commands over the bus: an edge asks the core to do something and waits for the answer.
 *
 * A call goes out on the commands channel with an ID of its own, the channel its answer goes to, and the moment its
 * caller stops waiting; the core runs it and sends the value back, or the error with everything an answer is made of
 * (an ActionError's code, so an edge answers 404 or 409 or 503 as one process does). Nothing hangs: a call nobody can
 * hear (no core listening, the bus down) is refused at once, one the core does not answer in time is refused when its
 * time is up, and every call waiting is refused when the core is lost (a heartbeat missed, see beat.ts) or replaced.
 * The refusal is "unavailable" (503, try again in a moment). A caller that stops waiting (the browser went away)
 * cancels its call, and the core stops the work if it can (a search, an import).
 *
 * A call the core already began when its caller gave up may still be done: the answer is lost, the change is not.
 * That is the same as a browser whose connection drops while it waits for one process to answer.
 */
import { randomBytes } from 'node:crypto';
import { ActionError } from '../app/actions.ts';
import type { Logger } from '../log.ts';
import { type Counter, type Metrics, NO_METRICS } from '../metrics/registry.ts';
import { type BusReport, type CommandOutcome, NO_BUS_REPORT } from '../metrics/services.ts';
import { decode, decodeArgs, encode, encodeArgs, fromWire, toWire } from './codec.ts';
import { servedCommands } from './metrics.ts';
import type { BusNames, BusTransport } from './transport.ts';

/** How long a command may take unless its table says otherwise: what any change or read of one server takes. */
export const COMMAND_LIMIT_MS = 15_000;

// When a refused call may be asked again: the core comes back within seconds of a restart.
const RETRY_MS = 2000;

/** What people are told when the core cannot be reached: it is starting, restarting, or the bus is down. */
export const CORE_AWAY = 'jukecord is starting or restarting; try again in a moment';
/** What people are told when the core took longer than the command may. */
export const CORE_LATE = 'jukecord did not answer in time; try again in a moment';

/** A refusal because the core is out of reach, as an edge answers it (503 with Retry-After). */
export function coreUnavailable(message = CORE_AWAY): ActionError {
  return new ActionError('unavailable', message, { retryAfterMs: RETRY_MS });
}

/** A name for one service's run, unique enough to tell services and restarts apart ("edge-3f9a..."). */
export function serviceId(role: string): string {
  return `${role}-${randomBytes(6).toString('hex')}`;
}

export interface CommandClientOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** This caller's name, which its answers are sent to (see serviceId). */
  readonly caller: string;
  readonly log: Logger;
  /** Where each call is reported when it ends: how long it took, and how it ended (src/metrics/services.ts). */
  readonly report?: BusReport;
  /** How long each command may take, by name (default COMMAND_LIMIT_MS). */
  readonly limitMs?: (command: string) => number;
  /** The clock the deadlines are on (wall time: the core compares them with its own). */
  readonly now?: () => number;
}

// One call waiting for its answer.
interface Waiting {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly done: (outcome: CommandOutcome) => void;
  readonly cleanup: () => void;
}

/** The edge's side: calls that wait for the core's answers. */
export class CommandClient {
  private readonly options: CommandClientOptions;
  private readonly now: () => number;
  private readonly waiting = new Map<string, Waiting>();
  private readonly report: BusReport;
  private sequence = 0;
  private stop: (() => Promise<void>) | null = null;
  // Answers that could not be read, told at most once a minute.
  private unreadToldAt = Number.NEGATIVE_INFINITY;

  private constructor(options: CommandClientOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.report = options.report ?? NO_BUS_REPORT;
  }

  /** Starts listening for answers, then takes calls. */
  static async start(options: CommandClientOptions): Promise<CommandClient> {
    const client = new CommandClient(options);
    client.stop = await options.transport.subscribe(options.names.replies(options.caller), (text) =>
      client.answered(text),
    );
    return client;
  }

  /** How many calls wait for their answers now (for tests and the metrics). */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Asks the core to run a command with these arguments, and gives its answer. Refused with "unavailable" when the core
   * cannot hear it, does not answer in time, or is lost meanwhile; rejected with the signal's reason when the signal
   * aborts (the call is then cancelled at the core too).
   */
  call<T>(command: string, args: readonly unknown[], ask: { signal?: AbortSignal; limitMs?: number } = {}): Promise<T> {
    const { signal } = ask;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const limitMs = ask.limitMs ?? this.options.limitMs?.(command) ?? COMMAND_LIMIT_MS;
    this.sequence += 1;
    const id = `${this.sequence}`;
    const started = performance.now();
    return new Promise<T>((resolve, reject) => {
      const finish = (outcome: CommandOutcome) => {
        this.report.command(command, (performance.now() - started) / 1000, outcome);
      };
      const onAbort = () => {
        const waiting = this.settle(id);
        if (!waiting) return;
        waiting.done('cancelled');
        void this.cancel(id);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        const waiting = this.settle(id);
        if (!waiting) return;
        waiting.done('timeout');
        // The core may still be working on it: told to stop, as a caller going away tells it.
        void this.cancel(id);
        this.options.log.warn('the core did not answer a command in time', { command, limitMs });
        reject(coreUnavailable(CORE_LATE));
      }, limitMs);
      // A stopping process does not wait for a call's time limit.
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        done: finish,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      const message = encode({
        type: 'call',
        id,
        from: this.options.caller,
        command,
        args: encodeArgs(args),
        // Wall time, which the core compares with its own: a call that reaches it after this is not run.
        deadline: this.now() + limitMs,
      });
      this.options.transport.publish(this.options.names.commands, message).then(
        (heard) => {
          // Nobody listens on the commands channel: no core runs now (it is starting, restarting, or not started).
          if (heard > 0) return;
          const waiting = this.settle(id);
          if (!waiting) return;
          waiting.done('unavailable');
          reject(coreUnavailable());
        },
        () => {
          // The bus is down: nothing can reach the core.
          const waiting = this.settle(id);
          if (!waiting) return;
          waiting.done('unavailable');
          reject(coreUnavailable());
        },
      );
    });
  }

  /** Refuses every call waiting: the core was lost or replaced, and the answers of the one that ran will not come. */
  failAll(message = CORE_AWAY): void {
    for (const id of [...this.waiting.keys()]) {
      const waiting = this.settle(id);
      if (!waiting) continue;
      waiting.done('unavailable');
      waiting.reject(coreUnavailable(message));
    }
  }

  /** Stops listening; the calls still waiting are refused. */
  async close(): Promise<void> {
    this.failAll();
    await this.stop?.();
    this.stop = null;
  }

  // An answer from the core: the call it is for gets its value or its error.
  private answered(text: string): void {
    const read = decode(text);
    if (!read.ok) {
      if (Date.now() - this.unreadToldAt >= 60_000) {
        this.unreadToldAt = Date.now();
        this.options.log.warn('an answer on the bus could not be read', { why: read.why });
      }
      return;
    }
    const { message } = read;
    if (message.type !== 'reply' || typeof message.id !== 'string') return;
    // An answer for a call nobody waits for any more (its time was up, its caller went away).
    const waiting = this.settle(message.id);
    if (!waiting) return;
    if (message.ok === true) {
      waiting.done('ok');
      waiting.resolve(message.value);
      return;
    }
    // A refusal (the action's own) or a failure of the core's: an error answer either way.
    waiting.done('error');
    waiting.reject(fromWire(message.error, waiting.command));
  }

  // Takes a call out of the waiting ones (once: whichever of the answer, the time limit or the abort comes first).
  private settle(id: string): Waiting | null {
    const waiting = this.waiting.get(id);
    if (!waiting) return null;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.cleanup();
    return waiting;
  }

  // Tells the core nobody waits for a call any more; nothing to do when the bus is down.
  private async cancel(id: string): Promise<void> {
    try {
      await this.options.transport.publish(
        this.options.names.commands,
        encode({ type: 'cancel', id, from: this.options.caller }),
      );
    } catch {
      // The bus is down: the core cannot be told, and its answer will find nobody waiting.
    }
  }
}

/** What runs one command at the core: its arguments, and a signal that aborts when its caller stops waiting. */
export type CommandHandler = (args: unknown[], signal: AbortSignal) => unknown;

export interface CommandServerOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** Every command the core answers, by name. */
  readonly handlers: ReadonlyMap<string, CommandHandler>;
  readonly log: Logger;
  readonly metrics?: Metrics;
  readonly now?: () => number;
}

/** The core's side: runs the commands edges send, each at once and side by side, and sends each answer back. */
export class CommandServer {
  private readonly options: CommandServerOptions;
  private readonly now: () => number;
  // The commands running, by caller and ID, so a cancel can stop one.
  private readonly running = new Map<string, AbortController>();
  private readonly served: Counter;
  private stop: (() => Promise<void>) | null = null;
  private unreadToldAt = Number.NEGATIVE_INFINITY;

  private constructor(options: CommandServerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.served = servedCommands(options.metrics ?? NO_METRICS);
  }

  /** Starts taking commands. */
  static async start(options: CommandServerOptions): Promise<CommandServer> {
    const server = new CommandServer(options);
    server.stop = await options.transport.subscribe(options.names.commands, (text) => server.heard(text));
    return server;
  }

  /** How many commands run now. */
  get busy(): number {
    return this.running.size;
  }

  /** Stops taking commands; those running are told their callers stopped waiting. */
  async close(): Promise<void> {
    await this.stop?.();
    this.stop = null;
    for (const controller of this.running.values()) controller.abort(new Error('the core is stopping'));
    this.running.clear();
  }

  private heard(text: string): void {
    const read = decode(text);
    if (!read.ok) {
      if (Date.now() - this.unreadToldAt >= 60_000) {
        this.unreadToldAt = Date.now();
        this.options.log.warn('a command on the bus could not be read', { why: read.why });
      }
      return;
    }
    const { message } = read;
    if (typeof message.id !== 'string' || typeof message.from !== 'string') return;
    const key = `${message.from} ${message.id}`;
    if (message.type === 'cancel') {
      this.running.get(key)?.abort(new Error('the caller stopped waiting'));
      return;
    }
    if (message.type !== 'call' || typeof message.command !== 'string') return;
    // Its caller stopped waiting already (the message waited somewhere): nobody would hear the answer, so the change
    // is not made either.
    if (typeof message.deadline === 'number' && message.deadline < this.now()) {
      this.served.inc({ command: this.label(message.command), outcome: 'late' });
      this.options.log.debug('a command came after its caller stopped waiting', { command: message.command });
      return;
    }
    void this.run(key, message.from, message.id, message.command, decodeArgs(message.args));
  }

  // A command's name as a metric's label: one of the commands the core knows, or "unknown" (a name from a message is
  // not to make a series of its own).
  private label(command: string): string {
    return this.options.handlers.has(command) ? command : 'unknown';
  }

  // Runs one command and sends its answer back to its caller.
  private async run(key: string, from: string, id: string, command: string, args: unknown[]): Promise<void> {
    const handler = this.options.handlers.get(command);
    const controller = new AbortController();
    this.running.set(key, controller);
    let reply: Record<string, unknown>;
    try {
      if (!handler) throw new Error(`no such command: ${command}`);
      const value = await handler(args, controller.signal);
      reply = { type: 'reply', id, ok: true, value };
      this.served.inc({ command: this.label(command), outcome: 'ok' });
    } catch (error) {
      const wire = toWire(error);
      // A refusal is the command's answer; anything else is the core's own failure, logged here with what it was.
      if (wire.kind === 'internal' && !controller.signal.aborted) {
        this.options.log.error('a command failed', { command, error });
      }
      reply = { type: 'reply', id, ok: false, error: wire };
      this.served.inc({ command: this.label(command), outcome: wire.kind === 'action' ? 'refused' : 'failed' });
    } finally {
      this.running.delete(key);
    }
    try {
      await this.options.transport.publish(this.options.names.replies(from), encode(reply));
    } catch (error) {
      // The bus went down meanwhile: the caller is refused on its side (it hears the bus is down, or its time runs out).
      this.options.log.debug('could not send a command answer', { command, error });
    }
  }
}
