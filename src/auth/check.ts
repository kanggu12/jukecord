/**
 * Testing the login settings without saving them or logging anyone in (`jukecord auth test-oidc`, `test-ldap`, and
 * the settings page's tests): the settings in use, or those with some values not saved yet put in their place, read by
 * the same rules as at start, then tried against the provider or the directory.
 */

import { MemoryCache } from '../cache/memory.ts';
import { type ConfigFiles, diskFiles } from '../config.ts';
import type { Logger } from '../log.ts';
import { LdapLogin, type LdapOptions } from './ldap.ts';
import { levelOf, sameLdapGroup } from './levels.ts';
import { type Check, OidcLogin } from './oidc.ts';
import { AUTH_VARIABLES, type AuthSettings, type MemberLevel, readAuthSettings } from './settings.ts';

export interface LoginChecksOptions {
  /** The environment jukecord started with: what is in use, under the values a test brings. */
  readonly env: NodeJS.ProcessEnv;
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

export class LoginChecks {
  private readonly options: LoginChecksOptions;

  constructor(options: LoginChecksOptions) {
    this.options = options;
  }

  /**
   * The login settings with some values in place of the ones in use, by their environment names. A value given for a
   * setting that has a `_FILE` twin replaces the file too; a name that is no login setting is a problem.
   */
  settingsWith(values: Readonly<Record<string, string>> = {}): { settings: AuthSettings; problems: string[] } {
    const env: NodeJS.ProcessEnv = { ...this.options.env };
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
    const read = readAuthSettings(env, this.options.cwd, this.options.files ?? diskFiles);
    return { settings: read.settings, problems: [...unknown, ...read.problems] };
  }

  /** Tests logging in through the identity provider: its document, its keys, the client and its secret. */
  async oidc(values: Readonly<Record<string, string>> = {}): Promise<TestAnswer> {
    const { settings, problems } = this.settingsWith(values);
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
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    const checks = await login.test();
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  /**
   * Tests logging in with a directory account: the connection, the service account, the base DN, and with a name the
   * person, their groups and the level those give. No password is asked for, and none is sent but the service's.
   */
  async ldap(
    username?: string,
    values: Readonly<Record<string, string>> = {},
  ): Promise<TestAnswer & { groups: string[] | null; level: MemberLevel | null }> {
    const { settings, problems } = this.settingsWith(values);
    if (problems.length > 0) return { ok: false, checks: problemsAsChecks(problems), groups: null, level: null };
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
