/**
 * The CLI's commands: one per API operation, each saying how its words become a request and how the answer is shown.
 *
 * The table is typed as a record over every operation, so an operation without a command does not compile, and the
 * requests are built from the API table itself (method, path, fields), so the CLI cannot call a path that does not
 * exist. People type 1-based queue numbers, as /queue and the panel show them; the commands look the item up.
 */

import { formatDuration, parseTimestamp } from '../util/time.ts';
import { API, type OperationName } from '../web/api.ts';

/** The words after the command name, with the options pulled out ("--next", "--limit 20"). */
export interface Words {
  readonly args: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** What a command sends: the path's parameters, the query and the body. */
export interface Request {
  readonly params?: Record<string, string | number>;
  readonly query?: Record<string, string | number>;
  readonly body?: Record<string, unknown>;
}

/** What a command may ask before building its request: the queue, to turn a number into an item. */
export interface Lookups {
  queueItemId(position: number): Promise<number>;
  /** The track playing now (for `like`); a refusal when nothing is. */
  currentTrackId(): Promise<number>;
  /** The track at a 1-based number of `jukecord likes` (for `unlike`). */
  likedTrackId(position: number): Promise<number>;
}

export interface Command {
  /** What people type, with a space for a subcommand ("playlist save"). */
  readonly name: string;
  /** The arguments in the help text. */
  readonly usage: string;
  readonly summary: string;
  request(words: Words, lookups: Lookups): Request | Promise<Request>;
  /** The answer for people; --json prints the JSON as it came instead. */
  show(answer: unknown): string;
}

/** A mistake in what was typed; the CLI prints it with the command's usage and exits with 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

// Answers as the CLI reads them (the API's shapes, only the fields the text uses).
interface TrackJson {
  title: string;
  url: string;
  durationMs: number | null;
}
interface ItemJson {
  position: number;
  track: TrackJson;
  addedByName: string | null;
}
interface PlayerJson {
  status: string;
  track: TrackJson | null;
  addedByName: string | null;
  positionMs: number;
  at: number;
  durationMs: number | null;
  repeat: string;
  progress: number | null;
  error: string | null;
  autoplay?: string;
}
interface AddJson {
  items: ItemJson[];
  skippedTooLong: number;
  skippedFull: number;
}

// The text of the words joined, for inputs typed without quotes ("jukecord add never gonna give you up").
function rest(words: Words, what: string): string {
  const text = words.args.join(' ').trim();
  if (!text) throw new UsageError(`say ${what}`);
  return text;
}

// A whole number argument, at least 1.
function number(text: string | undefined, what: string): number {
  if (!text || !/^\d+$/.test(text) || Number(text) < 1) throw new UsageError(`say ${what} (1 or more)`);
  return Number(text);
}

// An option's number, or the fallback when it was not given.
function option(words: Words, name: string, fallback: number): number {
  const value = words.flags.get(name);
  if (value === undefined) return fallback;
  if (value === true || !/^-?\d+$/.test(value)) throw new UsageError(`--${name} takes a number`);
  return Number(value);
}

// "Title · 3:45 · added by Name".
function trackLine(track: TrackJson, by: string | null): string {
  const parts = [track.title];
  if (track.durationMs !== null) parts.push(formatDuration(track.durationMs));
  if (by) parts.push(`added by ${by}`);
  return parts.join(' · ');
}

function showPlayer(answer: unknown): string {
  const player = answer as PlayerJson;
  const repeat =
    (player.repeat === 'off' ? '' : `\nRepeating ${player.repeat === 'track' ? 'this track' : 'the queue'}`) +
    // Autoplay, when it is on, on a line of its own after the repeat.
    (player.autoplay && player.autoplay !== 'off'
      ? `\nAutoplay: ${player.autoplay === 'history' ? "from this server's plays" : 'related to the last track'}`
      : '');
  if (!player.track) return `${player.error ? `Nothing is playing (${player.error})` : 'Nothing is playing'}${repeat}`;
  // Where it is now: the snapshot's position plus the time since it was taken, while playing.
  const position =
    player.status === 'playing' ? player.positionMs + Math.max(0, Date.now() - player.at) : player.positionMs;
  const where = player.durationMs ? ` ${formatDuration(position)} / ${formatDuration(player.durationMs)}` : '';
  const state =
    player.status === 'loading'
      ? `Getting ready${player.progress !== null ? ` (${Math.round(player.progress * 100)}%)` : ''}`
      : player.status === 'paused'
        ? 'Paused'
        : 'Playing';
  return `${state}:${where}\n${trackLine(player.track, player.addedByName)}${repeat}`;
}

function showAdded(answer: unknown): string {
  const added = answer as AddJson;
  const lines =
    added.items.length === 1 && added.items[0]
      ? [`Added at ${added.items[0].position + 1}: ${trackLine(added.items[0].track, null)}`]
      : [`Added ${added.items.length} tracks`];
  if (added.skippedTooLong > 0) lines.push(`${added.skippedTooLong} left out: longer than the limit`);
  if (added.skippedFull > 0) lines.push(`${added.skippedFull} left out: the queue is full`);
  return lines.join('\n');
}

const showOk = () => 'Done';
const showRemoved = (answer: unknown) => `Removed ${(answer as { removed: number }).removed}`;

function showVoice(answer: unknown): string {
  const voice = answer as {
    current: { name: string } | null;
    channels: { id: string; name: string; people: number }[];
  };
  // An empty name: the bot is in a channel this login cannot see.
  const lines = [voice.current ? `In ${voice.current.name || 'a channel you cannot see'}` : 'Not in a voice channel'];
  for (const channel of voice.channels) lines.push(`  ${channel.id}  ${channel.name} (${channel.people})`);
  return lines.join('\n');
}

function showSettings(answer: unknown): string {
  const settings = answer as { djRoleId: string | null; roles: { id: string; name: string }[] };
  const role = settings.roles.find((entry) => entry.id === settings.djRoleId);
  const lines = [
    settings.djRoleId === null
      ? 'DJ role: none (everyone may change the music)'
      : `DJ role: ${role?.name ?? settings.djRoleId}`,
  ];
  if (settings.roles.length > 0) lines.push('Roles:', ...settings.roles.map((entry) => `  ${entry.id}  ${entry.name}`));
  return lines.join('\n');
}

function showPlaylist(answer: unknown): string {
  const playlist = answer as { name: string; size: number };
  return `${playlist.name} (${playlist.size} tracks)`;
}

/** Every command, by the operation it runs. */
export const COMMANDS: Readonly<Record<OperationName, Command>> = {
  'now-playing': { name: 'np', usage: '', summary: 'What is playing', request: () => ({}), show: showPlayer },
  'play-now': {
    name: 'play',
    usage: '<address or words>',
    summary: 'Play now (the current track is skipped)',
    request: (words) => ({ body: { input: rest(words, 'what to play') } }),
    show: showAdded,
  },
  skip: { name: 'skip', usage: '', summary: 'Skip to the next track', request: () => ({}), show: showPlayer },
  'remove-current': {
    name: 'drop',
    usage: '',
    summary: 'Remove this track (not kept in the history)',
    request: () => ({}),
    show: showPlayer,
  },
  pause: { name: 'pause', usage: '', summary: 'Pause', request: () => ({}), show: showPlayer },
  resume: { name: 'resume', usage: '', summary: 'Play on (or start the queue)', request: () => ({}), show: showPlayer },
  seek: {
    name: 'seek',
    usage: '<time: 83, 1:23 or 1m23s>',
    summary: 'Go to a place in the current track',
    request: (words) => {
      try {
        return { body: { positionMs: parseTimestamp(rest(words, 'where to go')) } };
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
    },
    show: showPlayer,
  },
  repeat: {
    name: 'repeat',
    usage: '<off|track|queue>',
    summary: 'Repeat nothing, this track or the queue',
    request: (words) => {
      const mode = words.args[0];
      if (mode !== 'off' && mode !== 'track' && mode !== 'queue') throw new UsageError('repeat off, track or queue');
      return { body: { mode } };
    },
    show: showPlayer,
  },
  stop: {
    name: 'stop',
    usage: '',
    summary: 'Stop playing (the queue stays)',
    request: () => ({}),
    show: () => 'Stopped (the queue stays)',
  },

  queue: {
    name: 'queue',
    usage: '',
    summary: 'The queue',
    request: () => ({}),
    show: (answer) => {
      const queue = answer as { items: ItemJson[] };
      if (queue.items.length === 0) return 'The queue is empty';
      return queue.items.map((item) => `${item.position + 1}. ${trackLine(item.track, item.addedByName)}`).join('\n');
    },
  },
  add: {
    name: 'add',
    usage: '<address or words> [--next]',
    summary: 'Add to the queue (plays if nothing is)',
    request: (words) => ({ body: { input: rest(words, 'what to add'), at: words.flags.has('next') ? 'next' : 'end' } }),
    show: showAdded,
  },
  clear: { name: 'clear', usage: '', summary: 'Empty the queue', request: () => ({}), show: showRemoved },
  remove: {
    name: 'remove',
    usage: '<number>',
    summary: 'Remove a track from the queue',
    request: async (words, lookups) => ({
      params: { item: await lookups.queueItemId(number(words.args[0], 'the number')) },
    }),
    show: showOk,
  },
  move: {
    name: 'move',
    usage: '<number> <new number>',
    summary: 'Move a track in the queue',
    request: async (words, lookups) => ({
      params: { item: await lookups.queueItemId(number(words.args[0], 'the number')) },
      body: { index: number(words.args[1], 'the new number') - 1 },
    }),
    show: showOk,
  },
  jump: {
    name: 'jump',
    usage: '<number>',
    summary: 'Play a queued track now',
    request: async (words, lookups) => ({
      params: { item: await lookups.queueItemId(number(words.args[0], 'the number')) },
    }),
    show: showPlayer,
  },
  shuffle: { name: 'shuffle', usage: '', summary: 'Shuffle the queue', request: () => ({}), show: showOk },
  dedupe: {
    name: 'dedupe',
    usage: '',
    summary: 'Remove tracks queued twice',
    request: () => ({}),
    show: showRemoved,
  },

  history: {
    name: 'history',
    usage: '[--limit 20]',
    summary: 'Recently played',
    request: (words) => ({ query: { limit: option(words, 'limit', 20) } }),
    show: (answer) => {
      const entries = answer as { track: TrackJson; addedByName: string | null; playedAt: number }[];
      if (entries.length === 0) return 'Nothing has been played yet';
      return entries
        .map((entry) => `${new Date(entry.playedAt).toLocaleString()}  ${trackLine(entry.track, entry.addedByName)}`)
        .join('\n');
    },
  },
  stats: {
    name: 'stats',
    usage: '[--days 30]',
    summary: 'Listening figures',
    // The time zone of this machine, so "today" is today here.
    request: (words) => ({ query: { days: option(words, 'days', 30), tz: -new Date().getTimezoneOffset() } }),
    show: (answer) => {
      const stats = answer as {
        span: number;
        plays: number;
        playedMs: number;
        tracks: number;
        topTracks: { track: TrackJson; plays: number }[];
        topPeople: { name: string | null; plays: number }[];
      };
      const hours = Math.floor(stats.playedMs / 3_600_000);
      const minutes = Math.round((stats.playedMs % 3_600_000) / 60_000);
      const lines = [
        `The last ${stats.span} days: ${stats.plays} plays, ${hours} h ${minutes} min, ${stats.tracks} tracks`,
      ];
      if (stats.topTracks.length > 0) lines.push('Most played:');
      for (const entry of stats.topTracks.slice(0, 10)) lines.push(`  ${entry.plays}  ${entry.track.title}`);
      if (stats.topPeople.length > 0) lines.push('Added most:');
      for (const entry of stats.topPeople.slice(0, 5)) lines.push(`  ${entry.plays}  ${entry.name ?? 'the host'}`);
      return lines.join('\n');
    },
  },

  playlists: {
    name: 'playlists',
    usage: '',
    summary: 'Saved playlists',
    request: () => ({}),
    show: (answer) => {
      const playlists = answer as { name: string; size: number }[];
      return playlists.length === 0 ? 'No saved playlists' : playlists.map(showPlaylist).join('\n');
    },
  },
  'playlist-save': {
    name: 'playlist save',
    usage: '<name>',
    summary: 'Save the current track and the queue',
    request: (words) => ({ body: { name: rest(words, 'a name') } }),
    show: showPlaylist,
  },
  'playlist-load': {
    name: 'playlist load',
    usage: '<name> [--next]',
    summary: 'Add a saved playlist to the queue',
    request: (words) => ({
      params: { name: rest(words, 'which playlist') },
      body: { at: words.flags.has('next') ? 'next' : 'end' },
    }),
    show: showAdded,
  },
  'playlist-rename': {
    name: 'playlist rename',
    usage: '<name> <new name>',
    summary: 'Rename a saved playlist (quote spaced names)',
    request: (words) => {
      const [name, next] = words.args;
      if (!name || !next) throw new UsageError('say the playlist and its new name');
      return { params: { name }, body: { name: next } };
    },
    show: showPlaylist,
  },
  'playlist-delete': {
    name: 'playlist delete',
    usage: '<name>',
    summary: 'Delete a saved playlist',
    request: (words) => ({ params: { name: rest(words, 'which playlist') } }),
    show: showOk,
  },

  'voice-channels': {
    name: 'channels',
    usage: '',
    summary: 'Where the bot is, and where it can go',
    request: () => ({}),
    show: showVoice,
  },
  join: {
    name: 'join',
    usage: '[channel ID]',
    summary: 'Join a voice channel',
    request: (words) => ({ body: words.args[0] ? { channelId: words.args[0] } : {} }),
    show: (answer) => {
      const voice = answer as { current: { name: string } | null };
      return voice.current ? `Joined ${voice.current.name || 'a channel you cannot see'}` : 'Not in a voice channel';
    },
  },
  leave: {
    name: 'leave',
    usage: '',
    summary: 'Leave the voice channel',
    request: () => ({}),
    show: () => 'Left the voice channel',
  },

  settings: {
    name: 'settings',
    usage: '',
    summary: "The server's DJ role and roles",
    request: () => ({}),
    show: showSettings,
  },
  'dj-role': {
    name: 'dj',
    usage: '<role ID|none>',
    summary: 'Who may change the music (none: everyone)',
    request: (words) => {
      const role = words.args[0];
      if (!role) throw new UsageError('say a role ID (see jukecord settings) or none');
      return { body: { roleId: role === 'none' ? null : role } };
    },
    show: showSettings,
  },
  status: {
    name: 'status',
    usage: '',
    summary: 'The version and the connection to Discord',
    request: () => ({}),
    show: (answer) => {
      const status = answer as { version: string; mode: string; discord: boolean; uptimeMs: number };
      const discord =
        status.mode === 'browser-only' ? 'browser-only (no bot)' : status.discord ? 'connected' : 'not connected';
      return `jukecord ${status.version}\nDiscord: ${discord}\nUp for ${formatDuration(status.uptimeMs)}`;
    },
  },

  me: {
    name: 'whoami',
    usage: '',
    summary: 'Who this token belongs to',
    request: () => ({}),
    show: (answer) => {
      const me = answer as { kind: string; name: string; scope: string };
      return `${me.kind === 'host' ? 'the host' : me.name} (${me.scope})`;
    },
  },
  guilds: {
    name: 'servers',
    usage: '',
    summary: 'The servers you can use',
    request: () => ({}),
    show: (answer) => {
      const guilds = answer as { id: string; name: string; mayControl: boolean }[];
      if (guilds.length === 0) return 'No servers';
      return guilds.map((guild) => `${guild.id}  ${guild.name}${guild.mayControl ? '' : ' (view only)'}`).join('\n');
    },
  },
  tokens: {
    name: 'token list',
    usage: '',
    summary: 'Your API tokens',
    request: () => ({}),
    show: (answer) => {
      const tokens = answer as { id: number; name: string; scope: string; usedAt: number | null }[];
      if (tokens.length === 0) return 'No tokens';
      return tokens
        .map(
          (token) =>
            `${token.id}  ${token.name} (${token.scope}), ${token.usedAt ? `used ${new Date(token.usedAt).toLocaleString()}` : 'never used'}`,
        )
        .join('\n');
    },
  },
  'token-create': {
    name: 'token create',
    usage: '<name> [--scope read|control|admin]',
    summary: 'Make an API token (shown once)',
    request: (words) => {
      const scope = words.flags.get('scope') ?? 'control';
      if (scope !== 'read' && scope !== 'control' && scope !== 'admin')
        throw new UsageError('--scope read, control or admin');
      return { body: { name: rest(words, 'a name for the token'), scope } };
    },
    show: (answer) => {
      const created = answer as { token: string; info: { id: number; scope: string } };
      return `${created.token}\n(token ${created.info.id}, ${created.info.scope}; it is not shown again)`;
    },
  },
  'token-revoke': {
    name: 'token revoke',
    usage: '<token ID>',
    summary: 'Revoke an API token',
    request: (words) => ({ params: { id: number(words.args[0], 'the token ID') } }),
    show: showOk,
  },
  logs: {
    name: 'logs',
    usage: '[--limit 100] [--level warn] [--component discord]',
    summary: "jukecord's log",
    request: (words) => {
      const level = words.flags.get('level');
      const component = words.flags.get('component');
      return {
        query: {
          limit: option(words, 'limit', 100),
          ...(typeof level === 'string' ? { level } : {}),
          ...(typeof component === 'string' ? { component } : {}),
        },
      };
    },
    show: (answer) => {
      const records = answer as {
        time: string;
        level: string;
        component: string;
        msg: string;
        fields: Record<string, unknown>;
      }[];
      // An empty answer says so, rather than printing nothing.
      if (records.length === 0) return 'No log records';
      return records
        .map((record) => {
          const fields = Object.entries(record.fields)
            .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
            .join(' ');
          return `${record.time} ${record.level.padEnd(5)} ${record.component}: ${record.msg}${fields ? ` ${fields}` : ''}`;
        })
        .join('\n');
    },
  },
  'login-link': {
    name: 'link',
    usage: '',
    summary: 'A one-time host login link (10 minutes)',
    request: () => ({}),
    show: (answer) => (answer as { url: string }).url,
  },
  backup: {
    name: 'backup',
    usage: '',
    summary: 'Copy the database to the backups folder',
    request: () => ({}),
    show: (answer) => {
      const backup = answer as { file: string; bytes: number };
      return `${backup.file} (${Math.max(1, Math.round(backup.bytes / 1024))} KiB)`;
    },
  },
  doctor: {
    name: 'doctor',
    usage: '',
    summary: 'Check the parts jukecord needs',
    request: () => ({}),
    show: (answer) => {
      const report = answer as {
        checks: { name: string; status: string; detail: string }[];
        settings: Record<string, string>;
      };
      const marks: Record<string, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
      const lines = report.checks.map(
        (check) => `${marks[check.status] ?? check.status}  ${check.name}: ${check.detail}`,
      );
      lines.push('', ...Object.entries(report.settings).map(([key, value]) => `${key}: ${value}`));
      return lines.join('\n');
    },
  },

  likes: {
    name: 'likes',
    usage: '',
    summary: 'The tracks you liked, newest first',
    request: () => ({}),
    show: (answer) => {
      const liked = answer as { track: TrackJson }[];
      if (liked.length === 0) return 'No liked tracks';
      return liked.map((entry, index) => `${index + 1}. ${trackLine(entry.track, null)}`).join('\n');
    },
  },
  like: {
    name: 'like',
    usage: '',
    summary: 'Like the track playing now',
    request: async (_words, lookups) => ({ params: { track: await lookups.currentTrackId() } }),
    show: (answer) => `Liked: ${(answer as { track: TrackJson }).track.title}`,
  },
  unlike: {
    name: 'unlike',
    usage: '<number>',
    summary: 'Take back a like (its number in jukecord likes)',
    request: async (words, lookups) => ({
      params: { track: await lookups.likedTrackId(number(words.args[0], 'the number')) },
    }),
    show: showOk,
  },
  'likes-add': {
    name: 'likes add',
    usage: '[--next]',
    summary: 'Add every track you liked to the queue',
    request: (words) => ({ body: { at: words.flags.has('next') ? 'next' : 'end' } }),
    show: showAdded,
  },

  autoplay: {
    name: 'autoplay',
    usage: '<off|history|related>',
    summary: "When the queue runs out: nothing, this server's plays, or related tracks",
    request: (words) => {
      const mode = words.args[0];
      if (mode !== 'off' && mode !== 'history' && mode !== 'related')
        throw new UsageError('autoplay off, history or related');
      return { body: { mode } };
    },
    show: showPlayer,
  },

  search: {
    name: 'search',
    usage: '<words> [--limit 8]',
    summary: 'What YouTube finds, each with the address that adds it',
    request: (words) => ({ query: { q: rest(words, 'what to search for'), limit: option(words, 'limit', 8) } }),
    show: (answer) => {
      const found = answer as {
        results: { url: string; title: string; uploader: string | null; durationMs: number | null }[];
      };
      if (found.results.length === 0) return 'Nothing was found';
      // "1. Title · Channel · 3:45", the address under it: what `jukecord add` or `jukecord play` takes.
      return found.results
        .map((result, index) => {
          const parts = [result.title, ...(result.uploader ? [result.uploader] : [])];
          if (result.durationMs !== null) parts.push(formatDuration(result.durationMs));
          return `${index + 1}. ${parts.join(' · ')}\n   ${result.url}`;
        })
        .join('\n');
    },
  },
};

/** Whether an operation's path names a server (and so the command needs one). */
export function needsGuild(operation: OperationName): boolean {
  return API[operation].path.includes('{guild}');
}
