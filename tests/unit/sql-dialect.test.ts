/**
 * The words of SQL that differ between the databases, as the dialects write them; the placeholders numbered for
 * PostgreSQL; a migration's statements split for MySQL; the drivers' errors told apart; the TLS options of each mode.
 * What each statement does on each database is the store tests' part (tests/support/databases.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerAddress } from '../../src/store/address.ts';
import { mysqlDialect, POSTGRES, SQLITE } from '../../src/store/dialect.ts';
import { splitStatements } from '../../src/store/mysql.ts';
import { ConnectionError, connectionFailure, tlsOptions } from '../../src/store/network.ts';
import { numberPlaceholders } from '../../src/store/postgres.ts';
import { isUniqueViolation, statementKind } from '../../src/store/sql.ts';

// A track's upsert, as the repository asks for it.
const TRACK = {
  table: 'tracks',
  columns: ['source', 'url', 'title'],
  key: ['source'],
  update: [
    'url',
    [
      'title',
      (incoming: (c: string) => string, current: (c: string) => string) =>
        `COALESCE(${incoming('title')}, ${current('title')})`,
    ] as const,
  ],
  id: true,
};

describe('the dialects', () => {
  it('write an upsert each their own way, the row’s id said by each', () => {
    assert.equal(
      SQLITE.upsert(TRACK),
      'INSERT INTO tracks (source, url, title) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET url = excluded.url, title = COALESCE(excluded.title, tracks.title) RETURNING id',
    );
    assert.equal(SQLITE.upsert(TRACK), POSTGRES.upsert(TRACK));
    assert.equal(
      mysqlDialect(false).upsert(TRACK),
      'INSERT INTO tracks (source, url, title) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), url = new.url, title = COALESCE(new.title, tracks.title)',
    );
    assert.equal(
      mysqlDialect(true).upsert(TRACK),
      'INSERT INTO tracks (source, url, title) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), url = VALUES(url), title = COALESCE(VALUES(title), tracks.title)',
    );
  });

  it('quote a column whose name is a reserved word somewhere', () => {
    const spec = { table: 'player_state', columns: ['guild_id', 'repeat'], key: ['guild_id'], update: ['repeat'] };
    assert.match(SQLITE.upsert(spec), /\(guild_id, "repeat"\).*"repeat" = excluded\."repeat"/);
    assert.match(mysqlDialect(false).upsert(spec), /"repeat" = new\."repeat"/);
  });

  it('compare with null, divide whole numbers, order nulls first and ignore a taken key each their own way', () => {
    assert.deepEqual(
      [SQLITE, POSTGRES, mysqlDialect(false)].map((dialect) => [
        dialect.same('a'),
        dialect.differs('a'),
        dialect.quotient('x + ?', 1000),
        dialect.nullsFirst('a'),
        dialect.wholeNumber,
      ]),
      [
        ['a IS ?', 'a IS NOT ?', '(x + ?) / 1000', 'a', 'CAST(? AS INTEGER)'],
        ['a IS NOT DISTINCT FROM ?', 'a IS DISTINCT FROM ?', '(x + ?) / 1000', 'a NULLS FIRST', 'CAST(? AS BIGINT)'],
        ['a <=> ?', 'NOT (a <=> ?)', '(x + ?) DIV 1000', 'a', 'CAST(? AS SIGNED)'],
      ],
    );
    assert.equal(SQLITE.insertOrIgnore('likes', ['owner']), 'INSERT OR IGNORE INTO likes (owner) VALUES (?)');
    assert.equal(
      POSTGRES.insertOrIgnore('likes', ['owner']),
      'INSERT INTO likes (owner) VALUES (?) ON CONFLICT DO NOTHING',
    );
    assert.equal(mysqlDialect(false).insertOrIgnore('likes', ['owner']), 'INSERT INTO likes (owner) VALUES (?)');
    assert.equal(mysqlDialect(false).ignoresDuplicates, false);
  });

  it('find a track by its source: the text on SQLite, its hash and the text on the servers', () => {
    assert.deepEqual(SQLITE.bySource('t', 's'), { where: 't.source = ?', params: ['s'] });
    assert.deepEqual(POSTGRES.bySource('t', 's').params, ['s', 's']);
    assert.match(POSTGRES.bySource('t', 's').where, /^t\.source_hash = sha256\(.*\) AND t\.source = \?$/);
    assert.equal(mysqlDialect(true).bySource('t', 's').where, 't.source_hash = UNHEX(SHA2(?, 256)) AND t.source = ?');
  });
});

describe('placeholders for PostgreSQL', () => {
  it('are numbered in order, outside quoted text, quoted names and comments', () => {
    assert.equal(numberPlaceholders('SELECT ? AS a, ? AS b WHERE c = ?'), 'SELECT $1 AS a, $2 AS b WHERE c = $3');
    assert.equal(
      numberPlaceholders(`SELECT '?', 'it''s ?', "a?b", ? -- what?\nFROM t /* ? */ WHERE x = ?`),
      `SELECT '?', 'it''s ?', "a?b", $1 -- what?\nFROM t /* ? */ WHERE x = $2`,
    );
  });
});

describe('a migration’s statements for MySQL', () => {
  it('are split at the semicolons that end them, not those in text, names or comments', () => {
    assert.deepEqual(
      splitStatements(`
        -- a comment; with a semicolon
        CREATE TABLE a (x TEXT DEFAULT ';');
        /* another; */ INSERT INTO a VALUES ('it''s; here', "b;c", \`d;e\`);

        ;
        SELECT 1`),
      [
        "-- a comment; with a semicolon\n        CREATE TABLE a (x TEXT DEFAULT ';')",
        "/* another; */ INSERT INTO a VALUES ('it''s; here', \"b;c\", `d;e`)",
        'SELECT 1',
      ],
    );
  });
});

describe('the drivers’ errors', () => {
  it('tell a taken key apart on each database', () => {
    const errorWith = (fields: Record<string, unknown>) => Object.assign(new Error('refused'), fields);
    // node:sqlite's UNIQUE and PRIMARY KEY, PostgreSQL's 23505, MySQL's ER_DUP_ENTRY.
    assert.equal(isUniqueViolation(errorWith({ errcode: 2067 })), true);
    assert.equal(isUniqueViolation(errorWith({ errcode: 1555 })), true);
    assert.equal(isUniqueViolation(errorWith({ code: '23505' })), true);
    assert.equal(isUniqueViolation(errorWith({ errno: 1062, code: 'ER_DUP_ENTRY' })), true);
    // A foreign key, a deadlock, or no error at all: not a taken key.
    assert.equal(isUniqueViolation(errorWith({ errcode: 787 })), false);
    assert.equal(isUniqueViolation(errorWith({ code: '40P01' })), false);
    assert.equal(isUniqueViolation('UNIQUE'), false);
  });

  it('say a connection that failed in words, and whether waiting may help', () => {
    const address: ServerAddress = {
      kind: 'postgres',
      product: 'PostgreSQL',
      host: 'db.example.com',
      port: 5432,
      socket: null,
      user: 'music',
      password: 'secret',
      database: 'jukecord',
      schema: null,
      tls: 'disable',
      tlsFiles: { ca: null, cert: null, key: null },
      connectTimeoutMs: 10_000,
    };
    const said = (fields: Record<string, unknown>, message = 'failed') =>
      connectionFailure(Object.assign(new Error(message), fields), address);
    const refused = said({ code: 'ECONNREFUSED' });
    assert.ok(refused instanceof ConnectionError);
    assert.deepEqual(
      [refused.transient, /nothing answers at db\.example\.com:5432/.test(refused.message)],
      [true, true],
    );
    assert.equal(said({ code: 'ENOTFOUND' })?.transient, true);
    assert.deepEqual(
      [said({ code: '28P01' })?.transient, said({ code: '28P01' })?.message],
      [false, 'the user name or password was refused by db.example.com:5432'],
    );
    assert.match(said({ code: '3D000' })?.message ?? '', /no database "jukecord"/);
    assert.equal(said({ code: '57P03' })?.transient, true);
    assert.equal(said({ errno: 1045 })?.transient, false);
    assert.equal(said({}, 'self-signed certificate in certificate chain')?.transient, false);
    // A statement's own error is no connection failure.
    assert.equal(said({ code: '23505' }), null);
    // Nothing of it carries the password.
    for (const fields of [{ code: 'ECONNREFUSED' }, { code: '28P01' }, { errno: 1049 }]) {
      assert.doesNotMatch(said(fields)?.message ?? '', /secret/);
    }
  });

  it('count each statement under the kind of its first word', () => {
    assert.deepEqual(
      [
        'SELECT 1',
        ' insert into t',
        '\n  UPDATE t',
        'DELETE FROM t',
        'WITH x AS (SELECT 1) SELECT 1',
        'BEGIN',
        'SAVEPOINT sp1',
        'REPLACE INTO t VALUES (1)',
        'PRAGMA user_version',
        '-- a\nSELECT 1',
      ].map(statementKind),
      ['select', 'insert', 'update', 'delete', 'select', 'transaction', 'transaction', 'insert', 'other', 'select'],
    );
  });
});

describe('TLS from the address', () => {
  const at = (tls: ServerAddress['tls']): ServerAddress => ({
    kind: 'mysql',
    product: 'MySQL',
    host: 'db',
    port: 3306,
    socket: null,
    user: 'u',
    password: null,
    database: 'j',
    schema: null,
    tls,
    tlsFiles: { ca: null, cert: null, key: null },
    connectTimeoutMs: 10_000,
  });

  it('checks nothing for require, the chain for verify-ca, the chain and the name for verify-full', () => {
    assert.equal(tlsOptions(at('disable')), null);
    assert.deepEqual(tlsOptions(at('require')), { options: { rejectUnauthorized: false }, verify: 'none' });
    const chain = tlsOptions(at('verify-ca'));
    assert.equal(chain?.verify, 'chain');
    assert.equal(chain?.options.rejectUnauthorized, true);
    // The name is not checked: any certificate the authority signed passes.
    assert.equal(chain?.options.checkServerIdentity?.('db', {} as never), undefined);
    assert.deepEqual(tlsOptions(at('verify-full')), { options: { rejectUnauthorized: true }, verify: 'full' });
  });

  it('says which certificate file cannot be read', () => {
    const address = { ...at('verify-full'), tlsFiles: { ca: '/nowhere/ca.pem', cert: null, key: null } };
    assert.throws(() => tlsOptions(address), /root certificate \(sslrootcert\) file \/nowhere\/ca\.pem/);
  });
});
