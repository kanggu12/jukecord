/**
 * Telling a server about trouble, in a Discord channel the server chose for it (a server setting, chosen by people who
 * can manage the server), and in jukecord's log.
 *
 * Trouble of jukecord as a whole (YouTube's check for bots, a restart by the watchdog, a disk nearly full, connections
 * turned away at a cap, a scheduled backup that failed) goes to every server with an alerts channel; trouble of one
 * server (a track taken out of its looping queue) to that server's. Each kind is said at most once an hour per server
 * (a track leaving a loop once an hour per track), and a state that lasts (the bot check) once as it starts and once
 * as it ends: a channel gets a few lines on a bad day, not one per failed fetch. The lines say what happened and the
 * figures, nothing more.
 */
import fs from 'node:fs';
import type { Clock, TimerHandle } from '../core/clock.ts';
import { BOT_CHECK, plainReason } from '../core/reasons.ts';
import { translate } from '../core/say.ts';
import type { Logger } from '../log.ts';
import { isPlaylistAddress } from '../media/source.ts';
import type { SettingsRepository } from '../store/store.ts';
import { formatSize } from '../util/units.ts';

/** What happened. */
export type AlertKind = 'bot-check' | 'bot-check-over' | 'restarted' | 'disk' | 'loop' | 'turned-away' | 'backup';

/** One alert: what kind, which server (null: jukecord as a whole), and its words in English and Korean. */
export interface Alert {
  readonly kind: AlertKind;
  readonly guildId: string | null;
  readonly en: string;
  readonly ko: string;
  /** Said apart from others of its kind within the hour (the track a loop lost); the kind alone otherwise. */
  readonly about?: string;
  /** Good news (the trouble is over), drawn without the colour of a problem. */
  readonly over?: boolean;
  /** Already in the log where it happened, so it is not logged again here. */
  readonly logged?: boolean;
}

/** Where alerts are posted: the bot. */
export interface AlertSink {
  post(guildId: string, channelId: string, alert: Alert): Promise<void>;
}

/** What the parts that fetch tell about the site they asked, for YouTube's check for bots. */
export interface FetchWatch {
  /** A fetch or a lookup worked; `address` is the page's address, or "search" for words searched on YouTube. */
  worked(address: string): void;
  /** One failed, with the full text of the error. */
  failed(address: string, reason: string): void;
}

export interface AlertsOptions {
  readonly settings: SettingsRepository;
  /** The bot, once there is one (none in browser-only mode: the log alone then). */
  readonly sink: () => AlertSink | null;
  readonly log: Logger;
  readonly clock: Clock;
  /** How long one kind of alert stays said for a server (an hour by default). */
  readonly everyMs?: number;
}

// Below this much free space on the data's disk, it is said once (and again after it had room once more).
const LOW_DISK = 1024 ** 3;

// Whether a lookup of an address is a flat listing (words searched, a playlist page; see ytdlp.ts) rather than one
// video's own page, where YouTube's check for bots happens: a listing works through a check that still holds.
function flat(address: string): boolean {
  if (address === 'search') return true;
  try {
    return isPlaylistAddress(new URL(address));
  } catch {
    return false;
  }
}

// Whether an address is YouTube's (where the check for bots is), "search" being YouTube's search.
function youtube(address: string): boolean {
  if (address === 'search') return true;
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(address).hostname);
  } catch {
    return false;
  }
}

export class Alerts implements FetchWatch {
  private readonly options: AlertsOptions;
  private readonly everyMs: number;
  // When each kind was last said to each server (on the steady clock), by "kind server about".
  private readonly said = new Map<string, number>();
  // Whether YouTube is refusing jukecord now (said once as it starts, once as it ends).
  private refused = false;
  // Whether the data's disk is low now, and the timer that looks.
  private low = false;
  private diskTimer: TimerHandle | null = null;

  constructor(options: AlertsOptions) {
    this.options = options;
    this.everyMs = options.everyMs ?? 3_600_000;
  }

  /** Says an alert in the log and in the alerts channel of each server it is for, unless said there lately. */
  raise(alert: Alert): void {
    if (!alert.logged)
      this.options.log.warn(alert.en, { kind: alert.kind, ...(alert.guildId ? { guild: alert.guildId } : {}) });
    const sink = this.options.sink();
    if (!sink) return;
    // The server it is about, or every server that chose a channel.
    const targets = alert.guildId
      ? [{ guildId: alert.guildId, channelId: this.options.settings.get(alert.guildId).alertsChannelId }]
      : this.options.settings.withAlerts();
    const now = this.options.clock.steady();
    for (const { guildId, channelId } of targets) {
      if (!channelId) continue;
      const key = `${alert.kind} ${guildId} ${alert.about ?? ''}`;
      const last = this.said.get(key);
      if (last !== undefined && now - last < this.everyMs) continue;
      this.said.set(key, now);
      sink
        .post(guildId, channelId, alert)
        .catch((error: unknown) =>
          this.options.log.info('could not post an alert in its channel', { guild: guildId, kind: alert.kind, error }),
        );
    }
    // The marks of the hour gone by are let go, so the map stays small.
    for (const [key, at] of this.said) if (now - at >= this.everyMs) this.said.delete(key);
  }

  worked(address: string): void {
    // Only a video's own page shows the check is over: a search's or a playlist's answer ended an episode that still
    // held, and the next refusal was then held back for the hour.
    if (!this.refused || !youtube(address) || flat(address)) return;
    this.refused = false;
    this.raise({
      kind: 'bot-check-over',
      guildId: null,
      over: true,
      en: 'YouTube answers this jukecord again',
      ko: 'YouTube가 다시 이 jukecord에 응답함',
    });
  }

  failed(_address: string, reason: string): void {
    if (this.refused || !BOT_CHECK.test(reason)) return;
    this.refused = true;
    this.raise({
      kind: 'bot-check',
      guildId: null,
      en: 'YouTube is refusing this jukecord for now (its check for bots): tracks not in the cache cannot be fetched',
      ko: '지금은 YouTube가 이 jukecord를 막고 있음(봇 확인): 캐시에 없는 곡은 가져오지 못함',
    });
  }

  /** Looks at the free space of the data's disk now and every ten minutes; says once when it runs low. */
  watchDisk(dir: string): void {
    const look = (): void => {
      let free: number;
      try {
        const disk = fs.statfsSync(dir);
        free = disk.bavail * disk.bsize;
      } catch {
        // Not readable this once: the next look tries again.
        return;
      }
      // Said as it runs low; said again only after it had twice that room once more, so it does not flap.
      if (free >= 2 * LOW_DISK) this.low = false;
      if (this.low || free >= LOW_DISK) return;
      this.low = true;
      this.raise({
        kind: 'disk',
        guildId: null,
        en: `The disk of jukecord's data has ${formatSize(free)} free`,
        ko: `jukecord 데이터 디스크에 남은 공간: ${formatSize(free)}`,
      });
    };
    look();
    const again = (): void => {
      this.diskTimer = this.options.clock.setTimeout(() => {
        look();
        again();
      }, 600_000);
    };
    again();
  }

  /** Stops looking at the disk (shutting down). */
  stop(): void {
    if (this.diskTimer !== null) this.options.clock.clearTimeout(this.diskTimer);
    this.diskTimer = null;
  }
}

/** A track taken out of a server's looping queue, with its short reason in each language. */
export function leftLoopAlert(guildId: string, title: string, trackId: number, reason: string): Alert {
  const short = plainReason(reason);
  return {
    kind: 'loop',
    guildId,
    // One line per track within the hour, not one for the kind.
    about: String(trackId),
    // The player logged it, with the full reason.
    logged: true,
    en: `${title}: taken out of the looping queue (${short})`,
    ko: `${title}: 대기열 반복에서 뺌(${translate(short, 'ko')})`,
  };
}

/** Connections turned away at one of jukecord's caps (see the web server and the live updates). */
export function turnedAwayAlert(away: {
  readonly cap: 'connections' | 'address' | 'live';
  readonly count: number;
  readonly limit: number;
  readonly address?: string;
}): Alert {
  // The web server logged it already, once a minute, with the minute's count and the address. Neither is said here:
  // the alert goes to every server's channel (one server's member, or the proxy's own address, is no other server's
  // business), and it is raised at the minute's first refusal, so its count was nearly always 1.
  const base = { kind: 'turned-away' as const, guildId: null, about: away.cap, logged: true };
  if (away.cap === 'address') {
    return {
      ...base,
      en: `jukecord turned connections away from one address, which had as many open as one may (${away.limit}); the log names it`,
      ko: `jukecord가 한 주소의 연결을 거절함: 한 주소에 허용하는 만큼(${away.limit}개) 열려 있었음. 주소는 로그에 있음`,
    };
  }
  if (away.cap === 'live') {
    return {
      ...base,
      en: `jukecord turned live connections away: as many were open as JUKECORD_LIVE_MAX allows (${away.limit})`,
      ko: `jukecord가 실시간 연결을 거절함: JUKECORD_LIVE_MAX가 허용하는 만큼(${away.limit}개) 열려 있었음`,
    };
  }
  return {
    ...base,
    en: `jukecord turned connections away: as many were open as it takes (${away.limit})`,
    ko: `jukecord가 연결을 거절함: 받을 수 있는 만큼(${away.limit}개) 열려 있었음`,
  };
}

/** The watchdog ended the last run (src/watchdog.ts): how long the main thread had not answered, when known. */
export function restartedAlert(stillMs: number): Alert {
  const seconds = Math.round(stillMs / 1000);
  return {
    kind: 'restarted',
    guildId: null,
    // Logged where the mark is read, with the same figure.
    logged: true,
    en:
      seconds > 0
        ? `jukecord restarted itself: its main thread had not answered for ${seconds} s`
        : 'jukecord restarted itself: its main thread had stopped answering',
    ko:
      seconds > 0
        ? `jukecord가 스스로 다시 시작함: 주 스레드가 ${seconds}초 동안 응답하지 않았음`
        : 'jukecord가 스스로 다시 시작함: 주 스레드가 응답하지 않았음',
  };
}
