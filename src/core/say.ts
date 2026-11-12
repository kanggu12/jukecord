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
  [/^the bot may not connect or speak in (.+)$/, '봇이 $1에 들어가거나 말할 권한이 없음'],
  ['join a voice channel first, or name one', '먼저 음성 채널에 들어가거나 채널을 고르세요'],
  ['that is not a voice channel', '음성 채널이 아님'],
  ['the bot does not play on stages', '스테이지 채널에서는 재생하지 않음'],
  ['the position must be 0 or more', '자리 번호는 0 이상'],
  ['there is nothing to save: the queue is empty', '저장할 곡 없음: 대기열이 비어 있음'],
  [/^longer than the (\d+) minute limit$/, '$1분보다 긴 곡'],
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
  ['nothing to add', '넣을 것이 없음'],
  [/^item \d+ is not in the queue$/, '대기열에 없는 곡'],
  [/^position \d+ is outside the queue \(0-(\d+)\)$/, '대기열 밖의 자리(마지막 자리 번호는 $1)'],
  [/^Discord did not answer: .*$/, '디스코드가 답하지 않음: 잠시 뒤 다시 시도하세요'],
  ['you are not a member of that server', '그 서버의 멤버가 아님'],
  // The ones only the panel and the API give (the bot never meets them).
  ['log in first', '먼저 로그인하세요'],
  ['only the host can use jukecord here', '여기서는 호스트만 jukecord를 쓸 수 있음'],
  ['there is no such server here', '여기에 없는 서버'],
  ['there is no such token of yours', '내 토큰 중에 없는 토큰'],
  ['days is 1 to 366', '기간은 1일부터 366일까지'],
  ['the time zone offset is -720 to 840 minutes', '시간대 차이는 -720분부터 840분까지'],
  [
    'jukecord runs without a Discord bot here, so it cannot join voice',
    '디스코드 봇 없이 실행 중이라 음성 채널에 들어갈 수 없음',
  ],
  ['jukecord runs without a Discord bot here, so there are no roles', '디스코드 봇 없이 실행 중이라 역할이 없음'],
  [
    /^"(.+)" is not a time in the track \(examples: 83, 1:23, 1m23s\)$/,
    '곡 안의 시간이 아님: "$1"(예: 83, 1:23, 1m23s)',
  ],
  // Changes faster than the rates allow (429), and work turned away while jukecord is behind (503).
  ['too many changes at once; try again in a moment', '한꺼번에 너무 많이 바꿈: 잠시 뒤 다시 시도하세요'],
  ['too many skips at once; try again in a moment', '한꺼번에 너무 많이 넘김: 잠시 뒤 다시 시도하세요'],
  ['too many requests at once; try again in a moment', '한꺼번에 너무 많이 요청함: 잠시 뒤 다시 시도하세요'],
  ['jukecord is busy; try again in a moment', 'jukecord가 바쁨: 잠시 뒤 다시 시도하세요'],
  // Why a live connection ended, which the panel shows.
  ['jukecord is restarting', 'jukecord가 다시 시작하는 중'],
  ['logged out', '로그아웃됨'],
  ['the login has ended', '로그인이 끝남'],
  ['no longer allowed in that server', '그 서버를 더는 열 수 없음'],
  ['connections come from the panel only', '패널에서만 연결할 수 있음'],
  // Refusals of the web server and the database that a panel can meet.
  ["the change came without the panel's CSRF token; reload the panel", 'CSRF 토큰 없이 온 변경: 패널을 새로고침하세요'],
  ["the logout came without the panel's CSRF token", 'CSRF 토큰 없이 온 로그아웃'],
  ['that track is not playing or queued in this server', '이 서버에서 틀고 있거나 대기열에 있는 곡이 아님'],
  ['the track is not prepared yet', '아직 준비되지 않은 곡'],
  [
    'jukecord is making other MP3 copies right now; try again in a moment',
    '다른 MP3를 만드는 중: 잠시 뒤 다시 시도하세요',
  ],
  ['a token name is 1 to 100 characters', '토큰 이름은 1~100자'],
  ['the new order does not hold exactly the items in the queue', '새 순서가 지금 대기열의 곡과 맞지 않음'],
  ['this needs the host', '호스트만 할 수 있음'],
  [/^this needs a (\w+) token$/, '$1 권한이 있는 토큰이 필요함'],
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
  [REASONS.nothingToPlay, '그 주소에는 틀 것이 없음'],
  [REASONS.tooLarge, '파일이 너무 큼'],
  [REASONS.tooLong, '가져오는 데 너무 오래 걸림'],
  [REASONS.noSuchSite, '없는 사이트'],
  [REASONS.nothingFound, '찾은 곡 없음'],
  [REASONS.failed, '받지 못함'],
  [/^the site answered (\d{3})$/, '사이트 응답 코드 $1'],
  // Searching (the add field's list, Discord's suggestions, the API).
  ['searching is not set up here', '여기서는 검색을 쓸 수 없음'],
  ['nothing to search for', '찾을 말이 없음'],
  ['a search takes words, not an address', '검색어로 주소를 쓸 수 없음'],
  ['too many searches at once; try again in a moment', '한꺼번에 너무 많이 검색함: 잠시 뒤 다시 시도하세요'],
];

/** A message from the actions in the person's language, as it is (for a reason inside a sentence). */
export function translate(message: string, lang: Lang): string {
  if (lang === 'ko') {
    for (const [english, korean] of KOREAN) {
      if (typeof english === 'string' ? english === message : english.test(message)) {
        return typeof english === 'string' ? korean : message.replace(english, korean);
      }
    }
  }
  return message;
}

/**
 * A player's failure, "the track's title: the reason" (core/player.ts), with the reason in the person's language. The
 * reasons have no colon in them, so the last colon is where the reason starts, whatever the title holds.
 */
export function sayFailure(message: string, lang: Lang): string {
  const at = message.lastIndexOf(': ');
  if (at < 0) return translate(message, lang);
  return `${message.slice(0, at)}: ${translate(message.slice(at + 2), lang)}`;
}

/** A message from the actions as the person reads it: a sentence in their language. */
export function sayError(message: string, lang: Lang): string {
  const said = translate(message, lang);
  // Korean has no capitals: a translation is shown as it is, and a word in Latin letters at its start keeps its case.
  if (said !== message) return said;
  // English (or Korean without an entry): the message as a sentence, with its capital; jukecord's name has none.
  if (said.startsWith('jukecord')) return said;
  return said.charAt(0).toUpperCase() + said.slice(1);
}
