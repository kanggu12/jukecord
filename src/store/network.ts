/**
 * What the two network databases' executors share: the TLS options an address asks for, the reason a connection
 * failed in words a person can act on, and which failures are worth waiting out at a start (the database still
 * starting, its name not known yet in a cluster) and which are not (a wrong password).
 */
import fs from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import type { ServerAddress } from './address.ts';

/**
 * The database cannot be reached, or refuses this jukecord; the message says why without the password. Not a
 * StoreError, which means a request the data does not allow (the panel's "invalid"): this is jukecord's own trouble,
 * logged, and a 500 to whoever asked.
 */
export class ConnectionError extends Error {
  override name = 'ConnectionError';
  /** Whether waiting may help: the server not up yet (or restarting), a name not known yet, no room for a connection. */
  readonly transient: boolean;

  constructor(message: string, transient: boolean, options?: ErrorOptions) {
    super(message, options);
    this.transient = transient;
  }
}

// A certificate file named in the address, read now (a missing one is said with its name, not as a TLS failure).
function certificate(file: string | null, what: string): string | undefined {
  if (file === null) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConnectionError(
      `the ${what} file ${file} in the database address cannot be read (${error instanceof Error ? error.message : String(error)})`,
      false,
    );
  }
}

/**
 * The TLS options of an address for Node's tls.connect, as both drivers take them (pg as `ssl`, mysql2 likewise with
 * its own words for the checks), or null for none. libpq's meanings: require encrypts and checks nothing (unless a
 * root certificate is given, which makes it verify-ca), verify-ca checks the chain, verify-full the chain and the name.
 */
export function tlsOptions(
  address: ServerAddress,
): { readonly options: ConnectionOptions; readonly verify: 'none' | 'chain' | 'full' } | null {
  if (address.tls === 'disable') return null;
  const ca = certificate(address.tlsFiles.ca, 'root certificate (sslrootcert)');
  const cert = certificate(address.tlsFiles.cert, 'certificate (sslcert)');
  const key = certificate(address.tlsFiles.key, 'key (sslkey)');
  // Only the files that were given: Node's own authorities are used when no root certificate is named.
  const files: ConnectionOptions = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
  };
  const verify =
    address.tls === 'verify-full' ? 'full' : address.tls === 'verify-ca' || ca !== undefined ? 'chain' : 'none';
  if (verify === 'none') return { options: { ...files, rejectUnauthorized: false }, verify };
  // The chain checked; the name too only for verify-full (an address by IP, or a certificate made out to another name,
  // passes verify-ca).
  const options: ConnectionOptions =
    verify === 'full'
      ? { ...files, rejectUnauthorized: true }
      : { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  return { options, verify };
}

// Where the server is, for the messages.
function where(address: ServerAddress): string {
  return address.socket !== null && address.host === '' ? address.socket : `${address.host}:${address.port}`;
}

// The Node error codes of a connection that did not get through, and whether waiting may help each.
const NETWORK: Readonly<Record<string, { transient: boolean; say: (address: ServerAddress) => string }>> = {
  ECONNREFUSED: {
    transient: true,
    say: (address) => `nothing answers at ${where(address)} (is the database running, and is that its port?)`,
  },
  ENOTFOUND: {
    transient: true,
    say: (address) => `the host name ${address.host} is not known (a typo, or the database's host is not up yet)`,
  },
  EAI_AGAIN: {
    transient: true,
    say: (address) => `the host name ${address.host} could not be looked up just now (the name server did not answer)`,
  },
  ETIMEDOUT: {
    transient: true,
    say: (address) => `${where(address)} did not answer in time (a firewall, or the wrong address)`,
  },
  ECONNRESET: { transient: true, say: (address) => `${where(address)} cut the connection` },
  EPIPE: { transient: true, say: (address) => `${where(address)} cut the connection` },
  EHOSTUNREACH: { transient: true, say: (address) => `there is no way to ${where(address)} from here (no route)` },
  ENETUNREACH: { transient: true, say: (address) => `there is no way to ${where(address)} from here (no network)` },
  ENOENT: { transient: true, say: (address) => `there is no socket at ${where(address)}` },
  EACCES: { transient: false, say: (address) => `the socket at ${where(address)} may not be opened by this user` },
};

/**
 * The connection failure an error is, in words, with whether waiting may help; null when it is not a failure to
 * connect at all (a statement's own error, which is passed on as it is).
 */
export function connectionFailure(error: unknown, address: ServerAddress): ConnectionError | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof ConnectionError) return error;
  const fields = error as Error & { code?: unknown; errno?: unknown };
  const code = typeof fields.code === 'string' ? fields.code : '';
  const network = NETWORK[code];
  if (network) return new ConnectionError(network.say(address), network.transient, { cause: error });
  const message = error.message;
  // TLS: a certificate refused, or a server that does not speak it, in the driver's or Node's words.
  if (
    /certificate|self[- ]signed|unable to verify|Hostname\/IP does not match|ERR_TLS|SSL routines|wrong version number/i.test(
      `${code} ${message}`,
    )
  ) {
    return new ConnectionError(
      `TLS with ${where(address)} failed: ${message} (see sslmode and sslrootcert in the address)`,
      false,
      { cause: error },
    );
  }
  if (/does not support SSL|does not support secure transport|server does not allow insecure/i.test(message)) {
    return new ConnectionError(`${where(address)} and the address disagree about TLS: ${message}`, false, {
      cause: error,
    });
  }
  // A connection that took too long (pg says it in words, mysql2 with its own code).
  if (/timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(message)) {
    return new ConnectionError(`${where(address)} did not answer in time (a firewall, or the wrong address)`, true, {
      cause: error,
    });
  }
  if (/Connection terminated unexpectedly|Connection lost|server closed the connection/i.test(message)) {
    return new ConnectionError(`${where(address)} cut the connection (${message})`, true, { cause: error });
  }
  // PostgreSQL's SQLSTATE codes of a refused login or connection.
  const postgres: Readonly<Record<string, readonly [boolean, string]>> = {
    '28P01': [false, `the user name or password was refused by ${where(address)}`],
    '28000': [false, `${where(address)} does not let this user in from here (pg_hba.conf): ${message}`],
    '3D000': [false, `${where(address)} has no database "${address.database}" (create it first)`],
    '57P03': [true, `the database at ${where(address)} is starting up`],
    '53300': [true, `${where(address)} has no room for another connection (max_connections)`],
    '42501': [false, `the user may not use the database "${address.database}": ${message}`],
  };
  const known = postgres[code];
  if (known) return new ConnectionError(known[1], known[0], { cause: error });
  // MySQL's and MariaDB's error numbers of the same.
  const mysql: Readonly<Record<number, readonly [boolean, string]>> = {
    1045: [false, `the user name or password was refused by ${where(address)}`],
    1044: [false, `the user may not use the database "${address.database}" on ${where(address)}`],
    1049: [false, `${where(address)} has no database "${address.database}" (create it first)`],
    1040: [true, `${where(address)} has no room for another connection (max_connections)`],
    1053: [true, `the database at ${where(address)} is shutting down`],
    1129: [false, `${where(address)} blocks this host after too many failed connections (FLUSH HOSTS)`],
    1130: [false, `${where(address)} does not let this host in`],
  };
  const numbered = typeof fields.errno === 'number' ? mysql[fields.errno] : undefined;
  if (numbered) return new ConnectionError(numbered[1], numbered[0], { cause: error });
  return null;
}

/** Waits `ms` milliseconds. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
