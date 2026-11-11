#!/usr/bin/env node
/**
 * The `jukecord` command: everything the panel does, from a terminal, through the HTTP API.
 *
 *   jukecord np                     what is playing
 *   jukecord add <address|words>    add to the queue
 *   jukecord --help                 every command
 *
 * Where it connects: JUKECORD_URL (default http://127.0.0.1:<JUKECORD_PORT or 8795>). How it logs in:
 * JUKECORD_TOKEN or --token, else the host token in the data directory (JUKECORD_DATA_DIR, default ./data), which is
 * how `./jukecord <command>` works with no setup. Which server: --guild or JUKECORD_GUILD, else the only one there is.
 *
 * Exit codes: 0 done, 1 jukecord refused (the message says why), 2 a typing mistake, 3 jukecord did not answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec } from '../web/api.ts';
import { COMMANDS, type Command, needsGuild, type Request, UsageError, type Words } from './commands.ts';

/** Something the API said no to, with its code. */
class ApiError extends Error {
  override name = 'ApiError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** jukecord could not be reached. */
class Unreachable extends Error {
  override name = 'Unreachable';
}

// Options that take a value; everything else starting with -- is a switch.
const VALUED = new Set(['url', 'token', 'guild', 'limit', 'level', 'component', 'days', 'scope']);

/** Splits the command line into options and words. "--name value" and "--name=value" both work. */
export function parseLine(argv: readonly string[]): Words {
  const args: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? '';
    if (word === '--') {
      // Everything after -- is words, even if it starts with dashes (a search for "--help").
      args.push(...argv.slice(index + 1));
      break;
    }
    if (!word.startsWith('--') || word === '--') {
      args.push(word);
      continue;
    }
    const [name = '', value] = word.slice(2).split(/=(.*)/s);
    if (value !== undefined) flags.set(name, value);
    else if (VALUED.has(name) && index + 1 < argv.length) flags.set(name, argv[++index] ?? '');
    else flags.set(name, true);
  }
  return { args, flags };
}

/** Finds the command the words start with (the longest name wins: "playlist save" over a "playlist"). */
export function findCommand(
  args: readonly string[],
): { operation: OperationName; command: Command; rest: string[] } | null {
  let best: { operation: OperationName; command: Command; rest: string[] } | null = null;
  for (const operation of OPERATIONS) {
    const command = COMMANDS[operation];
    const name = command.name.split(' ');
    if (
      name.every((part, index) => args[index] === part) &&
      (!best || name.length > best.command.name.split(' ').length)
    ) {
      best = { operation, command, rest: args.slice(name.length) };
    }
  }
  // "version" is what people try first.
  if (!best && args[0] === 'version') return { operation: 'status', command: COMMANDS.status, rest: args.slice(1) };
  return best;
}

/** The help text: every command with its arguments, grouped as the API document groups them. */
export function helpText(): string {
  const width = Math.max(
    ...OPERATIONS.map((operation) => COMMANDS[operation].name.length + COMMANDS[operation].usage.length),
  );
  const lines = [
    'jukecord: one queue, heard in a Discord voice channel and in the browser.',
    '',
    'Usage: jukecord [--url URL] [--token TOKEN] [--guild ID] [--json] <command>',
    '',
  ];
  for (const operation of OPERATIONS) {
    const command = COMMANDS[operation];
    const left = `${command.name}${command.usage ? ` ${command.usage}` : ''}`;
    lines.push(`  ${left.padEnd(width + 2)}${command.summary}`);
  }
  lines.push(
    '',
    'Settings: JUKECORD_URL, JUKECORD_TOKEN, JUKECORD_GUILD (or the options above); the host token in the data',
    'directory is used when no token is given.',
  );
  return lines.join('\n');
}

/** Talks to one jukecord with one token. */
export class Client {
  private readonly base: string;
  private readonly token: string | null;

  constructor(base: string, token: string | null) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  /** Calls an operation with its request; returns the JSON answer or throws ApiError / Unreachable. */
  async call(operation: OperationName, request: Request): Promise<unknown> {
    const spec: OperationSpec = API[operation];
    // Path parameters are filled in by name and escaped (a playlist called "a/b" stays one segment).
    const pathname = spec.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = request.params?.[name];
      if (value === undefined) throw new UsageError(`missing ${name}`);
      return encodeURIComponent(String(value));
    });
    const query = new URLSearchParams(
      Object.entries(request.query ?? {}).map(([key, value]) => [key, String(value)] as [string, string]),
    ).toString();
    const url = `${this.base}${API_PREFIX}${pathname}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // A body only for operations that take one: Fastify refuses a JSON content type with an empty body.
    let body: string | undefined;
    if (spec.body) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.body ?? {});
    }
    let response: Response;
    try {
      // Lookups (yt-dlp) can take a while for a long playlist; a minute and a half covers them.
      response = await fetch(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new Unreachable(
        `jukecord is not answering at ${this.base} (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)})`,
      );
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError('invalid', `jukecord answered ${response.status} with something that is not JSON`);
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(error?.code ?? String(response.status), error?.message ?? `HTTP ${response.status}`);
    }
    return json;
  }
}

/** Where the CLI connects and with what, from the options and the environment. */
export function connection(
  flags: ReadonlyMap<string, string | true>,
  env: NodeJS.ProcessEnv,
): { url: string; token: string | null } {
  const flag = (name: string) => {
    const value = flags.get(name);
    return typeof value === 'string' && value ? value : null;
  };
  const url = flag('url') ?? env.JUKECORD_URL ?? `http://127.0.0.1:${env.JUKECORD_PORT ?? '8795'}`;
  let token = flag('token') ?? env.JUKECORD_TOKEN ?? null;
  if (!token) {
    // The host token, readable by the user jukecord runs as (inside the container, the same user as the CLI).
    const file = path.join(path.resolve(env.JUKECORD_DATA_DIR ?? 'data'), 'host-token');
    try {
      token = fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      token = null;
    }
  }
  return { url, token };
}

/** Runs one command line; returns the exit code. Output goes through `print` (tests catch it). */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  print: (text: string, error?: boolean) => void,
): Promise<number> {
  const words = parseLine(argv);
  if (words.flags.has('help') || words.args.length === 0 || words.args[0] === 'help') {
    print(helpText());
    return words.args.length === 0 && !words.flags.has('help') ? 2 : 0;
  }
  const found = findCommand(words.args);
  if (!found) {
    print(`jukecord: there is no command "${words.args.join(' ')}" (see jukecord --help)`, true);
    return 2;
  }
  const { operation, command, rest } = found;
  const { url, token } = connection(words.flags, env);
  const client = new Client(url, token);
  try {
    let guild: string | null = null;
    if (needsGuild(operation)) guild = await chooseGuild(client, words.flags, env);
    const lookups = {
      // The queue as it is now, to turn a 1-based number into an item ID.
      queueItemId: async (position: number) => {
        const queue = (await client.call('queue', { params: { guild: guild ?? '' } })) as { items: { id: number }[] };
        const item = queue.items[position - 1];
        if (!item)
          throw new UsageError(`there is no track number ${position} in the queue (it has ${queue.items.length})`);
        return item.id;
      },
    };
    const request = await command.request({ args: rest, flags: words.flags }, lookups);
    const answer = await client.call(operation, {
      ...request,
      params: { ...(guild ? { guild } : {}), ...(request.params ?? {}) },
    });
    print(words.flags.has('json') ? JSON.stringify(answer, null, 2) : command.show(answer));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      print(
        `jukecord ${command.name}: ${error.message}\nUsage: jukecord ${command.name} ${command.usage}`.trimEnd(),
        true,
      );
      return 2;
    }
    if (error instanceof Unreachable) {
      print(error.message, true);
      return 3;
    }
    print(`jukecord: ${error instanceof Error ? error.message : String(error)}`, true);
    return 1;
  }
}

// The server to act on: the option, the environment, or the only one this login can use.
async function chooseGuild(
  client: Client,
  flags: ReadonlyMap<string, string | true>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const chosen = flags.get('guild');
  if (typeof chosen === 'string' && chosen) return chosen;
  if (env.JUKECORD_GUILD) return env.JUKECORD_GUILD;
  const guilds = (await client.call('guilds', {})) as { id: string; name: string }[];
  if (guilds.length === 1 && guilds[0]) return guilds[0].id;
  if (guilds.length === 0) throw new ApiError('not-found', 'there is no server to use (is the bot in one?)');
  throw new UsageError(
    `say which server with --guild (or JUKECORD_GUILD):\n${guilds.map((guild) => `  ${guild.id}  ${guild.name}`).join('\n')}`,
  );
}

// Run as a program (not imported by a test).
if (import.meta.main) {
  const code = await run(process.argv.slice(2), process.env, (text, error) =>
    (error ? process.stderr : process.stdout).write(`${text}\n`),
  );
  process.exitCode = code;
}
