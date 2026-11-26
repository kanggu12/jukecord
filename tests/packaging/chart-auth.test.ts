/**
 * The chart's logins (auth): the OIDC and LDAP settings given to the pods that serve browsers (the one pod; in split
 * mode the edges, and not the core), the client's secret and the bind password as files from the chart's Secret or
 * one of the user's, a private CA mounted for both, the way out to the provider and the directory, and the refusals:
 * every login setting in env or extraEnv (checked against src/auth/settings.ts's own list), and values that cannot
 * work together. Rendered and validated with helm and kubeconform when they are installed (CI installs both).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AUTH_VARIABLES } from '../../src/auth/settings.ts';

// Whether a program answers `<program> <args>`.
function have(program: string, args = ['version']): boolean {
  try {
    execFileSync(program, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The values every split render needs: a database and a bus.
const SPLIT = [
  '--set',
  'mode=split',
  '--set',
  'database.url=postgres://j:p@db:5432/j',
  '--set',
  'bus.url=redis://v:6379',
];

// Both ways of logging in, as a host with a Keycloak and a directory writes them (a private authority of theirs is the
// chart's ca, which every connection trusts: tests/packaging/chart-ca.test.ts).
const LOGINS = `auth:
  oidc:
    issuer: https://sso.example.com/realms/home
    clientId: jukecord
    clientSecret: the-client-secret
    scopes: [openid, profile, groups]
    groupsClaim: realm_access.roles
    adminGroups: [jukecord-admins]
    readGroups: ["*"]
  ldap:
    url: ldaps://ldap.example.com
    bindDn: cn=jukecord,ou=services,dc=example,dc=org
    bindPassword: the-bind-password
    baseDn: dc=example,dc=org
    groupFilter: (member={dn})
    controlGroups: ["cn=dj,ou=groups,dc=example,dc=org", listeners]
  egressTo:
    - to:
        - ipBlock:
            cidr: 10.20.0.5/32
      ports:
        - port: 636
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-chart-auth-'));
const logins = path.join(dir, 'logins.yaml');
fs.writeFileSync(logins, LOGINS);

// The chart rendered with these values, or the error it refused them with.
function render(...values: string[]): string {
  try {
    return execFileSync('helm', ['template', 't', 'deploy/helm/jukecord', ...values], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return `refused: ${String((error as { stderr?: Buffer }).stderr ?? error)}`;
  }
}

// One object of a render, by its kind and name.
function object(rendered: string, kind: string, name: string): string {
  const found = rendered
    .split(/^---$/m)
    .find((part) => part.includes(`\nkind: ${kind}\n`) && part.includes(`\n  name: ${name}\n`));
  assert.ok(found, `no ${kind} ${name}`);
  return found;
}

// A variable's value in a container's env, or undefined.
function variable(part: string, name: string): string | undefined {
  return new RegExp(`- name: ${name}\\n\\s+value: (.+)\\n`).exec(part)?.[1];
}

// What a pod that logs people in carries: every setting, and the two secrets as files.
function logsPeopleIn(part: string): void {
  assert.equal(variable(part, 'JUKECORD_OIDC_ISSUER'), '"https://sso.example.com/realms/home"');
  assert.equal(variable(part, 'JUKECORD_OIDC_SCOPES'), '"openid profile groups"');
  assert.equal(variable(part, 'JUKECORD_OIDC_READ_GROUPS'), '"*"');
  assert.equal(variable(part, 'JUKECORD_OIDC_CLIENT_SECRET_FILE'), '/run/secrets/jukecord-auth/oidcClientSecret');
  assert.equal(variable(part, 'JUKECORD_LDAP_CONTROL_GROUPS'), '"cn=dj,ou=groups,dc=example,dc=org;listeners"');
  assert.equal(variable(part, 'JUKECORD_LDAP_BIND_PASSWORD_FILE'), '/run/secrets/jukecord-auth/ldapBindPassword');
  // No authority of their own: the chart's ca is every connection's.
  assert.equal(variable(part, 'JUKECORD_LDAP_CA_FILE'), undefined);
  assert.equal(variable(part, 'NODE_EXTRA_CA_CERTS'), undefined);
  // The secrets never as variables.
  assert.equal(variable(part, 'JUKECORD_OIDC_CLIENT_SECRET'), undefined);
  assert.equal(variable(part, 'JUKECORD_LDAP_BIND_PASSWORD'), undefined);
  assert.doesNotMatch(part, /the-client-secret|the-bind-password/);
  assert.match(part, /- name: auth\n\s+mountPath: \/run\/secrets\/jukecord-auth\n\s+readOnly: true/);
  assert.match(part, /- key: oidcClientSecret\n\s+path: oidcClientSecret/);
  assert.match(part, /- key: ldapBindPassword\n\s+path: ldapBindPassword/);
  assert.match(part, /checksum\/auth: [0-9a-f]{16}\n/);
}

describe("the chart's logins", { skip: !have('helm') && 'helm is not installed' }, () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('give the one pod the settings, and the two secrets as files from its Secret', () => {
    const rendered = render('-f', logins);
    logsPeopleIn(object(rendered, 'Deployment', 't-jukecord'));
    const secret = object(rendered, 'Secret', 't-jukecord-auth');
    assert.match(secret, /oidcClientSecret: "the-client-secret"/);
    assert.match(secret, /ldapBindPassword: "the-bind-password"/);
    // The way out to the directory, for the pod that logs people in (the values' rule as given).
    const policy = object(rendered, 'NetworkPolicy', 't-jukecord');
    assert.match(policy, /cidr: 10\.20\.0\.5\/32\n/);
    assert.match(policy, /- port: 636\n/);
    assert.doesNotMatch(policy, /^\s+$/m, 'no blank line among the rules');
  });

  it('give them to the edges in split mode, and nothing of them to the core', () => {
    const rendered = render('-f', logins, ...SPLIT);
    logsPeopleIn(object(rendered, 'Deployment', 't-jukecord-edge'));
    const core = object(rendered, 'Deployment', 't-jukecord-core');
    assert.doesNotMatch(core, /JUKECORD_OIDC_|JUKECORD_LDAP_|NODE_EXTRA_CA_CERTS|jukecord-auth/);
    assert.match(object(rendered, 'NetworkPolicy', 't-jukecord-edge'), /cidr: 10\.20\.0\.5\/32/);
    assert.doesNotMatch(object(rendered, 'NetworkPolicy', 't-jukecord-core'), /10\.20\.0\.5/);
  });

  it("read the secrets from Secrets of the user's under the keys the values name, and set nothing when off", () => {
    const theirs = render(
      '-f',
      logins,
      '--set',
      'auth.oidc.clientSecret=',
      '--set',
      'auth.oidc.existingSecret=my-sso',
      '--set',
      'auth.ldap.bindPassword=',
      '--set',
      'auth.ldap.existingSecret=my-directory',
    );
    const pod = object(theirs, 'Deployment', 't-jukecord');
    assert.match(pod, /name: my-sso\n\s+items:\n\s+- key: oidcClientSecret/);
    assert.match(pod, /name: my-directory\n\s+items:\n\s+- key: ldapBindPassword/);
    assert.doesNotMatch(theirs, /name: t-jukecord-auth\n/);
    // A public client and an anonymous search: only the settings.
    const plain = render(
      '-f',
      logins,
      '--set',
      'auth.oidc.clientSecret=',
      '--set',
      'auth.ldap.bindDn=',
      '--set',
      'auth.ldap.bindPassword=',
    );
    const bare = object(plain, 'Deployment', 't-jukecord');
    assert.equal(variable(bare, 'JUKECORD_OIDC_CLIENT_SECRET_FILE'), undefined);
    assert.doesNotMatch(bare, /name: auth\n/);
    // Both off (the default): no setting, no Secret, no checksum change from them.
    const off = render();
    assert.doesNotMatch(off, /JUKECORD_OIDC_|JUKECORD_LDAP_|t-jukecord-auth/);
  });

  it('restart the pods when a login setting or secret changes', () => {
    const checksum = (rendered: string) =>
      /checksum\/auth: (\w+)/.exec(object(rendered, 'Deployment', 't-jukecord'))?.[1];
    const before = checksum(render('-f', logins));
    assert.notEqual(checksum(render('-f', logins, '--set', 'auth.oidc.clientSecret=another')), before);
    assert.equal(checksum(render('-f', logins)), before);
  });

  it('refuse every login setting in env or extraEnv (the list of src/auth/settings.ts)', () => {
    for (const name of AUTH_VARIABLES) {
      assert.match(render('--set', `env.${name}=x`), new RegExp(`env: ${name} is not set here`), name);
    }
    assert.match(
      render('--set', 'extraEnv[0].name=JUKECORD_LDAP_BIND_PASSWORD', '--set', 'extraEnv[0].value=x'),
      /extraEnv: JUKECORD_LDAP_BIND_PASSWORD is not set here/,
    );
    // The directory's own authority file points at the chart's ca, which covers it.
    assert.match(
      render('--set', 'env.JUKECORD_LDAP_CA_FILE=/x'),
      /in the chart's ca \(a Secret or a ConfigMap of yours\)/,
    );
    // NODE_EXTRA_CA_CERTS is not the chart's (extraEnv may set it: env takes JUKECORD_ names only).
    const extra = ['--set', 'extraEnv[0].name=NODE_EXTRA_CA_CERTS', '--set', 'extraEnv[0].value=/x'];
    assert.doesNotMatch(render('-f', logins, ...extra), /^refused/);
  });

  it('refuse values that cannot work together, saying what to change', () => {
    const refusals: [string[], RegExp][] = [
      [['--set', 'auth.oidc.clientId=x'], /auth\.oidc\.clientId is set but auth\.oidc\.issuer is not/],
      [['--set', 'auth.ldap.baseDn=dc=x'], /auth\.ldap\.baseDn is set but auth\.ldap\.url is not/],
      [['-f', logins, '--set', 'auth.oidc.clientId='], /auth\.oidc\.issuer is set but auth\.oidc\.clientId is not/],
      [
        ['-f', logins, '--set', 'auth.oidc.adminGroups=null', '--set', 'auth.oidc.readGroups=null'],
        /auth\.oidc needs who may log in/,
      ],
      [['-f', logins, '--set', 'auth.ldap.baseDn='], /auth\.ldap\.url is set but auth\.ldap\.baseDn is not/],
      [['-f', logins, '--set', 'auth.ldap.bindPassword='], /auth\.ldap\.bindDn and its password .* go together/],
      [
        ['-f', logins, '--set', 'auth.oidc.existingSecret=s'],
        /auth\.oidc\.clientSecret and auth\.oidc\.existingSecret are both set/,
      ],
      [
        ['-f', logins, '--set', 'auth.ldap.existingSecret=s'],
        /auth\.ldap\.bindPassword and auth\.ldap\.existingSecret are both set/,
      ],
      // auth.ca is gone (the chart's ca is every connection's): the schema refuses it.
      [['--set', 'auth.ca.secret=s'], /don't meet the specifications of the schema/],
      [['--set', 'auth.oidc.issuer=sso.example.com'], /don't meet the specifications of the schema/],
      [['--set', 'auth.ldap.url=https://ldap.example.com'], /don't meet the specifications of the schema/],
    ];
    for (const [values, refusal] of refusals) assert.match(render(...values), refusal, values.join(' '));
  });

  it('pass kubeconform with the logins in both modes', {
    skip: !have('kubeconform', ['-v']) && 'kubeconform is not installed',
  }, () => {
    for (const [name, text] of [
      ['single.yaml', render('-f', logins)],
      ['split.yaml', render('-f', logins, ...SPLIT)],
    ] as const) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      execFileSync('kubeconform', ['-strict', '-summary', '-kubernetes-version', '1.31.0', file], { stdio: 'pipe' });
    }
  });
});
