/**
 * Logging in with an account of an LDAP directory (OpenLDAP, FreeIPA) or Active Directory, with ldapts: jukecord's
 * service account finds the person under the base DN with the user filter, their groups come from their memberOf, a
 * group search or Active Directory's nested-group rule, and then the directory itself checks their password, by a
 * bind as that person. jukecord never sees a password again after that bind, and keeps none.
 *
 * What the person types goes into a filter only escaped (RFC 4515), so a name such as `*)(uid=*` finds nobody instead
 * of everybody. An empty password is refused before anything is sent: a directory takes a bind with a name and no
 * password as an anonymous bind (RFC 4513, 5.1.2) and says yes to it.
 */
import type tls from 'node:tls';
import {
  AndFilter,
  ApproximateFilter,
  Client,
  type ClientOptions,
  ConfidentialityRequiredError,
  EqualityFilter,
  type Filter,
  FilterParser,
  InvalidCredentialsError,
  NoSuchObjectError,
  OrFilter,
  ResultCodeError,
  SizeLimitExceededError,
  StrongAuthRequiredError,
} from 'ldapts';
import type { Logger } from '../log.ts';
import { normalDn } from './levels.ts';
import type { Check } from './oidc.ts';
import { type LdapSettings, ldapsUrl } from './settings.ts';

/** Active Directory's rule for "a member of this group, or of a group inside it, at any depth". */
export const IN_CHAIN = '1.2.840.113556.1.4.1941';

// The longest name and password taken: more is no one's, and a directory would refuse it after work.
const NAME_MAX = 256;
const PASSWORD_MAX = 1024;
// The longest display name kept, as for a member who logs in through OIDC.
const DISPLAY_MAX = 64;
// The most groups read for one person: enough for any real directory, a bound on a group search gone wrong.
const GROUPS_MAX = 1000;

/** Who the directory says logged in, and their groups (by DN). */
export interface LdapIdentity {
  /** Their entry's lasting ID (entryUUID, objectGUID, nsUniqueId, ipaUniqueID), or their DN when it has none. */
  readonly subject: string;
  readonly dn: string;
  /** Their display name, from displayName or cn, else the name they typed. */
  readonly name: string;
  readonly groups: readonly string[];
}

/** Why a directory login did not go through, said in the panel's words by its code. */
export class LdapError extends Error {
  override name = 'LdapError';
  /**
   * invalid: an empty name or password (nothing was sent); wrong: no such person, or not their password; expired:
   * their password must be changed first (Active Directory says so); disabled: the account is turned off, expired or
   * locked; ambiguous: the filter found more than one person; unavailable: the directory did not answer, or refused
   * jukecord's own account; blocked: the account found failed too often lately (no password was sent).
   */
  readonly code: 'invalid' | 'wrong' | 'expired' | 'disabled' | 'ambiguous' | 'unavailable' | 'blocked';

  constructor(code: LdapError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** What jukecord asks of a directory connection: the part of ldapts' Client it uses, so tests can stand in for it. */
export interface DirectoryClient {
  startTLS(options?: tls.ConnectionOptions): Promise<void>;
  bind(dn: string, password?: string): Promise<void>;
  search(
    base: string,
    options: {
      scope: 'base' | 'sub';
      filter: string;
      attributes: string[];
      sizeLimit: number;
      explicitBufferAttributes?: string[];
    },
  ): Promise<{ searchEntries: Record<string, unknown>[] }>;
  unbind(): Promise<void>;
}

/** What a login may be asked on its way, between finding the person and sending their password. */
export interface LoginGuard {
  /**
   * The account the name found, by its lasting ID: false holds the try back there (it failed too often, under this
   * name or another of its names), before any password is sent.
   */
  readonly found?: (subject: string) => Promise<boolean>;
}

export interface LdapOptions {
  readonly settings: LdapSettings;
  readonly log: Logger;
  /** Opens a connection (tests pass their own); ldapts' Client by default. */
  readonly connect?: (options: ClientOptions) => DirectoryClient;
}

/**
 * A value escaped for a filter (RFC 4515, 3): the backslash first, then the star, the parentheses and NUL, each as a
 * backslash and two hex digits. What is left is taken by the directory as the value itself.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** A filter with its placeholders filled in, each value escaped: `{username}` and, for groups, `{dn}`. */
export function fillFilter(template: string, values: { username: string; dn?: string }): string {
  // split and join, not replace: a "$&" in a value would be read by replace as a pattern of its own.
  let filter = template.split('{username}').join(escapeFilterValue(values.username));
  if (values.dn !== undefined) filter = filter.split('{dn}').join(escapeFilterValue(values.dn));
  return filter;
}

/**
 * A name as directories compare names (RFC 4518's string preparation, near enough): what LDAP maps to nothing taken
 * out (a soft hyphen, a zero-width space, the other format and control characters), every other space a plain one,
 * compatibility forms folded (fullwidth, circled and mathematical letters are the letters: NFKC), case set aside both
 * ways (so "ß" is "ss", as "SS" is), and the spaces at the ends dropped and those inside counted as one.
 */
export function directoryName(name: string): string {
  return (
    name
      .replace(/[\t\n\v\f\r\u0085\p{Z}]/gu, ' ')
      // Controls and format characters (the soft hyphen and the zero-width ones among them), variation selectors, the
      // combining grapheme joiner, the Mongolian soft hyphen and the object replacement character.
      .replace(/\p{Cc}|\p{Cf}|\p{Variation_Selector}|\u034f|\u1806|\ufffc/gu, '')
      .normalize('NFKC')
      .toUpperCase()
      .toLowerCase()
      .trim()
      .replace(/ {2,}/g, ' ')
  );
}

// What stands for the typed name while the user filter is read for the attributes it compares the name with.
const NAME_MARK = 'jukecord0name0mark';

/**
 * The attributes a user filter finds people by, in its order: those it compares the typed name with, as in
 * (uid={username}) or (|(sAMAccountName={username})(userPrincipalName={username})). Read with ldapts' own parser; a
 * name compared under a NOT, or inside a longer value, is no attribute of the person's own name.
 */
export function nameAttributes(userFilter: string): string[] {
  const found: string[] = [];
  const walk = (filter: Filter) => {
    if (filter instanceof AndFilter || filter instanceof OrFilter) for (const inner of filter.filters) walk(inner);
    else if ((filter instanceof EqualityFilter || filter instanceof ApproximateFilter) && filter.value === NAME_MARK)
      found.push(filter.attribute);
  };
  try {
    walk(FilterParser.parseString(fillFilter(userFilter, { username: NAME_MARK })));
  } catch {
    // A filter ldapts cannot read finds nobody either; the search says so.
  }
  // Each once, in the case written (attributes are compared regardless of case).
  return found.filter((name, at) => found.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === at);
}

// An attribute's values in an entry, its name compared regardless of case (a directory answers in the case its
// schema writes, which need not be the case the settings wrote).
function valuesOf(entry: Record<string, unknown>, attribute: string): string[] {
  const key = Object.keys(entry).find((name) => name.toLowerCase() === attribute.toLowerCase());
  return key === undefined ? [] : texts(entry[key]);
}

/**
 * What Active Directory's refusal of a bind says beyond "invalid credentials" (the `data` code in its message):
 * an expired password or one that must be changed, an account turned off, expired or locked out. Anything else, and
 * every other directory, is the wrong name or password.
 */
export function bindRefusal(message: string): 'wrong' | 'expired' | 'disabled' {
  const data = /\bdata ([0-9a-f]{3,4})\b/i.exec(message)?.[1]?.toLowerCase();
  if (data === '532' || data === '773') return 'expired';
  if (data === '533' || data === '701' || data === '775') return 'disabled';
  return 'wrong';
}

// An attribute's values as text: one or many, a string or the bytes of one.
function texts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.flatMap((item) => (typeof item === 'string' ? [item] : Buffer.isBuffer(item) ? [item.toString()] : []));
}

// An entry's lasting ID: OpenLDAP's entryUUID, Active Directory's objectGUID (bytes, in hex), 389's nsUniqueId,
// FreeIPA's ipaUniqueID; its DN, as the directory compares it, when it has none of them.
function subjectOf(entry: Record<string, unknown>, dn: string): string {
  const guid = entry.objectGUID;
  const bytes = Array.isArray(guid) ? guid[0] : guid;
  if (Buffer.isBuffer(bytes) && bytes.length === 16) return `guid:${bytes.toString('hex')}`;
  for (const name of ['entryUUID', 'nsUniqueId', 'ipaUniqueID']) {
    const [id] = texts(entry[name]);
    if (id) return `${name}:${id.toLowerCase()}`;
  }
  return `dn:${normalDn(dn)}`;
}

// What a failure of the connection or the directory says, in a few words.
function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a directory that takes binds over an encrypted connection only (Active Directory with LDAP signing required,
// Samba by default) is told by the settings to do.
const ENCRYPT =
  'the directory takes names and passwords over an encrypted connection only: use ldaps:// or JUKECORD_LDAP_STARTTLS=yes';

// Whether the directory refused for want of encryption (strongerAuthRequired, confidentialityRequired).
function wantsEncryption(error: unknown): boolean {
  return error instanceof StrongAuthRequiredError || error instanceof ConfidentialityRequiredError;
}

// The attributes read of a person: their names, their groups and the IDs that last.
const PERSON_ATTRIBUTES = ['displayName', 'cn', 'memberOf', 'entryUUID', 'objectGUID', 'nsUniqueId', 'ipaUniqueID'];

export class LdapLogin {
  private readonly options: LdapOptions;

  constructor(options: LdapOptions) {
    this.options = options;
  }

  /** The words on the directory form's key, when the host chose them. */
  get label(): string | null {
    return this.options.settings.label;
  }

  // A connection to the directory, upgraded with StartTLS when the settings say: certificates checked against the
  // CA file when one is given (the system's otherwise), and nothing sent until the connection is encrypted.
  private async open(): Promise<DirectoryClient> {
    const { settings } = this.options;
    const host = new URL(settings.url).hostname;
    const tlsOptions: tls.ConnectionOptions = {
      ...(settings.ca ? { ca: settings.ca } : {}),
      // The name the certificate must carry: the host the URL names (an address in brackets without them).
      servername: host.replace(/^\[|\]$/g, ''),
      minVersion: 'TLSv1.2',
    };
    const options: ClientOptions = {
      url: settings.url,
      timeout: settings.timeoutMs,
      connectTimeout: settings.timeoutMs,
      // An address encrypted from the start gets the certificates and the name to check (LDAPS:// as ldaps://).
      ...(ldapsUrl(settings.url) ? { tlsOptions } : {}),
      strictDN: true,
    };
    const client = this.options.connect ? this.options.connect(options) : new Client(options);
    if (settings.startTls) {
      // ldapts' StartTLS has no clock of its own (the timeout covers one message and the connect, not the handshake
      // after them): a directory, or anything between, that answers the request and then stalls the handshake would
      // hold the login, and its socket, for good. It gets the timeout the rest gets.
      let timer: NodeJS.Timeout | undefined;
      const upgrade = client.startTLS(tlsOptions);
      try {
        await Promise.race([
          upgrade,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`StartTLS did not finish within ${settings.timeoutMs} ms`)),
              settings.timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        // A connection that could not be encrypted is let go of, unused: nothing was sent over it in the clear. Letting
        // go of it also ends a handshake still under way, whose failure then says nothing more.
        upgrade.catch(() => {});
        await client.unbind().catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    return client;
  }

  // Binds as jukecord's service account, when there is one (an anonymous search otherwise). A refusal is the host's
  // trouble (a wrong password in the settings), never the person's: said as the directory being unavailable. ldapts
  // connects at the first request, so a directory that cannot be reached (or a certificate not trusted) shows here.
  private async serviceBind(client: DirectoryClient): Promise<void> {
    const { bindDn, bindPassword } = this.options.settings;
    if (bindDn === null || bindPassword === null) return;
    try {
      await client.bind(bindDn, bindPassword);
    } catch (error) {
      // Its answer (a refusal of the account, or of a bind sent in the clear), or no answer at all.
      throw new LdapError(
        'unavailable',
        wantsEncryption(error)
          ? ENCRYPT
          : error instanceof ResultCodeError
            ? `the directory refused jukecord's service account: ${said(error)}`
            : `the directory could not be reached: ${said(error)}`,
      );
    }
  }

  // Finds the one person the name stands for: none is the wrong name, two are a filter that is too wide.
  private async find(client: DirectoryClient, username: string): Promise<Record<string, unknown> & { dn: string }> {
    const { settings } = this.options;
    let entries: Record<string, unknown>[];
    try {
      ({ searchEntries: entries } = await client.search(settings.baseDn, {
        scope: 'sub',
        filter: fillFilter(settings.userFilter, { username }),
        // Their own name too: the attributes the filter found them by.
        attributes: [...PERSON_ATTRIBUTES, ...nameAttributes(settings.userFilter)],
        // Two are enough to know there is more than one.
        sizeLimit: 2,
        explicitBufferAttributes: ['objectGUID'],
      }));
    } catch (error) {
      if (error instanceof SizeLimitExceededError)
        throw new LdapError('ambiguous', 'the user filter finds more than one person for that name');
      if (error instanceof NoSuchObjectError)
        throw new LdapError('unavailable', `the base DN ${settings.baseDn} is not in the directory`);
      throw new LdapError('unavailable', `the directory did not answer the search: ${said(error)}`);
    }
    if (entries.length > 1)
      throw new LdapError('ambiguous', 'the user filter finds more than one person for that name');
    const entry = entries[0];
    if (!entry || typeof entry.dn !== 'string') throw new LdapError('wrong', 'no person by that name');
    return entry as Record<string, unknown> & { dn: string };
  }

  /**
   * The person's own name as the directory keeps it: the value of the first attribute the user filter found them by
   * that they have (of several values, the one the typed name stands for). Null when they have none of them.
   */
  private ownName(entry: Record<string, unknown>, typed: string): string | null {
    const wanted = directoryName(typed);
    for (const attribute of nameAttributes(this.options.settings.userFilter)) {
      const values = valuesOf(entry, attribute).filter((value) => value.trim() !== '');
      if (values.length > 0) return values.find((value) => directoryName(value) === wanted) ?? values[0] ?? null;
    }
    return null;
  }

  // A person's groups, by DN: from their memberOf, or a search for the groups that have them (with Active Directory's
  // nested rule when the settings say), read with jukecord's own account before the person's bind. A group filter's
  // {username} is the person's own name, never what was typed: memberUid is compared case and all, so "ALICE" typed
  // for alice must not find the groups of an "ALICE".
  private async groupsOf(client: DirectoryClient, entry: Record<string, unknown> & { dn: string }, typed: string) {
    const { settings } = this.options;
    if (settings.groupFilter === null && !settings.nestedGroups) return texts(entry.memberOf);
    const own = this.ownName(entry, typed);
    if (!settings.nestedGroups && settings.groupFilter?.includes('{username}') && own === null) {
      this.options.log.warn('the person found has none of the attributes the user filter compares names with', {
        attributes: nameAttributes(settings.userFilter).join(', ') || 'none',
      });
      return [];
    }
    const filter = settings.nestedGroups
      ? `(member:${IN_CHAIN}:=${escapeFilterValue(entry.dn)})`
      : fillFilter(settings.groupFilter ?? '', { username: own ?? '', dn: entry.dn });
    try {
      const { searchEntries } = await client.search(settings.groupBaseDn ?? settings.baseDn, {
        scope: 'sub',
        filter,
        // Only the DNs: a group's members are not read.
        attributes: ['1.1'],
        sizeLimit: GROUPS_MAX,
      });
      return searchEntries.flatMap((group) => (typeof group.dn === 'string' ? [group.dn] : []));
    } catch (error) {
      // More groups than that: the first ones are what a directory gives, and a level is decided on them.
      if (error instanceof SizeLimitExceededError) return [];
      throw new LdapError('unavailable', `the directory did not answer the group search: ${said(error)}`);
    }
  }

  /**
   * Logs a person in with their directory name and password: who they are and their groups, or LdapError. The guard
   * is asked about the account the name found before its password is sent.
   */
  async login(username: string, password: string, guard: LoginGuard = {}): Promise<LdapIdentity> {
    const name = username.trim();
    // Refused before anything is sent: an empty password is an anonymous bind, which a directory says yes to.
    if (name === '' || password === '') throw new LdapError('invalid', 'type a name and a password');
    if (name.length > NAME_MAX || password.length > PASSWORD_MAX || name.includes('\0') || password.includes('\0'))
      throw new LdapError('wrong', 'no person by that name');
    let client: DirectoryClient;
    try {
      client = await this.open();
    } catch (error) {
      throw new LdapError('unavailable', `the directory could not be reached: ${said(error)}`);
    }
    try {
      await this.serviceBind(client);
      const entry = await this.find(client, name);
      const subject = subjectOf(entry, entry.dn);
      // Held back here when the account failed too often lately, whatever name found it this time.
      if (guard.found && !(await guard.found(subject)))
        throw new LdapError('blocked', 'the account found failed too often lately');
      const groups = await this.groupsOf(client, entry, name);
      // The directory checks the password, by a bind as the person: jukecord compares nothing itself.
      try {
        await client.bind(entry.dn, password);
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          const why = bindRefusal(error.message);
          throw new LdapError(why, why === 'wrong' ? 'not their password' : `the directory says the account is ${why}`);
        }
        // A bind in the clear refused is the settings' trouble, not the person's (an anonymous search came first).
        if (wantsEncryption(error)) throw new LdapError('unavailable', ENCRYPT);
        throw new LdapError('unavailable', `the directory did not answer the bind: ${said(error)}`);
      }
      const display =
        [...texts(entry.displayName), ...texts(entry.cn)].find((text) => text.trim() !== '') ??
        this.ownName(entry, name) ??
        name;
      return {
        subject,
        dn: entry.dn,
        name: [...display.trim()].slice(0, DISPLAY_MAX).join(''),
        groups,
      };
    } catch (error) {
      if (error instanceof LdapError) throw error;
      throw new LdapError('unavailable', `the directory did not answer: ${said(error)}`);
    } finally {
      // Let go of the connection whatever happened; a connection already gone has nothing to let go.
      await client.unbind().catch(() => {});
    }
  }

  /**
   * Checks the settings against the directory without logging anyone in: the connection, the service account, the
   * base DN and, with a name, the person it finds and their groups (no password is asked for or sent).
   */
  async test(username?: string): Promise<{ checks: Check[]; groups: string[] | null }> {
    const { settings } = this.options;
    const checks: Check[] = [];
    let client: DirectoryClient;
    try {
      client = await this.open();
    } catch (error) {
      checks.push({ name: 'connection', status: 'fail', detail: `${settings.url}: ${said(error)}` });
      return { checks, groups: null };
    }
    // ldapts connects at the first request: the directory's root entry, which a directory shows anyone, says whether it
    // answers (over TLS, with its certificate trusted). A refusal to show it is an answer too.
    const how = ldapsUrl(settings.url) ? 'over TLS' : settings.startTls ? 'with StartTLS' : 'unencrypted';
    try {
      await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'], sizeLimit: 1 });
      checks.push({ name: 'connection', status: 'ok', detail: `${settings.url} answered, ${how}` });
    } catch (error) {
      const answered = error instanceof Error && 'code' in error && typeof error.code === 'number';
      checks.push(
        answered
          ? { name: 'connection', status: 'ok', detail: `${settings.url} answered, ${how}` }
          : { name: 'connection', status: 'fail', detail: `${settings.url}: ${said(error)}` },
      );
      if (!answered) {
        await client.unbind().catch(() => {});
        return { checks, groups: null };
      }
    }
    let groups: string[] | null = null;
    try {
      try {
        await this.serviceBind(client);
        checks.push({
          name: 'service account',
          status: 'ok',
          detail: settings.bindDn ? `bound as ${settings.bindDn}` : 'none: people are found by an anonymous search',
        });
      } catch (error) {
        checks.push({ name: 'service account', status: 'fail', detail: said(error) });
        return { checks, groups };
      }
      try {
        const { searchEntries } = await client.search(settings.baseDn, {
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: ['1.1'],
          sizeLimit: 1,
        });
        checks.push(
          searchEntries.length > 0
            ? { name: 'base DN', status: 'ok', detail: `${settings.baseDn} is there` }
            : { name: 'base DN', status: 'fail', detail: `${settings.baseDn} is not in the directory` },
        );
      } catch (error) {
        checks.push({ name: 'base DN', status: 'fail', detail: `${settings.baseDn}: ${said(error)}` });
        return { checks, groups };
      }
      const name = username?.trim();
      if (!name) return { checks, groups };
      try {
        const entry = await this.find(client, name);
        checks.push({ name: 'person', status: 'ok', detail: `${name} is ${entry.dn}` });
        groups = await this.groupsOf(client, entry, name);
        checks.push({
          name: 'groups',
          status: 'ok',
          detail: groups.length > 0 ? `${groups.length}: ${groups.join(' | ')}` : 'none found',
        });
      } catch (error) {
        checks.push({
          name: 'person',
          status: 'fail',
          detail: error instanceof LdapError && error.code === 'wrong' ? `no one is found by ${name}` : said(error),
        });
      }
      return { checks, groups };
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}
