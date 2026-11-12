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
 * Exit codes: 0 done, 1 jukecord refused (the message says why), 2 a typing mistake, 3 jukecord did not answer, 4
 * jukecord said to try again later (a rate, a busy moment: an answer with Retry-After). Under --json a failure is said
 * as JSON too, on stderr: {"error":{"code","message"}}, with the API's code, or usage or unreachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec } from '../web/api.ts';
import { type FieldSchema, GuildId, misfit } from '../web/schemas.ts';
import { COMMANDS, type Command, needsGuild, type Request, UsageError, type Words } from './commands.ts';

/** Something the API said no to, with its code, and in how many seconds to ask again when it said (Retry-After). */
class ApiError extends Error {
  override name = 'ApiError';
  readonly code: string;
  readonly retryAfter: number | null;
  constructor(code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** jukecord could not be reached. */
class Unreachable extends Error {
  override name = 'Unreachable';
}

// Options that take a value, and the switches; anything else starting with -- is a typing mistake.
const VALUED = new Set(['url', 'token', 'guild', 'limit', 'level', 'component', 'days', 'scope', 'year', 'month']);
const SWITCHES = new Set(['json', 'help', 'version', 'next', 'last']);

// What people type from Discord's names, to the command it means here.
const ALIASES: readonly (readonly [readonly string[], readonly string[]])[] = [
  [['dj', 'show'], ['settings']],
  [
    ['dj', 'clear'],
    ['dj', 'none'],
  ],
  [['playlist', 'list'], ['playlists']],
];

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
  typed: readonly string[],
): { operation: OperationName; command: Command; rest: string[] } | null {
  // Discord's names ("dj show", "playlist list") mean the commands that do the same here.
  const alias = ALIASES.find(([from]) => from.every((word, index) => typed[index] === word));
  const args = alias ? [...alias[1], ...typed.slice(alias[0].length)] : typed;
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

/** One command's help: how it is typed, and what it does. */
export function commandHelp(command: Command): string {
  // A command without arguments has no space after its name.
  const typed = command.usage ? `${command.name} ${command.usage}` : command.name;
  return `Usage: jukecord ${typed}\n  ${command.summary}`;
}

// Checks the options typed for a command against what the API takes for them, so a wrong one is said in the option's
// own words, before jukecord is asked (the API's own answer named the validator's path, four times over).
function checkOptions(operation: OperationName, request: Request, flags: ReadonlyMap<string, string | true>): void {
  const spec: OperationSpec = API[operation];
  const fields = (spec.query?.properties ?? {}) as Record<string, FieldSchema>;
  for (const [name, value] of Object.entries(request.query ?? {})) {
    // Only what was typed: the command fills some fields itself (the time zone of the statistics).
    if (!flags.has(name)) continue;
    const problem = misfit(fields[name], value);
    if (problem) throw new UsageError(`--${name} ${problem}`);
  }
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
  // Two columns while they fit an 80-column terminal; a long command line puts its summary on the next line.
  const column = Math.min(width + 2, 34);
  for (const operation of OPERATIONS) {
    const command = COMMANDS[operation];
    const left = `${command.name}${command.usage ? ` ${command.usage}` : ''}`;
    if (left.length + 2 <= column) lines.push(`  ${left.padEnd(column)}${command.summary}`);
    else lines.push(`  ${left}`, `  ${' '.repeat(column)}${command.summary}`);
  }
  lines.push(
    '',
    'Settings: JUKECORD_URL, JUKECORD_TOKEN, JUKECORD_GUILD (or the options above).',
    'Without a token, the host token in the data directory is used.',
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
      // "Try again later" comes with Retry-After (a rate, a busy moment), which the exit code tells apart.
      const later = Number(response.headers.get('retry-after'));
      throw new ApiError(
        error?.code ?? String(response.status),
        error?.message ?? `HTTP ${response.status}`,
        Number.isFinite(later) && later > 0 ? later : null,
      );
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
  // -h is --help, as in most commands: as an option only, before any "--" (after it, "-h" is something to search for).
  const end = argv.indexOf('--');
  const words = parseLine(argv.map((word, index) => (word === '-h' && (end < 0 || index < end) ? '--help' : word)));
  if (words.flags.has('version')) {
    print(`jukecord ${VERSION}`);
    return 0;
  }
  // A typing mistake found before anything is asked: as JSON under --json too (code "usage"), as the later ones are.
  const mistake = (message: string): number => {
    print(
      words.flags.has('json') ? JSON.stringify({ error: { code: 'usage', message } }, null, 2) : `jukecord: ${message}`,
      true,
    );
    return 2;
  };
  // One command's help: "help add", or "add --help".
  const asked = words.args[0] === 'help' ? words.args.slice(1) : words.flags.has('help') ? words.args : [];
  if (asked.length > 0) {
    const found = findCommand(asked);
    if (!found) return mistake(`there is no command "${asked.join(' ')}" (see jukecord --help)`);
    print(commandHelp(found.command));
    return 0;
  }
  if (words.flags.has('help') || words.args.length === 0 || words.args[0] === 'help') {
    print(helpText());
    return words.args.length === 0 && !words.flags.has('help') ? 2 : 0;
  }
  // A mistyped option is said at once, not silently left out ("--jsno"); so is one that needs a value and has none.
  for (const [name, value] of words.flags) {
    if (!VALUED.has(name) && !SWITCHES.has(name)) return mistake(`there is no option --${name} (see jukecord --help)`);
    if (VALUED.has(name) && (value === true || value === '')) return mistake(`--${name} needs a value`);
    if (SWITCHES.has(name) && value !== true) return mistake(`--${name} takes no value`);
  }
  const found = findCommand(words.args);
  if (!found) return mistake(`there is no command "${words.args.join(' ')}" (see jukecord --help)`);
  const { operation, command, rest } = found;
  const { url, token } = connection(words.flags, env);
  const client = new Client(url, token);
  // Under --json a failure is said as JSON as well, with its code, on stderr; the exit code is the same.
  const json = words.flags.has('json');
  const failed = (code: string, message: string, text: string): void => {
    print(json ? JSON.stringify({ error: { code, message } }, null, 2) : text, true);
  };
  try {
    // The server is asked for only when something needs it, so a typing mistake is said before any connection.
    let guild: string | null = null;
    const guildOf = async (): Promise<string> => {
      guild ??= await chooseGuild(client, words.flags, env);
      return guild;
    };
    const lookups = {
      // The queue as it is now, to turn a 1-based number into an item ID.
      queueItemId: async (position: number) => {
        const queue = (await client.call('queue', { params: { guild: await guildOf() } })) as {
          items: { id: number }[];
        };
        const item = queue.items[position - 1];
        if (!item)
          throw new UsageError(`there is no track number ${position} in the queue (it has ${queue.items.length})`);
        return item.id;
      },
    };
    const request = await command.request({ args: rest, flags: words.flags }, lookups);
    checkOptions(operation, request, words.flags);
    if (needsGuild(operation)) await guildOf();
    const answer = await client.call(operation, {
      ...request,
      params: { ...(guild ? { guild } : {}), ...(request.params ?? {}) },
    });
    print(json ? JSON.stringify(answer, null, 2) : command.show(answer));
    // The self-check fails the command when a check failed, so scripts and monitors can tell.
    if (operation === 'doctor') {
      const checks = (answer as { checks?: { status: string }[] }).checks ?? [];
      if (checks.some((check) => check.status === 'fail')) return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      failed(
        'usage',
        error.message,
        `jukecord ${command.name}: ${error.message}\nUsage: jukecord ${command.name} ${command.usage}`.trimEnd(),
      );
      return 2;
    }
    if (error instanceof Unreachable) {
      failed('unreachable', error.message, error.message);
      return 3;
    }
    // Refused for want of a login: no token at all says how to give one; a token that did not work says so.
    if (error instanceof ApiError && error.code === 'unauthorized') {
      const message = token
        ? 'the token was refused (revoked, or made for another jukecord)'
        : 'needs a token: --token or JUKECORD_TOKEN (make one with jukecord token create <name>)';
      failed(error.code, message, `jukecord: ${message}`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    // jukecord's own sentences start with its name ("jukecord runs without a Discord bot here ..."): not twice.
    failed(
      error instanceof ApiError ? error.code : 'failed',
      message,
      message.startsWith('jukecord ') ? message : `jukecord: ${message}`,
    );
    // Told to try again later (Retry-After): its own exit code, so a script can tell it from a refusal.
    return error instanceof ApiError && error.retryAfter !== null ? 4 : 1;
  }
}

// The server to act on: the option, the environment, or the only one this login can use.
async function chooseGuild(
  client: Client,
  flags: ReadonlyMap<string, string | true>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // A server's ID as the API takes one, checked here so a wrong one is said plainly (the API's answer was a pattern).
  const id = new RegExp((GuildId as { pattern?: string }).pattern ?? '');
  const chosen = flags.get('guild');
  if (typeof chosen === 'string' && chosen) {
    if (!id.test(chosen)) throw new UsageError('--guild takes a server ID (see jukecord servers)');
    return chosen;
  }
  if (env.JUKECORD_GUILD) {
    if (!id.test(env.JUKECORD_GUILD)) throw new UsageError('JUKECORD_GUILD takes a server ID (see jukecord servers)');
    return env.JUKECORD_GUILD;
  }
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
