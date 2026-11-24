/**
 * The settings that apply at once, each handed to the part of jukecord it changes when it is saved: the log, the
 * limits, the lyrics, the links, the backups, the metrics token and the rest. main.ts gives the parts; a setting that
 * applies at once and has no part here throws, so none can be marked "at once" and then wait for a restart unseen.
 */
import type { Config, LogFormat, LogLevel } from '../config.ts';
import type { LinkService } from '../media/links.ts';

/** What each setting that applies at once changes, as main.ts makes them (a part not made, such as the bot: null). */
export interface LiveParts {
  readonly log: {
    setLevel(level: LogLevel): void;
    setFormat(format: LogFormat): void;
    setLimits(limits: { readonly maxBytes: number; readonly files: number }): void;
  };
  readonly limits: { setLimits(limits: { readonly queueMax: number; readonly trackMaxMs: number }): void };
  readonly autoplay: { setTrackMax(ms: number): void };
  readonly lyrics: { setLyrics(on: boolean): void };
  readonly rest: { setAfter(ms: number): void };
  readonly cache: { setMaxBytes(bytes: number): void };
  readonly prefetch: { setCount(count: number): void };
  readonly links: {
    setServices(services: ReadonlySet<LinkService>): void;
    setSpotify(app: { readonly clientId: string; readonly clientSecret: string } | null): void;
  };
  readonly backups: { setSchedule(at: Config['backups']['at'], keep: number): void };
  readonly metrics: { setToken(token: string | null): void };
  /** The live connections' cap: the web server's, once it is made. */
  readonly live: () => { setTotal(total: number): void } | null;
  /** The voice channels' time alone: the bot's, when there is one. */
  readonly voice: () => { setIdleMs(ms: number): void } | null;
}

/** Hands each setting named (all of them apply at once) to its part, with its value in the next Config. */
export function applyLive(names: readonly string[], next: Config, parts: LiveParts): void {
  for (const name of names) {
    switch (name) {
      case 'JUKECORD_LOG_LEVEL':
        parts.log.setLevel(next.log.level);
        break;
      case 'JUKECORD_LOG_FORMAT':
        parts.log.setFormat(next.log.format);
        break;
      // The file's size and count go together: either is the file sink's rotation.
      case 'JUKECORD_LOG_MAX':
      case 'JUKECORD_LOG_FILES':
        parts.log.setLimits({ maxBytes: next.log.maxBytes, files: next.log.files });
        break;
      case 'JUKECORD_QUEUE_MAX':
        parts.limits.setLimits({ queueMax: next.queueMax, trackMaxMs: next.media.trackMaxMs });
        break;
      // The longest track is the actions' limit and autoplay's too.
      case 'JUKECORD_TRACK_MAX':
        parts.limits.setLimits({ queueMax: next.queueMax, trackMaxMs: next.media.trackMaxMs });
        parts.autoplay.setTrackMax(next.media.trackMaxMs);
        break;
      case 'JUKECORD_LYRICS':
        parts.lyrics.setLyrics(next.lyrics);
        break;
      case 'JUKECORD_REST_AFTER':
        parts.rest.setAfter(next.restAfterMs);
        break;
      case 'JUKECORD_CACHE_MAX':
        parts.cache.setMaxBytes(next.media.cacheMaxBytes);
        break;
      case 'JUKECORD_PREFETCH':
        parts.prefetch.setCount(next.media.prefetch);
        break;
      case 'JUKECORD_LINK_SERVICES':
        parts.links.setServices(next.links.services);
        break;
      // The Spotify app is its two settings together (one without the other is refused before it gets here).
      case 'JUKECORD_SPOTIFY_CLIENT_ID':
      case 'JUKECORD_SPOTIFY_CLIENT_SECRET':
        parts.links.setSpotify(next.links.spotify);
        break;
      case 'JUKECORD_BACKUP_AT':
      case 'JUKECORD_BACKUP_KEEP':
        parts.backups.setSchedule(next.backups.at, next.backups.keep);
        break;
      case 'JUKECORD_METRICS_TOKEN':
        parts.metrics.setToken(next.metrics.token);
        break;
      case 'JUKECORD_LIVE_MAX':
        parts.live()?.setTotal(next.liveMax);
        break;
      case 'JUKECORD_VOICE_IDLE':
        parts.voice()?.setIdleMs(next.voice.idleMs);
        break;
      default:
        throw new Error(`${name} applies at once, but nothing applies it`);
    }
  }
}
