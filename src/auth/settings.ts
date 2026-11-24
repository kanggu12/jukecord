/**
 * The settings of logging in through the host's identity provider (OIDC: Keycloak, Authentik, Entra ID, Okta, Google
 * ...) and directory (LDAP: OpenLDAP, Active Directory, FreeIPA), read from JUKECORD_OIDC_* and JUKECORD_LDAP_*.
 *
 * Each is off until its address is set (JUKECORD_OIDC_ISSUER, JUKECORD_LDAP_URL); a host who sets none of them sees
 * nothing change. Every problem is collected, as src/config.ts collects its own, so one run lists them all. The same
 * reading serves the settings test (`jukecord auth test-oidc`, `test-ldap`), which may be handed values not saved yet:
 * they are read by the same rules as at start.
 */
import path from 'node:path';
import type { ConfigFiles } from '../config.ts';
import { parseDuration } from '../util/units.ts';

/** What a member may do: what the host may (admin), change the music everywhere (control), or look and listen. */
export type MemberLevel = 'admin' | 'control' | 'read';

/** The levels, the widest first: the first one a person's groups reach is theirs. */
export const LEVELS: readonly MemberLevel[] = ['admin', 'control', 'read'];

/** Which groups (or roles) give each level; `*` in a list stands for anyone the provider lets in. */
export interface LevelGroups {
  readonly admin: readonly string[];
  readonly control: readonly string[];
  readonly read: readonly string[];
}

/** Logging in through an OpenID Connect provider. */
export interface OidcSettings {
  /** The issuer's address, exactly as the provider names itself (its discovery document is found under it). */
  readonly issuer: string;
  readonly clientId: string;
  /** The client's secret; null for a public client, which proves itself with PKCE alone. */
  readonly clientSecret: string | null;
  /** The scopes asked for, `openid` first. */
  readonly scopes: readonly string[];
  /** Where the groups or roles are among the claims: a name, or a dotted path (`realm_access.roles`). */
  readonly groupsClaim: string;
  readonly groups: LevelGroups;
  /** The words on the login key, as the host wrote them; null for the panel's own ("Log in with SSO"). */
  readonly label: string | null;
  /** The claim that carries a Discord user ID, when a login that has one should be that Discord user; null for none. */
  readonly discordClaim: string | null;
}

/** Logging in with an account of an LDAP directory or Active Directory. */
export interface LdapSettings {
  /** `ldap://host[:port]` or `ldaps://host[:port]`. */
  readonly url: string;
  /** Whether a plain connection is upgraded with StartTLS before anything is sent (never with ldaps://). */
  readonly startTls: boolean;
  /** The certificates (PEM) the directory's certificate is checked against, read from JUKECORD_LDAP_CA_FILE; null for
   * the system's. */
  readonly ca: string | null;
  /** The service account that finds people; null for an anonymous search. */
  readonly bindDn: string | null;
  readonly bindPassword: string | null;
  /** Where people are looked for. */
  readonly baseDn: string;
  /** The filter that finds one person, with `{username}` for what they typed (escaped before it is put in). */
  readonly userFilter: string;
  /** A filter that finds a person's groups (`{dn}`, `{username}`); null to read their memberOf instead. */
  readonly groupFilter: string | null;
  /** Where groups are looked for (the base DN when null). */
  readonly groupBaseDn: string | null;
  /** Whether groups come from Active Directory's rule for nested groups (LDAP_MATCHING_RULE_IN_CHAIN). */
  readonly nestedGroups: boolean;
  readonly groups: LevelGroups;
  /** How long connecting, and each request after, may take. */
  readonly timeoutMs: number;
  /** The words on the directory form's key, as the host wrote them; null for the panel's own. */
  readonly label: string | null;
}

export interface AuthSettings {
  readonly oidc: OidcSettings | null;
  readonly ldap: LdapSettings | null;
}

/** Every variable read here, for src/config.ts's list of the settings it knows. */
export const AUTH_VARIABLES: readonly string[] = [
  'JUKECORD_OIDC_ISSUER',
  'JUKECORD_OIDC_CLIENT_ID',
  'JUKECORD_OIDC_CLIENT_SECRET',
  'JUKECORD_OIDC_CLIENT_SECRET_FILE',
  'JUKECORD_OIDC_SCOPES',
  'JUKECORD_OIDC_GROUPS_CLAIM',
  'JUKECORD_OIDC_ADMIN_GROUPS',
  'JUKECORD_OIDC_CONTROL_GROUPS',
  'JUKECORD_OIDC_READ_GROUPS',
  'JUKECORD_OIDC_LABEL',
  'JUKECORD_OIDC_DISCORD_CLAIM',
  'JUKECORD_LDAP_URL',
  'JUKECORD_LDAP_STARTTLS',
  'JUKECORD_LDAP_CA_FILE',
  'JUKECORD_LDAP_BIND_DN',
  'JUKECORD_LDAP_BIND_PASSWORD',
  'JUKECORD_LDAP_BIND_PASSWORD_FILE',
  'JUKECORD_LDAP_BASE_DN',
  'JUKECORD_LDAP_USER_FILTER',
  'JUKECORD_LDAP_GROUP_FILTER',
  'JUKECORD_LDAP_GROUP_BASE_DN',
  'JUKECORD_LDAP_NESTED_GROUPS',
  'JUKECORD_LDAP_ADMIN_GROUPS',
  'JUKECORD_LDAP_CONTROL_GROUPS',
  'JUKECORD_LDAP_READ_GROUPS',
  'JUKECORD_LDAP_TIMEOUT',
  'JUKECORD_LDAP_LABEL',
];

/** The secrets among them: never shown, only whether they are set. */
export const AUTH_SECRETS: readonly string[] = ['JUKECORD_OIDC_CLIENT_SECRET', 'JUKECORD_LDAP_BIND_PASSWORD'];

/** The scopes asked for when none are set: who the person is and their name. */
export const DEFAULT_SCOPES: readonly string[] = ['openid', 'profile'];

/** The filter that finds a person when none is set: OpenLDAP's and FreeIPA's user ID (AD's is sAMAccountName). */
export const DEFAULT_USER_FILTER = '(uid={username})';

// The longest words a login key takes before they would break over two lines on a phone.
const LABEL_MAX = 40;

/**
 * Splits a list of groups: OIDC's at commas and semicolons; LDAP's at semicolons, because a DN has commas in it, and
 * at commas too between plain names (a piece without an "=" is no DN).
 */
export function splitGroups(text: string, provider: 'oidc' | 'ldap'): string[] {
  const pieces = provider === 'oidc' ? text.split(/[,;]/) : text.split(';').flatMap(plainNames);
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

// A piece of an LDAP list: a DN stays whole; plain names written with commas between them are split.
function plainNames(piece: string): string[] {
  return piece.includes('=') ? [piece] : piece.split(',');
}

// Whether a filter's parentheses open and close as a filter's do, around the whole of it, outside escapes (\28 is an
// escaped parenthesis; a bare one in a value is a mistake that the directory would refuse anyway).
function balanced(filter: string): boolean {
  if (!filter.startsWith('(') || !filter.endsWith(')')) return false;
  let depth = 0;
  for (const [at, char] of [...filter].entries()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    // Closed before the end: two filters side by side ("(a=1)(b=2)") are not one filter.
    if (depth === 0 && at < filter.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Reads the login settings from the environment, collecting every problem with the variable it is about. */
export function readAuthSettings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  files: ConfigFiles,
): { settings: AuthSettings; problems: string[] } {
  const problems: string[] = [];
  // Unset when missing or only spaces, as src/config.ts reads its own (compose writes `VAR=` for an empty setting).
  const get = (name: string): string | null => {
    const value = env[name]?.trim();
    return value ? value : null;
  };
  // A secret from its variable or from the file <VARIABLE>_FILE names (a Docker or Kubernetes secret), not both.
  const secret = (name: string): string | null => {
    const value = get(name);
    const file = get(`${name}_FILE`);
    if (file === null) return value;
    if (value !== null) {
      problems.push(`set ${name} or ${name}_FILE, not both`);
      return value;
    }
    const full = path.resolve(cwd, file);
    if (!files.readable(full)) {
      problems.push(`${name}_FILE: ${full} cannot be read`);
      return null;
    }
    // A file written by an editor ends with a newline; a password may have spaces inside, never at its ends here.
    const content = files.read(full).replace(/\r?\n$/, '');
    if (content.trim() === '') problems.push(`${name}_FILE: ${full} is empty`);
    return content.trim() === '' ? null : content;
  };
  // Yes or no, as the other switches are written.
  const yesNo = (name: string): boolean => {
    const text = get(name)?.toLowerCase();
    if (text === undefined) return false;
    if (['yes', 'true', 'on', '1'].includes(text)) return true;
    if (['no', 'false', 'off', '0'].includes(text)) return false;
    problems.push(`${name}: "${get(name)}" is not yes or no`);
    return false;
  };
  // The words on a login key: the host's own, short enough for a phone's key.
  const label = (name: string): string | null => {
    const text = get(name);
    if (text !== null && [...text].length > LABEL_MAX) problems.push(`${name}: at most ${LABEL_MAX} characters`);
    return text;
  };
  // The three lists of groups, and at least one of them: without any, nobody could log in this way.
  const levelGroups = (prefix: string, provider: 'oidc' | 'ldap'): LevelGroups => {
    const groups = {
      admin: splitGroups(get(`${prefix}_ADMIN_GROUPS`) ?? '', provider),
      control: splitGroups(get(`${prefix}_CONTROL_GROUPS`) ?? '', provider),
      read: splitGroups(get(`${prefix}_READ_GROUPS`) ?? '', provider),
    };
    if (groups.admin.length + groups.control.length + groups.read.length === 0) {
      problems.push(
        `set who may log in: ${prefix}_ADMIN_GROUPS, ${prefix}_CONTROL_GROUPS or ${prefix}_READ_GROUPS (a * lets in everyone the ${provider === 'oidc' ? 'provider' : 'directory'} knows)`,
      );
    }
    return groups;
  };
  // Who the provider or the directory is and who may log in, set for a way that is off, is a mistake worth stopping
  // for: it would silently do nothing. (A switch or a filter written out at its default is not.)
  const strays = (names: readonly string[], on: string): void => {
    for (const name of names) if (get(name) !== null) problems.push(`${name} is set but ${on} is not`);
  };
  // A claim's name, or a dotted path into the claims: no spaces, no empty step.
  const claimPath = (name: string): string | null => {
    const text = get(name);
    if (text !== null && (/\s/.test(text) || text.split('.').some((step) => step === ''))) {
      problems.push(`${name}: "${text}" is not a claim name or a dotted path like realm_access.roles`);
    }
    return text;
  };

  // OIDC: on with its issuer.
  let oidc: OidcSettings | null = null;
  const issuer = get('JUKECORD_OIDC_ISSUER');
  if (issuer === null) {
    strays(
      [
        'JUKECORD_OIDC_CLIENT_ID',
        'JUKECORD_OIDC_CLIENT_SECRET',
        'JUKECORD_OIDC_CLIENT_SECRET_FILE',
        'JUKECORD_OIDC_ADMIN_GROUPS',
        'JUKECORD_OIDC_CONTROL_GROUPS',
        'JUKECORD_OIDC_READ_GROUPS',
        'JUKECORD_OIDC_DISCORD_CLAIM',
      ],
      'JUKECORD_OIDC_ISSUER',
    );
  } else {
    let issuerOk = true;
    try {
      const url = new URL(issuer);
      // The issuer is an address without a query or a fragment (OpenID Connect Discovery, section 2).
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) issuerOk = false;
    } catch {
      issuerOk = false;
    }
    if (!issuerOk)
      problems.push(
        `JUKECORD_OIDC_ISSUER: "${issuer}" is not an issuer's address (example: https://sso.example.com/realms/home)`,
      );
    const clientId = get('JUKECORD_OIDC_CLIENT_ID');
    if (clientId === null) problems.push('JUKECORD_OIDC_ISSUER is set but JUKECORD_OIDC_CLIENT_ID is not');
    // Spaces or commas between the scopes; openid always, and first.
    const asked = (get('JUKECORD_OIDC_SCOPES') ?? DEFAULT_SCOPES.join(' ')).split(/[\s,]+/).filter(Boolean);
    const scopes = ['openid', ...asked.filter((scope) => scope !== 'openid')];
    oidc = {
      // Kept exactly as written: the provider's discovery document must name the same issuer, a trailing slash too.
      issuer,
      clientId: clientId ?? '',
      clientSecret: secret('JUKECORD_OIDC_CLIENT_SECRET'),
      scopes,
      groupsClaim: claimPath('JUKECORD_OIDC_GROUPS_CLAIM') ?? 'groups',
      groups: levelGroups('JUKECORD_OIDC', 'oidc'),
      label: label('JUKECORD_OIDC_LABEL'),
      discordClaim: claimPath('JUKECORD_OIDC_DISCORD_CLAIM'),
    };
  }

  // LDAP: on with its address.
  let ldap: LdapSettings | null = null;
  const address = get('JUKECORD_LDAP_URL');
  if (address === null) {
    strays(
      [
        'JUKECORD_LDAP_CA_FILE',
        'JUKECORD_LDAP_BIND_DN',
        'JUKECORD_LDAP_BIND_PASSWORD',
        'JUKECORD_LDAP_BIND_PASSWORD_FILE',
        'JUKECORD_LDAP_BASE_DN',
        'JUKECORD_LDAP_GROUP_FILTER',
        'JUKECORD_LDAP_GROUP_BASE_DN',
        'JUKECORD_LDAP_ADMIN_GROUPS',
        'JUKECORD_LDAP_CONTROL_GROUPS',
        'JUKECORD_LDAP_READ_GROUPS',
      ],
      'JUKECORD_LDAP_URL',
    );
  } else {
    let secure = false;
    try {
      const url = new URL(address);
      secure = url.protocol === 'ldaps:';
      // One server, by its address alone: a DN or a filter in the URL is not how jukecord is told them.
      if ((url.protocol !== 'ldap:' && !secure) || !url.hostname || (url.pathname !== '' && url.pathname !== '/'))
        throw new Error('not a server');
    } catch {
      problems.push(
        `JUKECORD_LDAP_URL: "${address}" is not ldap://host or ldaps://host (with a port if not the usual)`,
      );
    }
    const startTls = yesNo('JUKECORD_LDAP_STARTTLS');
    if (startTls && secure) problems.push('JUKECORD_LDAP_STARTTLS is for ldap://; ldaps:// is encrypted already');
    // The certificates to trust for the directory's own (a private CA), read now so a wrong path stops the start.
    let ca: string | null = null;
    const caFile = get('JUKECORD_LDAP_CA_FILE');
    if (caFile !== null) {
      const full = path.resolve(cwd, caFile);
      if (!files.readable(full)) problems.push(`JUKECORD_LDAP_CA_FILE: ${full} cannot be read`);
      else {
        ca = files.read(full);
        if (!ca.includes('-----BEGIN CERTIFICATE-----'))
          problems.push(`JUKECORD_LDAP_CA_FILE: ${full} has no certificate in PEM form`);
      }
    }
    const bindDn = get('JUKECORD_LDAP_BIND_DN');
    const bindPassword = secret('JUKECORD_LDAP_BIND_PASSWORD');
    // A service account needs both; neither is an anonymous search.
    if ((bindDn === null) !== (bindPassword === null))
      problems.push('set both JUKECORD_LDAP_BIND_DN and JUKECORD_LDAP_BIND_PASSWORD, or neither');
    if (bindDn !== null && !bindDn.includes('='))
      problems.push(
        `JUKECORD_LDAP_BIND_DN: "${bindDn}" is not a DN (example: cn=jukecord,ou=services,dc=example,dc=org)`,
      );
    const baseDn = get('JUKECORD_LDAP_BASE_DN');
    if (baseDn === null) problems.push('JUKECORD_LDAP_URL is set but JUKECORD_LDAP_BASE_DN is not');
    else if (!baseDn.includes('='))
      problems.push(`JUKECORD_LDAP_BASE_DN: "${baseDn}" is not a DN (example: dc=example,dc=org)`);
    const userFilter = get('JUKECORD_LDAP_USER_FILTER') ?? DEFAULT_USER_FILTER;
    if (!userFilter.includes('{username}'))
      problems.push('JUKECORD_LDAP_USER_FILTER: put {username} where the name typed goes, as in (uid={username})');
    else if (!balanced(userFilter))
      problems.push(`JUKECORD_LDAP_USER_FILTER: "${userFilter}" is not one filter in parentheses`);
    const groupFilter = get('JUKECORD_LDAP_GROUP_FILTER');
    if (groupFilter !== null && !groupFilter.includes('{dn}') && !groupFilter.includes('{username}'))
      problems.push('JUKECORD_LDAP_GROUP_FILTER: put {dn} (or {username}) where the person goes, as in (member={dn})');
    else if (groupFilter !== null && !balanced(groupFilter))
      problems.push(`JUKECORD_LDAP_GROUP_FILTER: "${groupFilter}" is not one filter in parentheses`);
    const nestedGroups = yesNo('JUKECORD_LDAP_NESTED_GROUPS');
    if (nestedGroups && groupFilter !== null)
      problems.push('set JUKECORD_LDAP_GROUP_FILTER or JUKECORD_LDAP_NESTED_GROUPS, not both');
    const groupBaseDn = get('JUKECORD_LDAP_GROUP_BASE_DN');
    if (groupBaseDn !== null && groupFilter === null && !nestedGroups)
      problems.push(
        'JUKECORD_LDAP_GROUP_BASE_DN is where groups are searched: set JUKECORD_LDAP_GROUP_FILTER or JUKECORD_LDAP_NESTED_GROUPS too',
      );
    let timeoutMs = 10_000;
    const timeout = get('JUKECORD_LDAP_TIMEOUT');
    if (timeout !== null) {
      try {
        timeoutMs = parseDuration(timeout);
        // Under a second a busy directory fails people; over a minute a login page waits too long to say so.
        if (timeoutMs < 1000 || timeoutMs > 60_000)
          problems.push(`JUKECORD_LDAP_TIMEOUT: ${timeout} is outside 1s-60s`);
      } catch (error) {
        problems.push(`JUKECORD_LDAP_TIMEOUT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ldap = {
      // Without a trailing slash, which ldapts would take as part of the address.
      url: address.replace(/\/+$/, ''),
      startTls,
      ca,
      bindDn,
      bindPassword,
      baseDn: baseDn ?? '',
      userFilter,
      groupFilter,
      groupBaseDn,
      nestedGroups,
      groups: levelGroups('JUKECORD_LDAP', 'ldap'),
      timeoutMs,
      label: label('JUKECORD_LDAP_LABEL'),
    };
  }

  return { settings: { oidc, ldap }, problems };
}

// A level's groups as one line: "admin: a, b; read: *".
function levelsText(groups: LevelGroups): string {
  // A bar between groups: an LDAP group's DN has commas of its own.
  const parts = LEVELS.filter((level) => groups[level].length > 0).map(
    (level) => `${level}: ${groups[level].join(' | ')}`,
  );
  return parts.join('; ');
}

/** The login settings as text for the doctor and the start, the secrets as whether they are set. */
export function describeAuth(settings: AuthSettings): Record<string, string> {
  const set = (value: string | null): string => (value === null ? 'not set' : 'set');
  const { oidc, ldap } = settings;
  return {
    'sso (oidc)': oidc ? oidc.issuer : 'off',
    ...(oidc
      ? {
          'sso client': oidc.clientId,
          'sso client secret': oidc.clientSecret === null ? 'none (a public client)' : 'set',
          'sso scopes': oidc.scopes.join(' '),
          'sso groups claim': oidc.groupsClaim,
          'sso levels': levelsText(oidc.groups),
          'sso discord claim': oidc.discordClaim ?? 'not set',
        }
      : {}),
    'directory (ldap)': ldap ? ldap.url : 'off',
    ...(ldap
      ? {
          'directory encryption': ldap.url.startsWith('ldaps:') ? 'ldaps' : ldap.startTls ? 'starttls' : 'none',
          'directory certificates': ldap.ca === null ? "the system's" : 'JUKECORD_LDAP_CA_FILE',
          'directory service account': ldap.bindDn ?? 'none (anonymous search)',
          'directory service password': set(ldap.bindPassword),
          'directory base': ldap.baseDn,
          'directory user filter': ldap.userFilter,
          'directory groups': ldap.nestedGroups
            ? `nested (Active Directory) under ${ldap.groupBaseDn ?? ldap.baseDn}`
            : ldap.groupFilter
              ? `${ldap.groupFilter} under ${ldap.groupBaseDn ?? ldap.baseDn}`
              : 'memberOf',
          'directory levels': levelsText(ldap.groups),
          'directory timeout': `${ldap.timeoutMs} ms`,
        }
      : {}),
  };
}
