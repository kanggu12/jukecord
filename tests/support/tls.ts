/**
 * A certificate authority made for one test (with openssl, as tests/auth/run.sh makes its own), and a server
 * certificate it signed for localhost and 127.0.0.1, for the tests of what trusts the host's own authorities
 * (src/authorities.ts). Everything lives in a temporary folder of the test's own, keys included, and goes with it:
 * nothing of it is kept in the repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/** A test's authority: its certificate (PEM, and its file), a server's key and certificate it signed, and its end. */
export interface TestAuthority {
  readonly dir: string;
  /** The authority's certificate as a file, as JUKECORD_CA_FILE names one. */
  readonly caFile: string;
  readonly ca: string;
  /** The server's key and certificate, made out to localhost and 127.0.0.1. */
  readonly key: string;
  readonly cert: string;
  /** Removes the folder (the keys with it). */
  remove(): void;
}

// Runs openssl with these arguments in a folder, quietly.
function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** Whether openssl is there to make authorities (the tests that need one are skipped without it). */
export function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A new authority, named `name`, and a server certificate it signed, valid for a day. */
export function testAuthority(name = 'jukecord-test-ca'): TestAuthority {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-ca-'));
  openssl(dir, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${name}`,
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
  ]);
  openssl(dir, [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
  ]);
  fs.writeFileSync(path.join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(dir, [
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    'server.ext',
    '-out',
    'server.crt',
  ]);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  return {
    dir,
    caFile: path.join(dir, 'ca.crt'),
    ca: read('ca.crt'),
    key: read('server.key'),
    cert: read('server.crt'),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** An HTTPS server with the authority's certificate on 127.0.0.1, answering with `handle`; its port and its end. */
export async function httpsServer(
  authority: TestAuthority,
  handle: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = https.createServer({ key: authority.key, cert: authority.cert }, handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A TLS server with the authority's certificate on 127.0.0.1: each connection handed to `connected` once its
 * handshake is done (a proxy to a plain server, or one that hangs up).
 */
export async function tlsServer(
  authority: TestAuthority,
  connected: (socket: tls.TLSSocket) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ key: authority.key, cert: authority.cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    connected(socket);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Whether a TLS connection to 127.0.0.1:port (as localhost) verifies with these options: "ok", or Node's error code. */
export function verifies(port: number, options: tls.ConnectionOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ...options }, () => {
      socket.destroy();
      resolve('ok');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}
