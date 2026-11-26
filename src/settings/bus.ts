/**
 * The host's settings in a split jukecord, over its bus (src/bus): the core keeps them (its settings service saves
 * and announces), an edge carries the page's calls to it as commands, and every service takes each change in from the
 * database when the core says one was made, and restarts when the core says every service does.
 *
 * The announcement is a hint: a service that missed it (its bus was down at that moment) takes the settings in again
 * when its bus is back, and once a minute in any case, so every service ends up with what the database holds.
 */

import { decode, encode } from '../bus/codec.ts';
import type { CommandClient } from '../bus/commands.ts';
import type { BusNames, BusTransport } from '../bus/transport.ts';
import type { Supervisor } from '../config.ts';
import type { Logger } from '../log.ts';
import type { DiscordLoginTest } from './discord.ts';
import type { DatabaseTest, MoveFailure, MoveState } from './move.ts';
import type { ServerTest, ServerUse } from './servers.ts';
import type { AuthoritiesView, ChangedSetting, HostSettings, HostSettingsPort, HostSettingsView } from './service.ts';

/** The commands an edge sends the core for the page's calls (each answered by the core's settings service). */
export const SETTINGS_COMMANDS = [
  'settings.view',
  'settings.change',
  'settings.reset',
  'settings.restart',
  'settings.test-database',
  'settings.test-server',
  'settings.test-discord-login',
  'settings.authorities',
  'settings.authorities-import',
  'settings.authorities-remove',
  'settings.move-start',
  'settings.move-state',
  'settings.move-cancel',
  'settings.move-switch',
] as const;

// How often a service takes the settings in again by itself, for an announcement it missed.
const AGAIN_MS = 60_000;

/**
 * The core's announce: takes the change in here first (what applies at once is applied), then tells every edge, which
 * takes it in from the database. A bus that does not take the message is said in the log; the edges catch up.
 */
export function announceOnBus(
  transport: BusTransport,
  names: BusNames,
  settings: () => HostSettings,
  log?: Pick<Logger, 'warn'>,
): (changed: readonly string[]) => Promise<void> {
  return async (changed) => {
    await settings().takeIn(changed);
    try {
      await transport.publish(names.settings, encode({ type: 'changed', names: [...changed] }));
    } catch (error) {
      log?.warn('could not tell the edges that settings changed; they take them in within a minute', { error });
    }
  };
}

/** Tells every service to restart (the page's Restart, a database move's switch): each edge restarts in a moment. */
export async function announceRestart(transport: BusTransport, names: BusNames): Promise<void> {
  try {
    await transport.publish(names.settings, encode({ type: 'restart' }));
  } catch {
    // The bus is down: the edges stay as they are, and restart when the host asks again.
  }
}

/** An edge's (or any service's) side: takes each change in, and hears when every service restarts. */
export async function takeInFromBus(
  transport: BusTransport,
  names: BusNames,
  settings: HostSettings,
  log: Pick<Logger, 'debug' | 'warn'>,
): Promise<{ stop(): Promise<void>; onRestart(listener: () => void): void }> {
  const restarts: (() => void)[] = [];
  const unsubscribe = await transport.subscribe(names.settings, (text) => {
    const read = decode(text);
    if (!read.ok) {
      log.warn('a settings message could not be read', { why: read.why });
      return;
    }
    if (read.message.type === 'changed') {
      const changed = Array.isArray(read.message.names) ? read.message.names.map(String) : [];
      void settings.takeIn(changed);
    } else if (read.message.type === 'restart') {
      for (const listener of restarts) listener();
    }
  });
  // Back after the bus was down: what was said meanwhile is lost, so the settings are read again.
  let wasDown = false;
  const offChange = transport.onChange((up) => {
    if (!up) wasDown = true;
    else if (wasDown) {
      wasDown = false;
      void settings.takeIn();
    }
  });
  // And now and then in any case.
  const timer = setInterval(() => void settings.takeIn(), AGAIN_MS);
  timer.unref();
  return {
    onRestart: (listener) => {
      restarts.push(listener);
    },
    stop: async () => {
      clearInterval(timer);
      offChange();
      await unsubscribe();
    },
  };
}

/** The page's calls as commands to the core, answering what the core's settings service answers. */
export function remoteSettings(client: CommandClient): HostSettingsPort {
  return {
    view: () => client.call<HostSettingsView>('settings.view', []),
    change: (values: Readonly<Record<string, string | null>>, revisions?: Readonly<Record<string, number>>) =>
      client.call<{ changed: ChangedSetting[]; view: HostSettingsView }>('settings.change', [
        values,
        revisions ?? null,
      ]),
    reset: (names: readonly string[], revisions?: Readonly<Record<string, number>>) =>
      client.call<{ changed: ChangedSetting[]; view: HostSettingsView }>('settings.reset', [names, revisions ?? null]),
    restartNow: () => client.call<{ supervisor: Supervisor }>('settings.restart', []),
    testDatabase: (url: string, ca?: string, password?: string) =>
      client.call<DatabaseTest>('settings.test-database', [url, ca ?? null, password ?? null]),
    // Tried from the core, as one process tries it: the server the services would share is the core's to reach too.
    testServer: (url: string, use: ServerUse, ca?: string) =>
      client.call<ServerTest>('settings.test-server', [url, use, ca ?? null]),
    authorities: () => client.call<AuthoritiesView>('settings.authorities', []),
    importAuthorities: (pem: string) =>
      client.call<{ changed: ChangedSetting[]; view: HostSettingsView }>('settings.authorities-import', [pem]),
    removeAuthorities: () =>
      client.call<{ changed: ChangedSetting[]; view: HostSettingsView }>('settings.authorities-remove', []),
    testDiscordLogin: (values?: Readonly<Record<string, string>>) =>
      client.call<DiscordLoginTest>('settings.test-discord-login', [values ?? {}]),
    startMove: (url: string, replace: boolean, password?: string) =>
      client.call<MoveState>('settings.move-start', [url, replace, password ?? null]),
    moveState: () =>
      client.call<{ state: MoveState | null; lastFailure: MoveFailure | null }>('settings.move-state', []),
    cancelMove: () => client.call<undefined>('settings.move-cancel', []),
    switchMove: () =>
      client.call<{ where: string; restarts: boolean; supervisor: Supervisor }>('settings.move-switch', []),
  };
}

/** The core's handlers of those commands, over its settings service. */
export function settingsCommands(settings: HostSettings): Map<string, (args: readonly unknown[]) => unknown> {
  const record = (value: unknown): Record<string, string | null> =>
    typeof value === 'object' && value !== null ? (value as Record<string, string | null>) : {};
  // A PEM given with a test, or none.
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const revisions = (value: unknown): Record<string, number> | undefined =>
    typeof value === 'object' && value !== null ? (value as Record<string, number>) : undefined;
  return new Map<string, (args: readonly unknown[]) => unknown>([
    ['settings.view', () => settings.view()],
    ['settings.change', ([values, read]) => settings.change(record(values), revisions(read))],
    [
      'settings.reset',
      ([names, read]) => settings.reset(Array.isArray(names) ? names.map(String) : [], revisions(read)),
    ],
    ['settings.restart', () => settings.restartNow()],
    [
      'settings.test-database',
      ([url, ca, password]) => settings.testDatabase(String(url ?? ''), text(ca), text(password)),
    ],
    [
      'settings.test-server',
      ([url, use, ca]) => settings.testServer(String(url ?? ''), use === 'bus' ? 'bus' : 'cache', text(ca)),
    ],
    ['settings.authorities', () => settings.authorities()],
    ['settings.authorities-import', ([pem]) => settings.importAuthorities(String(pem ?? ''))],
    ['settings.authorities-remove', () => settings.removeAuthorities()],
    [
      'settings.test-discord-login',
      ([values]) =>
        settings.testDiscordLogin(
          typeof values === 'object' && values !== null ? (values as Record<string, string>) : {},
        ),
    ],
    [
      'settings.move-start',
      ([url, replace, password]) => settings.startMove(String(url ?? ''), replace === true, text(password)),
    ],
    ['settings.move-state', () => settings.moveState()],
    ['settings.move-cancel', () => settings.cancelMove()],
    ['settings.move-switch', () => settings.switchMove()],
  ]);
}
