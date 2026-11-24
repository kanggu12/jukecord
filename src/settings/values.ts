/**
 * Each setting's value as the running jukecord holds it, read out of a Config: what is compared to tell whether a
 * change took effect, waits for a restart, or changed nothing at all ("2048MiB" and "2GiB" are one size).
 *
 * Secrets are compared here like any value and never leave this module's callers: what the API and the logs say of a
 * secret is only whether it is set.
 */
import type { Config } from '../config.ts';
import { shownServer, timeOfDay } from '../config.ts';
import { describeAddress } from '../store/address.ts';

// Each setting's value out of a Config, by name. A setting the Config holds only together with others (a way of
// logging in that is off holds none of its settings) reads as null then.
const READERS: Readonly<Record<string, (config: Config) => unknown>> = {
  JUKECORD_HOST: (config) => config.host,
  JUKECORD_PORT: (config) => config.port,
  JUKECORD_PUBLISHED_PORT: (config) => config.publishedPort,
  JUKECORD_PUBLIC_URL: (config) => config.publicUrl,
  JUKECORD_TRUST_PROXY: (config) => config.trustProxy,
  JUKECORD_LIVE_MAX: (config) => config.liveMax,
  JUKECORD_DATA_DIR: (config) => config.dataDir,
  JUKECORD_SUPERVISOR: (config) => config.supervisor,
  JUKECORD_DISCORD_TOKEN: (config) => config.discord.token,
  JUKECORD_VOICE_IDLE: (config) => config.voice.idleMs,
  JUKECORD_DISCORD_CLIENT_ID: (config) => config.discord.clientId,
  JUKECORD_DISCORD_CLIENT_SECRET: (config) => config.discord.clientSecret,
  JUKECORD_OIDC_ISSUER: (config) => config.auth.oidc?.issuer ?? null,
  JUKECORD_OIDC_CLIENT_ID: (config) => config.auth.oidc?.clientId ?? null,
  JUKECORD_OIDC_CLIENT_SECRET: (config) => config.auth.oidc?.clientSecret ?? null,
  JUKECORD_OIDC_SCOPES: (config) => config.auth.oidc?.scopes ?? null,
  JUKECORD_OIDC_GROUPS_CLAIM: (config) => config.auth.oidc?.groupsClaim ?? null,
  JUKECORD_OIDC_ADMIN_GROUPS: (config) => config.auth.oidc?.groups.admin ?? null,
  JUKECORD_OIDC_CONTROL_GROUPS: (config) => config.auth.oidc?.groups.control ?? null,
  JUKECORD_OIDC_READ_GROUPS: (config) => config.auth.oidc?.groups.read ?? null,
  JUKECORD_OIDC_LABEL: (config) => config.auth.oidc?.label ?? null,
  JUKECORD_OIDC_DISCORD_CLAIM: (config) => config.auth.oidc?.discordClaim ?? null,
  JUKECORD_LDAP_URL: (config) => config.auth.ldap?.url ?? null,
  JUKECORD_LDAP_STARTTLS: (config) => config.auth.ldap?.startTls ?? null,
  JUKECORD_LDAP_CA_FILE: (config) => config.auth.ldap?.ca ?? null,
  JUKECORD_LDAP_BIND_DN: (config) => config.auth.ldap?.bindDn ?? null,
  JUKECORD_LDAP_BIND_PASSWORD: (config) => config.auth.ldap?.bindPassword ?? null,
  JUKECORD_LDAP_BASE_DN: (config) => config.auth.ldap?.baseDn ?? null,
  JUKECORD_LDAP_USER_FILTER: (config) => config.auth.ldap?.userFilter ?? null,
  JUKECORD_LDAP_GROUP_FILTER: (config) => config.auth.ldap?.groupFilter ?? null,
  JUKECORD_LDAP_GROUP_BASE_DN: (config) => config.auth.ldap?.groupBaseDn ?? null,
  JUKECORD_LDAP_NESTED_GROUPS: (config) => config.auth.ldap?.nestedGroups ?? null,
  JUKECORD_LDAP_ADMIN_GROUPS: (config) => config.auth.ldap?.groups.admin ?? null,
  JUKECORD_LDAP_CONTROL_GROUPS: (config) => config.auth.ldap?.groups.control ?? null,
  JUKECORD_LDAP_READ_GROUPS: (config) => config.auth.ldap?.groups.read ?? null,
  JUKECORD_LDAP_TIMEOUT: (config) => config.auth.ldap?.timeoutMs ?? null,
  JUKECORD_LDAP_LABEL: (config) => config.auth.ldap?.label ?? null,
  // The address read whole (a password moved or a TLS word changed is a change).
  JUKECORD_DATABASE_URL: (config) => config.database.address,
  JUKECORD_DATABASE_POOL: (config) => config.database.pool,
  JUKECORD_QUEUE_MAX: (config) => config.queueMax,
  JUKECORD_TRACK_MAX: (config) => config.media.trackMaxMs,
  JUKECORD_REST_AFTER: (config) => config.restAfterMs,
  JUKECORD_CACHE_MAX: (config) => config.media.cacheMaxBytes,
  JUKECORD_FETCH_TIMEOUT: (config) => config.media.fetchTimeoutMs,
  JUKECORD_PREFETCH: (config) => config.media.prefetch,
  JUKECORD_ALLOW_PRIVATE_ADDRESSES: (config) => config.media.allowPrivate,
  JUKECORD_YTDLP_COOKIES: (config) => config.media.cookies,
  JUKECORD_YTDLP: (config) => config.media.ytdlp,
  JUKECORD_FFMPEG: (config) => config.media.ffmpeg,
  JUKECORD_LYRICS: (config) => config.lyrics,
  JUKECORD_LINK_SERVICES: (config) => [...config.links.services].sort(),
  JUKECORD_SPOTIFY_CLIENT_ID: (config) => config.links.spotify?.clientId ?? null,
  JUKECORD_SPOTIFY_CLIENT_SECRET: (config) => config.links.spotify?.clientSecret ?? null,
  JUKECORD_BACKUP_AT: (config) => (config.backups.at ? timeOfDay(config.backups.at) : null),
  JUKECORD_BACKUP_KEEP: (config) => config.backups.keep,
  JUKECORD_LOG_LEVEL: (config) => config.log.level,
  JUKECORD_LOG_FORMAT: (config) => config.log.format,
  JUKECORD_LOG_MAX: (config) => config.log.maxBytes,
  JUKECORD_LOG_FILES: (config) => config.log.files,
  JUKECORD_METRICS_TOKEN: (config) => config.metrics.token,
  JUKECORD_BUS_URL: (config) => config.bus.url,
  JUKECORD_CACHE_URL: (config) => config.cacheUrl,
  JUKECORD_KEY_PREFIX: (config) => config.bus.prefix,
  JUKECORD_ROLE: (config) => config.role,
  JUKECORD_INTERNAL_PORT: (config) => config.internal.port,
  JUKECORD_INTERNAL_SECRET: (config) => config.internal.secret,
  JUKECORD_CORE_URL: (config) => config.internal.coreUrl,
};

/** The names READERS knows, for the test that holds them to the settings table. */
export const READ_NAMES: readonly string[] = Object.keys(READERS);

/** A setting's value in a Config, as data that compares (sets as sorted lists). */
export function valueIn(config: Config, name: string): unknown {
  const reader = READERS[name];
  if (!reader) throw new Error(`${name} has no reader of its value`);
  return reader(config);
}

/** Whether a setting holds the same value in two Configs. */
export function sameValue(a: Config, b: Config, name: string): boolean {
  return JSON.stringify(valueIn(a, name)) === JSON.stringify(valueIn(b, name));
}

/**
 * A setting's value as text for people: the database's address without its user or password, sizes and durations as
 * the Config holds them. Never called for a secret but the database's address, which says where, not who.
 */
export function shownValue(config: Config, name: string): string | null {
  if (name === 'JUKECORD_DATABASE_URL') return describeAddress(config.database.address);
  // The bus's and the shared cache's servers, without their user or password.
  if (name === 'JUKECORD_BUS_URL') return config.bus.url === null ? null : shownServer(config.bus.url);
  if (name === 'JUKECORD_CACHE_URL') return config.cacheUrl === 'memory' ? 'memory' : shownServer(config.cacheUrl);
  const value = valueIn(config, name);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
