/**
 * A made-up LDAP directory for tests, in the shape of a connection (src/auth/ldap.ts, DirectoryClient): people and
 * groups, a service account, filters read with ldapts' own parser, Active Directory's nested-group rule, and the
 * refusals a directory gives. Every operation is written down in order, so a test sees what was sent and what was not.
 */
import { FilterParser, InvalidCredentialsError } from 'ldapts';
import type { DirectoryClient } from '../../src/auth/ldap.ts';
import { IN_CHAIN } from '../../src/auth/ldap.ts';

export interface DirectoryPerson {
  readonly dn: string;
  readonly password: string;
  /** Their attributes, as a directory returns them (memberOf among them, when the directory keeps one). */
  readonly attributes: Record<string, string | string[]>;
  /** What a bind with the right password says instead of yes: Active Directory's refusal code (532, 533 ...). */
  readonly refuse?: string;
}

export interface DirectoryGroup {
  readonly dn: string;
  /** The DNs of its members: people and groups. */
  readonly members: readonly string[];
}

export class FakeDirectoryServer {
  readonly people: DirectoryPerson[] = [];
  readonly groups: DirectoryGroup[] = [];
  service = { dn: 'cn=jukecord,ou=services,dc=example,dc=org', password: 'service-secret' };
  /** Everything asked of it, in order: "open", "starttls", "bind <dn>", "search <base> <filter>", "unbind". */
  readonly log: string[] = [];
  /** When set, opening a connection fails as an unreachable server does. */
  down = false;

  /** The connect function LdapLogin takes. */
  readonly connect = (): DirectoryClient => {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:389');
    this.log.push('open');
    return this.client();
  };

  private client(): DirectoryClient {
    return {
      startTLS: async () => {
        this.log.push('starttls');
      },
      bind: async (dn, password) => {
        this.log.push(`bind ${dn}`);
        if (dn === this.service.dn) {
          if (password !== this.service.password) throw new InvalidCredentialsError('invalid credentials');
          return;
        }
        const person = this.people.find((one) => one.dn.toLowerCase() === dn.toLowerCase());
        if (!person || person.password !== password)
          throw new InvalidCredentialsError(
            '80090308: LdapErr: DSID-0C090447, comment: AcceptSecurityContext error, data 52e, v3839',
          );
        if (person.refuse)
          throw new InvalidCredentialsError(
            `80090308: LdapErr: DSID-0C090447, comment: AcceptSecurityContext error, data ${person.refuse}, v3839`,
          );
      },
      search: async (base, options) => {
        this.log.push(`search ${base} ${options.filter}`);
        const under = (dn: string) => dn.toLowerCase().endsWith(base.toLowerCase());
        if (options.scope === 'base') return { searchEntries: under(base) ? [{ dn: base }] : [] };
        const nested = new RegExp(`^\\(member:${IN_CHAIN.replaceAll('.', '\\.')}:=(.*)\\)$`).exec(options.filter);
        if (nested) {
          const dn = unescaped(nested[1] ?? '');
          return {
            searchEntries: this.containing(dn)
              .filter(under)
              .map((group) => ({ dn: group })),
          };
        }
        const filter = FilterParser.parseString(options.filter);
        const entries = [
          ...this.people.map((person) => ({ dn: person.dn, ...person.attributes })),
          ...this.groups.map((group) => ({ dn: group.dn, member: [...group.members], cn: firstName(group.dn) })),
        ];
        const found = entries.filter((entry) => under(entry.dn) && variants(entry).some((one) => filter.matches(one)));
        return {
          searchEntries: found.slice(0, options.sizeLimit || found.length).map((entry) => {
            // Only the attributes asked for, as a directory answers ("1.1": none).
            const kept: Record<string, unknown> = { dn: entry.dn };
            for (const name of options.attributes)
              if (name in entry) kept[name] = (entry as Record<string, unknown>)[name];
            return kept;
          }),
        };
      },
      unbind: async () => {
        this.log.push('unbind');
      },
    };
  }

  // Every group a DN is in, through groups in groups.
  private containing(dn: string, seen = new Set<string>()): string[] {
    const direct = this.groups.filter((group) =>
      group.members.some((member) => member.toLowerCase() === dn.toLowerCase()),
    );
    const out: string[] = [];
    for (const group of direct) {
      if (seen.has(group.dn)) continue;
      seen.add(group.dn);
      out.push(group.dn, ...this.containing(group.dn, seen));
    }
    return out;
  }
}

// A filter value's escapes undone (\2a is "*").
function unescaped(value: string): string {
  return value.replace(/\\([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function firstName(dn: string): string {
  return dn.split(',')[0]?.split('=')[1] ?? '';
}

// An entry as ldapts' filters read one, once for each value of its many-valued attributes (a filter matches an entry
// when it matches any of its values, as a directory reads it; ldapts' matcher compares one value).
function variants(entry: Record<string, unknown>): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [name, value] of Object.entries(entry)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    out = out.flatMap((partial) => values.map((one) => ({ ...partial, [name]: one })));
  }
  return out;
}
