/**
 * What each API operation does: read its input, call the action, shape the answer.
 *
 * Handlers hold no rules of their own. Who may call an operation is decided before the handler runs (by its access
 * in src/web/api.ts and, for a server, by Access); what is allowed in a server is decided inside the action. That is
 * what makes the API do exactly what the panel, the slash commands and the CLI do.
 */
import type { Static, TSchema } from 'typebox';
import type { Access } from '../app/access.ts';
import { type ActionContext, ActionError, type Actions, type Directory, type SettingsView } from '../app/actions.ts';
import { KEEP_BACKUPS, makeBackup } from '../app/backups.ts';
import type { DoctorReport } from '../app/doctor.ts';
import type { LoginChecks } from '../auth/check.ts';
import type { AuthSettings } from '../auth/settings.ts';
import { LYRICS_SOURCE } from '../media/lyrics.ts';
import { searchWords } from '../media/search.ts';
import type { HostSettingsPort, HostSettingsView, SettingState } from '../settings/service.ts';
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
  /** How many backups stay in the folder (JUKECORD_BACKUP_KEEP; seven by default). */
  readonly backupKeep?: number;
  /** The settings of logging in through the host's identity provider and directory (who gets which level). */
  readonly loginSettings?: AuthSettings;
  /** Tests of those settings, as they are or with values not saved yet (null: no test can run here). */
  readonly loginChecks?: LoginChecks | null;
  /** The host's settings (src/settings): seen, changed, put back, and the restart; absent where they are not kept. */
  readonly settings?: HostSettingsPort;
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

// Backups are made and pruned in app/backups.ts (the scheduled ones too). Each is a whole copy of the database, so
// without a limit they would fill the volume (the front door copies each one out, and Kubernetes users keep theirs
// there).

const OK = { ok: true as const };

/** Every operation's handler; a missing one fails the type check. */
export const HANDLERS: { readonly [K in OperationName]: Handler<(typeof API)[K]> } = {
  'now-playing': ({ context, deps }) => deps.presenter.player(deps.actions.nowPlaying(context)),
  'play-now': async ({ context, body, deps }) => {
    const result = await deps.actions.playNow(context, body.input);
    return { ...result, items: await deps.presenter.items(result.items) };
  },
  skip: async ({ context, query, deps }) => {
    const { snapshot, votes } = await deps.actions.skip(context, query.track);
    return { ...(await deps.presenter.player(snapshot)), votes };
  },
  'remove-current': async ({ context, deps }) => deps.presenter.player(await deps.actions.removeCurrent(context)),
  pause: async ({ context, deps }) => deps.presenter.player(await deps.actions.pause(context)),
  resume: async ({ context, deps }) => deps.presenter.player(await deps.actions.resume(context)),
  seek: async ({ context, body, deps }) => deps.presenter.player(await deps.actions.seek(context, body.positionMs)),
  repeat: async ({ context, body, deps }) => deps.presenter.player(await deps.actions.repeat(context, body.mode)),
  stop: async ({ context, deps }) => deps.presenter.player(await deps.actions.stop(context)),

  queue: async ({ context, deps }) => deps.presenter.queue(await deps.actions.queue(context)),
  add: async ({ context, body, deps }) => {
    const result = await deps.actions.add(context, body.input, body.at ?? 'end');
    return { ...result, items: await deps.presenter.items(result.items) };
  },
  clear: async ({ context, deps }) => ({ removed: await deps.actions.clear(context) }),
  remove: async ({ context, params, deps }) => {
    await deps.actions.remove(context, params.item);
    return OK;
  },
  move: async ({ context, params, body, deps }) => {
    await deps.actions.move(context, params.item, body.index);
    return OK;
  },
  jump: async ({ context, params, deps }) => deps.presenter.player(await deps.actions.jump(context, params.item)),
  shuffle: async ({ context, deps }) => {
    await deps.actions.shuffle(context);
    return OK;
  },
  dedupe: async ({ context, deps }) => ({ removed: await deps.actions.dedupe(context) }),

  history: async ({ context, query, deps }) =>
    deps.presenter.history(await deps.actions.history(context, query.limit ?? 50, query.before)),
  stats: async ({ context, query, deps }) =>
    deps.presenter.stats(await deps.actions.stats(context, query.days ?? 30, query.tz ?? 0)),

  playlists: async ({ context, deps }) =>
    (await deps.actions.playlists(context)).map((playlist) => deps.presenter.playlist(playlist)),
  'playlist-save': async ({ context, body, deps }) =>
    deps.presenter.playlist(await deps.actions.playlistSave(context, body.name)),
  'playlist-load': async ({ context, params, body, deps }) => {
    const result = await deps.actions.playlistLoad(context, params.name, body.at ?? 'end');
    return { ...result, items: await deps.presenter.items(result.items) };
  },
  'playlist-rename': async ({ context, params, body, deps }) =>
    deps.presenter.playlist(await deps.actions.playlistRename(context, params.name, body.name)),
  'playlist-delete': async ({ context, params, deps }) => {
    await deps.actions.playlistDelete(context, params.name);
    return OK;
  },

  'voice-channels': ({ context, deps }) => deps.actions.voiceChannels(context),
  join: async ({ context, body, deps }) => {
    await deps.actions.join(context, body.channelId ?? null);
    return deps.actions.voiceChannels(context);
  },
  leave: async ({ context, deps }) => {
    await deps.actions.leave(context);
    return deps.actions.voiceChannels(context);
  },

  settings: async ({ context, deps }) => settingsAnswer(await deps.actions.settings(context)),
  'dj-role': async ({ context, body, deps }) => settingsAnswer(await deps.actions.djRole(context, body.roleId)),
  status: ({ deps }) => {
    const status = deps.actions.status();
    return {
      version: status.version,
      discord: status.discord,
      mode: deps.discordMode ? ('discord' as const) : ('browser-only' as const),
      uptimeMs: Math.max(0, Math.round(status.uptimeMs)),
      login: { discord: deps.auth.discordLogin },
      lyrics: status.lyrics,
      // Which kind of database, never where it is or who logs in to it.
      database: deps.store.backend,
    };
  },

  me: async ({ caller, deps }) => {
    const { principal, scope, csrf } = who(caller);
    const bot = deps.directory()?.self() ?? null;
    const none = { guest: null, member: null };
    if (principal.kind === 'host')
      return { kind: 'host' as const, id: null, name: 'Host', avatar: null, scope, csrf, bot, ...none };
    // A friend and a guest have no name of their own (the panel says which they are in the person's language).
    if (principal.kind === 'friend')
      return { kind: 'friend' as const, id: null, name: 'Friend', avatar: null, scope, csrf, bot, ...none };
    if (principal.kind === 'guest') {
      return {
        kind: 'guest' as const,
        id: null,
        name: 'Guest',
        avatar: null,
        scope,
        csrf,
        bot,
        guest: { guildId: principal.guildId, expiresAt: principal.expiresAt },
        member: null,
      };
    }
    // A member is named by what their provider said at their last login (kept with their key in the users table).
    if (principal.kind === 'member') {
      const person = await deps.store.users.get(principal.memberId);
      return {
        kind: 'member' as const,
        id: principal.memberId,
        name: person?.name ?? principal.memberId,
        avatar: null,
        scope,
        csrf,
        bot,
        guest: null,
        member: { provider: principal.provider, level: principal.level },
      };
    }
    const person = await deps.store.users.get(principal.userId);
    return {
      kind: 'user' as const,
      id: principal.userId,
      name: person?.name ?? principal.userId,
      avatar: person?.avatar ?? null,
      scope,
      csrf,
      bot,
      guest: null,
      // A Discord user who logged in through OIDC: the level their groups gave them, too.
      member: principal.level ? { provider: 'oidc' as const, level: principal.level } : null,
    };
  },
  guilds: async ({ caller, deps }) => (await deps.access.guilds(who(caller).principal)).map((guild) => ({ ...guild })),
  tokens: ({ caller, deps }) => deps.auth.listTokens(who(caller)),
  'token-create': async ({ caller, body, deps }) => {
    try {
      return await deps.auth.createToken(who(caller), body.name, body.scope);
    } catch (error) {
      throw new ActionError('forbidden', error instanceof Error ? error.message : String(error));
    }
  },
  'token-revoke': async ({ caller, params, deps }) => {
    if (!(await deps.auth.revokeToken(who(caller), params.id)))
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
  'login-link': async ({ query, deps }) => {
    const scope = query.scope ?? 'admin';
    const link = await deps.auth.createLink(scope);
    return { url: `${deps.publicUrl}/auth/link/${link.code}`, expiresAt: link.expiresAt, scope };
  },
  backup: async ({ deps }) => {
    // Named by the time, so backups sort and none replaces another; the newest JUKECORD_BACKUP_KEEP stay. Written
    // beside the main thread, which goes on answering meanwhile.
    const made = await makeBackup(deps.store, deps.backupDir, deps.backupKeep ?? KEEP_BACKUPS);
    return { file: made.file, bytes: made.bytes };
  },
  doctor: async ({ deps }) => {
    const report = await deps.doctor();
    return { ok: report.ok, checks: report.checks.map((check) => ({ ...check })), settings: { ...report.settings } };
  },
  // The login page's ways in: Discord, the identity provider and the directory, each when it is set up.
  'auth-methods': ({ deps }) => ({
    discord: deps.auth.discordLogin,
    sso: deps.auth.oidc ? { label: deps.auth.oidc.label } : null,
    directory: deps.auth.ldap ? { label: deps.auth.ldap.label } : null,
  }),
  'auth-test-oidc': async ({ body, deps }) => {
    const checks = deps.loginChecks;
    if (!checks) throw new ActionError('unavailable', 'the login settings cannot be tested here');
    const answer = await checks.oidc(body.settings ?? {});
    return { ok: answer.ok, checks: answer.checks.map((check) => ({ ...check })) };
  },
  'auth-test-ldap': async ({ body, deps }) => {
    const checks = deps.loginChecks;
    if (!checks) throw new ActionError('unavailable', 'the login settings cannot be tested here');
    const answer = await checks.ldap(body.username, body.settings ?? {});
    return {
      ok: answer.ok,
      checks: answer.checks.map((check) => ({ ...check })),
      groups: answer.groups ? [...answer.groups] : null,
      level: answer.level,
    };
  },

  // The host's settings: each handler hands its request to the settings service (src/settings/service.ts), which a
  // split jukecord's edge carries to its core as it carries the actions.
  'host-settings': async ({ deps }) => plainView(await hostSettings(deps).view()),
  'host-setting': async ({ params, deps }) => {
    const found = (await hostSettings(deps).view()).settings.find((setting) => setting.name === params.name);
    if (!found) throw new ActionError('not-found', `${params.name} is not a jukecord setting`);
    return plainSetting(found);
  },
  'host-settings-change': async ({ body, deps }) => {
    const { changed, view } = await hostSettings(deps).change(body.values, body.revisions);
    return { changed: changed.map((entry) => ({ ...entry })), view: plainView(view) };
  },
  'host-setting-reset': async ({ params, query, deps }) => {
    const revisions = query.revision === undefined ? undefined : { [params.name]: query.revision };
    const { changed, view } = await hostSettings(deps).reset([params.name], revisions);
    return { changed: changed.map((entry) => ({ ...entry })), view: plainView(view) };
  },
  'settings-test-database': async ({ body, deps }) => ({ ...(await hostSettings(deps).testDatabase(body.url)) }),
  'database-move': async ({ body, deps }) => ({
    ...(await hostSettings(deps).startMove(body.url, body.replace ?? false)),
  }),
  'database-move-status': ({ deps }) => plainMove(hostSettings(deps).moveState()),
  'database-move-switch': ({ deps }) => {
    const settings = hostSettings(deps);
    const { restarts } = settings.switchMove();
    return { supervisor: settings.supervisor, restarts };
  },
  'database-move-cancel': async ({ deps }) => {
    await hostSettings(deps).cancelMove();
    return OK;
  },
  restart: ({ deps }) => ({ ...hostSettings(deps).restartNow(), restarts: true }),

  wrapped: async ({ context, query, deps }) =>
    deps.presenter.wrapped(await deps.actions.wrapped(context, query.period, query.tz ?? 0)),
  'alerts-channel': async ({ context, body, deps }) =>
    settingsAnswer(await deps.actions.alertsChannel(context, body.channelId)),
  lyrics: async ({ context, deps }) => {
    const lyrics = await deps.actions.lyrics(context);
    return {
      trackId: lyrics.trackId,
      kind: lyrics.kind,
      lines: lyrics.lines.map((line) => ({ ...line })),
      text: lyrics.text,
      // Credited wherever they are shown; "none found" has nothing to credit.
      source: lyrics.kind === 'none' ? null : { ...LYRICS_SOURCE },
    };
  },
  'stop-after': async ({ context, body, deps }) =>
    deps.presenter.player(await deps.actions.stopAfter(context, body.on)),
  'listen-links': async ({ context, deps }) => deps.presenter.listenLinks(await deps.actions.listenLinks(context)),
  'listen-link-create': async ({ context, body, deps }) => {
    const { code, link } = await deps.actions.listenLinkCreate(context, body.days);
    const [shown] = await deps.presenter.listenLinks([link]);
    if (!shown) throw new Error('the listening link just made cannot be shown');
    // The code after a "#": the browser keeps it to itself, so no log or proxy on the way sees it.
    return { url: `${deps.publicUrl}/listen#${code}`, link: shown };
  },
  'listen-link-revoke': async ({ context, params, deps }) => {
    await deps.actions.listenLinkRevoke(context, params.id);
    return OK;
  },

  stay: async ({ context, body, deps }) => settingsAnswer(await deps.actions.stay(context, body.on)),
  'vote-skip': async ({ context, body, deps }) => settingsAnswer(await deps.actions.voteSkip(context, body.on)),
  'take-turns': async ({ context, body, deps }) => settingsAnswer(await deps.actions.takeTurns(context, body.on)),
  'turns-now': async ({ context, deps }) => ({ moved: await deps.actions.turnsNow(context) }),
  'person-limit': async ({ context, body, deps }) =>
    settingsAnswer(await deps.actions.personLimit(context, body.tracks)),
  volume: async ({ context, body, deps }) => ({ ...(await deps.actions.volume(context, body.percent)) }),
  sound: async ({ context, body, deps }) => ({ ...(await deps.actions.sound(context, body.preset)) }),

  likes: async ({ context, deps }) => (await deps.actions.likes(context)).map((entry) => deps.presenter.liked(entry)),
  like: async ({ context, params, deps }) => deps.presenter.liked(await deps.actions.like(context, params.track)),
  unlike: async ({ context, params, deps }) => {
    await deps.actions.unlike(context, params.track);
    return OK;
  },
  'likes-add': async ({ context, body, deps }) => {
    const result = await deps.actions.likesAdd(context, body.at ?? 'end');
    return { ...result, items: await deps.presenter.items(result.items) };
  },

  autoplay: async ({ context, body, deps }) => deps.presenter.player(await deps.actions.autoplay(context, body.mode)),

  'playlist-export': async ({ context, params, query, deps }) => ({
    ...(await deps.actions.playlistExport(context, params.name, query.format ?? 'text')),
  }),
  'playlist-import': async ({ context, body, deps, signal }) => {
    const result = await deps.actions.playlistImport(context, body.name, body.content, signal);
    return { playlist: deps.presenter.playlist(result.playlist), tracks: result.tracks, leftOut: result.leftOut };
  },

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

// The settings service, where the host's settings are kept (absent: jukecord was made without them, as some tests are).
function hostSettings(deps: HandlerDeps): HostSettingsPort {
  if (!deps.settings) throw new ActionError('unavailable', 'the settings cannot be changed here');
  return deps.settings;
}

// A setting as the API sends it (the schema's lists are mutable).
function plainSetting(setting: SettingState) {
  return {
    ...setting,
    choices: setting.choices ? [...setting.choices] : null,
    words: setting.words ? [...setting.words] : null,
    roles: [...setting.roles],
  };
}

// The settings page's view as the API sends it.
function plainView(view: HostSettingsView) {
  return {
    ...view,
    groups: view.groups.map((group) => ({
      id: group.id,
      label: group.label,
      ...(group.parts ? { parts: group.parts.map((part) => ({ ...part })) } : {}),
    })),
    settings: view.settings.map(plainSetting),
    restart: { ...view.restart, pending: [...view.restart.pending] },
    strays: [...view.strays],
    move: plainMove(view.move),
  };
}

// The move's state as the API sends it.
function plainMove(move: HostSettingsView['move']) {
  return {
    state: move.state ? { ...move.state } : null,
    lastFailure: move.lastFailure ? { ...move.lastFailure } : null,
  };
}

// A server's settings as the API sends them: every setting (the DJ role, the alerts channel, how people share the
// music and how the voice channel sounds), with the lists as arrays of their own (the schema's arrays are mutable).
function settingsAnswer(view: SettingsView) {
  return { ...view, roles: [...view.roles], channels: [...view.channels] };
}
