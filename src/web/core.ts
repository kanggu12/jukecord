/**
 * What the web layer asks of jukecord's core: the actions, the access rules, and a few facts and host jobs.
 *
 * In one process these are the core's own objects (Actions, Access) and the answer of a method may come at once. In
 * an edge (roles/edge.ts) every one of them is a command to the core over the bus, which answers later. The types
 * here are what both satisfy, so the API's handlers, the live updates and the routes are written once: each call is
 * awaited, which costs one process nothing it can notice. They are worked out from Actions and Access themselves, so
 * a new argument or answer of an action is the edge's at once.
 */
import type { Access } from '../app/access.ts';
import type { Actions, Directory } from '../app/actions.ts';
import type { LogLine, LogQuery } from './logs.ts';

/** The actions the web layer calls: every API operation's, the live updates' reads, and the search results' covers. */
export const WEB_ACTIONS = [
  'nowPlaying',
  'playNow',
  'skip',
  'removeCurrent',
  'pause',
  'resume',
  'seek',
  'repeat',
  'stop',
  'queue',
  'add',
  'clear',
  'remove',
  'move',
  'jump',
  'shuffle',
  'dedupe',
  'history',
  'stats',
  'playlists',
  'playlistSave',
  'playlistLoad',
  'playlistRename',
  'playlistDelete',
  'voiceChannels',
  'join',
  'leave',
  'settings',
  'djRole',
  'status',
  'wrapped',
  'alertsChannel',
  'lyrics',
  'stopAfter',
  'listenLinks',
  'listenLinkCreate',
  'listenLinkRevoke',
  'stay',
  'voteSkip',
  'takeTurns',
  'turnsNow',
  'personLimit',
  'volume',
  'sound',
  'likes',
  'like',
  'unlike',
  'likesAdd',
  'autoplay',
  'playlistExport',
  'playlistImport',
  'search',
  'searched',
  'skipVotes',
  'skipVoters',
  'currentSound',
] as const satisfies readonly (keyof Actions)[];

export type WebAction = (typeof WEB_ACTIONS)[number];

/** A value now, or a promise of it. */
export type Later<T> = T | Promise<T>;

// A method as the web layer meets it: the same arguments, the same answer, now or later.
type NowOrLater<F> = F extends (...args: infer A) => infer R ? (...args: A) => Later<Awaited<R>> : never;

/** What the web layer asks of the actions: Actions in one process, the core over the bus in an edge. */
export type ActionsPort = { readonly [K in WebAction]: NowOrLater<Actions[K]> };

/** What the web layer asks of the access rules: Access in one process, the core's over the bus in an edge. */
export interface AccessPort {
  context: Access['context'];
  guilds: Access['guilds'];
  /** Forgets what is remembered about a person's membership (logging in and out); an edge tells the core. */
  forget(userId?: string): void;
}

/** What the handlers learn of Discord without asking: the bot's own account, for the panel's header. */
export type BotAccount = Pick<Directory, 'self'>;

/**
 * The host's jobs that belong to the core's data folder, done there for an edge (which has no folder that lasts): a
 * backup of the database into the backups folder, and the log of the part of jukecord that plays the music.
 */
export interface HostJobs {
  backup(): Promise<{ readonly file: string; readonly bytes: number }>;
  logs(query: LogQuery): Later<LogLine[]>;
}
