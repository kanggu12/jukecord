/**
 * The programs' `jukecord start` (deploy/bundle/jukecord runs it in its own place, with exec): runs jukecord as its
 * child, hands it every signal that ends a program, and starts it again when it ends with RESTART_EXIT_CODE, its
 * restart. Any other end is this process's end too, the same way: jukecord's exit code, or the signal that ended it.
 *
 * Node, not the shell, holds the loop. A shell started in the background (`&`, nohup) ignores SIGINT and SIGQUIT from
 * its start and can never trap them, so Ctrl+C's signal sent to it would stop nothing; and a shell dies of a signal it
 * has no trap for (a SIGHUP, as a closed terminal sends), leaving jukecord running without it. Node sets every signal
 * back to its default when it starts, and takes the ones it listens to, whatever it was started with: so each signal
 * the program is sent reaches jukecord, which stops on it once (a second one, as when a terminal's Ctrl+C reaches both
 * processes, is the same stop: src/main.ts).
 *
 *   node launcher.js <settings file> <jukecord's main.js> [jukecord's arguments...]
 *
 * The settings file (.env beside the launcher) is read by each jukecord it starts, not by this process: a change to it
 * applies at the next restart, as it would for a jukecord started by hand.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { RESTART_EXIT_CODE } from './settings/restart.ts';

// The signals that end a program, which jukecord gets in turn: a service manager's TERM, a terminal's INT and QUIT,
// the HUP of a terminal that closed.
const HANDED_ON = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const;

const [settingsFile, mainFile, ...args] = process.argv.slice(2);
if (!settingsFile || !mainFile) {
  process.stderr.write('Usage: node launcher.js <settings file> <main.js> [arguments...]\n');
  process.exit(2);
}
// Named for the functions below, which see them as given.
const settings: string = settingsFile;
const main: string = mainFile;

// jukecord while it runs (null between its end and the next start).
let child: ChildProcess | null = null;
// The signal this process was sent, once it was: jukecord is not started again after it, whatever it ends with.
let asked: NodeJS.Signals | null = null;

// Ends this process the way jukecord ended: by the same signal, its own listeners gone so the default ends it (a
// parent sees what it would have seen with jukecord in this process's place), or with its exit code.
function endAs(signal: NodeJS.Signals | null, code: number | null): void {
  if (signal === null) process.exit(code ?? 1);
  for (const name of HANDED_ON) process.removeAllListeners(name);
  process.kill(process.pid, signal);
  // A signal whose default does not end a process (none ends jukecord, but to be sure): the shell's number for it.
  setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 1000);
}

// Starts jukecord: Node in this folder, the settings file read when there is one (each time: it may be new), the
// experimental features' notices left out as the launcher always did.
function start(): void {
  const node = [
    ...(fs.existsSync(settings) ? [`--env-file=${settings}`] : []),
    '--disable-warning=ExperimentalWarning',
    main,
    ...args,
  ];
  // The same terminal and output: jukecord's console is the program's.
  const started = spawn(process.execPath, node, { stdio: 'inherit' });
  child = started;
  started.on('error', (error) => {
    // A signal for a jukecord that has just ended: its end, which follows, is the answer.
    if (started.pid !== undefined) return;
    // Not started at all (a Node.js that cannot run): said, and the program ends as a start that failed.
    process.stderr.write(`jukecord could not be started: ${error.message}\n`);
    process.exit(1);
  });
  started.on('exit', (code, signal) => {
    child = null;
    // Its restart, and nobody asked this process to stop meanwhile: started again at once.
    if (code === RESTART_EXIT_CODE && asked === null) {
      start();
      return;
    }
    // A restart that crossed a stop: the stop wins, as it would have reached the next jukecord.
    if (code === RESTART_EXIT_CODE && asked !== null) {
      endAs(asked, null);
      return;
    }
    endAs(signal, code);
  });
}

for (const name of HANDED_ON) {
  process.on(name, () => {
    asked = name;
    // Handed on while jukecord runs (one already gone has nothing to hear it: its end ends this process); between a
    // restart's end and the next start, this process ends on it at once.
    if (child) child.kill(name);
    else endAs(name, null);
  });
}

start();
