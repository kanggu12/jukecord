/**
 * A jukecord for the end-to-end logins: this checkout's server started as its own process, browser-only (nothing
 * reaches Discord), on a port of the test's, with a data folder of its own that goes away with it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunningJukecord {
  /** Where it answers, as its public address says. */
  readonly url: string;
  /** The host token, for the API. */
  readonly hostToken: string;
  /** What it wrote to its standard output and error (its log), so far. */
  output(): string;
  stop(): Promise<void>;
}

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Starts jukecord on 127.0.0.1:<port> with these settings, and waits until it is ready. */
export async function startJukecord(port: number, env: Record<string, string>): Promise<RunningJukecord> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-e2e-'));
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/main.ts')],
    {
      cwd: ROOT,
      // Only what the test gives: none of this machine's own JUKECORD_ settings, no Discord token.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: data,
        JUKECORD_DATA_DIR: data,
        JUKECORD_HOST: '127.0.0.1',
        JUKECORD_PORT: String(port),
        JUKECORD_PUBLIC_URL: url,
        JUKECORD_LOG_LEVEL: 'debug',
        JUKECORD_LYRICS: 'off',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    fs.rmSync(data, { recursive: true, force: true });
  };
  // Ready when it says so; a start that fails says why.
  for (let tries = 0; tries < 100; tries += 1) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`jukecord did not start:\n${output}`);
    }
    const ready = await fetch(`${url}/readyz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) {
      const hostToken = fs.readFileSync(path.join(data, 'host-token'), 'utf8').trim();
      return { url, hostToken, output: () => output, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`jukecord did not get ready:\n${output}`);
}
