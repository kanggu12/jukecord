/**
 * The host's certificate authorities as the settings page keeps them: a PEM pasted or uploaded there is checked (at
 * least one authority's certificate, and nothing that is not a certificate, a private key above all), kept in the
 * data folder as a file of its own (0600, named by what is in it), and JUKECORD_CA_FILE points at it in settings.json;
 * the start trusts it (src/authorities.ts). What the page shows of each certificate is read from the file: whose it is,
 * who signed it, until when it holds.
 *
 * A test of an address (the database's, the cache's or the bus's, the identity provider's, the directory's) may take
 * the authorities the page has not saved yet: trustedWith gives the list such a test's connection trusts.
 */
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { certificatesIn } from '../authorities.ts';

/** One certificate as the page and the command show it. */
export interface CertificateFacts {
  /** Whose it is: its subject's names, one line ("CN=Home Root CA, O=Home"). */
  readonly subject: string;
  /** Who signed it: the same for an authority that signed itself. */
  readonly issuer: string;
  /** From when and until when it holds, as ISO times. */
  readonly validFrom: string;
  readonly validTo: string;
  /** Whether it is an authority's (CA:TRUE), which may sign others. */
  readonly authority: boolean;
  /** Its SHA-256 fingerprint, as openssl and browsers show it. */
  readonly fingerprint: string;
}

// The largest PEM the page and the command take: far more than any bundle of authorities (a system's whole list is
// about 220 KiB).
export const PEM_MAX = 1024 * 1024;

// A private key of any kind in PEM: RSA, EC, PKCS #8, encrypted or not.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
// Any PEM block's first line, to find what is not a certificate.
const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----/g;

/**
 * Checks a PEM text the host gives as their authorities: its certificates, or why it cannot be taken. Text around the
 * certificates (a bundle's comments, openssl's "Bag Attributes") is left as it is.
 */
export function checkAuthorities(text: string): { certificates: string[] } | { problem: string } {
  if (Buffer.byteLength(text, 'utf8') > PEM_MAX) return { problem: 'the certificates are larger than 1 MiB' };
  // A key is refused by name: it is a secret, and it has no place among what every connection trusts.
  if (PRIVATE_KEY.test(text))
    return { problem: 'it holds a private key: give only the authorities’ certificates, never a key' };
  for (const [, kind] of text.matchAll(BLOCK))
    if (kind !== 'CERTIFICATE') return { problem: `it holds something other than certificates (${kind})` };
  const read = certificatesIn(text);
  if ('problem' in read) return { problem: `it ${read.problem}` };
  // At least one authority: a bundle of server certificates alone signs nothing.
  if (!read.certificates.some((pem) => new X509Certificate(pem).ca))
    return {
      problem: 'it has no authority’s certificate (CA:TRUE): a server’s or a person’s certificate signs nothing',
    };
  return { certificates: read.certificates };
}

/** What the page shows of each certificate. */
export function certificateFacts(certificates: readonly string[]): CertificateFacts[] {
  return certificates.map((pem) => {
    const certificate = new X509Certificate(pem);
    return {
      subject: oneLine(certificate.subject),
      issuer: oneLine(certificate.issuer),
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      authority: certificate.ca,
      fingerprint: certificate.fingerprint256,
    };
  });
}

// A certificate's names, which Node gives one per line, on one line as people write them.
function oneLine(names: string): string {
  return names
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .join(', ');
}

// The files the page keeps in the data folder: "authorities-" and a hash of what is in them.
const KEPT = /^authorities-[0-9a-f]{16}\.pem$/;

/**
 * Keeps the certificates in the data folder as a file of their own (0600, written whole under another name and renamed
 * over, so a stop halfway leaves no half file), named by what is in it: other certificates are another file, which is
 * a change of the setting that waits for a restart. Returns the file's path.
 */
export function keepAuthorities(dataDir: string, certificates: readonly string[]): string {
  const text = fileText(certificates);
  const file = authoritiesFile(dataDir, certificates);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  // A file left from before with other permissions is put right as well.
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  return file;
}

/** The path keepAuthorities keeps these certificates at (named by what is in them), without writing anything. */
export function authoritiesFile(dataDir: string, certificates: readonly string[]): string {
  const name = `authorities-${createHash('sha256').update(fileText(certificates)).digest('hex').slice(0, 16)}.pem`;
  return path.join(dataDir, name);
}

// What a kept file holds: the certificates one after another, each as the import read it.
function fileText(certificates: readonly string[]): string {
  return `${certificates.join('\n')}\n`;
}

/** Removes the files the page kept in the data folder, but `keep` (the one the setting names now, when there is one). */
export function forgetAuthorities(dataDir: string, keep: string | null = null): void {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dataDir, name);
    if (KEPT.test(name) && file !== keep) fs.rmSync(file, { force: true });
  }
}

/** Whether a file is one the page keeps (and may remove), not one the host named themselves. */
export function keptByThePage(dataDir: string, file: string | null): boolean {
  return file !== null && path.dirname(file) === dataDir && KEPT.test(path.basename(file));
}

/**
 * The authorities a test's connection trusts with authorities not saved yet: Node's default list as this process has
 * it (the host's file is in it since the start) and those. None without any: the connection takes the default itself.
 */
export function trustedWith(extra: readonly string[] | undefined): string[] | undefined {
  if (!extra || extra.length === 0) return undefined;
  return [...tls.getCACertificates('default'), ...extra];
}
