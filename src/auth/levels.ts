/**
 * From what a provider says about a person to the level they log in at: reading a claim by its dotted path, the
 * groups' names compared as each provider writes them, and the widest level the groups reach.
 */
import { LEVELS, type LevelGroups, type MemberLevel } from './settings.ts';

/**
 * The value at a path among the claims: `groups`, `realm_access.roles`, `resource_access.jukecord.roles`. A step may
 * itself hold dots, as a namespaced claim does (`https://example.com/roles`) or a Keycloak client ID: at each level the
 * longest name that is there is taken first, so no escaping is needed. Undefined when the path leads nowhere.
 */
export function claimAt(claims: unknown, path: string): unknown {
  let here: unknown = claims;
  let rest = path;
  while (rest !== '') {
    if (here === null || typeof here !== 'object' || Array.isArray(here)) return undefined;
    const object = here as Record<string, unknown>;
    const steps = rest.split('.');
    // The longest run of steps that names a key here, then the rest under it.
    let taken = 0;
    for (let count = steps.length; count > 0; count -= 1) {
      if (Object.hasOwn(object, steps.slice(0, count).join('.'))) {
        taken = count;
        break;
      }
    }
    if (taken === 0) return undefined;
    here = object[steps.slice(0, taken).join('.')];
    rest = steps.slice(taken).join('.');
  }
  return here;
}

/**
 * A claim's value as a list of words: a list as it is, one word as a list of one (Google's `hd`, a single role), a
 * number or a yes/no as written. Anything else (an object) says nothing.
 */
export function claimValues(value: unknown): string[] {
  const one = (item: unknown): string[] =>
    typeof item === 'string' ? [item] : typeof item === 'number' || typeof item === 'boolean' ? [String(item)] : [];
  return Array.isArray(value) ? value.flatMap(one) : one(value);
}

// An OIDC group as compared: case and the form of its letters set aside, and a leading slash (Keycloak's full group
// path, "/jukecord/djs") the same as none.
function oidcName(name: string): string {
  return name.trim().normalize('NFC').toLowerCase().replace(/^\//, '');
}

/** Whether a group a provider sent is the one written in a list; `*` is every group, and no group at all. */
export function sameOidcGroup(written: string, sent: string): boolean {
  return written === '*' || oidcName(written) === oidcName(sent);
}

/**
 * A DN as compared: its letters' case set aside and the spaces around its commas and equals signs dropped, which no
 * directory counts ("CN=DJs, OU=Groups" is "cn=djs,ou=groups"). Escaped characters stay as they are.
 */
export function normalDn(dn: string): string {
  return dn
    .trim()
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s*(?<!\\),\s*/g, ',')
    .replace(/\s*(?<!\\)=\s*/g, '=');
}

/** The name of the entry a DN names: the value of its first part ("DJs" for "CN=DJs,OU=Groups,DC=corp"). */
export function firstValue(dn: string): string {
  // Up to the first comma that is not escaped, after the first equals sign.
  const first = /^(?:[^,\\]|\\.)*/.exec(dn)?.[0] ?? dn;
  const value = first.slice(first.indexOf('=') + 1).trim();
  // Escapes undone: \, \+ \" \\ and \XX hex pairs (RFC 4514).
  return value.replace(/\\([0-9a-fA-F]{2}|.)/g, (_, escaped: string) =>
    escaped.length === 2 ? String.fromCharCode(Number.parseInt(escaped, 16)) : escaped,
  );
}

/**
 * Whether a group of the directory (by its DN) is the one written in a list: a written DN (it has an "=") matches the
 * same DN, a plain name the group's own name (its first part's value), case set aside; `*` is every group.
 */
export function sameLdapGroup(written: string, groupDn: string): boolean {
  if (written === '*') return true;
  if (written.includes('=')) return normalDn(written) === normalDn(groupDn);
  return written.trim().normalize('NFC').toLowerCase() === firstValue(groupDn).normalize('NFC').toLowerCase();
}

/**
 * The widest level a person's groups reach, or null when none of them is in any list (they are refused). A `*` in a
 * list gives its level to everyone the provider lets in, groups or none.
 */
export function levelOf(
  found: readonly string[],
  groups: LevelGroups,
  same: (written: string, sent: string) => boolean,
): MemberLevel | null {
  for (const level of LEVELS) {
    const written = groups[level];
    if (written.includes('*')) return level;
    if (written.some((name) => found.some((group) => same(name, group)))) return level;
  }
  return null;
}
