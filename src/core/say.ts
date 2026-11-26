/**
 * Refusals and failures in a person's language, for every place that shows them: Discord, the panel. The actions say
 * what went wrong in short English (the API and the command line show that as it is); people read it as a sentence, in
 * Korean for Korean users.
 *
 * Each entry matches one message the actions can give. A message without an entry is shown in English, so a new
 * message is never lost, only untranslated until it gets its line here. Nothing here needs Node or a browser: the
 * panel's bundle takes this file as it is.
 */
import { REASONS } from './reasons.ts';

/** The languages people read jukecord in. */
export type Lang = 'en' | 'ko';

// [the English message, or a pattern for one with a value in it; the Korean, with $1 for that value].
const KOREAN: readonly (readonly [string | RegExp, string])[] = [
  ['nothing is playing', '재생 중인 곡 없음'],
  ['the bot is not in a voice channel', '봇이 음성 채널에 없음'],
  [/^the queue is full \((\d+) tracks\)$/, '대기열이 가득 참($1곡)'],
  ['the queue is empty', '대기열이 비어 있음'],
  ['it is already playing', '이미 재생 중'],
  ['only members with the DJ role can change the music here', '이 서버에서는 DJ 역할이 있어야 음악을 바꿀 수 있음'],
  ['only people who can manage the server can set the DJ role', '서버 관리 권한이 있어야 DJ 역할을 정할 수 있음'],
  ['you cannot join that channel yourself', '본인이 들어갈 수 없는 채널'],
  [/^the bot may not connect or speak in (.+)$/, '$1 채널에서 봇에게 연결 또는 말하기 권한이 없음'],
  ['join a voice channel first, or name one', '먼저 음성 채널에 들어가거나 채널을 고르세요'],
  ['that is not a voice channel', '음성 채널이 아님'],
  ['the bot does not play on stages', '스테이지 채널에서는 재생하지 않음'],
  // Only seek gives it: a time in the track, not a place in the queue.
  ['the position must be 0 or more', '재생 위치는 0초 이상이어야 함'],
  ['there is nothing to save: the queue is empty', '저장할 곡 없음: 대기열이 비어 있음'],
  [/^longer than the (\d+) minute limit$/, '$1분 제한보다 긴 곡'],
  ['that role is not in this server', '이 서버에 없는 역할'],
  ['that track is no longer in the queue', '대기열에 없는 곡'],
  ['the bot is not in that server', '봇이 그 서버에 없음'],
  ['there is no track with that number in the queue', '대기열에 그 번호의 곡이 없음'],
  [/^there is no playlist named "(.+)"$/, '"$1" 플레이리스트 없음'],
  [/^a playlist named "(.+)" exists$/, '"$1" 플레이리스트가 이미 있음'],
  ['a playlist name is 1 to 100 characters', '플레이리스트 이름은 1자부터 100자까지'],
  ['could not connect to the voice channel in time', '음성 채널에 제때 연결하지 못함'],
  [
    'jukecord is still connecting to Discord; try again in a moment',
    'jukecord가 아직 디스코드에 연결 중: 잠시 뒤 다시 시도하세요',
  ],
  [
    'jukecord is looking up other tracks right now; try again in a moment',
    '다른 곡을 찾는 중: 잠시 뒤 다시 시도하세요',
  ],
  ['nothing to add', '추가할 내용 없음'],
  [/^item \d+ is not in the queue$/, '대기열에 없는 곡'],
  [/^position \d+ is outside the queue \(0-(\d+)\)$/, '대기열 범위를 벗어난 위치(0~$1)'],
  [/^Discord did not answer: .*$/, '디스코드가 응답하지 않음: 잠시 뒤 다시 시도하세요'],
  ['you are not a member of that server', '그 서버의 멤버가 아님'],
  // The ones only the panel and the API give (the bot never meets them).
  ['log in first', '먼저 로그인하세요'],
  ['only the host can use jukecord here', '여기서는 호스트만 jukecord를 쓸 수 있음'],
  ['there is no such server here', '여기에 없는 서버'],
  ['there is no such token of yours', '내 토큰 목록에 없는 토큰'],
  ['days is 1 to 366', '기간은 1일부터 366일까지'],
  ['the time zone offset is -720 to 840 minutes', '시간대 차이는 -720분부터 840분까지'],
  [
    'jukecord runs without a Discord bot here, so it cannot join voice',
    '디스코드 봇 없이 실행 중이라 음성 채널에 들어갈 수 없음',
  ],
  ['jukecord runs without a Discord bot here, so there are no roles', '디스코드 봇 없이 실행 중이라 역할이 없음'],
  [
    /^"(.+)" is not a time in the track \(examples: 83, 1:23, 1m23s\)$/,
    '시간으로 읽을 수 없음: "$1"(예: 83, 1:23, 1m23s)',
  ],
  // Changes faster than the rates allow (429), and work turned away while jukecord is behind (503).
  ['too many changes at once; try again in a moment', '변경 요청이 너무 잦음: 잠시 뒤 다시 시도하세요'],
  ['too many skips at once; try again in a moment', '건너뛰기가 너무 잦음: 잠시 뒤 다시 시도하세요'],
  ['too many requests at once; try again in a moment', '요청이 너무 많음: 잠시 뒤 다시 시도하세요'],
  ['jukecord is busy; try again in a moment', 'jukecord가 지금 바쁨: 잠시 뒤 다시 시도하세요'],
  // A split jukecord whose core cannot be reached (it starts, restarts, or the bus is down), or was too slow (503).
  [
    'jukecord is starting or restarting; try again in a moment',
    'jukecord가 시작하거나 다시 시작하는 중: 잠시 뒤 다시 시도하세요',
  ],
  ['jukecord did not answer in time; try again in a moment', 'jukecord가 제때 답하지 않음: 잠시 뒤 다시 시도하세요'],
  // A server's state that could not be read for a live connection (the panel asks again).
  [
    'jukecord could not read this server now; try again in a moment',
    'jukecord가 지금 이 서버를 읽지 못함: 잠시 뒤 다시 시도하세요',
  ],
  // An edge's question to the core that names no login (a mistake between services, never a person's).
  ['no login or server named', '로그인이나 서버가 빠진 요청'],
  ['no login named', '로그인이 빠진 요청'],
  // Why a live connection ended, which the panel shows.
  ['jukecord is restarting', 'jukecord가 다시 시작하는 중'],
  ['logged out', '로그아웃됨'],
  ['the login has ended', '로그인이 끝남'],
  ['no longer allowed in that server', '그 서버를 더는 열 수 없음'],
  ['connections come from the panel only', '패널에서만 연결할 수 있음'],
  // Refusals of the web server and the database that a panel can meet.
  [
    "the change came without the panel's CSRF token; reload the panel",
    '변경 요청에 CSRF 토큰이 없음: 패널을 새로고침하세요',
  ],
  ["the logout came without the panel's CSRF token", '로그아웃 요청에 CSRF 토큰이 없음'],
  ['that track is not playing or queued in this server', '이 서버에서 재생 중이거나 대기열에 있는 곡이 아님'],
  ['the track is not prepared yet', '아직 준비되지 않은 곡'],
  [
    'jukecord is making other MP3 copies right now; try again in a moment',
    '다른 MP3를 만드는 중: 잠시 뒤 다시 시도하세요',
  ],
  ['a token name is 1 to 100 characters', '토큰 이름은 1~100자'],
  ['the new order does not hold exactly the items in the queue', '새 순서가 지금 대기열의 곡과 맞지 않음'],
  ['this needs the host', '호스트만 할 수 있음'],
  [/^this needs an? (\w+) token$/, '$1 권한이 있는 토큰이 필요함'],
  // What a friend's login (a link from the host, no token) may not do.
  [
    'a friend who may only look and listen cannot change the music',
    '보기만 하는 친구 로그인으로는 음악을 바꿀 수 없음',
  ],
  ["a friend cannot change the server's settings or tokens", '친구 로그인으로는 서버 설정이나 토큰을 바꿀 수 없음'],
  // What a member's level (their groups at the host's identity provider or directory) does not let them do.
  ['your groups let you look and listen, not change the music', '그룹 권한으로는 보고 듣기만 할 수 있음'],
  [
    "your groups let you change the music, not the server's settings or tokens",
    '그룹 권한으로는 음악만 바꿀 수 있고 서버 설정이나 토큰은 바꿀 수 없음',
  ],
  ['a login through SSO or a directory cannot make tokens', 'SSO나 디렉터리 계정으로 로그인하면 토큰을 만들 수 없음'],
  ['the login settings cannot be tested here', '여기서는 로그인 설정을 시험할 수 없음'],
  ['only the host can test settings not saved yet', '저장하지 않은 설정은 호스트만 시험할 수 있음'],
  ['only the host can make login links', '로그인 링크는 호스트만 만들 수 있음'],
  ['there is no such login', '그런 로그인이 없음'],
  // The directory form's refusals (the login page says them in its own words; the API says these).
  ['logging in with a directory account is not set up here', '여기는 디렉터리 계정 로그인이 설정되지 않음'],
  ['type your name and your password', '이름과 암호를 입력하세요'],
  ['wrong name or password', '이름이나 암호가 틀림'],
  ['the directory has more than one account by that name', '디렉터리에 그 이름의 계정이 둘 이상 있음'],
  ['the directory did not answer; try again in a moment', '디렉터리가 응답하지 않음: 잠시 뒤 다시 시도하세요'],
  ['your account is in none of the groups jukecord lets in', 'jukecord에 들어올 수 있는 그룹에 속해 있지 않음'],
  [/^repeat is one of (.+)$/, '반복은 $1 중 하나'],
  [/^no such address: (.+)$/, '없는 주소: $1'],
  [/^playlist (\d+) does not exist$/, '없는 플레이리스트(번호 $1)'],
  [/^position (-?\d+) is before the start of the queue$/, '대기열 시작보다 앞선 자리(번호 $1)'],
  // Why a live connection was turned away (1013), which the panel shows.
  ['jukecord has as many live connections as it allows', 'jukecord의 실시간 연결이 가득 참'],
  [
    'too many live connections for this login; close a tab or two',
    '이 로그인의 실시간 연결이 너무 많음: 탭을 한두 개 닫으세요',
  ],
  [
    'too many live connections from this address; close a tab or two',
    '이 주소의 실시간 연결이 너무 많음: 탭을 한두 개 닫으세요',
  ],
  ['too many failed logins; wait ten minutes', '로그인 실패가 너무 많음: 10분 뒤 다시 시도하세요'],
  // The reasons a track could not be got (core/reasons.ts).
  [REASONS.botCheck, '지금은 YouTube가 이 jukecord를 막고 있음'],
  [REASONS.privateNetwork, '사설망 주소라 가져오지 않음'],
  [REASONS.unavailable, '볼 수 없는 영상'],
  [REASONS.notYet, '아직 시작하지 않음'],
  [REASONS.nothingToPlay, '그 주소에는 재생할 수 있는 것이 없음'],
  [REASONS.tooLarge, '파일이 너무 큼'],
  [REASONS.tooLong, '가져오는 데 너무 오래 걸림'],
  [REASONS.noSuchSite, '사이트를 찾을 수 없음'],
  [REASONS.nothingFound, '검색 결과 없음'],
  [REASONS.failed, '가져오지 못함'],
  [REASONS.offline, 'jukecord가 인터넷에 연결하지 못함'],
  // A site's answer by its status ("the site answered 404") is said in words, in either language: siteAnswer() below.
  // The audio of a long track for a browser that needs MP3, while its copy is still being made.
  [
    'jukecord is making the MP3 copy of this track; try again in a moment',
    '이 곡의 MP3 사본을 만드는 중: 잠시 뒤 다시 시도하세요',
  ],
  // What the player did by itself (PlayerSnapshot.notice), after the track's title.
  ['taken out of the looping queue', '대기열 반복에서 뺌'],
  // Pause and play on, when the player is that way already.
  ['it is already paused', '이미 일시정지됨'],
  ['the track is getting ready', '곡을 준비하는 중'],
  // A voice channel at its member limit.
  [/^the voice channel (.+) is full$/, '$1 음성 채널이 가득 참'],
  // A player that paused by itself with nobody hearing it anywhere (app/rest.ts): why, beside the state that says it
  // is paused ("일시정지" over "듣는 사람이 없어 일시정지함" said it twice).
  ['paused with nobody listening', '듣는 사람이 없었음'],
  // Choosing the alerts channel (app/alerts.ts).
  [
    'only people who can manage the server can choose the alerts channel',
    '서버 관리 권한이 있어야 알림 채널을 정할 수 있음',
  ],
  ['jukecord runs without a Discord bot here, so there are no channels', '디스코드 봇 없이 실행 중이라 채널이 없음'],
  ['that is not a channel of this server the bot may post in', '봇이 글을 올릴 수 있는 이 서버의 채널이 아님'],
  // An answer that was not jukecord's (a reverse proxy's own page while jukecord restarts), with its status.
  [/^jukecord did not answer \((\d{3})\)$/, 'jukecord가 응답하지 않음($1)'],
  // Covers and Wrapped.
  ['that track is not in this server', '이 서버에 없는 곡'],
  ['that track has no cover', '커버 이미지가 없는 곡'],
  [
    'jukecord is fetching other covers right now; try again in a moment',
    '다른 커버 이미지를 받는 중: 잠시 뒤 다시 시도하세요',
  ],
  [
    'the period is a year (2026), a month (2026-03) or last-12-months',
    '기간은 연도(2026), 달(2026-03), last-12-months 중 하나',
  ],
  // Lyrics (src/media/lyrics.ts).
  ['lyrics are turned off here', '여기서는 가사를 찾지 않음'],
  ['LRCLIB did not answer; try again in a moment', 'LRCLIB가 답하지 않음: 잠시 뒤 다시 시도하세요'],
  [
    'jukecord is looking up other lyrics right now; try again in a moment',
    '다른 곡의 가사를 찾는 중: 잠시 뒤 다시 시도하세요',
  ],
  // Listening links and their guests (src/app/actions.ts, src/web/server.ts), and a friend's login.
  ['a listening link lasts 1, 7 or 30 days', '듣기 링크 기간은 1일, 7일, 30일 중 하나'],
  [
    /^this server has as many listening links as it allows \((\d+)\); revoke one first$/,
    '이 서버의 듣기 링크가 가득 참($1개): 하나를 먼저 폐기하세요',
  ],
  ['there is no such listening link here', '여기에 없는 듣기 링크'],
  [
    'only its maker and people who can manage the server can revoke a listening link',
    '듣기 링크는 만든 사람과 서버 관리 권한이 있는 사람만 폐기할 수 있음',
  ],
  ['a guest can only look and listen', '손님은 보고 듣기만 할 수 있음'],
  ['a listening link opens its own server only', '듣기 링크는 그 링크의 서버만 열 수 있음'],
  ['this listening link has ended or does not exist', '끝났거나 없는 듣기 링크'],
  ['this listening link has as many guests as it allows', '이 듣기 링크의 손님 자리가 가득 참'],
  ['the listening link has ended', '듣기 링크가 끝남'],
  ['this login cannot make tokens', '이 로그인으로는 토큰을 만들 수 없음'],
  // How a server's people share the music.
  ['only people who can manage the server can change this setting', '서버 관리 권한이 있어야 이 설정을 바꿀 수 있음'],
  ['only people listening can vote to skip', '듣고 있는 사람만 건너뛰기에 투표할 수 있음'],
  [/^each person may have (\d+) tracks in the queue here$/, '이 서버에서는 한 사람이 대기열에 $1곡까지 추가할 수 있음'],
  [/^the limit is 0 \(none\) to (\d+) tracks$/, '제한은 0(없음)부터 $1곡까지'],
  [/^the volume is 0 to (\d+) percent$/, '음량은 0부터 $1퍼센트까지'],
  [/^the sound is one of (.+)$/, '음향 효과는 $1 중 하나'],
  // Searching (the add field's list, Discord's suggestions, the API).
  ['searching is not set up here', '여기서는 검색을 쓸 수 없음'],
  ['nothing to search for', '찾을 말이 없음'],
  ['a search takes words, not an address', '검색어로 주소를 쓸 수 없음'],
  ['too many searches at once; try again in a moment', '한꺼번에 너무 많이 검색함: 잠시 뒤 다시 시도하세요'],
  // Likes.
  [
    'that track is not playing, queued, played or in a playlist in this server',
    '이 서버에서 재생 중이거나 대기열이나 플레이리스트에 있거나 들은 곡이 아님',
  ],
  ['that track is not in your likes', '내 좋아요 목록에 없는 곡임'],
  ['there are no liked tracks to add', '추가할 좋아요 곡 없음'],
  [/^your likes are full \((\d+) tracks\)$/, '좋아요 목록이 가득 참($1곡)'],
  // Autoplay.
  [/^autoplay is one of (.+)$/, '자동 재생은 $1 중 하나'],
  // Playlists in and out.
  [/^the format is one of (.+)$/, '형식은 $1 중 하나'],
  ['there is nothing to import in it', '가져올 것이 없음'],
  ['nothing in it could be found', '그 안의 곡을 하나도 찾지 못함'],
  ['the file is not valid JSON', '올바른 JSON 파일이 아님'],
  ['the JSON is not a jukecord playlist', 'jukecord 플레이리스트 JSON이 아님'],
  ['the file is larger than 1 MiB', '파일이 1MiB보다 큼'],
  ['importing a file is not set up here', '여기서는 파일 가져오기를 쓸 수 없음'],
  ['Discord did not hand over the file', '디스코드가 파일을 넘겨주지 않음'],
  [
    'jukecord is still adding a list of yours; try again when it is done',
    '내 목록을 아직 추가하는 중: 끝나면 다시 시도하세요',
  ],
  // Links of other music services.
  ['that is not a link jukecord reads', 'jukecord가 읽는 링크가 아님'],
  [/^jukecord does not read (.+) links here$/, '여기서는 $1 링크를 읽지 않음'],
  [/^there are no tracks at that (.+) link$/, '그 $1 링크에는 곡이 없음'],
  [/^that (.+) link leads to nothing jukecord reads$/, '그 $1 링크는 jukecord가 읽는 곳으로 이어지지 않음'],
  [
    'jukecord reads single Apple Music tracks, not albums or playlists',
    'Apple Music은 곡 하나만 읽음: 앨범과 플레이리스트는 읽지 않음',
  ],
  ['Deezer has nothing at that link', 'Deezer에 그 링크의 곡이 없음'],
  [
    'Spotify albums and playlists need the host’s Spotify app (JUKECORD_SPOTIFY_CLIENT_ID and JUKECORD_SPOTIFY_CLIENT_SECRET)',
    'Spotify 앨범과 플레이리스트는 호스트의 Spotify 앱이 있어야 읽음(JUKECORD_SPOTIFY_CLIENT_ID, JUKECORD_SPOTIFY_CLIENT_SECRET)',
  ],
  ['Spotify has nothing at that link', 'Spotify에 그 링크의 곡이 없음'],
  [
    'Spotify refused the host’s Spotify app (JUKECORD_SPOTIFY_CLIENT_ID)',
    'Spotify가 호스트의 Spotify 앱을 거절함(JUKECORD_SPOTIFY_CLIENT_ID)',
  ],
  ['Spotify is not set up here', '여기서는 Spotify를 쓸 수 없음'],
  ['the Spotify page does not say what the track is', 'Spotify 페이지에 곡 정보가 없음'],
  ['Apple Music has nothing at that link', 'Apple Music에 그 링크의 곡이 없음'],
  ['the Apple Music page does not say what the track is', 'Apple Music 페이지에 곡 정보가 없음'],
  [/^(\S+) did not answer$/, '$1에서 답이 없음'],
  ['the music service is busy', '음악 서비스가 바쁨'],
  ['the music service answered something that is not JSON', '음악 서비스가 JSON이 아닌 답을 보냄'],
  ['none of its tracks was found on YouTube', 'YouTube에서 그 곡들을 하나도 찾지 못함'],
  ['links of other services are not read here', '여기서는 다른 음악 서비스의 링크를 읽지 않음'],
  // The picture of a search's result (the search cover route, src/web/server.ts), beside a track's cover above.
  ['no search found that address lately', '최근 검색 결과에 없는 주소'],
  ['that search result has no picture', '이미지가 없는 검색 결과'],
  // The host's settings (src/settings): a change refused, the database away, a restart.
  ['the database does not answer', '데이터베이스가 응답하지 않음'],
  ['the database does not answer; nothing was saved', '데이터베이스가 응답하지 않음: 아무것도 저장하지 않음'],
  [
    'the database does not answer; the change may still be saved when it does',
    '데이터베이스가 응답하지 않음. 다시 응답하면 그때 저장될 수 있음',
  ],
  ['say which settings to change', '바꿀 설정을 정하세요'],
  [/^(JUKECORD_\w+) is not a jukecord setting$/, '$1: jukecord 설정이 아님'],
  [/^(JUKECORD_\w+) is set where jukecord starts, not here$/, '$1: jukecord를 시작하는 곳에서 정함'],
  [/^(JUKECORD_\w+) is set by the environment \((JUKECORD_\w+)\)$/, '$1: 환경 변수($2)로 정해짐'],
  [
    /^(JUKECORD_\w+) comes from each service's environment in a split jukecord$/,
    '$1: 나눠 띄운 jukecord에서는 서비스마다 환경 변수로 정함',
  ],
  ['settings.json could not be written; nothing was saved', 'settings.json에 쓰지 못함: 아무것도 저장하지 않음'],
  [/^changed by someone else meanwhile: (.+); read them again$/, '그사이 다른 사람이 바꿈($1): 다시 읽어 오세요'],
  ['jukecord cannot restart itself here', '여기서는 jukecord가 스스로 다시 시작할 수 없음'],
  ['the settings cannot be changed here', '여기서는 설정을 바꿀 수 없음'],
  ['only the host itself can see and change jukecord’s settings', 'jukecord 설정은 호스트 본인만 보고 바꿀 수 있음'],
  [
    /^(JUKECORD_\w+): type it again for the new (.+); a saved secret is not sent to another place$/,
    '$1: 새 $2에 맞게 다시 입력하세요. 저장된 비밀 값은 다른 곳으로 보내지 않음',
  ],
  // A database's address in words (src/store/address.ts describeAddress), as the settings page and the move show it.
  [
    /^(PostgreSQL|MySQL|MariaDB) \(([^,]+), database ([^,]+), schema ([^,]+), without TLS\)$/,
    '$1 ($2, 데이터베이스 $3, 스키마 $4, TLS 없음)',
  ],
  [/^(PostgreSQL|MySQL|MariaDB) \(([^,]+), database ([^,]+), without TLS\)$/, '$1 ($2, 데이터베이스 $3, TLS 없음)'],
  [
    /^(PostgreSQL|MySQL|MariaDB) \(([^,]+), database ([^,]+), schema ([^,]+), TLS ([\w-]+)\)$/,
    '$1 ($2, 데이터베이스 $3, 스키마 $4, TLS $5)',
  ],
  [/^(PostgreSQL|MySQL|MariaDB) \(([^,]+), database ([^,]+), TLS ([\w-]+)\)$/, '$1 ($2, 데이터베이스 $3, TLS $4)'],
  // Moving to another database (src/settings/move.ts).
  ['a move is under way already', '이미 옮기는 중'],
  ['the switch is under way; it cannot be stopped', '전환하는 중이라 멈출 수 없음'],
  ['there is no finished copy to switch to; copy the data first', '전환할 복사본이 없음: 먼저 데이터를 복사하세요'],
  ['that is the database jukecord uses now', 'jukecord가 지금 쓰는 데이터베이스'],
  ['the database cannot be moved from here', '여기서는 데이터베이스를 옮길 수 없음'],
  [/^the database cannot be moved to: (.+)$/, '옮길 수 없는 데이터베이스: $1'],
  [
    'the database holds jukecord’s data already; move with replace to empty it first',
    '이미 jukecord 데이터가 있는 데이터베이스: 비우고 옮기려면 바꾸기를 고르세요',
  ],
  ['the move was cancelled', '옮기기를 멈춤'],
  ['it is the database jukecord uses now', 'jukecord가 지금 쓰는 데이터베이스'],
  [/^it is at schema (\d+), newer than this jukecord's \((\d+)\)$/, '이 jukecord(스키마 $2)보다 새로운 스키마 $1'],
  [
    /^it is at schema (\d+), older than this jukecord's \((\d+)\); start a jukecord on it first$/,
    '이 jukecord(스키마 $2)보다 오래된 스키마 $1: 먼저 그 위에서 jukecord를 한 번 시작하세요',
  ],
  ['it does not answer', '응답하지 않음'],
  // Testing the Discord login's application (src/settings/discord.ts).
  ['no client ID (JUKECORD_DISCORD_CLIENT_ID)', '클라이언트 ID가 없음(JUKECORD_DISCORD_CLIENT_ID)'],
  ['no client secret (JUKECORD_DISCORD_CLIENT_SECRET)', '클라이언트 시크릿이 없음(JUKECORD_DISCORD_CLIENT_SECRET)'],
  [/^Discord could not be reached \((.+)\)$/, 'Discord에 닿지 못함($1)'],
  [/^Discord knows application (\d+) and its secret$/, 'Discord가 애플리케이션 ID와 시크릿을 알아봄($1)'],
  [/^Discord refused the client ID or its secret \((.+)\)$/, 'Discord가 클라이언트 ID나 시크릿을 받지 않음($1)'],
  [/^the application's OAuth2 redirects must list (.+)$/, '애플리케이션의 OAuth2 리디렉션 목록에 있어야 하는 주소: $1'],
  [
    /^Discord refused the request \(invalid_request\): the application may not list (.+)$/,
    'Discord가 요청을 받지 않음(invalid_request). 애플리케이션 목록에 없을 수 있는 주소: $1',
  ],
  [/^Discord answered (\d+) \((.+)\)$/, 'Discord 응답: $1($2)'],
  [/^Discord answered (\d+)$/, 'Discord 응답: $1'],
  [/^(JUKECORD_\w+) is no setting of the Discord login$/, '$1: Discord 로그인 설정이 아님'],
  // Testing an address for the shared cache or the bus (src/settings/servers.ts).
  [/^that is not an address \(example: (.+)\)$/, '주소가 아님(예: $1)'],
  [
    'a Redis or Valkey address starts with redis://, rediss:// (TLS), valkey:// or valkeys:// (TLS), and names a host',
    'Redis나 Valkey 주소는 redis://, rediss://(TLS), valkey://, valkeys://(TLS) 중 하나로 시작하고 호스트를 적어야 함',
  ],
  [/^(.+) cannot take a new file$/, '$1 폴더에 새 파일을 만들 수 없음'],
  [
    'nothing would start jukecord again here (it runs without a supervisor, as in a terminal): stop it and start it yourself',
    '여기서는 jukecord를 다시 띄워 줄 것이 없음(터미널처럼 감독 프로그램 없이 실행 중): 직접 멈추고 다시 시작하세요',
  ],
  // The settings' rules (src/config.ts, src/auth/settings.ts, src/store/address.ts, src/util/units.ts), as a refused
  // change shows them: each names its variable, and a value it quotes goes at the end in Korean.
  [/^(JUKECORD_\w+): "(.*)" is not a whole number$/, '$1: 정수가 아님("$2")'],
  [/^(JUKECORD_\w+): (.+) is outside ([^\s-]+)-([^\s-]+)$/, '$1: $3~$4 범위 밖($2)'],
  [
    /^(JUKECORD_\w+): (.+) is outside ([^\s-]+)-([^\s-]+) \(or 0 to never leave\)$/,
    '$1: $3~$4 범위 밖($2). 0이면 나가지 않음',
  ],
  [
    /^(JUKECORD_\w+): (.+) is outside ([^\s-]+)-([^\s-]+) \(or 0 to never pause\)$/,
    '$1: $3~$4 범위 밖($2). 0이면 멈추지 않음',
  ],
  [/^(JUKECORD_\w+): "(.*)" is not a URL \(example: (.+)\)$/, '$1: 주소가 아님("$2", 예: $3)'],
  [/^(JUKECORD_\w+): "(.*)" must start with http\(s\):\/\/$/, '$1: http:// 또는 https://로 시작해야 함("$2")'],
  [
    /^(JUKECORD_\w+): "(.*)" is not true, false, a hop count or addresses$/,
    '$1: true, false, 프록시 수, 주소 가운데 하나가 아님("$2")',
  ],
  [/^(JUKECORD_\w+): an application ID is 17 to 20 digits$/, '$1: 애플리케이션 ID는 17~20자리 숫자'],
  [
    /^(JUKECORD_\w+): (.+) is too small for the media cache \(at least (.+)\)$/,
    '$1: 미디어 캐시로는 너무 작음($2, 최소 $3)',
  ],
  [/^(JUKECORD_\w+): (.+) is too small for a log file \(at least (.+)\)$/, '$1: 로그 파일로는 너무 작음($2, 최소 $3)'],
  [/^(JUKECORD_\w+): (.+) cannot be read$/, '$1: 읽을 수 없는 파일($2)'],
  [/^(JUKECORD_\w+): (.+) is empty$/, '$1: 빈 파일($2)'],
  [/^(JUKECORD_\w+): "(.*)" is not true or false$/, '$1: true나 false가 아님("$2")'],
  [/^(JUKECORD_\w+): "(.*)" is not off or a time of day like 04:30$/, '$1: off나 04:30 같은 시각이 아님("$2")'],
  [/^(JUKECORD_\w+): "(.*)" is not on or off$/, '$1: on이나 off가 아님("$2")'],
  [/^(JUKECORD_\w+): "(.*)" is not yes or no$/, '$1: yes나 no가 아님("$2")'],
  [/^(JUKECORD_\w+): "(.*)" is not text or json$/, '$1: text나 json이 아님("$2")'],
  [/^(JUKECORD_\w+): "(.*)" is not one of (.+)$/, '$1: 다음 가운데 하나가 아님("$2"): $3'],
  [/^(JUKECORD_\w+): a Spotify client ID is letters and digits$/, '$1: Spotify 클라이언트 ID는 영문자와 숫자'],
  [/^(JUKECORD_\w+): "(.*)" is not a size \(examples: (.+)\)$/, '$1: 크기가 아님("$2", 예: $3)'],
  [/^(JUKECORD_\w+): "(.*)" has an unknown size unit \(use (.+)\)$/, '$1: 모르는 크기 단위("$2", 쓸 수 있는 단위: $3)'],
  [/^(JUKECORD_\w+): "(.*)" is not a duration \(examples: (.+)\)$/, '$1: 시간이 아님("$2", 예: $3)'],
  [
    /^(JUKECORD_\w+): "(.*)" has an unknown duration unit \(use (.+)\)$/,
    '$1: 모르는 시간 단위("$2", 쓸 수 있는 단위: $3)',
  ],
  [/^(JUKECORD_\w+): at most (\d+) characters$/, '$1: 최대 $2자'],
  [
    /^(JUKECORD_\w+): "(.*)" is not a claim name or a dotted path like realm_access\.roles$/,
    '$1: 클레임 이름이나 realm_access.roles 같은 경로가 아님("$2")',
  ],
  [/^set (JUKECORD_\w+) or (JUKECORD_\w+), not both$/, '$1, $2 가운데 하나만 정하세요'],
  [/^set both (JUKECORD_\w+) and (JUKECORD_\w+), or neither$/, '$1, $2 둘 다 정하거나 둘 다 비우세요'],
  [/^(JUKECORD_\w+) is set but (JUKECORD_\w+) is not$/, '$2 없이 $1만 있음'],
  [
    /^set who may log in: (JUKECORD_\w+), (JUKECORD_\w+) or (JUKECORD_\w+) \(a \* lets in everyone the (?:provider|directory) knows\)$/,
    '로그인할 수 있는 그룹을 정하세요: $1, $2, $3(*는 모든 사람)',
  ],
  [
    /^JUKECORD_METRICS_TOKEN: at least 16 characters and no spaces \(openssl rand -hex 32 makes one\)$/,
    'JUKECORD_METRICS_TOKEN: 공백 없이 16자 이상(openssl rand -hex 32로 만들 수 있음)',
  ],
  [
    /^JUKECORD_OIDC_ISSUER: "(.*)" is not an issuer's address \(example: (.+)\)$/,
    'JUKECORD_OIDC_ISSUER: 발급자 주소가 아님("$1", 예: $2)',
  ],
  [
    /^JUKECORD_LDAP_URL: "(.*)" is not ldap:\/\/host or ldaps:\/\/host \(with a port if not the usual\)$/,
    'JUKECORD_LDAP_URL: ldap://호스트나 ldaps://호스트가 아님("$1")',
  ],
  [
    'JUKECORD_LDAP_STARTTLS is for ldap://; ldaps:// is encrypted already',
    'JUKECORD_LDAP_STARTTLS는 ldap://에만 씀. ldaps://는 이미 암호화됨',
  ],
  // The host's certificate authorities: the file the settings name (src/authorities.ts), and a PEM the page or the
  // command gives (src/settings/authorities.ts).
  [/^JUKECORD_CA_FILE: (.+) cannot be read$/, 'JUKECORD_CA_FILE: 읽을 수 없는 파일($1)'],
  [
    /^JUKECORD_CA_FILE: (.+) has no certificate in PEM form \(-----BEGIN CERTIFICATE-----\)$/,
    'JUKECORD_CA_FILE: PEM 형식의 인증서가 없는 파일($1)',
  ],
  [
    /^JUKECORD_CA_FILE: (.+) has a certificate that cannot be read \(the (\w+): (.+)\)$/,
    'JUKECORD_CA_FILE: 읽을 수 없는 인증서가 든 파일($1, $3)',
  ],
  [
    'JUKECORD_CA_FILE: it holds a private key: give only the authorities’ certificates, never a key',
    'JUKECORD_CA_FILE: 개인 키가 들어 있음. 인증 기관의 인증서만 넣으세요',
  ],
  [
    /^JUKECORD_CA_FILE: it holds something other than certificates \((.+)\)$/,
    'JUKECORD_CA_FILE: 인증서가 아닌 것이 들어 있음($1)',
  ],
  [
    'JUKECORD_CA_FILE: it has no certificate in PEM form (-----BEGIN CERTIFICATE-----)',
    'JUKECORD_CA_FILE: PEM 형식의 인증서가 없음(-----BEGIN CERTIFICATE-----)',
  ],
  [
    /^JUKECORD_CA_FILE: it has a certificate that cannot be read \(the (\w+): (.+)\)$/,
    'JUKECORD_CA_FILE: 읽을 수 없는 인증서가 있음($2)',
  ],
  [
    'JUKECORD_CA_FILE: it has no authority’s certificate (CA:TRUE): a server’s or a person’s certificate signs nothing',
    'JUKECORD_CA_FILE: 인증 기관의 인증서(CA:TRUE)가 없음. 서버나 사람의 인증서는 다른 인증서에 서명하지 않음',
  ],
  ['JUKECORD_CA_FILE: the certificates are larger than 1 MiB', 'JUKECORD_CA_FILE: 인증서가 1MiB보다 큼'],
  [
    /^JUKECORD_LDAP_CA_FILE: (.+) has no certificate in PEM form$/,
    'JUKECORD_LDAP_CA_FILE: PEM 형식의 인증서가 없는 파일($1)',
  ],
  [
    /^JUKECORD_LDAP_BIND_DN: "(.*)" is not a DN \(example: (.+)\) or, for Active Directory, (.+)$/,
    'JUKECORD_LDAP_BIND_DN: DN이 아님("$1", 예: $2, Active Directory는 $3)',
  ],
  [/^JUKECORD_LDAP_BASE_DN: "(.*)" is not a DN \(example: (.+)\)$/, 'JUKECORD_LDAP_BASE_DN: DN이 아님("$1", 예: $2)'],
  [
    /^(JUKECORD_\w+): put \{username\} where the name typed goes, as in (.+)$/,
    '$1: 입력한 이름이 들어갈 자리에 {username}을 넣으세요(예: $2)',
  ],
  [/^(JUKECORD_\w+): "(.*)" is not one filter in parentheses$/, '$1: 괄호로 묶인 필터 하나가 아님("$2")'],
  [
    /^(JUKECORD_\w+): put \{dn\} \(or \{username\}\) where the person goes, as in (.+)$/,
    '$1: 사람이 들어갈 자리에 {dn}이나 {username}을 넣으세요(예: $2)',
  ],
  [
    /^JUKECORD_LDAP_GROUP_BASE_DN is where groups are searched: set (JUKECORD_\w+) or (JUKECORD_\w+) too$/,
    'JUKECORD_LDAP_GROUP_BASE_DN은 그룹을 찾는 위치: $1, $2 가운데 하나도 정하세요',
  ],
  // A split jukecord's settings (src/config.ts): the role's needs, the bus's and the cache's addresses, the secret.
  [/^(JUKECORD_\w+): that is not an address \(example: (.+)\)$/, '$1: 주소가 아님(예: $2)'],
  [
    /^(JUKECORD_\w+): a Redis or Valkey address starts with redis:\/\/, rediss:\/\/ \(TLS\), valkey:\/\/ or valkeys:\/\/ \(TLS\), and names a host$/,
    '$1: Redis나 Valkey 주소는 redis://, rediss://(TLS), valkey://, valkeys://(TLS) 중 하나로 시작하고 호스트를 적어야 함',
  ],
  [
    /^(JUKECORD_\w+): a prefix is up to 64 letters, digits and \. _ : - \(starting with a letter or digit\)$/,
    '$1: 접두어는 영문자, 숫자, . _ : -로 64자까지(영문자나 숫자로 시작)',
  ],
  [
    /^JUKECORD_INTERNAL_SECRET is too short: at least (\d+) characters \(openssl rand -hex 32 makes one\)$/,
    'JUKECORD_INTERNAL_SECRET: 너무 짧음, 최소 $1자(openssl rand -hex 32로 만들 수 있음)',
  ],
  [
    /^JUKECORD_ROLE=(\w+) needs a database every service reaches, and a SQLite file is one process's: set JUKECORD_DATABASE_URL to a postgres:\/\/ or mysql:\/\/ address$/,
    'JUKECORD_ROLE=$1: 모든 서비스가 닿는 데이터베이스가 필요함. SQLite 파일은 한 프로세스용이니 JUKECORD_DATABASE_URL에 postgres:// 또는 mysql:// 주소를 넣으세요',
  ],
  [
    /^JUKECORD_ROLE=(\w+) needs JUKECORD_DATABASE_URL: .+$/,
    'JUKECORD_ROLE=$1: 모든 서비스가 함께 쓰는 PostgreSQL 또는 MySQL/MariaDB 데이터베이스를 JUKECORD_DATABASE_URL에 넣으세요',
  ],
  [
    /^JUKECORD_ROLE=(\w+) needs JUKECORD_BUS_URL: .+$/,
    'JUKECORD_ROLE=$1: 서비스끼리 주고받는 Redis나 Valkey 서버를 JUKECORD_BUS_URL에 넣으세요',
  ],
  [
    /^JUKECORD_ROLE=(\w+) needs JUKECORD_INTERNAL_SECRET \(or _FILE\): .+ (\d+) characters or more$/,
    'JUKECORD_ROLE=$1: 코어와 엣지가 함께 쓰는 $2자 이상의 비밀 값을 JUKECORD_INTERNAL_SECRET(또는 _FILE)에 넣으세요',
  ],
  [
    /^JUKECORD_ROLE=(\w+) needs JUKECORD_CORE_URL: where the core's internal port is \((.+)\)$/,
    'JUKECORD_ROLE=$1: 코어의 내부 포트 주소를 JUKECORD_CORE_URL에 넣으세요($2)',
  ],
  [
    /^JUKECORD_INTERNAL_PORT is the panel's port \((\d+)\): the core needs two ports$/,
    'JUKECORD_INTERNAL_PORT가 패널의 포트($1)와 같음: 코어에는 포트가 두 개 필요함',
  ],
  [/^(JUKECORD_\w+): "(.*)" is not an address \(example: (.+)\)$/, '$1: 주소가 아님("$2", 예: $3)'],
  // The database's address (src/store/address.ts): what is wrong with it, never the address itself (a password).
  [
    'JUKECORD_DATABASE_URL is not an address like postgres://user:password@host/database, mysql://... or sqlite:',
    'JUKECORD_DATABASE_URL: postgres://사용자:암호@호스트/데이터베이스, mysql://…, sqlite: 꼴의 주소가 아님',
  ],
  [
    /^JUKECORD_DATABASE_URL starts with (\S+), not sqlite:, postgres:\/\/, postgresql:\/\/, mysql:\/\/ or mariadb:\/\/$/,
    'JUKECORD_DATABASE_URL: sqlite:, postgres://, postgresql://, mysql://, mariadb:// 가운데 하나로 시작해야 함($1)',
  ],
  [
    /^JUKECORD_DATABASE_URL does not take the parameter "(.+)" for (\w+)$/,
    'JUKECORD_DATABASE_URL: $2에는 쓸 수 없는 매개변수("$1")',
  ],
  [/^JUKECORD_DATABASE_URL gives (\w+) twice$/, 'JUKECORD_DATABASE_URL: 매개변수가 두 번 있음($1)'],
  [
    /^JUKECORD_DATABASE_URL has a (.+) that is not percent-encoded properly$/,
    'JUKECORD_DATABASE_URL: 퍼센트 인코딩이 잘못된 부분이 있음',
  ],
  [/^JUKECORD_DATABASE_URL has no user name/, 'JUKECORD_DATABASE_URL: 사용자 이름이 없음'],
  [/^JUKECORD_DATABASE_URL names no database/, 'JUKECORD_DATABASE_URL: 데이터베이스 이름이 없음'],
  ['JUKECORD_DATABASE_URL names no host', 'JUKECORD_DATABASE_URL: 호스트가 없음'],
  [
    /^JUKECORD_DATABASE_URL has a schema "(.+)" that is not a plain name/,
    'JUKECORD_DATABASE_URL: 스키마 이름은 영문자, 숫자, _만("$1")',
  ],
  [
    'JUKECORD_DATABASE_URL gives sslmode and ssl; give one of them',
    'JUKECORD_DATABASE_URL: sslmode, ssl 가운데 하나만 쓰세요',
  ],
  [/^JUKECORD_DATABASE_URL has ssl=(.*); it is true or false$/, 'JUKECORD_DATABASE_URL: ssl은 true나 false($1)'],
  [
    /^JUKECORD_DATABASE_URL has sslmode=(.*); it is disable, require, verify-ca or verify-full/,
    'JUKECORD_DATABASE_URL: sslmode는 disable, require, verify-ca, verify-full 가운데 하나($1)',
  ],
  [
    /^JUKECORD_DATABASE_URL has connect_timeout=(.*); it is a whole number of seconds from 1 to 300$/,
    'JUKECORD_DATABASE_URL: connect_timeout은 1~300초 사이의 정수($1)',
  ],
  [
    'JUKECORD_DATABASE_URL sqlite: takes a path, not a host',
    'JUKECORD_DATABASE_URL: sqlite:에는 호스트 없이 경로만 씀',
  ],
];

// The few messages people read in other English words than the API's: [the API's message, the words for people].
const ENGLISH: readonly (readonly [string, string])[] = [
  // Why the player paused itself, shown beside the state that already says "Paused" ("Paused" over "Paused with
  // nobody listening" said it twice), in the panel, the bot's card and the command line alike.
  ['paused with nobody listening', 'nobody was listening'],
  // "This server" meant the machine jukecord runs on; beside a Discord server's name it read as that server.
  [REASONS.botCheck, 'YouTube is refusing this jukecord for now'],
];

// A site's answer by its HTTP status, as the API says it ("the site answered 404", from yt-dlp's "HTTP Error 404").
const SITE_ANSWERED = /^the site answered (\d{3})$/;

/**
 * What a site's answer means for the track, in words: its number says nothing to most people ("the site answered
 * 404" read as a code to look up). In English; in Korean as a state, for a reason after a colon ("추가하지 못함:
 * 사이트에 없음"); and in Korean as the cause in a sentence (sayFailure: "사이트에 없는 곡이라 ...").
 */
function siteAnswer(status: number): { readonly en: string; readonly ko: string; readonly koCause: string } {
  // Not there: an address that was wrong, or a track taken down.
  if (status === 404) return { en: 'the site does not have it', ko: '사이트에 없음', koCause: '사이트에 없는 곡이라' };
  // Taken down for good, as the site says.
  if (status === 410)
    return { en: 'the site has removed it', ko: '사이트에서 지워짐', koCause: '사이트에서 지운 곡이라' };
  // Withheld for legal reasons (a court's order, a country's law).
  if (status === 451)
    return {
      en: 'the site blocks it for legal reasons',
      ko: '법적인 이유로 막힘',
      koCause: '법적인 이유로 막힌 곡이라',
    };
  // Too many requests: the site wants fewer from jukecord for a while.
  if (status === 429)
    return {
      en: 'the site asked jukecord to slow down',
      ko: '사이트가 요청을 줄여 달라고 함',
      koCause: '사이트가 요청을 줄여 달라고 해서',
    };
  // The site's own trouble (500, 502, 503 ...), which may pass.
  if (status >= 500)
    return { en: 'the site is having trouble', ko: '사이트에 문제가 생김', koCause: '사이트에 문제가 생겨' };
  // Any other answer is a refusal (403 most of all, which YouTube gives an address it will not serve).
  return { en: 'the site refused it', ko: '사이트가 거절함', koCause: '사이트가 거절해' };
}

// Why a track could not be played, as the cause in the one sentence that names it (sayFailure): in English after
// "because", in Korean before the track ("...이라", "...어서"). One for each short reason of core/reasons.ts; a site's
// answer has its own (siteAnswer above).
const CAUSES: ReadonlyMap<string, { readonly en: string; readonly ko: string }> = new Map<
  string,
  { readonly en: string; readonly ko: string }
>([
  [
    REASONS.botCheck,
    { en: 'YouTube is refusing this jukecord for now', ko: '지금은 YouTube가 이 jukecord를 막고 있어' },
  ],
  [REASONS.privateNetwork, { en: 'its address is on a private network', ko: '사설망 주소라' }],
  [REASONS.unavailable, { en: 'the video is unavailable', ko: '볼 수 없는 영상이라' }],
  [REASONS.notYet, { en: 'it has not started yet', ko: '아직 시작 전이라' }],
  // Not "재생할 수 있는 것이 없는": the sentence ends in 재생하지 못함.
  [REASONS.nothingToPlay, { en: 'there is nothing to play at its address', ko: '들을 수 있는 소리가 없는 주소라' }],
  [REASONS.tooLarge, { en: 'the file is too large', ko: '파일이 너무 커서' }],
  [REASONS.tooLong, { en: 'getting it took too long', ko: '가져오는 데 너무 오래 걸려' }],
  [REASONS.noSuchSite, { en: 'there is no such site', ko: '사이트를 찾을 수 없어' }],
  [REASONS.nothingFound, { en: 'nothing was found', ko: '검색 결과가 없어' }],
  // Not "it could not be downloaded": after "Could not play ... because" it said "could not" twice.
  [REASONS.failed, { en: 'the download failed', ko: '다운로드에 실패해' }],
  [REASONS.offline, { en: 'jukecord cannot reach the internet', ko: 'jukecord가 인터넷에 연결되지 않아' }],
]);

// The no-break space: a line that wraps never breaks at it. Made from its code, so no editor turns it into a plain space
// unseen (Pretendard's subset that holds the space holds it too).
const NBSP = String.fromCharCode(0xa0);

// Where a wrapped line must not break, as a pattern and what it becomes ($1: the part before the space, kept). A panel
// wrapped "within 10 / minutes" and "쓸 / 수 있음": a unit or a bound word alone at the start of a line reads as a slip.
const TOGETHER: readonly (readonly [RegExp, string])[] = [
  // A number and the word after it, in either language: "10 minutes", "3 min", "2 votes", "MP3 사본".
  [/(\d) (?=\p{L})/gu, `$1${NBSP}`],
  // A month and its day or year: "Nov 14", "Nov 2025", "November 2026" (\b: not the start of a longer word).
  [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (?=\d)/g,
    `$1${NBSP}`,
  ],
  // "ago" with its time: "15 h ago".
  [/ ago\b/g, `${NBSP}ago`],
  // English's "a" and "an" with the word they come before: a line that ended in "a" ("Skip ... is a / vote") read as
  // cut short. Only the word itself: after the line's start, a space or a bracket, and before a plain space.
  [/(^|[\s(])(an?|An?) (?=\S)/g, `$1$2${NBSP}`],
  // Korean words that never start a line, kept with the word before: 수 of "쓸 수 있음" and "바꿀 수 없음" (with what
  // follows it too), ...
  [/ 수 (?=[있없])/g, `${NBSP}수${NBSP}`],
  // ... 님 after a name ("Mina 님이 추가"), ...
  [/ (?=님(?:[이의께을은도]|\s|$))/g, NBSP],
  // ... and 중 of a thing under way or among others ("찾는 중", "재생 중인", "곡 중에서"), not a word that starts with
  // it ("중복 제거").
  [/ (?=중(?:[이인에]|[\s:.,·)]|$))/g, NBSP],
  // A time and what it counts from or up to: "5분 전", "10초 뒤로", "10분 안에", "1분 미만", "0초 이상", "잠시 뒤".
  [/(\d(?:초|분|시간|일|주|개월|년)|잠시) (?=전|뒤|후|안에|미만|이상|이하)/g, `$1${NBSP}`],
  // A total and its figure ("총 39분"), and a date's year and month and day ("2025년 11월 14일").
  [/(총|\d년|\d월) (?=\d)/g, `$1${NBSP}`],
];

/**
 * A line as people read it wherever it wraps: no-break spaces where a break would split what reads as one (a number
 * and its unit, a month and its day, Korean's 수 of "쓸 수 있음"). Running it again changes nothing.
 */
export function together(text: string): string {
  let kept = text;
  for (const [pattern, replacement] of TOGETHER) kept = kept.replace(pattern, replacement);
  return kept;
}

/**
 * A message from the actions in the person's language, as it is (for a reason inside a sentence). English is the
 * message itself, but for the few that people read in other words (a site's answer in words, not its number).
 */
export function translate(message: string, lang: Lang): string {
  // A site's answer, in words in either language.
  const status = SITE_ANSWERED.exec(message)?.[1];
  if (status) return together(siteAnswer(Number(status))[lang]);
  for (const [english, said] of lang === 'ko' ? KOREAN : ENGLISH) {
    if (typeof english === 'string' ? english === message : english.test(message)) {
      // Read by people: a line that wraps keeps "할 수 있음" whole.
      return together(typeof english === 'string' ? said : message.replace(english, said));
    }
  }
  return message;
}

/**
 * A player's failure ("the track's title: the reason", core/player.ts) as one sentence that names the track and says
 * why in words: "Could not play Neon Rain because the site does not have it", "사이트에 없는 곡이라 Neon Rain 재생하지
 * 못함" (not "Could not play: Neon Rain: the site answered 404", two colons and a number). Korean says the cause
 * first, so no particle follows the title, whatever letters it ends in. The reasons have no colon in them, so the last
 * colon is where the reason starts, whatever the title holds.
 */
export function sayFailure(error: string, lang: Lang): string {
  const at = error.lastIndexOf(': ');
  // Not a title and its reason (the player always gives both): the message as a sentence.
  if (at < 0) return sayError(error, lang);
  const title = error.slice(0, at);
  const reason = error.slice(at + 2);
  const status = SITE_ANSWERED.exec(reason)?.[1];
  const answer = status ? siteAnswer(Number(status)) : null;
  const cause = answer ? { en: answer.en, ko: answer.koCause } : CAUSES.get(reason);
  // A reason with no cause here yet is still said, after the track (one colon): never lost, only less plain.
  if (!cause)
    return together(
      lang === 'ko' ? `${title} 재생하지 못함: ${translate(reason, 'ko')}` : `Could not play ${title}: ${reason}`,
    );
  return together(lang === 'ko' ? `${cause.ko} ${title} 재생하지 못함` : `Could not play ${title} because ${cause.en}`);
}

/**
 * What the player did by itself (PlayerSnapshot.notice) as people read it: after a track's title, what happened to it
 * ("Neon Rain: taken out of the looping queue"); on its own, as a sentence ("Nobody was listening", beside the state
 * that says it paused).
 */
export function sayNotice(message: string, lang: Lang): string {
  // The last colon, as for a failure: what happened has none, a title may.
  const at = message.lastIndexOf(': ');
  if (at < 0) return sayError(message, lang);
  return `${message.slice(0, at)}: ${translate(message.slice(at + 2), lang)}`;
}

/** A message from the actions as the person reads it: a sentence in their language. */
export function sayError(message: string, lang: Lang): string {
  const said = translate(message, lang);
  // Korean has no capitals: a translation is shown as it is, and a word in Latin letters at its start keeps its case.
  if (lang === 'ko' && said !== message) return said;
  // English (or Korean without an entry): the message as a sentence, with its capital; jukecord's name has none. Read
  // by people as a translation is: a number keeps its unit on its line ("500 tracks").
  if (said.startsWith('jukecord')) return together(said);
  return together(said.charAt(0).toUpperCase() + said.slice(1));
}
