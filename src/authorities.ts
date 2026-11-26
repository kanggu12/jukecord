/**
 * The host's own certificate authorities (JUKECORD_CA_FILE): a PEM file with one or more CA certificates, which every
 * TLS connection jukecord makes trusts besides the ones it trusts already. A database, a bus, an identity provider or a
 * directory whose certificate a private authority signed (a company's, a cluster's) then needs nothing of its own.
 *
 * They are added once, at the start, before any connection (src/main.ts, and the jukecord command's entry), to Node's
 * default list: the authorities Node ships with, the ones NODE_EXTRA_CA_CERTS adds when someone sets it, and the
 * system's when Node is told to read them. A connection given its own authority keeps it and trusts that alone, as
 * before: the database's sslrootcert, the directory's JUKECORD_LDAP_CA_FILE. Every client jukecord uses (pg, mysql2,
 * @redis/client, ldapts, openid-client through fetch, Discord's, its own requests) passes no authority of its own when
 * its own setting is absent, so it trusts the extended list (tests/unit/authorities.test.ts shows each one).
 *
 * yt-dlp and FFmpeg are programs of their own, with their own trust: this does not reach them.
 */
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

/** The authorities of JUKECORD_CA_FILE: where they came from, and each certificate in PEM. */
export interface Authorities {
  readonly file: string;
  readonly certificates: readonly string[];
}

// One certificate in PEM: what lies between its two lines, those included.
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * The certificates of a PEM text, each one Node can read, or why not: a text without one, or one that is not a
 * certificate (cut short, or something else between the lines). Anything around them (a bundle's comments) is left.
 */
export function certificatesIn(text: string): { certificates: string[] } | { problem: string } {
  const found = text.match(PEM) ?? [];
  if (found.length === 0) return { problem: 'has no certificate in PEM form (-----BEGIN CERTIFICATE-----)' };
  for (const [index, pem] of found.entries()) {
    try {
      new X509Certificate(pem);
    } catch (error) {
      return {
        problem: `has a certificate that cannot be read (the ${ordinal(index + 1)}: ${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  return { certificates: found };
}

// The files of this machine, as src/config.ts reads them (its tests give their own).
const DISK = {
  read: (file: string) => fs.readFileSync(file, 'utf8'),
  readable: (file: string) => {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * Reads JUKECORD_CA_FILE as the settings do (a path from the working folder), or says what is wrong with it. Nothing
 * is trusted here; see trustAuthorities.
 */
export function readAuthorities(
  file: string | null,
  cwd: string,
  files: { read(file: string): string; readable(file: string): boolean } = DISK,
): { authorities: Authorities | null; problem: string | null } {
  if (file === null) return { authorities: null, problem: null };
  const full = path.resolve(cwd, file);
  if (!files.readable(full)) return { authorities: null, problem: `JUKECORD_CA_FILE: ${full} cannot be read` };
  const read = certificatesIn(files.read(full));
  if ('problem' in read) return { authorities: null, problem: `JUKECORD_CA_FILE: ${full} ${read.problem}` };
  return { authorities: { file: full, certificates: read.certificates }, problem: null };
}

/**
 * Trusts the authorities besides Node's default list, for every TLS connection made after this, in this thread (the
 * main one: jukecord makes none in its workers). Returns how many were added.
 */
export function trustAuthorities(authorities: Authorities): number {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...authorities.certificates]);
  return authorities.certificates.length;
}

/** How the start and the self-check say it: "2 extra authorities from /run/jukecord-ca/ca.crt". */
export function describeAuthorities(authorities: Authorities | null): string {
  if (authorities === null) return "Node's own";
  const count = authorities.certificates.length;
  return `${count} extra ${count === 1 ? 'authority' : 'authorities'} from ${authorities.file}, besides Node's own`;
}

// "first", "second" ... for the message about one certificate of several.
function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth'][n - 1] ?? `${n}th`;
}
