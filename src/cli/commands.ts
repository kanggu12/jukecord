/**
 * The CLI's commands: one per API operation, each saying how its words become a request and how the answer is shown.
 *
 * The table is typed as a record over every operation, so an operation without a command does not compile, and the
 * requests are built from the API table itself (method, path, fields), so the CLI cannot call a path that does not
 * exist. People type 1-based queue numbers, as /queue and the panel show them; the commands look the item up.
 */

import fs from 'node:fs';
import { sayNotice } from '../core/say.ts';
import { formatDuration, parseTimestamp } from '../util/time.ts';
import { API, type OperationName } from '../web/api.ts';
import { Snowflake } from '../web/schemas.ts';

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
  /** How many tracks are queued now. */
  queueSize(): Promise<number>;
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
  /** The answer for people, as the options typed ask for it (none given: as plain as it comes); --json prints the JSON
   * as it came instead. */
  show(answer: unknown, words?: Words): string;
}

/** A mistake in what was typed; the CLI prints it with the command's usage and exits with 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** The largest file a playlist is imported from, as jukecord takes it. */
const IMPORT_MAX = 1024 * 1024;

/**
 * The text of a playlist file, read here on this machine (jukecord gets the text): `-` reads it from the standard input,
 * which is how ./jukecord hands over a file from where the command was typed (the command inside the container cannot
 * see it there). `input` reads the standard input (tests give it their own).
 */
export function readImport(file: string, input: () => Buffer = () => fs.readFileSync(0)): string {
  const what = file === '-' ? 'the standard input' : file;
  let bytes: Buffer;
  try {
    // A file's size is known before it is read; the standard input's only after.
    if (file !== '-' && fs.statSync(file).size > IMPORT_MAX) throw new UsageError(`${file} is larger than 1 MiB`);
    bytes = file === '-' ? input() : fs.readFileSync(file);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${what} cannot be read`);
  }
  if (bytes.length > IMPORT_MAX) throw new UsageError(`${what} is larger than 1 MiB`);
  return bytes.toString('utf8');
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
  notice: string | null;
  waiting: boolean;
  autoplay?: string;
}
interface AddJson {
  items: ItemJson[];
  skippedTooLong: number;
  skippedFull: number;
  skippedLimit?: number;
  skippedNotFound?: number;
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

// A Discord ID (a channel's, a role's) as the API takes one, checked here so a wrong one is said in words: the API's
// answer was its pattern ("channelId must match pattern ...").
const DISCORD_ID = new RegExp((Snowflake as { pattern?: string }).pattern ?? '^\\d{17,20}$');
function discordId(text: string, what: string): string {
  if (!DISCORD_ID.test(text)) throw new UsageError(what);
  return text;
}

// The most tracks one person may have queued, as the API takes it.
const PERSON_LIMIT_MAX =
  (API['person-limit'].body?.properties as { tracks?: { maximum?: number } } | undefined)?.tracks?.maximum ?? 1000;

// "on" or "off", for the settings that are one or the other.
function onOff(text: string | undefined): boolean {
  if (text !== 'on' && text !== 'off') throw new UsageError('say on or off');
  return text === 'on';
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

// Listening time as people say it, in whole minutes with the hours made from them: "3 h 12 min", "45 min". The
// minutes rounded after the hours were taken printed 59 min 59 s as "0 h 60 min".
function hoursMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function showPlayer(answer: unknown): string {
  const player = answer as PlayerJson;
  const repeat =
    (player.repeat === 'off' ? '' : `\nRepeating ${player.repeat === 'track' ? 'this track' : 'the queue'}`) +
    // Autoplay, when it is on, on a line of its own after the repeat.
    (player.autoplay && player.autoplay !== 'off'
      ? `\nAutoplay: ${player.autoplay === 'history' ? "from this server's plays" : 'related to the last track'}`
      : '');
  // What the player did by itself (a track taken out of the loop), on a line of its own.
  const notice = player.notice ? `\n${sayNotice(player.notice, 'en')}` : '';
  if (!player.track)
    return `${player.error ? `Nothing is playing (${player.error})` : 'Nothing is playing'}${repeat}${notice}`;
  // Where it is now: the snapshot's position plus the time since it was taken, while playing.
  const position =
    player.status === 'playing' ? player.positionMs + Math.max(0, Date.now() - player.at) : player.positionMs;
  const where = player.durationMs ? ` ${formatDuration(position)} / ${formatDuration(player.durationMs)}` : '';
  const state =
    player.status === 'loading'
      ? player.waiting
        ? 'Waiting for its turn'
        : `Getting ready${player.progress !== null ? ` (${Math.round(player.progress * 100)}%)` : ''}`
      : player.status === 'paused'
        ? 'Paused'
        : 'Playing';
  return `${state}:${where}\n${trackLine(player.track, player.addedByName)}${repeat}${notice}`;
}

function showAdded(answer: unknown): string {
  const added = answer as AddJson;
  const lines =
    added.items.length === 1 && added.items[0]
      ? [`Added at ${added.items[0].position + 1}: ${trackLine(added.items[0].track, null)}`]
      : [`Added ${added.items.length} tracks`];
  if (added.skippedTooLong > 0) lines.push(`${added.skippedTooLong} left out: longer than the limit`);
  if (added.skippedFull > 0) lines.push(`${added.skippedFull} left out: the queue is full`);
  if ((added.skippedLimit ?? 0) > 0) lines.push(`${added.skippedLimit} left out: your limit of tracks in the queue`);
  if ((added.skippedNotFound ?? 0) > 0) lines.push(`${added.skippedNotFound} left out: not found on YouTube`);
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

// The sound presets as the CLI names them.
const PRESET_NAMES: Readonly<Record<string, string>> = {
  off: 'off',
  bass: 'more bass',
  voices: 'clearer voices',
  bright: 'brighter',
  night: 'softer at night',
};

// A voice channel's sound: "Voice volume 80%, sound: more bass".
function showSound(answer: unknown): string {
  const sound = answer as { volume: number; preset: string };
  return `Voice volume ${sound.volume}%, sound: ${PRESET_NAMES[sound.preset] ?? sound.preset}`;
}

function showSettings(answer: unknown): string {
  const settings = answer as {
    djRoleId: string | null;
    roles: { id: string; name: string }[];
    alertsChannelId: string | null;
    channels: { id: string; name: string }[];
    voteSkip: boolean;
    takeTurns: boolean;
    personLimit: number;
    stay: boolean;
    volume: number;
    sound: string;
  };
  const role = settings.roles.find((entry) => entry.id === settings.djRoleId);
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  const lines = [
    settings.djRoleId === null
      ? 'DJ role: none (everyone may change the music)'
      : `DJ role: ${role?.name ?? settings.djRoleId}`,
    // How people share the music, and the voice channel's sound.
    `Vote to skip: ${onOff(settings.voteSkip)}`,
    `Take turns: ${onOff(settings.takeTurns)}`,
    `Tracks per person: ${settings.personLimit === 0 ? 'no limit' : settings.personLimit}`,
    `Stay in voice: ${onOff(settings.stay)}`,
    `Voice volume: ${settings.volume}%`,
    `Sound: ${PRESET_NAMES[settings.sound] ?? settings.sound}`,
  ];
  // Where jukecord tells the server about trouble, and the channels to choose it from.
  const alerts = settings.channels.find((entry) => entry.id === settings.alertsChannelId);
  lines.push(
    settings.alertsChannelId === null ? 'Alerts: none' : `Alerts: #${alerts?.name ?? settings.alertsChannelId}`,
  );
  if (settings.roles.length > 0) lines.push('Roles:', ...settings.roles.map((entry) => `  ${entry.id}  ${entry.name}`));
  if (settings.channels.length > 0)
    lines.push('Channels:', ...settings.channels.map((entry) => `  ${entry.id}  #${entry.name}`));
  return lines.join('\n');
}

function showPlaylist(answer: unknown): string {
  const playlist = answer as { name: string; size: number };
  return `${playlist.name} (${playlist.size} tracks)`;
}

// What a server's time in music has, as the CLI reads it (the API's Wrapped, the fields the text uses).
interface WrappedJson {
  period: { kind: string; key: string; from: string; to: string };
  plays: number;
  playedMs: number;
  tracks: number;
  people: number;
  days: number;
  topTracks: { track: TrackJson; plays: number }[];
  topPeople: { name: string | null; plays: number }[];
  weekdays: number[];
  hours: number[];
  longestDay: { day: string; plays: number; playedMs: number } | null;
  firstTrack: { track: TrackJson; playedAt: number; addedByName: string | null } | null;
  song: { track: TrackJson; plays: number; days: number } | null;
  keptFrom: string | null;
}

// "12 h 5 min", "45 min": time listened as people say it.
function listened(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

// The time Wrapped is asked for, from the options: a year, a month of it (or of this year), or the last 12 months;
// nothing at all is this year, which jukecord picks.
function wrappedPeriod(words: Words): { period?: string } {
  const year = words.flags.get('year');
  const month = words.flags.get('month');
  if (words.flags.has('last')) {
    if (year !== undefined || month !== undefined)
      throw new UsageError('--last is the last 12 months: no --year or --month');
    return { period: 'last-12-months' };
  }
  if (year !== undefined && (year === true || !/^\d{4}$/.test(year)))
    throw new UsageError('--year takes a year (2026)');
  if (month === undefined) return year === undefined ? {} : { period: String(year) };
  if (month !== true && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { period: month };
  if (month === true || !/^(0?[1-9]|1[0-2])$/.test(month))
    throw new UsageError('--month takes a month (3) or a year and a month (2026-03)');
  // A month alone is of the year given, or of this year here.
  const of = typeof year === 'string' ? year : String(new Date().getFullYear());
  return { period: `${of}-${month.padStart(2, '0')}` };
}

function showWrapped(answer: unknown): string {
  const wrapped = answer as WrappedJson;
  const { period } = wrapped;
  // "2026", "2026-03" or "the last 12 months", in the title and the song's line.
  const time = period.kind === 'last-12-months' ? 'the last 12 months' : period.key;
  const lines = [`${time.charAt(0).toUpperCase()}${time.slice(1)} in music (${period.from} to ${period.to})`];
  if (wrapped.plays === 0) return [...lines, 'Nothing was played in this time'].join('\n');
  // Each count with its word in the singular or the plural, as it reads.
  const many = (count: number, one: string, more: string) => `${count} ${count === 1 ? one : more}`;
  lines.push(
    [
      many(wrapped.plays, 'play', 'plays'),
      listened(wrapped.playedMs),
      many(wrapped.tracks, 'track', 'tracks'),
      many(wrapped.people, 'person', 'people'),
      `music on ${many(wrapped.days, 'day', 'days')}`,
    ].join(' · '),
  );
  if (wrapped.song) {
    const song = wrapped.song;
    // "played on 1 day, once" for a song of a quiet month, as people say it.
    const days = song.days === 1 ? '1 day' : `${song.days} days`;
    const times = song.plays === 1 ? 'once' : `${song.plays} times`;
    lines.push(`Song of ${time}: ${song.track.title} (played on ${days}, ${times})`);
  }
  lines.push('Most played:');
  for (const entry of wrapped.topTracks) lines.push(`  ${String(entry.plays).padStart(4)}  ${entry.track.title}`);
  lines.push('Added most:');
  for (const entry of wrapped.topPeople)
    lines.push(`  ${String(entry.plays).padStart(4)}  ${entry.name ?? 'the host'}`);
  // The busiest day of the week and hour of the day: the first of the most, as the panel shows them.
  const weekday = wrapped.weekdays.indexOf(Math.max(...wrapped.weekdays));
  const hour = wrapped.hours.indexOf(Math.max(...wrapped.hours));
  const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  lines.push(`Busiest: ${names[weekday]}, ${hour}:00-${hour + 1}:00`);
  if (wrapped.longestDay) {
    const day = wrapped.longestDay;
    lines.push(
      `Longest day: ${day.day}, ${listened(day.playedMs)} (${day.plays === 1 ? '1 play' : `${day.plays} plays`})`,
    );
  }
  if (wrapped.firstTrack) {
    const first = wrapped.firstTrack;
    const by = first.addedByName ? `, added by ${first.addedByName}` : '';
    lines.push(`First track: ${new Date(first.playedAt).toLocaleString()}, ${first.track.title}${by}`);
  }
  // The history no longer reaches the time's start: from when it does.
  if (wrapped.keptFrom) lines.push(`The history goes back to ${wrapped.keptFrom}`);
  return lines.join('\n');
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
  skip: {
    name: 'skip',
    usage: '',
    summary: 'Skip to the next track (a vote, without the DJ role where votes are on)',
    request: () => ({}),
    show: (answer) => {
      // A vote the track did not go by: how it stands. Otherwise the next track.
      const votes = (answer as { votes: { votes: number; needed: number } | null }).votes;
      return votes ? `Voted to skip: ${votes.votes} of ${votes.needed}` : showPlayer(answer);
    },
  },
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
    request: async (words, lookups) => {
      const item = await lookups.queueItemId(number(words.args[0], 'the number'));
      const to = number(words.args[1], 'the new number');
      // Past the end, said in the numbers typed: the API counts places from 0 ("position 8 is outside the queue").
      const size = await lookups.queueSize();
      if (to > size) throw new UsageError(`there is no number ${to} in the queue (it has ${size})`);
      return { params: { item }, body: { index: to - 1 } };
    },
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
      const lines = [
        `The last ${stats.span} days: ${stats.plays} plays, ${hoursMinutes(stats.playedMs)}, ${stats.tracks} tracks`,
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
    request: (words) => ({
      body: words.args[0]
        ? { channelId: discordId(words.args[0], 'say a voice channel ID (see jukecord channels)') }
        : {},
    }),
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
    summary: "The server's DJ role, roles and settings",
    request: () => ({}),
    show: showSettings,
  },
  'dj-role': {
    name: 'dj',
    usage: '<role ID|none>',
    summary: 'Who may change the music (none: everyone)',
    request: (words) => {
      const role = words.args[0];
      const what = 'say a role ID (see jukecord settings) or none';
      if (!role) throw new UsageError(what);
      return { body: { roleId: role === 'none' ? null : discordId(role, what) } };
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
      // Past a day, days and hours ("9 d 0 h"); a clock's hours ran to "216:00:00".
      const day = 86_400_000;
      const up =
        status.uptimeMs >= day
          ? `${Math.floor(status.uptimeMs / day)} d ${Math.floor((status.uptimeMs % day) / 3_600_000)} h`
          : formatDuration(status.uptimeMs);
      return `jukecord ${status.version}\nDiscord: ${discord}\nUp for ${up}`;
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
    usage: '[--scope read|control]',
    summary: 'A one-time login link (10 minutes): the host, or a friend who may view or control',
    request: (words) => {
      const scope = words.flags.get('scope');
      if (scope === undefined) return {};
      if (scope !== 'read' && scope !== 'control' && scope !== 'admin')
        throw new UsageError('--scope read, control or admin');
      return { query: { scope } };
    },
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
  wrapped: {
    name: 'wrapped',
    usage: '[--year 2026] [--month 3] [--last]',
    summary: 'A year in music (a month, or --last: 12 months)',
    // The time zone of this machine, so "this year" and the days are the ones here.
    request: (words) => ({ query: { ...wrappedPeriod(words), tz: -new Date().getTimezoneOffset() } }),
    show: showWrapped,
  },

  'alerts-channel': {
    name: 'alerts',
    usage: '<channel ID|none>',
    summary: 'Where jukecord tells this server about trouble (none: nowhere)',
    request: (words) => {
      const channel = words.args[0];
      const what = 'say a channel ID (see jukecord settings) or none';
      if (!channel) throw new UsageError(what);
      return { body: { channelId: channel === 'none' ? null : discordId(channel, what) } };
    },
    show: showSettings,
  },

  lyrics: {
    name: 'lyrics',
    usage: '[--synced]',
    summary: 'The lyrics of the track playing (--synced: with their times)',
    request: () => ({}),
    show: (answer, words) => {
      const lyrics = answer as {
        kind: string;
        lines: { atMs: number; text: string }[];
        text: string | null;
        source: { name: string; url: string } | null;
      };
      if (lyrics.kind === 'none') return 'No lyrics found for this track';
      if (lyrics.kind === 'instrumental') return `Instrumental (${lyrics.source?.name ?? 'LRCLIB'})`;
      // With --synced, each line after its time ("[1:02] words"); a pause is its time alone.
      const body =
        words?.flags.has('synced') && lyrics.lines.length > 0
          ? lyrics.lines.map((line) => `[${formatDuration(line.atMs)}] ${line.text}`.trimEnd()).join('\n')
          : (lyrics.text ?? '');
      return `${body}\n\nLyrics from ${lyrics.source?.name ?? 'LRCLIB'} (${lyrics.source?.url ?? 'https://lrclib.net'})`;
    },
  },
  // Also typed "jukecord stop --after-track", which main.ts turns into this.
  'stop-after': {
    name: 'stop-after',
    usage: '[on|off]',
    summary: 'Stop when this track ends (off: play on after it)',
    request: (words) => {
      const choice = words.args[0] ?? 'on';
      if (choice !== 'on' && choice !== 'off') throw new UsageError('stop-after on or off');
      return { body: { on: choice === 'on' } };
    },
    show: (answer) =>
      (answer as PlayerJson & { stopAfter?: boolean }).stopAfter
        ? 'Stops after this track'
        : 'Plays on after this track',
  },
  'listen-links': {
    name: 'shares',
    usage: '',
    summary: "The server's listening links that still work",
    request: () => ({}),
    show: (answer) => {
      const links = answer as {
        id: number;
        createdByName: string | null;
        createdBy: string | null;
        expiresAt: number;
        guests: number;
        maxGuests: number;
      }[];
      if (links.length === 0) return 'No listening links';
      return links
        .map(
          (link) =>
            `${link.id}  until ${new Date(link.expiresAt).toLocaleString()}, ${link.guests} of ${link.maxGuests} guests, made by ${link.createdBy ? (link.createdByName ?? link.createdBy) : 'the host'}`,
        )
        .join('\n');
    },
  },
  'listen-link-create': {
    name: 'share',
    usage: '[--days 1|7|30]',
    summary: 'A link to listen along without a Discord account (shown once)',
    request: (words) => {
      const days = option(words, 'days', 7);
      if (days !== 1 && days !== 7 && days !== 30) throw new UsageError('--days 1, 7 or 30');
      return { body: { days } };
    },
    show: (answer) => {
      const created = answer as { url: string; link: { id: number; expiresAt: number; maxGuests: number } };
      return `${created.url}\n(link ${created.link.id}, until ${new Date(created.link.expiresAt).toLocaleString()}, up to ${created.link.maxGuests} guests; it is not shown again)`;
    },
  },
  'listen-link-revoke': {
    name: 'unshare',
    usage: '<link ID>',
    summary: 'Revoke a listening link (its guests are out at once)',
    request: (words) => ({ params: { id: number(words.args[0], 'the link ID (see jukecord shares)') } }),
    show: showOk,
  },

  stay: {
    name: 'stay',
    usage: '<on|off>',
    summary: 'Stay in voice when everyone has left',
    request: (words) => ({ body: { on: onOff(words.args[0]) } }),
    show: (answer) =>
      (answer as { stay: boolean }).stay
        ? 'Stays in voice when everyone has left'
        : 'Leaves voice after the time alone the host set',
  },
  'vote-skip': {
    name: 'voteskip',
    usage: '<on|off>',
    summary: 'Whether Skip without the DJ role is a vote',
    request: (words) => ({ body: { on: onOff(words.args[0]) } }),
    show: (answer) =>
      (answer as { voteSkip: boolean }).voteSkip
        ? 'Skip from someone without the DJ role is a vote'
        : 'Skip needs the DJ role',
  },
  'take-turns': {
    name: 'turns',
    usage: '<on|off>',
    summary: 'Take turns: tracks added go in turn',
    request: (words) => ({ body: { on: onOff(words.args[0]) } }),
    show: (answer) =>
      (answer as { takeTurns: boolean }).takeTurns
        ? "Tracks added go in their person's turn"
        : 'Tracks added go at the end',
  },
  'turns-now': {
    name: 'turns now',
    usage: '',
    summary: 'Put the queue in turns, once',
    request: () => ({}),
    show: (answer) => {
      const moved = (answer as { moved: number }).moved;
      return moved === 0 ? 'The queue takes turns already' : `Moved ${moved} ${moved === 1 ? 'track' : 'tracks'}`;
    },
  },
  'person-limit': {
    name: 'limit',
    usage: '<tracks, 0 for none>',
    summary: 'The most tracks one person may have queued',
    request: (words) => {
      const text = words.args[0];
      // The most the API takes, said here rather than as its field's range ("tracks is 0 to 1000") after asking.
      if (!text || !/^\d+$/.test(text) || Number(text) > PERSON_LIMIT_MAX)
        throw new UsageError(`say how many tracks, 0 to ${PERSON_LIMIT_MAX} (0 for no limit)`);
      return { body: { tracks: Number(text) } };
    },
    show: (answer) => {
      const limit = (answer as { personLimit: number }).personLimit;
      return limit === 0 ? 'No limit of tracks per person' : `Each person may have ${limit} tracks in the queue`;
    },
  },
  volume: {
    name: 'volume',
    usage: '<0-200>',
    summary: "The voice channel's volume, in percent",
    request: (words) => {
      const text = words.args[0];
      if (!text || !/^\d+$/.test(text) || Number(text) > 200) throw new UsageError('say a volume from 0 to 200');
      return { body: { percent: Number(text) } };
    },
    show: showSound,
  },
  sound: {
    name: 'sound',
    usage: '<off|bass|voices|bright|night>',
    summary: "The voice channel's sound, in browsers too",
    request: (words) => {
      const preset = words.args[0];
      if (!preset || !(preset in PRESET_NAMES)) throw new UsageError('sound off, bass, voices, bright or night');
      return { body: { preset } };
    },
    show: showSound,
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

  'playlist-export': {
    name: 'playlist export',
    usage: '<name> [--format text|m3u|json]',
    summary: 'A saved playlist as a file, printed (redirect it into one)',
    request: (words) => {
      const format = words.flags.get('format') ?? 'text';
      if (format !== 'text' && format !== 'm3u' && format !== 'json')
        throw new UsageError('--format text, m3u or json');
      return { params: { name: rest(words, 'which playlist') }, query: { format } };
    },
    // The file as it is, so `> name.m3u` makes the file.
    show: (answer) => (answer as { content: string }).content.replace(/\n$/, ''),
  },
  'playlist-import': {
    name: 'playlist import',
    usage: '<name> <file> (quote a spaced name; - reads the file from the standard input)',
    summary: 'Make a playlist from a file: addresses, M3U or jukecord JSON',
    request: (words) => {
      const [name, file] = words.args;
      if (!name || !file) throw new UsageError('say the new playlist name and the file');
      return { body: { name, content: readImport(file) } };
    },
    show: (answer) => {
      const result = answer as { playlist: { name: string }; tracks: number; leftOut: number };
      const left = result.leftOut > 0 ? `, ${result.leftOut} left out` : '';
      return `Imported ${result.playlist.name}: ${result.tracks} tracks${left}`;
    },
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
