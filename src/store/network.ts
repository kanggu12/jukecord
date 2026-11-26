/**
 * What the two network databases' executors share: the TLS options an address asks for, the reason a connection
 * failed in words a person can act on, and which failures are worth waiting out at a start (the database still
 * starting, its name not known yet in a cluster) and which are not (a wrong password).
 */

import fs from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { untrustedAuthority, withoutNodeAdvice } from '../authorities.ts';
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
  trust?: readonly string[],
): { readonly options: ConnectionOptions; readonly verify: 'none' | 'chain' | 'full' } | null {
  if (address.tls === 'disable') return null;
  // The address's own root certificate decides alone; without one, a list given for a test (the default list and the
  // authorities the settings page has not saved yet) stands in for the default.
  const own = certificate(address.tlsFiles.ca, 'root certificate (sslrootcert)');
  const ca = own ?? (trust ? [...trust] : undefined);
  const cert = certificate(address.tlsFiles.cert, 'certificate (sslcert)');
  const key = certificate(address.tlsFiles.key, 'key (sslkey)');
  // Only the files that were given, and no `ca` at all without a root certificate: Node's default authorities check
  // the server then, with what JUKECORD_CA_FILE adds to them (tls.setDefaultCACertificates at the start). A `ca` of
  // an empty list would replace them, so none is ever passed in its place.
  const files: ConnectionOptions = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
  };
  const verify =
    // A root certificate of the address's own makes `require` check the chain (libpq's verify-ca); a test's list does
    // not change what the address asks for.
    address.tls === 'verify-full' ? 'full' : address.tls === 'verify-ca' || own !== undefined ? 'chain' : 'none';
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
    // Node's advice to run it with --use-system-ca left out; an authority of the host's own is named in the address
    // (sslrootcert) for this database alone, or in JUKECORD_CA_FILE for every connection (src/authorities.ts).
    const own = untrustedAuthority(error) ? ', or JUKECORD_CA_FILE for an authority of your own' : '';
    return new ConnectionError(
      `TLS with ${where(address)} failed: ${withoutNodeAdvice(message)} (see sslmode and sslrootcert in the address${own})`,
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
  // A connection that went away while in use, in the drivers' words: pg's (its end, and a statement asked of a
  // connection that failed before), mysql2's (its end, and a statement asked of one closed since).
  if (
    /Connection terminated|Connection lost|server closed the connection|not queryable|connection is in closed state/i.test(
      message,
    )
  ) {
    return new ConnectionError(`${where(address)} cut the connection (${message})`, true, { cause: error });
  }
  // A statement whose answer did not come in time (pg's query_timeout, see src/store/postgres.ts): the connection is
  // given up, since an answer that comes later would be taken for the next statement's.
  if (/Query read timeout/i.test(message)) {
    return new ConnectionError(
      `${where(address)} did not answer a statement in time (the connection is given up)`,
      true,
      {
        cause: error,
      },
    );
  }
  // PostgreSQL's SQLSTATE codes of a refused login or connection, and of a connection the server ended.
  const postgres: Readonly<Record<string, readonly [boolean, string]>> = {
    '28P01': [false, `the user name or password was refused by ${where(address)}`],
    '28000': [false, `${where(address)} does not let this user in from here (pg_hba.conf): ${message}`],
    '3D000': [false, `${where(address)} has no database "${address.database}" (create it first)`],
    '57P03': [true, `the database at ${where(address)} is starting up`],
    '53300': [true, `${where(address)} has no room for another connection (max_connections)`],
    '42501': [false, `the user may not use the database "${address.database}": ${message}`],
    // Ended by the server: an administrator (pg_terminate_backend), a shutdown or restart, a crash of another
    // connection, a connection or a transaction left idle too long, or the connection's own failure (class 08).
    '57P01': [true, `the database at ${where(address)} ended the connection (${message})`],
    '57P02': [true, `the database at ${where(address)} ended the connection (${message})`],
    '57P05': [true, `the database at ${where(address)} ended the connection (${message})`],
    '25P03': [true, `the database at ${where(address)} ended the connection (${message})`],
    '08000': [true, `the connection to ${where(address)} failed (${message})`],
    '08003': [true, `the connection to ${where(address)} failed (${message})`],
    '08006': [true, `the connection to ${where(address)} failed (${message})`],
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
    // Ended by the server: an administrator (KILL, MariaDB's own number for it), or idle too long (MySQL 8.0.24+).
    1927: [true, `the database at ${where(address)} ended the connection (${message})`],
    4031: [true, `the database at ${where(address)} ended the connection (${message})`],
  };
  const numbered = typeof fields.errno === 'number' ? mysql[fields.errno] : undefined;
  if (numbered) return new ConnectionError(numbered[1], numbered[0], { cause: error });
  return null;
}

/** Waits `ms` milliseconds. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
