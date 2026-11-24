/**
 * The database's address (JUKECORD_DATABASE_URL), read into what an executor needs to reach it.
 *
 *   sqlite:                          the file jukecord.db in the data folder (the default)
 *   sqlite:/var/lib/jukecord/my.db   a file of its own (a relative path is taken from the data folder)
 *   postgres://user:password@host:5432/database?sslmode=verify-full
 *   mysql://user:password@host:3306/database      (MySQL or MariaDB; mariadb:// is the same)
 *
 * TLS is asked for in the address with libpq's words, for both kinds of server: sslmode=disable (the default, as the
 * drivers' own), require (encrypted, the certificate not checked), verify-ca (signed by a known authority) or
 * verify-full (and made out to the host's name); sslrootcert names the authority's certificate (the system's are used
 * without it), sslcert and sslkey a certificate of jukecord's own. MySQL's names are taken too (ssl-mode=REQUIRED,
 * VERIFY_CA, VERIFY_IDENTITY; ssl-ca, ssl-cert, ssl-key). connect_timeout is in seconds (10 by default), schema picks
 * a PostgreSQL schema (public by default), host a PostgreSQL socket's folder and socket a MySQL socket.
 *
 * Nothing here reads a file or the network: the certificates are read when the executor opens, so the settings can be
 * checked (and tested) on their own.
 */
import path from 'node:path';

/** How a connection to a database server is encrypted and what of the server is checked (libpq's sslmode). */
export type TlsMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

/** A SQLite database: one file on this machine. */
export interface SqliteAddress {
  readonly kind: 'sqlite';
  /** The file's absolute path. */
  readonly file: string;
}

/** A database on a PostgreSQL or a MySQL/MariaDB server. */
export interface ServerAddress {
  readonly kind: 'postgres' | 'mysql';
  /** The program the address names: what is said of it before it answers (a mysql:// address may be a MariaDB). */
  readonly product: 'PostgreSQL' | 'MySQL' | 'MariaDB';
  /** The server's host name or address; empty when it is reached by its socket. */
  readonly host: string;
  readonly port: number;
  /** A socket to reach it by instead (PostgreSQL: the socket's folder; MySQL: the socket itself), or null. */
  readonly socket: string | null;
  readonly user: string;
  /** The password, or null when the address gives none (a server that trusts this user, or peer login). */
  readonly password: string | null;
  readonly database: string;
  /** PostgreSQL only: the schema jukecord's tables live in, or null for the user's default (public). */
  readonly schema: string | null;
  readonly tls: TlsMode;
  /** Certificate files for TLS, as paths (read when the executor opens). */
  readonly tlsFiles: { readonly ca: string | null; readonly cert: string | null; readonly key: string | null };
  /** How long connecting may take before it counts as no answer. */
  readonly connectTimeoutMs: number;
}

export type DatabaseAddress = SqliteAddress | ServerAddress;

/** An address that cannot be used; the message says why, without the password. */
export class AddressError extends Error {
  override name = 'AddressError';
}

// The schemes of each kind of server, and the port each listens on by default.
const SERVERS: Readonly<
  Record<string, { kind: 'postgres' | 'mysql'; product: ServerAddress['product']; port: number }>
> = {
  'postgres:': { kind: 'postgres', product: 'PostgreSQL', port: 5432 },
  'postgresql:': { kind: 'postgres', product: 'PostgreSQL', port: 5432 },
  'mysql:': { kind: 'mysql', product: 'MySQL', port: 3306 },
  'mariadb:': { kind: 'mysql', product: 'MariaDB', port: 3306 },
};

// The TLS words of either naming (libpq's lower-case ones, MySQL's upper-case ones), to jukecord's four modes. The
// modes that fall back to no encryption at all ("prefer", "allow", "PREFERRED") are left out on purpose: an address
// says whether it wants TLS or not.
const TLS_MODES: Readonly<Record<string, TlsMode>> = {
  disable: 'disable',
  disabled: 'disable',
  require: 'require',
  required: 'require',
  'verify-ca': 'verify-ca',
  verify_ca: 'verify-ca',
  'verify-full': 'verify-full',
  verify_identity: 'verify-full',
};

// The parameters an address may carry, each under its libpq name and its MySQL name, and which kinds take it.
const PARAMETERS: Readonly<Record<string, { name: string; kinds: readonly ('postgres' | 'mysql')[] }>> = {
  sslmode: { name: 'sslmode', kinds: ['postgres', 'mysql'] },
  'ssl-mode': { name: 'sslmode', kinds: ['postgres', 'mysql'] },
  ssl: { name: 'ssl', kinds: ['postgres', 'mysql'] },
  sslrootcert: { name: 'sslrootcert', kinds: ['postgres', 'mysql'] },
  'ssl-ca': { name: 'sslrootcert', kinds: ['postgres', 'mysql'] },
  sslcert: { name: 'sslcert', kinds: ['postgres', 'mysql'] },
  'ssl-cert': { name: 'sslcert', kinds: ['postgres', 'mysql'] },
  sslkey: { name: 'sslkey', kinds: ['postgres', 'mysql'] },
  'ssl-key': { name: 'sslkey', kinds: ['postgres', 'mysql'] },
  connect_timeout: { name: 'connect_timeout', kinds: ['postgres', 'mysql'] },
  schema: { name: 'schema', kinds: ['postgres'] },
  host: { name: 'host', kinds: ['postgres'] },
  socket: { name: 'socket', kinds: ['mysql'] },
};

// The host put into an address that names none before its path (see parseDatabaseAddress): .invalid is reserved for
// names that are never a host's.
const NO_HOST = 'no-host.invalid';

// A schema's name as jukecord accepts it: a plain identifier, so it can be written into a statement unquoted.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The file a SQLite address names when it names none: jukecord.db in the data folder. */
export function defaultSqliteFile(dataDir: string): string {
  return path.join(dataDir, 'jukecord.db');
}

/**
 * Reads a database's address. A SQLite path is taken from the data folder when it is relative; nothing is checked
 * on the disk or the network here.
 */
export function parseDatabaseAddress(text: string, dataDir: string): DatabaseAddress {
  const address = text.trim();
  // SQLite: the rest of the text is a path, as it is (no percent signs to decode, Windows' drive letters kept).
  if (/^sqlite:/i.test(address)) return { kind: 'sqlite', file: sqliteFile(address.slice('sqlite:'.length), dataDir) };
  let url: URL;
  try {
    // libpq's socket form puts the user before an empty host (postgres://user@/database?host=/run/postgresql), which a
    // URL cannot hold: a host that cannot be one is put in to read it, and taken out again below.
    url = new URL(address.replace(/^([a-z]+:\/\/[^/?#@]*@)(?=\/)/i, `$1${NO_HOST}`));
  } catch {
    throw new AddressError('is not an address like postgres://user:password@host/database, mysql://... or sqlite:');
  }
  const server = SERVERS[url.protocol.toLowerCase()];
  if (!server) {
    throw new AddressError(
      `starts with ${url.protocol}//, not sqlite:, postgres://, postgresql://, mysql:// or mariadb://`,
    );
  }
  // Every parameter is one jukecord knows, for this kind of server: a misspelt one would be ignored otherwise.
  const parameters = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    const known = PARAMETERS[key.toLowerCase()];
    if (!known?.kinds.includes(server.kind)) {
      throw new AddressError(`does not take the parameter "${key}" for ${server.product}`);
    }
    if (parameters.has(known.name)) throw new AddressError(`gives ${known.name} twice`);
    parameters.set(known.name, value);
  }
  // The user and password are percent-encoded in the address, so a password may hold any character.
  const decode = (part: string, what: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new AddressError(`has a ${what} that is not percent-encoded properly`);
    }
  };
  const user = decode(url.username, 'user name');
  if (user === '') throw new AddressError('has no user name (postgres://user:password@host/database)');
  const password = url.password === '' ? null : decode(url.password, 'password');
  // The database is the path's one part; a server has many, and jukecord does not guess which.
  const database = decode(url.pathname.replace(/^\//, ''), 'database name');
  if (database === '' || database.includes('/')) {
    throw new AddressError('names no database (the part after the host: .../jukecord)');
  }
  const socket = server.kind === 'postgres' ? (parameters.get('host') ?? null) : (parameters.get('socket') ?? null);
  // A host, or a socket to reach the server by; postgres:///jukecord?host=/run/postgresql has only the latter.
  const host = url.hostname === NO_HOST ? '' : url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '' && socket === null) throw new AddressError('names no host');
  const port = url.port === '' ? server.port : Number(url.port);
  const schema = parameters.get('schema') ?? null;
  if (schema !== null && !IDENTIFIER.test(schema)) {
    throw new AddressError(`has a schema "${schema}" that is not a plain name (letters, digits and _)`);
  }
  return {
    kind: server.kind,
    product: server.product,
    host,
    port,
    socket,
    user,
    password,
    database,
    schema,
    tls: tlsMode(parameters),
    tlsFiles: {
      ca: parameters.get('sslrootcert') ?? null,
      cert: parameters.get('sslcert') ?? null,
      key: parameters.get('sslkey') ?? null,
    },
    connectTimeoutMs: seconds(parameters.get('connect_timeout') ?? '10') * 1000,
  };
}

// The TLS mode an address asks for: sslmode (either naming), or ssl=true (verified, as Node's TLS is by default).
function tlsMode(parameters: ReadonlyMap<string, string>): TlsMode {
  const mode = parameters.get('sslmode');
  const ssl = parameters.get('ssl');
  if (mode !== undefined && ssl !== undefined) throw new AddressError('gives sslmode and ssl; give one of them');
  if (ssl !== undefined) {
    if (/^(true|1)$/i.test(ssl)) return 'verify-full';
    if (/^(false|0)$/i.test(ssl)) return 'disable';
    throw new AddressError(`has ssl=${ssl}; it is true or false`);
  }
  if (mode === undefined) {
    // Certificates without a mode mean TLS was wanted: as libpq does with a root certificate, the chain is checked.
    return parameters.has('sslrootcert') ? 'verify-ca' : 'disable';
  }
  const known = TLS_MODES[mode.toLowerCase()];
  if (!known) {
    throw new AddressError(
      `has sslmode=${mode}; it is disable, require, verify-ca or verify-full (a mode that may fall back to no TLS is not taken)`,
    );
  }
  return known;
}

// A whole number of seconds from 1 to 300, for connect_timeout.
function seconds(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 300) {
    throw new AddressError(`has connect_timeout=${text}; it is a whole number of seconds from 1 to 300`);
  }
  return Number(text);
}

// The file of a SQLite address, from what follows "sqlite:": nothing (the data folder's jukecord.db), a path, or the
// URL form sqlite:///path (an empty host, then the path).
function sqliteFile(rest: string, dataDir: string): string {
  let file = rest;
  if (file.startsWith('//')) {
    file = file.slice(2);
    // sqlite://somewhere/file.db: a host, which a file on this machine does not have.
    if (file !== '' && !file.startsWith('/')) throw new AddressError('sqlite: takes a path, not a host');
    // sqlite:///C:/data/jukecord.db: a Windows drive after the URL form's slash.
    if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1);
  }
  if (file === '') return defaultSqliteFile(dataDir);
  return path.resolve(dataDir, file);
}

/** The address in words for logs, the status and the doctor: the kind and where, never the user or the password. */
export function describeAddress(address: DatabaseAddress): string {
  if (address.kind === 'sqlite') return `SQLite (${address.file})`;
  const where = address.socket !== null && address.host === '' ? address.socket : `${address.host}:${address.port}`;
  const schema = address.schema === null ? '' : `, schema ${address.schema}`;
  const tls = address.tls === 'disable' ? 'without TLS' : `TLS ${address.tls}`;
  return `${address.product} (${where}, database ${address.database}${schema}, ${tls})`;
}

/** Whether two addresses are the same database (a copy onto itself would empty it first). */
export function sameDatabase(a: DatabaseAddress, b: DatabaseAddress): boolean {
  if (a.kind === 'sqlite') return b.kind === 'sqlite' && a.file === b.file;
  if (b.kind === 'sqlite') return false;
  // The same server (host and port, or socket), database and schema; the product word of the scheme does not matter.
  return (
    a.kind === b.kind &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.socket === b.socket &&
    a.database === b.database &&
    (a.schema ?? 'public') === (b.schema ?? 'public')
  );
}
