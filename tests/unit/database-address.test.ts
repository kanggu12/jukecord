/**
 * The database's address (JUKECORD_DATABASE_URL): every form it takes, what it refuses and why, and that nothing
 * printed of it carries the password.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AddressError,
  describeAddress,
  parseDatabaseAddress,
  type ServerAddress,
  sameDatabase,
  withoutPassword,
} from '../../src/store/address.ts';

const DATA = path.resolve('/srv/jukecord-data');

// An address that must be a server's.
function server(text: string): ServerAddress {
  const address = parseDatabaseAddress(text, DATA);
  assert.notEqual(address.kind, 'sqlite');
  return address as ServerAddress;
}

describe('a SQLite address', () => {
  it('is the data folder’s jukecord.db alone, a path of its own, or the URL form with three slashes', () => {
    assert.deepEqual(parseDatabaseAddress('sqlite:', DATA), { kind: 'sqlite', file: path.join(DATA, 'jukecord.db') });
    assert.deepEqual(parseDatabaseAddress('  sqlite:  ', DATA), {
      kind: 'sqlite',
      file: path.join(DATA, 'jukecord.db'),
    });
    assert.deepEqual(parseDatabaseAddress('sqlite:/var/lib/music.db', DATA), {
      kind: 'sqlite',
      file: path.resolve('/var/lib/music.db'),
    });
    // A relative path is taken from the data folder, as the default file is.
    assert.deepEqual(parseDatabaseAddress('sqlite:other/music.db', DATA), {
      kind: 'sqlite',
      file: path.join(DATA, 'other', 'music.db'),
    });
    assert.deepEqual(parseDatabaseAddress('sqlite:///var/lib/music.db', DATA), {
      kind: 'sqlite',
      file: path.resolve('/var/lib/music.db'),
    });
    assert.throws(() => parseDatabaseAddress('sqlite://host/music.db', DATA), AddressError);
  });
});

describe('a server address', () => {
  it('reads the user, the password (percent-encoded), the host, the port and the database', () => {
    const address = server('postgres://music:p%40ss%3Aw0rd%2F@db.example.com:6543/jukecord');
    assert.equal(address.kind, 'postgres');
    assert.equal(address.product, 'PostgreSQL');
    assert.equal(address.user, 'music');
    assert.equal(address.password, 'p@ss:w0rd/');
    assert.equal(address.host, 'db.example.com');
    assert.equal(address.port, 6543);
    assert.equal(address.database, 'jukecord');
    assert.equal(address.tls, 'disable');
    assert.equal(address.connectTimeoutMs, 10_000);
    // Each kind's own port when none is given; postgresql:// is postgres://, mariadb:// is mysql:// as MariaDB.
    assert.equal(server('postgresql://u@db/j').port, 5432);
    assert.equal(server('mysql://u@db/j').port, 3306);
    assert.deepEqual([server('mariadb://u@db/j').kind, server('mariadb://u@db/j').product], ['mysql', 'MariaDB']);
    assert.equal(server('mysql://u@[::1]:3307/j').host, '::1');
  });

  it('takes TLS in libpq’s words and in MySQL’s, and refuses a mode that may fall back to none', () => {
    assert.equal(server('postgres://u@db/j?sslmode=require').tls, 'require');
    assert.equal(server('postgres://u@db/j?sslmode=verify-ca').tls, 'verify-ca');
    assert.equal(server('postgres://u@db/j?sslmode=verify-full').tls, 'verify-full');
    assert.equal(server('mysql://u@db/j?ssl-mode=REQUIRED').tls, 'require');
    assert.equal(server('mysql://u@db/j?ssl-mode=VERIFY_IDENTITY').tls, 'verify-full');
    assert.equal(server('mysql://u@db/j?ssl=true').tls, 'verify-full');
    assert.equal(server('mysql://u@db/j?ssl=false').tls, 'disable');
    // A root certificate alone means its chain is to be checked, as libpq reads it.
    assert.equal(server('postgres://u@db/j?sslrootcert=/etc/ca.pem').tls, 'verify-ca');
    assert.deepEqual(
      server('mysql://u@db/j?ssl-mode=VERIFY_CA&ssl-ca=/ca.pem&ssl-cert=/c.pem&ssl-key=/k.pem').tlsFiles,
      {
        ca: '/ca.pem',
        cert: '/c.pem',
        key: '/k.pem',
      },
    );
    assert.throws(() => server('postgres://u@db/j?sslmode=prefer'), /may fall back to no TLS/);
    assert.throws(() => server('postgres://u@db/j?sslmode=require&ssl=true'), /give one of them/);
  });

  it('refuses what it cannot use, saying what, never the password', () => {
    const refused = (text: string, reason: RegExp) =>
      assert.throws(
        () => parseDatabaseAddress(text, DATA),
        (error: unknown) =>
          error instanceof AddressError && reason.test(error.message) && !error.message.includes('secret'),
      );
    refused('postgres://user:secret@db.example.com', /names no database/);
    refused('postgres://:secret@db.example.com/j', /no user name/);
    refused('redis://user:secret@db.example.com/0', /not sqlite:, postgres:\/\//);
    refused('/var/lib/jukecord.db', /not an address/);
    refused('postgres://user:secret@db.example.com/j?sslmod=require', /does not take the parameter "sslmod"/);
    refused('mysql://user:secret@db.example.com/j?schema=music', /does not take the parameter "schema"/);
    refused('postgres://user:secret@db.example.com/j?schema=music;drop', /not a plain name/);
    refused('postgres://user:secret@db.example.com/j?connect_timeout=0', /1 to 300/);
    refused('postgres://user:secret@db.example.com/a/b', /names no database/);
  });

  it('reaches a socket instead of a host, and a PostgreSQL schema of its own', () => {
    const socket = server('postgres://jukecord@/jukecord?host=/run/postgresql&schema=music');
    assert.deepEqual([socket.host, socket.socket, socket.schema], ['', '/run/postgresql', 'music']);
    assert.equal(
      server('mysql://jukecord@localhost/jukecord?socket=/run/mysqld/mysqld.sock').socket,
      '/run/mysqld/mysqld.sock',
    );
    assert.equal(server('postgres://u@db/j?connect_timeout=3').connectTimeoutMs, 3000);
  });
});

describe('an address in words', () => {
  it('names the kind and the place, never the user or the password', () => {
    const said = describeAddress(server('postgres://music:secret-word@db.example.com/jukecord?sslmode=verify-full'));
    assert.equal(said, 'PostgreSQL (db.example.com:5432, database jukecord, TLS verify-full)');
    assert.equal(describeAddress(server('mariadb://m:s@db:3307/j')), 'MariaDB (db:3307, database j, without TLS)');
    assert.equal(
      describeAddress(server('postgres://u@/j?host=/run/postgresql&schema=music')),
      'PostgreSQL (/run/postgresql, database j, schema music, without TLS)',
    );
    assert.equal(describeAddress(parseDatabaseAddress('sqlite:', DATA)), `SQLite (${path.join(DATA, 'jukecord.db')})`);
  });

  it('tells the same database from another, whatever the scheme and the password', () => {
    const same = (a: string, b: string) => sameDatabase(parseDatabaseAddress(a, DATA), parseDatabaseAddress(b, DATA));
    assert.equal(same('postgres://a:x@db/j', 'postgresql://b:y@DB:5432/j'), true);
    assert.equal(same('postgres://a@db/j', 'postgres://a@db/j?schema=other'), false);
    assert.equal(same('mysql://a@db/j', 'mariadb://a@db/j'), true);
    assert.equal(same('mysql://a@db/j', 'postgres://a@db/j'), false);
    assert.equal(same('sqlite:', `sqlite:${path.join(DATA, 'jukecord.db')}`), true);
    assert.equal(same('sqlite:', 'postgres://a@db/j'), false);
  });

  it('repeats an address as it was typed without its password, whatever characters the password holds', () => {
    // Percent-encoded, and not: with / (base64), ? # and @ in it, where the address is not read as one at all.
    assert.equal(withoutPassword('postgres://music:secret@db/j'), 'postgres://music:…@db/j');
    assert.equal(withoutPassword('postgres://music:pa/ss=@db:5432/j'), 'postgres://music:…@db:5432/j');
    assert.equal(
      withoutPassword('mysql://music:p?a#s@db/j?ssl-mode=REQUIRED'),
      'mysql://music:…@db/j?ssl-mode=REQUIRED',
    );
    assert.equal(withoutPassword('mysql://music:p@ss@db/j'), 'mysql://music:…@db/j');
    assert.equal(withoutPassword('postgres://music:pa%2Fss@db/j'), 'postgres://music:…@db/j');
    // No password to leave out: a user alone, no user, a port's colon after the host, a SQLite path.
    assert.equal(withoutPassword('postgres://music@db:5432/j'), 'postgres://music@db:5432/j');
    assert.equal(withoutPassword('postgres://db:5432/j'), 'postgres://db:5432/j');
    assert.equal(withoutPassword('sqlite:/srv/a:b@c.db'), 'sqlite:/srv/a:b@c.db');
  });
});
