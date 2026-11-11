/**
 * Refusals and failures in the person's language. The actions say what went wrong in short English (the API and the
 * command line show that as it is); Discord shows it as a sentence, in Korean for Korean users.
 *
 * Each entry matches one message the actions can give. A message without an entry is shown in English, so a new
 * message is never lost, only untranslated until it gets its line here.
 */
import { REASONS } from '../core/reasons.ts';
import type { Lang } from './cards.ts';

// [the English message, or a pattern for one with a value in it; the Korean, with $1 for that value].
const KOREAN: readonly (readonly [string | RegExp, string])[] = [
  ['nothing is playing', '재생 중인 곡 없음'],
  ['the bot is not in a voice channel', '봇이 음성 채널에 없음'],
  [/^the queue is full \((\d+) tracks\)$/, '대기열이 가득 참($1곡)'],
  ['the queue is empty', '대기열이 비어 있음'],
  ['it is already playing', '이미 재생 중'],
  ['only members with the DJ role can change the music here', '이 서버에서는 DJ 역할이 있어야 음악을 바꿀 수 있음'],
  ['only people who can manage the server can set the DJ role', '서버 관리 권한이 있어야 DJ 역할을 정할 수 있음'],
  ['you cannot join that channel yourself', '내가 들어갈 수 없는 채널'],
  [/^the bot may not connect or speak in (.+)$/, '봇이 $1에 들어가거나 말할 권한이 없음'],
  ['join a voice channel first, or name one', '먼저 음성 채널에 들어가거나 채널을 고르세요'],
  ['that is not a voice channel', '음성 채널이 아님'],
  ['the bot does not play on stages', '무대 채널에서는 재생하지 않음'],
  ['the position must be 0 or more', '위치는 0 이상'],
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
    'jukecord가 아직 디스코드에 연결 중: 잠시 뒤 다시',
  ],
  ['jukecord is looking up other tracks right now; try again in a moment', '다른 곡을 찾는 중: 잠시 뒤 다시'],
  ['nothing to add', '넣을 것이 없음'],
  [/^item \d+ is not in the queue$/, '대기열에 없는 곡'],
  [/^position \d+ is outside the queue \(0-(\d+)\)$/, '대기열 밖의 자리(마지막 자리 번호는 $1)'],
  [/^Discord did not answer: .*$/, '디스코드가 답하지 않음: 잠시 뒤 다시'],
  ['you are not a member of that server', '그 서버의 멤버가 아님'],
  [
    /^"(.+)" is not a time in the track \(examples: 83, 1:23, 1m23s\)$/,
    '"$1"은 곡 안의 시간이 아님(예: 83, 1:23, 1m23s)',
  ],
  // The reasons a track could not be got (core/reasons.ts).
  [REASONS.botCheck, '지금은 YouTube가 이 서버를 막고 있음'],
  [REASONS.privateNetwork, '사설망 주소라 가져오지 않음'],
  [REASONS.unavailable, '볼 수 없는 영상'],
  [REASONS.nothingToPlay, '그 주소에는 틀 것이 없음'],
  [REASONS.tooLong, '가져오는 데 너무 오래 걸림'],
  [REASONS.noSuchSite, '없는 사이트'],
  [REASONS.nothingFound, '찾은 곡 없음'],
  [REASONS.failed, '받지 못함'],
  [/^the site answered (\d{3})$/, '사이트가 $1로 답함'],
];

/** A message from the actions as the person reads it: a sentence in their language. */
export function sayError(message: string, lang: Lang): string {
  if (lang === 'ko') {
    for (const [english, korean] of KOREAN) {
      if (typeof english === 'string' ? english === message : english.test(message)) {
        return typeof english === 'string' ? korean : message.replace(english, korean);
      }
    }
  }
  // English, or Korean without an entry: the message as a sentence.
  return message.charAt(0).toUpperCase() + message.slice(1);
}
