/**
 * Testing the login settings without saving them or logging anyone in (`jukecord auth test-oidc`, `test-ldap`, and
 * the settings page's tests): the settings in use, or those with some values not saved yet put in their place, read by
 * the same rules as at start, then tried against the provider or the directory.
 */

import { trustingFetch } from '../authorities.ts';
import { MemoryCache } from '../cache/memory.ts';
import { type ConfigFiles, diskFiles } from '../config.ts';
import type { Logger } from '../log.ts';
import { LdapLogin, type LdapOptions } from './ldap.ts';
import { levelOf, sameLdapGroup } from './levels.ts';
import { type Check, OidcLogin } from './oidc.ts';
import { AUTH_VARIABLES, type AuthSettings, type MemberLevel, readAuthSettings } from './settings.ts';

export interface LoginChecksOptions {
  /**
   * The environment jukecord started with, or how to read it as it is now (with the saved settings under it, see
   * src/settings/layers.ts): what is in use, under the values a test brings.
   */
  readonly env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>);
  readonly cwd: string;
  readonly files?: ConfigFiles;
  /** Where the provider sends people back to, and after logging out (as the login itself is set up). */
  readonly redirectUri: string;
  readonly afterLogout: string;
  readonly log: Logger;
  /** The fetch used to reach the provider, and how the directory is reached (tests pass their own). */
  readonly fetch?: typeof fetch;
  readonly connect?: LdapOptions['connect'];
}

/** A test's answer: whether every check passed, and each check. */
export interface TestAnswer {
  readonly ok: boolean;
  readonly checks: Check[];
}

// The settings' problems as the checks of a test that could not start.
function problemsAsChecks(problems: readonly string[]): Check[] {
  return problems.map((problem) => ({ name: 'settings', status: 'fail', detail: problem }));
}

/**
 * The secrets in use and the settings that say where each goes: a test that brings another value for one of those
 * settings, and not the secret too, is not sent the secret in use (it goes only where it goes now). The directory's
 * address, its encryption, its certificates and the account the password belongs to; the provider and the client.
 */
const SECRET_GOES: Readonly<Record<string, readonly string[]>> = {
  JUKECORD_LDAP_BIND_PASSWORD: [
    'JUKECORD_LDAP_URL',
    'JUKECORD_LDAP_STARTTLS',
    'JUKECORD_LDAP_CA_FILE',
    'JUKECORD_LDAP_BIND_DN',
  ],
  JUKECORD_OIDC_CLIENT_SECRET: ['JUKECORD_OIDC_ISSUER', 'JUKECORD_OIDC_CLIENT_ID'],
};

export class LoginChecks {
  private readonly options: LoginChecksOptions;

  constructor(options: LoginChecksOptions) {
    this.options = options;
  }

  /**
   * The login settings with some values in place of the ones in use, by their environment names. A value given for a
   * setting that has a `_FILE` twin replaces the file too; a name that is no login setting is a problem. A secret in
   * use whose destination a value changes (see SECRET_GOES), and that is not given too, is left out: `withheld` names
   * it, and the test says to give it rather than send it anywhere new.
   */
  settingsWith(
    values: Readonly<Record<string, string>> = {},
    base: NodeJS.ProcessEnv = typeof this.options.env === 'function' ? {} : this.options.env,
  ): {
    settings: AuthSettings;
    problems: string[];
    withheld: string[];
  } {
    // In use: as jukecord started, or as the settings read now (the saved values under the environment).
    const live = base;
    const env: NodeJS.ProcessEnv = { ...live };
    const unknown: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      // Files are the host's to name in the environment: a test brings values, never a path to read.
      if (!AUTH_VARIABLES.includes(name) || name.endsWith('_FILE')) {
        unknown.push(`${name} is not a login setting a test can take`);
        continue;
      }
      env[name] = value;
      delete env[`${name}_FILE`];
    }
    // A value that differs from the one in use (spaces at the ends aside, as the settings read them).
    const changed = (name: string) =>
      Object.hasOwn(values, name) && (values[name] ?? '').trim() !== (live[name] ?? '').trim();
    const withheld: string[] = [];
    for (const [secret, destinations] of Object.entries(SECRET_GOES)) {
      if (Object.hasOwn(values, secret) || !destinations.some(changed)) continue;
      // Neither the value nor the file of the secret in use goes along.
      delete env[secret];
      delete env[`${secret}_FILE`];
      withheld.push(secret);
    }
    const read = readAuthSettings(env, this.options.cwd, this.options.files ?? diskFiles);
    // The problems of a secret left out are not the person's (the account without its password): the test says why.
    const problems = read.problems.filter(
      (problem) =>
        !(withheld.includes('JUKECORD_LDAP_BIND_PASSWORD') && problem.includes('JUKECORD_LDAP_BIND_PASSWORD')),
    );
    return { settings: read.settings, problems: [...unknown, ...problems], withheld };
  }

  // The environment the settings are read from now: as jukecord started, or as the settings say now.
  private async environment(): Promise<NodeJS.ProcessEnv> {
    const env = this.options.env;
    return typeof env === 'function' ? await env() : env;
  }

  /**
   * Tests logging in through the identity provider: its document, its keys, the client and its secret. With `trust`,
   * its connections trust that list of authorities (the settings page's, not saved yet, with the ones in use).
   */
  async oidc(values: Readonly<Record<string, string>> = {}, trust?: readonly string[]): Promise<TestAnswer> {
    const { settings, problems, withheld } = this.settingsWith(values, await this.environment());
    if (problems.length > 0) return { ok: false, checks: problemsAsChecks(problems) };
    if (!settings.oidc) {
      return {
        ok: false,
        checks: [{ name: 'settings', status: 'fail', detail: 'JUKECORD_OIDC_ISSUER is not set: SSO is off' }],
      };
    }
    const login = new OidcLogin({
      settings: settings.oidc,
      redirectUri: this.options.redirectUri,
      afterLogout: this.options.afterLogout,
      // A cache of its own: a test starts no login, and leaves nothing behind.
      cache: new MemoryCache(),
      log: this.options.log,
      // A fetch that trusts the list given, or the tests' own, or the process's.
      ...(trust ? { fetch: trustingFetch(trust) } : this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    // Without the secret in use (another issuer or client): its document and keys, and the client not tried.
    const checks = await login.test({ secretWithheld: withheld.includes('JUKECORD_OIDC_CLIENT_SECRET') });
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  /**
   * Tests logging in with a directory account: the connection, the service account, the base DN, and with a name the
   * person, their groups and the level those give. No password is asked for, and none is sent but the service's.
   */
  async ldap(
    username?: string,
    values: Readonly<Record<string, string>> = {},
    trust?: readonly string[],
  ): Promise<TestAnswer & { groups: string[] | null; level: MemberLevel | null }> {
    const { settings, problems, withheld } = this.settingsWith(values, await this.environment());
    if (problems.length > 0) return { ok: false, checks: problemsAsChecks(problems), groups: null, level: null };
    // Another directory, connection or account without the password typed again: nothing is tried, nothing is sent.
    if (withheld.includes('JUKECORD_LDAP_BIND_PASSWORD')) {
      return {
        ok: false,
        checks: [
          {
            name: 'service account',
            status: 'fail',
            detail:
              'give JUKECORD_LDAP_BIND_PASSWORD to test another directory, connection or account: the password in use goes only where it goes now',
          },
        ],
        groups: null,
        level: null,
      };
    }
    const ldap = settings.ldap;
    if (!ldap) {
      return {
        ok: false,
        checks: [
          { name: 'settings', status: 'fail', detail: 'JUKECORD_LDAP_URL is not set: directory accounts are off' },
        ],
        groups: null,
        level: null,
      };
    }
    const login = new LdapLogin({
      settings: ldap,
      log: this.options.log,
      ...(this.options.connect ? { connect: this.options.connect } : {}),
      // The page's authorities not saved yet, with the ones in use, when it gives some.
      ...(trust ? { trust } : {}),
    });
    const { checks, groups } = await login.test(username);
    const level = groups === null ? null : levelOf(groups, ldap.groups, sameLdapGroup);
    // With a name: the level they would log in at, or that they would be refused.
    if (groups !== null) {
      checks.push(
        level
          ? { name: 'level', status: 'ok', detail: `${username?.trim()} would log in at the ${level} level` }
          : { name: 'level', status: 'warn', detail: `${username?.trim()} is in none of the groups jukecord lets in` },
      );
    }
    return { ok: checks.every((check) => check.status !== 'fail'), checks, groups, level };
  }
}
