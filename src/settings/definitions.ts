/**
 * Every setting jukecord has, defined once: its environment variable, the group the panel shows it in, the kind of
 * value it holds, its default and limits, whether a change applies at once or after a restart, whether it is needed
 * before the database opens (bootstrap) or kept with the data (runtime), whether it is a secret, which services read
 * it, and its label and one-line explanation in English and Korean.
 *
 * src/config.ts reads every setting through this table (its names, defaults and limits); the settings page, the API's
 * answer and `jukecord settings` show it; the tests hold the examples, the guide's table and config.ts to it, so a
 * setting cannot be added in one place and forgotten in another. Nothing here needs Node: it is plain data and small
 * helpers.
 */

/**
 * What a setting holds, which says how its text is read and which control the panel gives it: free text, a secret
 * (never shown, only whether it is set), an address, a whole number, a duration ("60s", "5m"), a size ("2GiB"), yes or
 * no, one of a few words, a time of day ("04:30"), or a list of items.
 */
export type SettingKind =
  | 'text'
  | 'secret'
  | 'url'
  | 'integer'
  | 'duration'
  | 'size'
  | 'boolean'
  | 'choice'
  | 'time'
  | 'list';

/** The panel's groups, in the order the page shows them. */
export type GroupId =
  | 'server'
  | 'discord'
  | 'logins'
  | 'database'
  | 'cache'
  | 'media'
  | 'backups'
  | 'logging'
  | 'services';

/** The services of a split jukecord a setting changes something in (one process is both). */
export type ServiceRole = 'core' | 'edge';

/** Words in each language the panel speaks. */
export interface Words {
  readonly en: string;
  readonly ko: string;
}

/** One setting. */
export interface SettingDefinition {
  /** The environment variable, which is also the setting's name everywhere (the API, the CLI, settings.json). */
  readonly name: string;
  readonly group: GroupId;
  /** The part of its group it belongs to, for a group in parts (the logins: Discord, SSO, the directory). */
  readonly part?: string;
  readonly kind: SettingKind;
  /** The default as the environment would hold it; null when there is none (the setting is off, or unset). */
  readonly default: string | null;
  /** What the default is when it is made from something else (the published port is the port), in words. */
  readonly defaultNote?: Words;
  /** The smallest and largest value, in the kind's own notation: "1", "5s", "64MiB". */
  readonly min?: string;
  readonly max?: string;
  /** The words of a choice, or the items a list may hold (a list without them takes any). */
  readonly choices?: readonly string[];
  /** For a list: what its items are written apart with (a DN has commas in it, so LDAP's groups take semicolons). */
  readonly separator?: string;
  /** The word that turns a duration or a time off ("0", "off"), when it can be. */
  readonly off?: string;
  /** For yes or no: the two words written for it, yes first (each setting kept its own: on/off, true/false). */
  readonly words?: readonly [string, string];
  /** The longest text it takes, in characters (a login key's words). */
  readonly maxLength?: number;
  /** Whether a change applies at once, or once jukecord restarts. */
  readonly applies: 'now' | 'restart';
  /**
   * bootstrap: needed before the database opens (kept in settings.json in the data folder); runtime: kept in the
   * database, shared by every service; environment: read from the environment only (the data folder itself).
   */
  readonly layer: 'bootstrap' | 'runtime' | 'environment';
  /** Never shown, never logged: only whether it is set. */
  readonly secret?: boolean;
  /** Also read from the file <NAME>_FILE names (a Docker or Kubernetes secret). */
  readonly file?: boolean;
  /** The services it changes something in. */
  readonly roles: readonly ServiceRole[];
  /** Shown on the settings page; false for one that only says how jukecord was started (what restarts it). */
  readonly panel?: boolean;
  readonly label: Words;
  /** One line: what it is, and what its words mean when it has some. */
  readonly help: Words;
}

/** A group of the settings page, and its parts. */
export interface GroupDefinition {
  readonly id: GroupId;
  readonly label: Words;
  /** Parts shown and saved apart, each with its own test (the ways of logging in). */
  readonly parts?: readonly { readonly id: string; readonly label: Words }[];
}

export const GROUPS: readonly GroupDefinition[] = [
  { id: 'server', label: { en: 'Server and network', ko: '서버와 네트워크' } },
  { id: 'discord', label: { en: 'Discord', ko: '디스코드' } },
  {
    id: 'logins',
    label: { en: 'Logins', ko: '로그인' },
    parts: [
      { id: 'discord-login', label: { en: 'Discord login', ko: '디스코드 로그인' } },
      { id: 'sso', label: { en: 'SSO (OIDC)', ko: 'SSO(OIDC)' } },
      { id: 'directory', label: { en: 'Directory (LDAP, Active Directory)', ko: '디렉터리(LDAP, Active Directory)' } },
    ],
  },
  { id: 'database', label: { en: 'Database', ko: '데이터베이스' } },
  { id: 'cache', label: { en: 'Cache and bus', ko: '캐시와 버스' } },
  { id: 'media', label: { en: 'Media and limits', ko: '미디어와 제한' } },
  { id: 'backups', label: { en: 'Backups', ko: '백업' } },
  { id: 'logging', label: { en: 'Logging and monitoring', ko: '로그와 모니터링' } },
  { id: 'services', label: { en: 'Services', ko: '서비스' } },
];

// Both services: every process reads it (a split jukecord's core and edges, or the one process).
const BOTH: readonly ServiceRole[] = ['core', 'edge'];
// What the core alone does: Discord, the players, the media, the backups.
const CORE: readonly ServiceRole[] = ['core'];
// What the edges alone do: the panel, the API, the logins, the live connections.
const EDGE: readonly ServiceRole[] = ['edge'];

/** Every setting, group by group in the page's order. */
export const SETTINGS: readonly SettingDefinition[] = [
  // Server and network: where jukecord listens and how it is reached.
  {
    name: 'JUKECORD_HOST',
    group: 'server',
    kind: 'text',
    default: '127.0.0.1',
    applies: 'restart',
    layer: 'bootstrap',
    roles: BOTH,
    label: { en: 'Listen address', ko: '수신 주소' },
    help: {
      en: 'The address the panel and the API listen on; 0.0.0.0 is every network',
      ko: '패널과 API가 연결을 받는 주소. 0.0.0.0은 모든 네트워크',
    },
  },
  {
    name: 'JUKECORD_PORT',
    group: 'server',
    kind: 'integer',
    default: '8795',
    min: '1',
    max: '65535',
    applies: 'restart',
    layer: 'bootstrap',
    roles: BOTH,
    label: { en: 'Port', ko: '포트' },
    help: { en: 'The port the panel and the API listen on', ko: '패널과 API가 연결을 받는 포트' },
  },
  {
    name: 'JUKECORD_PUBLISHED_PORT',
    group: 'server',
    kind: 'integer',
    default: null,
    defaultNote: { en: 'the port', ko: '포트와 같음' },
    min: '1',
    max: '65535',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Port on this machine', ko: '이 컴퓨터의 포트' },
    help: {
      en: 'The port this machine reaches jukecord on, for links without a public address (Compose sets it)',
      ko: '이 컴퓨터에서 jukecord에 닿는 포트. 공개 주소가 없을 때 링크에 쓰임(Compose가 정함)',
    },
  },
  {
    name: 'JUKECORD_PUBLIC_URL',
    group: 'server',
    kind: 'url',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: BOTH,
    label: { en: 'Public address', ko: '공개 주소' },
    help: {
      en: 'The address people open the panel at, when it is not this machine; logins and links use it',
      ko: '다른 컴퓨터에서 패널을 여는 주소. 로그인과 링크가 이 주소를 씀',
    },
  },
  {
    name: 'JUKECORD_TRUST_PROXY',
    group: 'server',
    kind: 'text',
    default: 'false',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Reverse proxy', ko: '리버스 프록시' },
    help: {
      en: 'Behind a reverse proxy: how many proxies are in front (1 for one), or their addresses; false trusts none',
      ko: '리버스 프록시 뒤에서 앞에 있는 프록시 수(하나면 1)나 그 주소. false면 아무것도 믿지 않음',
    },
  },
  {
    name: 'JUKECORD_LIVE_MAX',
    group: 'server',
    kind: 'integer',
    default: '1000',
    min: '10',
    max: '100000',
    applies: 'now',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Open panels at most', ko: '동시에 열린 패널' },
    help: {
      en: 'The most live connections at once (each open panel is one); also ten per login and twenty per address',
      ko: '한꺼번에 받는 실시간 연결 수(열린 패널 하나가 하나). 로그인마다 10개, 주소마다 20개까지',
    },
  },
  {
    name: 'JUKECORD_DATA_DIR',
    group: 'server',
    kind: 'text',
    default: './data',
    applies: 'restart',
    layer: 'environment',
    roles: BOTH,
    label: { en: 'Data folder', ko: '데이터 폴더' },
    help: {
      en: 'Where the database, the media cache, the logs, the backups and settings.json are',
      ko: '데이터베이스, 미디어 캐시, 로그, 백업, settings.json이 있는 폴더',
    },
  },
  {
    name: 'JUKECORD_SUPERVISOR',
    group: 'server',
    kind: 'choice',
    default: null,
    defaultNote: { en: 'found out at the start', ko: '시작할 때 알아냄' },
    choices: ['docker', 'kubernetes', 'systemd', 'launcher', 'none'],
    applies: 'restart',
    layer: 'environment',
    roles: BOTH,
    panel: false,
    label: { en: 'What starts jukecord again', ko: 'jukecord를 다시 띄우는 것' },
    help: {
      en: 'What starts jukecord again when it restarts itself: docker, kubernetes, systemd, launcher or none',
      ko: 'jukecord가 스스로 다시 시작할 때 다시 띄우는 것: docker, kubernetes, systemd, launcher, none',
    },
  },

  // Discord: the bot.
  {
    name: 'JUKECORD_DISCORD_TOKEN',
    group: 'discord',
    kind: 'secret',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: CORE,
    label: { en: 'Bot token', ko: '봇 토큰' },
    help: {
      en: "The Discord bot's token; without it jukecord plays in browsers only",
      ko: '디스코드 봇의 토큰. 없으면 브라우저에서만 재생함',
    },
  },
  {
    name: 'JUKECORD_VOICE_IDLE',
    group: 'discord',
    kind: 'duration',
    default: '5m',
    min: '10s',
    max: '24h',
    off: '0',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Leave voice when alone after', ko: '혼자 남으면 나가기까지' },
    help: {
      en: 'How long the bot stays alone in a voice channel before it leaves; 0 stays',
      ko: '음성 채널에 혼자 남은 봇이 나가기까지 기다리는 시간. 0이면 나가지 않음',
    },
  },

  // Logins: logging in with Discord.
  {
    name: 'JUKECORD_DISCORD_CLIENT_ID',
    group: 'logins',
    part: 'discord-login',
    kind: 'text',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Application ID', ko: '애플리케이션 ID' },
    help: {
      en: "The Discord application's ID, for logging in with Discord",
      ko: '디스코드 로그인에 쓰는 애플리케이션 ID',
    },
  },
  {
    name: 'JUKECORD_DISCORD_CLIENT_SECRET',
    group: 'logins',
    part: 'discord-login',
    kind: 'secret',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: EDGE,
    label: { en: 'Client secret', ko: '클라이언트 시크릿' },
    help: {
      en: "The application's OAuth2 client secret, for logging in with Discord",
      ko: '디스코드 로그인에 쓰는 애플리케이션의 OAuth2 클라이언트 시크릿',
    },
  },

  // Logins: SSO through an OpenID Connect provider.
  {
    name: 'JUKECORD_OIDC_ISSUER',
    group: 'logins',
    part: 'sso',
    kind: 'url',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Issuer', ko: '발급자 주소' },
    help: {
      en: "The identity provider's issuer address; SSO is on once it is set",
      ko: 'ID 제공자의 발급자(issuer) 주소. 이 주소가 있으면 SSO가 켜짐',
    },
  },
  {
    name: 'JUKECORD_OIDC_CLIENT_ID',
    group: 'logins',
    part: 'sso',
    kind: 'text',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Client ID', ko: '클라이언트 ID' },
    help: { en: 'The client jukecord is at the provider', ko: '제공자에 등록한 jukecord 클라이언트의 ID' },
  },
  {
    name: 'JUKECORD_OIDC_CLIENT_SECRET',
    group: 'logins',
    part: 'sso',
    kind: 'secret',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: EDGE,
    label: { en: 'Client secret', ko: '클라이언트 시크릿' },
    help: {
      en: "The client's secret; none for a public client, which proves itself with PKCE",
      ko: '클라이언트 시크릿. 공개 클라이언트는 시크릿 없이 PKCE로 확인함',
    },
  },
  {
    name: 'JUKECORD_OIDC_SCOPES',
    group: 'logins',
    part: 'sso',
    kind: 'list',
    default: 'openid profile',
    separator: ' ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Scopes', ko: '스코프' },
    help: { en: 'The scopes asked for; openid always, and first', ko: '요청하는 스코프. openid는 늘 맨 앞에 요청함' },
  },
  {
    name: 'JUKECORD_OIDC_GROUPS_CLAIM',
    group: 'logins',
    part: 'sso',
    kind: 'text',
    default: 'groups',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Groups claim', ko: '그룹 클레임' },
    help: {
      en: 'Where the groups or roles are among the claims: a name, or a path like realm_access.roles',
      ko: '그룹이나 역할이 든 클레임. 이름이나 realm_access.roles 같은 경로',
    },
  },
  {
    name: 'JUKECORD_OIDC_ADMIN_GROUPS',
    group: 'logins',
    part: 'sso',
    kind: 'list',
    default: null,
    separator: ', ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Host-level groups', ko: '호스트 권한 그룹' },
    help: {
      en: 'Groups whose people may do what the host may; * is everyone the provider lets in',
      ko: '호스트와 같은 일을 할 수 있는 그룹. *는 제공자가 들여보내는 모든 사람',
    },
  },
  {
    name: 'JUKECORD_OIDC_CONTROL_GROUPS',
    group: 'logins',
    part: 'sso',
    kind: 'list',
    default: null,
    separator: ', ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Control groups', ko: '제어 그룹' },
    help: { en: 'Groups whose people change the music in every server', ko: '모든 서버에서 음악을 바꿀 수 있는 그룹' },
  },
  {
    name: 'JUKECORD_OIDC_READ_GROUPS',
    group: 'logins',
    part: 'sso',
    kind: 'list',
    default: null,
    separator: ', ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'View groups', ko: '보기 그룹' },
    help: { en: 'Groups whose people look and listen', ko: '보고 듣기만 하는 그룹' },
  },
  {
    name: 'JUKECORD_OIDC_LABEL',
    group: 'logins',
    part: 'sso',
    kind: 'text',
    default: null,
    defaultNote: { en: 'Log in with SSO', ko: 'SSO로 로그인' },
    maxLength: 40,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Words on the login key', ko: '로그인 단추의 문구' },
    help: { en: 'The words on the login page’s key for SSO', ko: '로그인 화면의 SSO 단추에 쓰는 문구' },
  },
  {
    name: 'JUKECORD_OIDC_DISCORD_CLAIM',
    group: 'logins',
    part: 'sso',
    kind: 'text',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Discord ID claim', ko: '디스코드 ID 클레임' },
    help: {
      en: 'A claim with a Discord user ID: a login that has one is that Discord user',
      ko: '디스코드 사용자 ID가 든 클레임. 이 값이 있는 로그인은 그 디스코드 사용자로 들어감',
    },
  },

  // Logins: accounts of an LDAP directory or Active Directory.
  {
    name: 'JUKECORD_LDAP_URL',
    group: 'logins',
    part: 'directory',
    kind: 'url',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Directory address', ko: '디렉터리 주소' },
    help: {
      en: "The directory's ldap:// or ldaps:// address; directory accounts are on once it is set",
      ko: '디렉터리의 ldap:// 또는 ldaps:// 주소. 이 주소가 있으면 디렉터리 계정 로그인이 켜짐',
    },
  },
  {
    name: 'JUKECORD_LDAP_STARTTLS',
    group: 'logins',
    part: 'directory',
    kind: 'boolean',
    default: 'no',
    words: ['yes', 'no'],
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'StartTLS', ko: 'StartTLS' },
    help: {
      en: 'Encrypts an ldap:// connection before anything is sent',
      ko: 'ldap:// 연결을 무엇이든 보내기 전에 암호화함',
    },
  },
  {
    name: 'JUKECORD_LDAP_CA_FILE',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    defaultNote: { en: "the system's", ko: '시스템의 인증서' },
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'CA certificates file', ko: 'CA 인증서 파일' },
    help: {
      en: "A file of the certificates (PEM) the directory's own is checked against",
      ko: '디렉터리의 인증서를 확인할 CA 인증서(PEM) 파일',
    },
  },
  {
    name: 'JUKECORD_LDAP_BIND_DN',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    defaultNote: { en: 'an anonymous search', ko: '익명 검색' },
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Service account', ko: '서비스 계정' },
    help: {
      en: 'The account that finds people: a DN, or name@domain for Active Directory',
      ko: '사람을 찾는 계정. DN이나 Active Directory의 이름@도메인',
    },
  },
  {
    name: 'JUKECORD_LDAP_BIND_PASSWORD',
    group: 'logins',
    part: 'directory',
    kind: 'secret',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: EDGE,
    label: { en: 'Service account password', ko: '서비스 계정 암호' },
    help: { en: "The service account's password", ko: '서비스 계정의 암호' },
  },
  {
    name: 'JUKECORD_LDAP_BASE_DN',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Base DN', ko: '기준 DN' },
    help: { en: 'Where people are looked for', ko: '사람을 찾는 위치' },
  },
  {
    name: 'JUKECORD_LDAP_USER_FILTER',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: '(uid={username})',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'User filter', ko: '사용자 필터' },
    help: {
      en: "The filter that finds one person, {username} where the name typed goes (Active Directory's: (sAMAccountName={username}))",
      ko: '한 사람을 찾는 필터. {username} 자리에 입력한 이름이 들어감(Active Directory는 (sAMAccountName={username}))',
    },
  },
  {
    name: 'JUKECORD_LDAP_GROUP_FILTER',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    defaultNote: { en: 'memberOf', ko: 'memberOf' },
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Group filter', ko: '그룹 필터' },
    help: {
      en: "A filter that finds a person's groups, with {dn} or {username}, in place of their memberOf",
      ko: '사람의 그룹을 찾는 필터. {dn}이나 {username}을 쓰고, memberOf 대신 쓰임',
    },
  },
  {
    name: 'JUKECORD_LDAP_GROUP_BASE_DN',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    defaultNote: { en: 'the base DN', ko: '기준 DN' },
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Group base DN', ko: '그룹 기준 DN' },
    help: { en: 'Where groups are looked for', ko: '그룹을 찾는 위치' },
  },
  {
    name: 'JUKECORD_LDAP_NESTED_GROUPS',
    group: 'logins',
    part: 'directory',
    kind: 'boolean',
    default: 'no',
    words: ['yes', 'no'],
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Nested groups', ko: '중첩 그룹' },
    help: {
      en: "Groups through Active Directory's rule for groups in groups",
      ko: 'Active Directory의 그룹 안 그룹 규칙으로 그룹을 읽음',
    },
  },
  {
    name: 'JUKECORD_LDAP_ADMIN_GROUPS',
    group: 'logins',
    part: 'directory',
    kind: 'list',
    default: null,
    separator: '; ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Host-level groups', ko: '호스트 권한 그룹' },
    help: {
      en: 'Groups (DNs or names) whose people may do what the host may; * is everyone the directory knows',
      ko: '호스트와 같은 일을 할 수 있는 그룹(DN이나 이름). *는 디렉터리의 모든 사람',
    },
  },
  {
    name: 'JUKECORD_LDAP_CONTROL_GROUPS',
    group: 'logins',
    part: 'directory',
    kind: 'list',
    default: null,
    separator: '; ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Control groups', ko: '제어 그룹' },
    help: {
      en: 'Groups (DNs or names) whose people change the music in every server',
      ko: '모든 서버에서 음악을 바꿀 수 있는 그룹(DN이나 이름)',
    },
  },
  {
    name: 'JUKECORD_LDAP_READ_GROUPS',
    group: 'logins',
    part: 'directory',
    kind: 'list',
    default: null,
    separator: '; ',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'View groups', ko: '보기 그룹' },
    help: { en: 'Groups (DNs or names) whose people look and listen', ko: '보고 듣기만 하는 그룹(DN이나 이름)' },
  },
  {
    name: 'JUKECORD_LDAP_TIMEOUT',
    group: 'logins',
    part: 'directory',
    kind: 'duration',
    default: '10s',
    min: '1s',
    max: '60s',
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Time limit', ko: '제한 시간' },
    help: {
      en: 'How long connecting, and each request after, may take',
      ko: '연결과 그 뒤의 요청마다 기다리는 가장 긴 시간',
    },
  },
  {
    name: 'JUKECORD_LDAP_LABEL',
    group: 'logins',
    part: 'directory',
    kind: 'text',
    default: null,
    defaultNote: { en: 'the panel’s own', ko: '패널의 기본 문구' },
    maxLength: 40,
    applies: 'restart',
    layer: 'runtime',
    roles: EDGE,
    label: { en: 'Words on the login key', ko: '로그인 단추의 문구' },
    help: {
      en: 'The words on the login page’s key for directory accounts',
      ko: '로그인 화면의 디렉터리 계정 단추에 쓰는 문구',
    },
  },

  // Database: where jukecord keeps its data.
  {
    name: 'JUKECORD_DATABASE_URL',
    group: 'database',
    kind: 'url',
    default: 'sqlite:',
    applies: 'restart',
    layer: 'bootstrap',
    secret: true,
    file: true,
    roles: BOTH,
    label: { en: 'Database', ko: '데이터베이스' },
    help: {
      en: 'Where the data is: sqlite: (the data folder’s file), sqlite:/a/file.db, postgres://… or mysql://…',
      ko: '데이터가 있는 곳: sqlite:(데이터 폴더의 파일), sqlite:/경로/파일.db, postgres://…, mysql://…',
    },
  },
  {
    name: 'JUKECORD_DATABASE_POOL',
    group: 'database',
    kind: 'integer',
    default: '10',
    min: '1',
    max: '100',
    applies: 'restart',
    layer: 'bootstrap',
    roles: BOTH,
    label: { en: 'Connections at most', ko: '최대 연결 수' },
    help: {
      en: 'The most connections jukecord opens to a database server (SQLite has its one)',
      ko: '데이터베이스 서버에 여는 연결의 최대 수(SQLite는 하나)',
    },
  },

  // Media and limits: what may be added, how tracks are fetched, and the outside services asked.
  {
    name: 'JUKECORD_QUEUE_MAX',
    group: 'media',
    kind: 'integer',
    default: '1000',
    min: '10',
    max: '100000',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Longest queue', ko: '대기열 길이' },
    help: { en: "The most tracks a server's queue holds", ko: '한 서버의 대기열에 들어가는 곡의 최대 수' },
  },
  {
    name: 'JUKECORD_TRACK_MAX',
    group: 'media',
    kind: 'duration',
    default: '3h',
    min: '1m',
    max: '24h',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Longest track', ko: '가장 긴 곡' },
    help: { en: 'The longest track that may be added', ko: '추가할 수 있는 곡의 최대 길이' },
  },
  {
    name: 'JUKECORD_REST_AFTER',
    group: 'media',
    kind: 'duration',
    default: '2m',
    min: '10s',
    max: '24h',
    off: '0',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Pause with nobody listening after', ko: '아무도 안 들으면 멈추기까지' },
    help: {
      en: 'How long a server nobody hears plays on before it pauses; 0 plays on',
      ko: '아무도 듣지 않는 서버가 멈추기 전까지 재생하는 시간. 0이면 계속 재생',
    },
  },
  {
    name: 'JUKECORD_CACHE_MAX',
    group: 'media',
    kind: 'size',
    default: '2GiB',
    min: '64MiB',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Media cache size', ko: '미디어 캐시 크기' },
    help: {
      en: 'The most the media cache holds; the tracks played longest ago go first',
      ko: '미디어 캐시의 최대 크기. 가장 오래전에 재생한 곡부터 지움',
    },
  },
  {
    name: 'JUKECORD_FETCH_TIMEOUT',
    group: 'media',
    kind: 'duration',
    default: '60s',
    min: '5s',
    max: '10m',
    applies: 'restart',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Time to get a track', ko: '곡을 받는 제한 시간' },
    help: { en: 'How long getting one track may take', ko: '곡 하나를 받는 데 기다리는 가장 긴 시간' },
  },
  {
    name: 'JUKECORD_PREFETCH',
    group: 'media',
    kind: 'integer',
    default: '2',
    min: '0',
    max: '5',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Tracks fetched ahead', ko: '미리 받는 곡' },
    help: { en: 'How many of the next tracks are fetched ahead of time', ko: '다음 곡 가운데 미리 받아 두는 곡 수' },
  },
  {
    name: 'JUKECORD_ALLOW_PRIVATE_ADDRESSES',
    group: 'media',
    kind: 'boolean',
    default: 'false',
    words: ['true', 'false'],
    applies: 'restart',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Private network addresses', ko: '사설망 주소' },
    help: {
      en: 'Also fetches from addresses on private networks (a media server on the local network)',
      ko: '사설망 주소(로컬 네트워크의 미디어 서버)에서도 받음',
    },
  },
  {
    name: 'JUKECORD_YTDLP_COOKIES',
    group: 'media',
    kind: 'text',
    default: null,
    applies: 'restart',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Cookies file for yt-dlp', ko: 'yt-dlp 쿠키 파일' },
    help: {
      en: "A cookies file for YouTube's sign-in check; yt-dlp gets a copy of it",
      ko: 'YouTube의 로그인 확인에 쓰는 쿠키 파일. yt-dlp는 그 사본을 씀',
    },
  },
  {
    name: 'JUKECORD_YTDLP',
    group: 'media',
    kind: 'text',
    default: 'yt-dlp',
    applies: 'restart',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'yt-dlp program', ko: 'yt-dlp 프로그램' },
    help: { en: 'The yt-dlp program jukecord runs', ko: 'jukecord가 실행하는 yt-dlp 프로그램' },
  },
  {
    name: 'JUKECORD_FFMPEG',
    group: 'media',
    kind: 'text',
    default: 'ffmpeg',
    applies: 'restart',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'FFmpeg program', ko: 'FFmpeg 프로그램' },
    help: { en: 'The ffmpeg program jukecord runs', ko: 'jukecord가 실행하는 ffmpeg 프로그램' },
  },
  {
    name: 'JUKECORD_LYRICS',
    group: 'media',
    kind: 'boolean',
    default: 'on',
    words: ['on', 'off'],
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Lyrics', ko: '가사' },
    help: {
      en: 'Lyrics of the track playing, from LRCLIB; off asks LRCLIB nothing',
      ko: '재생 중인 곡의 가사를 LRCLIB에서 찾음. 끄면 LRCLIB에 아무것도 묻지 않음',
    },
  },
  {
    name: 'JUKECORD_LINK_SERVICES',
    group: 'media',
    kind: 'list',
    default: 'deezer, spotify, apple-music',
    choices: ['deezer', 'spotify', 'apple-music'],
    separator: ', ',
    off: 'none',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Links read', ko: '읽는 링크' },
    help: {
      en: 'The music services whose links jukecord reads and finds on YouTube',
      ko: '링크를 읽어 YouTube에서 찾아 주는 음악 서비스',
    },
  },
  {
    name: 'JUKECORD_SPOTIFY_CLIENT_ID',
    group: 'media',
    kind: 'text',
    default: null,
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Spotify app', ko: 'Spotify 앱' },
    help: {
      en: 'Your own Spotify app’s client ID, for Spotify albums and playlists',
      ko: 'Spotify 앨범과 플레이리스트에 쓰는 내 Spotify 앱의 클라이언트 ID',
    },
  },
  {
    name: 'JUKECORD_SPOTIFY_CLIENT_SECRET',
    group: 'media',
    kind: 'secret',
    default: null,
    applies: 'now',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: CORE,
    label: { en: 'Spotify app secret', ko: 'Spotify 앱 시크릿' },
    help: { en: "The Spotify app's client secret", ko: 'Spotify 앱의 클라이언트 시크릿' },
  },

  // Backups.
  {
    name: 'JUKECORD_BACKUP_AT',
    group: 'backups',
    kind: 'time',
    default: 'off',
    off: 'off',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Daily backup at', ko: '매일 백업하는 시각' },
    help: {
      en: "A backup of the database every day at this time, in jukecord's time zone; off makes none",
      ko: '매일 이 시각(jukecord의 시간대)에 데이터베이스를 백업함. off면 하지 않음',
    },
  },
  {
    name: 'JUKECORD_BACKUP_KEEP',
    group: 'backups',
    kind: 'integer',
    default: '7',
    min: '1',
    max: '365',
    applies: 'now',
    layer: 'runtime',
    roles: CORE,
    label: { en: 'Backups kept', ko: '남기는 백업' },
    help: { en: 'How many backups the backups folder keeps', ko: '백업 폴더에 남기는 백업 수' },
  },

  // Logging and monitoring.
  {
    name: 'JUKECORD_LOG_LEVEL',
    group: 'logging',
    kind: 'choice',
    default: 'info',
    choices: ['debug', 'info', 'warn', 'error'],
    applies: 'now',
    layer: 'runtime',
    roles: BOTH,
    label: { en: 'Log level', ko: '로그 수준' },
    help: {
      en: 'The least a record is to be written: debug, info, warn or error',
      ko: '기록하는 로그의 가장 낮은 수준: debug, info, warn, error',
    },
  },
  {
    name: 'JUKECORD_LOG_FORMAT',
    group: 'logging',
    kind: 'choice',
    default: 'text',
    choices: ['text', 'json'],
    applies: 'now',
    layer: 'runtime',
    roles: BOTH,
    label: { en: 'Console lines', ko: '콘솔 출력 형식' },
    help: {
      en: "The console's lines as text, or as JSON for a log shipper; the log files are JSON either way",
      ko: '콘솔 줄을 text로, 또는 로그 수집기에 맞춰 JSON으로 씀. 로그 파일은 늘 JSON',
    },
  },
  {
    name: 'JUKECORD_LOG_MAX',
    group: 'logging',
    kind: 'size',
    default: '5MiB',
    min: '64KiB',
    applies: 'now',
    layer: 'runtime',
    roles: BOTH,
    label: { en: 'Log file size', ko: '로그 파일 크기' },
    help: { en: 'The size at which a log file is put aside for a new one', ko: '로그 파일을 새로 시작하는 크기' },
  },
  {
    name: 'JUKECORD_LOG_FILES',
    group: 'logging',
    kind: 'integer',
    default: '5',
    min: '1',
    max: '50',
    applies: 'now',
    layer: 'runtime',
    roles: BOTH,
    label: { en: 'Log files kept', ko: '남기는 로그 파일' },
    help: { en: 'How many log files are kept, the current one included', ko: '지금 파일을 넣어 남기는 로그 파일 수' },
  },
  {
    name: 'JUKECORD_METRICS_TOKEN',
    group: 'logging',
    kind: 'secret',
    default: null,
    applies: 'now',
    layer: 'runtime',
    secret: true,
    file: true,
    roles: BOTH,
    label: { en: 'Metrics token', ko: '메트릭 토큰' },
    help: {
      en: 'A token that lets a scraper read /metrics from anywhere (Authorization: Bearer)',
      ko: '어디서든 /metrics를 읽게 해 주는 토큰(Authorization: Bearer)',
    },
  },
];

/**
 * Variables of the deployment that jukecord itself does not read (Compose's published address and image): known, so
 * that passing them through from .env raises no "not a jukecord setting".
 */
export const DEPLOYMENT_VARIABLES: readonly string[] = ['JUKECORD_BIND', 'JUKECORD_IMAGE'];

// The table by name, for the lookups below.
const BY_NAME: ReadonlyMap<string, SettingDefinition> = new Map(SETTINGS.map((setting) => [setting.name, setting]));

/** A setting's definition by its name; a name that is not in the table is a mistake in jukecord's own code. */
export function definition(name: string): SettingDefinition {
  const found = BY_NAME.get(name);
  if (!found) throw new Error(`${name} is not in the settings table`);
  return found;
}

/** A setting's definition by its name, or null for a name that is no setting. */
export function findDefinition(name: string): SettingDefinition | null {
  return BY_NAME.get(name) ?? null;
}

/** Every variable jukecord knows: each setting, the _FILE twin of each read from a file, and the deployment's. */
export const KNOWN_VARIABLES: readonly string[] = [
  ...SETTINGS.flatMap((setting) => (setting.file ? [setting.name, `${setting.name}_FILE`] : [setting.name])),
  ...DEPLOYMENT_VARIABLES,
];

/** Where a saved value of a setting is kept: settings.json beside the data (bootstrap ones and secrets), or the database. */
export function storedIn(setting: SettingDefinition): 'file' | 'database' | 'nowhere' {
  if (setting.layer === 'environment') return 'nowhere';
  return setting.layer === 'bootstrap' || setting.secret ? 'file' : 'database';
}

/** The settings of one group, in the table's order. */
export function settingsOf(group: GroupId): readonly SettingDefinition[] {
  return SETTINGS.filter((setting) => setting.group === group);
}
