/**
 * Who may do what, and in which server: turns a login into the ActionContext the actions take.
 *
 * Four kinds of login exist. The host is the machine running jukecord: its CLI (with the host token from the data
 * directory) and the one-time login links it prints. The host may do everything in every server. A Discord user logs
 * in to the panel with Discord and may act in the servers they are a member of, where the server's DJ role (when one
 * is set) decides who changes the music and Manage Server decides who changes the settings. A friend is a browser the
 * host let in with a login link for view or control: every server the host has, never Manage Server. A guest came in
 * with a listening link: the one server of that link, to look and listen, nothing to change.
 *
 * Membership and roles come from Discord through the bot and are kept for a minute, so a panel that asks every few
 * seconds does not hammer Discord, while a role taken away still stops working within a minute.
 */
import type { SettingsRepository } from '../store/store.ts';
import {
  type ActionContext,
  ActionError,
  type Directory,
  djRoleNow,
  type GuildInfo,
  type MemberInfo,
} from './actions.ts';

/** A login: the host, a Discord user, a friend the host let in, or a guest of a listening link. */
export type Principal =
  | { readonly kind: 'host' }
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'friend'; readonly scope: 'read' | 'control' }
  | {
      readonly kind: 'guest';
      readonly linkId: number;
      /** The one server its link opens. */
      readonly guildId: string;
      /** When its link stops working (and its session with it). */
      readonly expiresAt: number;
    };

/** The logins that are someone of the server's own: everyone but a guest. */
export type MemberPrincipal = Exclude<Principal, { readonly kind: 'guest' }>;

/** The single queue of browser-only mode: without a bot there are no Discord servers, so jukecord keeps one of its own. */
export const LOCAL_GUILD: GuildInfo = { id: 'local', name: 'jukecord', icon: null };

/** A server as a login sees it: the server and what this login may do there. */
export interface GuildAccess extends GuildInfo {
  readonly mayControl: boolean;
  readonly mayManage: boolean;
}

export interface AccessOptions {
  readonly settings: SettingsRepository;
  /** Discord's view of servers and members; returns null in browser-only mode (and before the bot is set up). */
  readonly directory: () => Directory | null;
  readonly now?: () => number;
  /** How long a membership answer is reused (default one minute). */
  readonly ttlMs?: number;
}

// The answer while Discord has not sent the server list yet (the first seconds after a start); panels ask again.
const STILL_CONNECTING = 'jukecord is still connecting to Discord; try again in a moment';
// The answer to a guest asking for any server but its link's: the same whether that server exists or not.
const OTHER_SERVER = 'a listening link opens its own server only';

// What a friend and a guest may do in a server they can open: a friend's view or control, never the settings; a
// guest's look and listen.
function narrowed(principal: Principal): { mayControl: boolean; mayManage: boolean } {
  return { mayControl: principal.kind === 'friend' && principal.scope === 'control', mayManage: false };
}

// One remembered answer about a member (null: not in the server) and when it was asked.
interface Remembered {
  readonly member: MemberInfo | null;
  readonly at: number;
}

export class Access {
  private readonly options: AccessOptions;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly members = new Map<string, Remembered>();
  // Questions on their way to Discord, so ten panel requests at once ask once.
  private readonly asking = new Map<string, Promise<MemberInfo | null>>();
  // When the answers too old to use were last dropped.
  private sweptAt = 0;

  constructor(options: AccessOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /** The servers this login can open, with what it may do in each. */
  async guilds(principal: Principal): Promise<GuildAccess[]> {
    const directory = this.options.directory();
    // Browser-only: the one local queue, which the host reaches, and the friends and guests it let in (there is no
    // Discord login without a bot).
    if (!directory) {
      if (principal.kind === 'host') return [{ ...LOCAL_GUILD, mayControl: true, mayManage: true }];
      if (principal.kind === 'friend') return [{ ...LOCAL_GUILD, ...narrowed(principal) }];
      if (principal.kind === 'guest' && principal.guildId === LOCAL_GUILD.id)
        return [{ ...LOCAL_GUILD, ...narrowed(principal) }];
      return [];
    }
    // Just started: an empty list now would read as "the bot is in no server".
    if (!directory.loaded()) throw new ActionError('unavailable', STILL_CONNECTING);
    const guilds = directory.guilds();
    if (principal.kind === 'host') return guilds.map((guild) => ({ ...guild, mayControl: true, mayManage: true }));
    // A friend: every server the host has, to view or control. A guest: its link's server, while the bot is there.
    if (principal.kind === 'friend') return guilds.map((guild) => ({ ...guild, ...narrowed(principal) }));
    if (principal.kind === 'guest') {
      return guilds
        .filter((guild) => guild.id === principal.guildId)
        .map((guild) => ({ ...guild, ...narrowed(principal) }));
    }
    // A user sees the servers they are in; the questions go out together, not one after another.
    const answers = await Promise.all(
      guilds.map(async (guild) => {
        const member = await this.member(directory, guild.id, principal.userId);
        return member ? { ...guild, ...this.rights(directory, guild.id, member) } : null;
      }),
    );
    return answers.filter((guild): guild is GuildAccess => guild !== null);
  }

  /** What this login may do in a server; refuses a server it cannot open. */
  async context(principal: Principal, guildId: string): Promise<ActionContext> {
    const directory = this.options.directory();
    const userId = principal.kind === 'user' ? principal.userId : null;
    // A guest is answered for any other server before anything is looked up: it learns nothing of what is here.
    if (principal.kind === 'guest' && guildId !== principal.guildId) throw new ActionError('forbidden', OTHER_SERVER);
    if (!directory) {
      // Browser-only mode knows one server: the host's, its friends' and its guests'.
      if (guildId !== LOCAL_GUILD.id) throw new ActionError('not-found', 'there is no such server here');
      if (principal.kind === 'friend' || principal.kind === 'guest') {
        return { guildId, userId: null, ...narrowed(principal) };
      }
      if (principal.kind !== 'host') throw new ActionError('forbidden', 'only the host can use jukecord here');
      return { guildId, userId: null, mayControl: true, mayManage: true };
    }
    if (!directory.loaded()) throw new ActionError('unavailable', STILL_CONNECTING);
    if (!directory.guilds().some((guild) => guild.id === guildId)) {
      throw new ActionError('not-found', 'the bot is not in that server');
    }
    if (principal.kind === 'host') return { guildId, userId: null, mayControl: true, mayManage: true };
    if (principal.kind === 'friend' || principal.kind === 'guest')
      return { guildId, userId: null, ...narrowed(principal) };
    const member = await this.member(directory, guildId, principal.userId);
    if (!member) throw new ActionError('forbidden', 'you are not a member of that server');
    return { guildId, userId, ...this.rights(directory, guildId, member) };
  }

  /** Drops what is remembered about a person (after logging out), or about everyone. */
  forget(userId?: string): void {
    if (userId === undefined) {
      this.members.clear();
      return;
    }
    for (const key of this.members.keys()) if (key.endsWith(`:${userId}`)) this.members.delete(key);
  }

  // The rights a member has: the DJ role (or Manage Server) to change the music, Manage Server for the settings. A DJ
  // role deleted in Discord counts as none (see djRoleNow); the server is one the bot sees here, so its roles are known.
  private rights(
    directory: Directory,
    guildId: string,
    member: MemberInfo,
  ): { mayControl: boolean; mayManage: boolean } {
    const role = djRoleNow(this.options.settings.get(guildId).djRoleId, directory.roles(guildId));
    return { mayControl: role === null || member.roles.includes(role) || member.manage, mayManage: member.manage };
  }

  // Asks Discord (through the bot) whether someone is in a server, reusing an answer younger than the TTL.
  private async member(directory: Directory, guildId: string, userId: string): Promise<MemberInfo | null> {
    const key = `${guildId}:${userId}`;
    const known = this.members.get(key);
    if (known && this.now() - known.at < this.ttlMs) return known.member;
    const pending = this.asking.get(key);
    if (pending) return pending;
    const question = directory
      .member(guildId, userId)
      .then((member) => {
        this.members.set(key, { member, at: this.now() });
        this.sweep();
        return member;
      })
      .catch((error: unknown) => {
        // Discord unreachable: say so, rather than treating the person as a stranger and locking them out.
        throw new ActionError(
          'unavailable',
          `Discord did not answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.asking.delete(key));
    this.asking.set(key, question);
    return question;
  }

  // Drops the answers older than the TTL, at most once per TTL and only when a new answer comes in. An old answer is
  // never used again (the next question asks Discord afresh), so without this the map kept a line for every person who
  // ever opened the panel, in every server, until the next start.
  private sweep(): void {
    const now = this.now();
    if (now - this.sweptAt < this.ttlMs) return;
    this.sweptAt = now;
    for (const [key, known] of this.members) if (now - known.at >= this.ttlMs) this.members.delete(key);
  }
}
