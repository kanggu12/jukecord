/**
 * Running yt-dlp, ffmpeg and ffprobe: with a time limit, cancellation, and bounded output.
 *
 * Every external program jukecord starts goes through here, so none of them can outlive a skip (abort kills it), hang
 * forever (the time limit kills it), or fill memory with output (only the first part of stdout and the last part of
 * stderr are kept, which is where the result and the error are).
 */
import { type ChildProcess, spawn } from 'node:child_process';

/** How a program ended and what it printed. */
export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A program that failed, was killed or could not start; the message ends with the last lines it printed. */
export class ProcessError extends Error {
  override name = 'ProcessError';
  readonly result: RunResult | null;

  constructor(message: string, result: RunResult | null) {
    super(message);
    this.result = result;
  }
}

export interface RunOptions {
  /** Kills the program when aborted (a skip, a stop, shutting down). */
  readonly signal?: AbortSignal;
  /** Kills the program after this long. */
  readonly timeoutMs?: number;
  /** The most stdout kept, in bytes; a playlist listing is a few MB at most. */
  readonly maxStdout?: number;
  /** The most stderr kept (its end), in bytes. */
  readonly maxStderr?: number;
}

// Keeps the first `limit` bytes of a stream (stdout carries the JSON we parse; its start is what matters).
function head(limit: number): { push(chunk: Buffer): void; text(): string } {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= limit) return;
      const room = limit - size;
      parts.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      size += Math.min(room, chunk.length);
    },
    text: () => Buffer.concat(parts).toString('utf8'),
  };
}

// Keeps the last `limit` bytes of a stream (stderr: the error is at the end).
function tail(limit: number): { push(chunk: Buffer): void; text(): string } {
  let kept = Buffer.alloc(0);
  return {
    push(chunk) {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > limit) kept = kept.subarray(kept.length - limit);
    },
    text: () => kept.toString('utf8'),
  };
}

/** The last few non-empty lines of a program's stderr, for error messages and logs. */
export function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' | ');
}

/**
 * Wires a started process to the abort signal and the time limit, and resolves when it has exited.
 *
 * SIGKILL rather than SIGTERM: yt-dlp ignores SIGTERM while a fragment is downloading, and a killed ffmpeg leaves only
 * a temporary file, which the caller deletes.
 */
export function watch(child: ChildProcess, name: string, options: RunOptions = {}): Promise<RunResult> {
  const stdout = head(options.maxStdout ?? 16 * 1024 ** 2);
  const stderr = tail(options.maxStderr ?? 64 * 1024);
  // stdout may already be piped into another process (yt-dlp into ffmpeg); then there is nothing to collect here.
  if (child.stdout && child.stdout.listenerCount('data') === 0 && !child.stdout.readableFlowing) {
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  }
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise<RunResult>((resolve, reject) => {
    let killedFor: string | null = null;
    const kill = (reason: string): void => {
      if (killedFor !== null || child.exitCode !== null) return;
      killedFor = reason;
      child.kill('SIGKILL');
    };
    // Abort and time limit both end in a kill; the reason decides the error message.
    const onAbort = (): void => kill('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) kill('cancelled');
    const limit = options.timeoutMs;
    const timer =
      limit === undefined ? null : setTimeout(() => kill(`took longer than ${Math.round(limit / 1000)} s`), limit);

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      // ENOENT is the common one: the program is not installed or JUKECORD_YTDLP/FFMPEG points nowhere.
      const why = error.code === 'ENOENT' ? `${name} was not found` : `${name} could not start: ${error.message}`;
      reject(new ProcessError(why, null));
    });
    child.once('close', (code, signal) => {
      cleanup();
      const result: RunResult = { code, signal, stdout: stdout.text(), stderr: stderr.text() };
      if (killedFor !== null) {
        reject(new ProcessError(`${name} ${killedFor}`, result));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Runs a program to the end and returns what it printed. A non-zero exit is an error whose message carries the last
 * lines of stderr ("ERROR: Video unavailable" from yt-dlp, say).
 */
export async function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const name = command.split('/').at(-1) ?? command;
  // stdin closed: none of these programs needs input, and ffmpeg would otherwise wait for a keypress on a terminal.
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await watch(child, name, options);
  if (result.code !== 0) {
    throw new ProcessError(
      `${name} failed: ${lastLines(result.stderr) || `exit ${result.code ?? result.signal}`}`,
      result,
    );
  }
  return result;
}
