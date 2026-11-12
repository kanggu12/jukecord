/**
 * What each API operation does: read its input, call the action, shape the answer.
 *
 * Handlers hold no rules of their own. Who may call an operation is decided before the handler runs (by its access
 * in src/web/api.ts and, for a server, by Access); what is allowed in a server is decided inside the action. That is
 * what makes the API do exactly what the panel, the slash commands and the CLI do.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Static, TSchema } from 'typebox';
import type { Access } from '../app/access.ts';
import { type ActionContext, ActionError, type Actions, type Directory } from '../app/actions.ts';
import type { DoctorReport } from '../app/doctor.ts';
import { searchWords } from '../media/search.ts';
import type { Store } from '../store/store.ts';
import type { API, OperationName, OperationSpec } from './api.ts';
import type { Auth, Caller } from './auth.ts';
import { readLogs } from './logs.ts';
import type { Presenter } from './present.ts';

/** What handlers reach for. */
export interface HandlerDeps {
  readonly actions: Actions;
  readonly access: Access;
  readonly auth: Auth;
  readonly store: Store;
  readonly presenter: Presenter;
  readonly directory: () => Directory | null;
  /** The address people open the panel at, for login links. */
  readonly publicUrl: string;
  readonly logDir: string;
  readonly logFiles: number;
  readonly backupDir: string;
  readonly doctor: () => Promise<DoctorReport>;
  /** Whether the Discord bot is set up at all (browser-only mode otherwise). */
  readonly discordMode: boolean;
}

// The parts of a request, typed from the operation's schemas.
type Part<S, K extends 'params' | 'query' | 'body'> = S extends { readonly [P in K]: infer T extends TSchema }
  ? Static<T>
  : Record<string, never>;

/** A handler's input: the request's parts, the caller, and the server context for operations on a server. */
export interface HandlerInput<S extends OperationSpec> {
  readonly params: Part<S, 'params'>;
  readonly query: Part<S, 'query'>;
  readonly body: Part<S, 'body'>;
  /** Null only for public operations called without a login. */
  readonly caller: Caller | null;
  /** What the caller may do in the server named in the path; null for operations not on a server. */
  readonly context: Part<S, 'params'> extends { guild: string } ? ActionContext : null;
  readonly deps: HandlerDeps;
  /** Aborted when the caller goes away before the answer (a search for words typed over already). */
  readonly signal: AbortSignal;
}

export type Handler<S extends OperationSpec> = (
  input: HandlerInput<S>,
) => Static<S['response']> | Promise<Static<S['response']>>;

// Operations that need a login get one; this narrows the type where the access rules already guarantee it.
function who(caller: Caller | null): Caller {
  if (!caller) throw new ActionError('forbidden', 'log in first');
  return caller;
}

// How many backups stay in the data folder: a week of daily ones. Each is a whole copy of the database, so without a
// limit they would fill the volume (the front door copies each one out, and Kubernetes users keep theirs there).
export const KEEP_BACKUPS = 7;

/** Removes all but the newest `keep` backups (their names sort by time) from the folder. */
export function pruneBackups(dir: string, keep: number): void {
  const backups = fs
    .readdirSync(dir)
    .filter((name) => /^jukecord-.+\.db$/.test(name))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - keep)))
    fs.rmSync(path.join(dir, name), { force: true });
}

const OK = { ok: true as const };

/** Every operation's handler; a missing one fails the type check. */
export const HANDLERS: { readonly [K in OperationName]: Handler<(typeof API)[K]> } = {
  'now-playing': ({ context, deps }) => deps.presenter.player(deps.actions.nowPlaying(context)),
  'play-now': async ({ context, body, deps }) => {
    const result = await deps.actions.playNow(context, body.input);
    return { ...result, items: deps.presenter.items(result.items) };
  },
  skip: ({ context, deps }) => deps.presenter.player(deps.actions.skip(context)),
  'remove-current': ({ context, deps }) => deps.presenter.player(deps.actions.removeCurrent(context)),
  pause: ({ context, deps }) => deps.presenter.player(deps.actions.pause(context)),
  resume: ({ context, deps }) => deps.presenter.player(deps.actions.resume(context)),
  seek: ({ context, body, deps }) => deps.presenter.player(deps.actions.seek(context, body.positionMs)),
  repeat: ({ context, body, deps }) => deps.presenter.player(deps.actions.repeat(context, body.mode)),
  stop: ({ context, deps }) => deps.presenter.player(deps.actions.stop(context)),

  queue: ({ context, deps }) => deps.presenter.queue(deps.actions.queue(context)),
  add: async ({ context, body, deps }) => {
    const result = await deps.actions.add(context, body.input, body.at ?? 'end');
    return { ...result, items: deps.presenter.items(result.items) };
  },
  clear: ({ context, deps }) => ({ removed: deps.actions.clear(context) }),
  remove: ({ context, params, deps }) => {
    deps.actions.remove(context, params.item);
    return OK;
  },
  move: ({ context, params, body, deps }) => {
    deps.actions.move(context, params.item, body.index);
    return OK;
  },
  jump: ({ context, params, deps }) => deps.presenter.player(deps.actions.jump(context, params.item)),
  shuffle: ({ context, deps }) => {
    deps.actions.shuffle(context);
    return OK;
  },
  dedupe: ({ context, deps }) => ({ removed: deps.actions.dedupe(context) }),

  history: ({ context, query, deps }) =>
    deps.presenter.history(deps.actions.history(context, query.limit ?? 50, query.before)),
  stats: ({ context, query, deps }) =>
    deps.presenter.stats(deps.actions.stats(context, query.days ?? 30, query.tz ?? 0)),

  playlists: ({ context, deps }) =>
    deps.actions.playlists(context).map((playlist) => deps.presenter.playlist(playlist)),
  'playlist-save': ({ context, body, deps }) => deps.presenter.playlist(deps.actions.playlistSave(context, body.name)),
  'playlist-load': ({ context, params, body, deps }) => {
    const result = deps.actions.playlistLoad(context, params.name, body.at ?? 'end');
    return { ...result, items: deps.presenter.items(result.items) };
  },
  'playlist-rename': ({ context, params, body, deps }) =>
    deps.presenter.playlist(deps.actions.playlistRename(context, params.name, body.name)),
  'playlist-delete': ({ context, params, deps }) => {
    deps.actions.playlistDelete(context, params.name);
    return OK;
  },

  'voice-channels': ({ context, deps }) => deps.actions.voiceChannels(context),
  join: async ({ context, body, deps }) => {
    await deps.actions.join(context, body.channelId ?? null);
    return deps.actions.voiceChannels(context);
  },
  leave: ({ context, deps }) => {
    deps.actions.leave(context);
    return deps.actions.voiceChannels(context);
  },

  settings: ({ context, deps }) => {
    const settings = deps.actions.settings(context);
    return { djRoleId: settings.djRoleId, roles: [...settings.roles] };
  },
  'dj-role': ({ context, body, deps }) => {
    const settings = deps.actions.djRole(context, body.roleId);
    return { djRoleId: settings.djRoleId, roles: [...settings.roles] };
  },
  status: ({ deps }) => {
    const status = deps.actions.status();
    return {
      version: status.version,
      discord: status.discord,
      mode: deps.discordMode ? ('discord' as const) : ('browser-only' as const),
      uptimeMs: Math.max(0, Math.round(status.uptimeMs)),
      login: { discord: deps.auth.discordLogin },
    };
  },

  me: ({ caller, deps }) => {
    const { principal, scope, csrf } = who(caller);
    const bot = deps.directory()?.self() ?? null;
    if (principal.kind === 'host')
      return { kind: 'host' as const, id: null, name: 'Host', avatar: null, scope, csrf, bot };
    const person = deps.store.users.get(principal.userId);
    return {
      kind: 'user' as const,
      id: principal.userId,
      name: person?.name ?? principal.userId,
      avatar: person?.avatar ?? null,
      scope,
      csrf,
      bot,
    };
  },
  guilds: async ({ caller, deps }) => (await deps.access.guilds(who(caller).principal)).map((guild) => ({ ...guild })),
  tokens: ({ caller, deps }) => deps.auth.listTokens(who(caller)),
  'token-create': ({ caller, body, deps }) => {
    try {
      return deps.auth.createToken(who(caller), body.name, body.scope);
    } catch (error) {
      throw new ActionError('forbidden', error instanceof Error ? error.message : String(error));
    }
  },
  'token-revoke': ({ caller, params, deps }) => {
    if (!deps.auth.revokeToken(who(caller), params.id))
      throw new ActionError('not-found', 'there is no such token of yours');
    return OK;
  },

  logs: ({ query, deps }) =>
    readLogs(
      deps.logDir,
      {
        limit: query.limit ?? 200,
        ...(query.level ? { level: query.level } : {}),
        ...(query.component ? { component: query.component } : {}),
        ...(query.before ? { before: query.before } : {}),
      },
      deps.logFiles,
    ).map((record) => ({ ...record })),
  'login-link': ({ deps }) => {
    const link = deps.auth.createLink();
    return { url: `${deps.publicUrl}/auth/link/${link.code}`, expiresAt: link.expiresAt };
  },
  backup: ({ deps }) => {
    // One file per backup, named by the time, so backups sort and none replaces another.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(deps.backupDir, `jukecord-${stamp}.db`);
    deps.store.backup(file);
    const bytes = fs.statSync(file).size;
    pruneBackups(deps.backupDir, KEEP_BACKUPS);
    return { file, bytes };
  },
  doctor: async ({ deps }) => {
    const report = await deps.doctor();
    return { ok: report.ok, checks: report.checks.map((check) => ({ ...check })), settings: { ...report.settings } };
  },

  likes: ({ context, deps }) => deps.actions.likes(context).map((entry) => deps.presenter.liked(entry)),
  like: ({ context, params, deps }) => deps.presenter.liked(deps.actions.like(context, params.track)),
  unlike: ({ context, params, deps }) => {
    deps.actions.unlike(context, params.track);
    return OK;
  },
  'likes-add': ({ context, body, deps }) => {
    const result = deps.actions.likesAdd(context, body.at ?? 'end');
    return { ...result, items: deps.presenter.items(result.items) };
  },

  autoplay: ({ context, body, deps }) => deps.presenter.player(deps.actions.autoplay(context, body.mode)),

  search: async ({ context, query, deps, signal }) => ({
    query: searchWords(query.q),
    results: (await deps.actions.search(context, query.q, query.limit ?? 8, signal)).map((found) => ({
      url: found.url,
      title: found.title,
      uploader: found.uploader,
      durationMs: found.durationMs,
      thumbnail: found.thumbnail,
    })),
  }),
};
