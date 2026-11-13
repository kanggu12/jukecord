/**
 * The slash commands, in English with Korean names and descriptions (Discord shows each person their own language).
 *
 * SLASH_COMMANDS maps every action to the command that runs it; it is typed as a record over all action names, so a
 * new action without a slash command does not compile.
 */
import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js';
import type { ActionName } from '../app/actions.ts';

/** The command (and subcommand) that runs each action. */
export const SLASH_COMMANDS: Readonly<Record<ActionName, string>> = {
  add: '/add',
  'play-now': '/play',
  skip: '/skip',
  'remove-current': '/drop',
  pause: '/pause',
  resume: '/resume',
  seek: '/seek',
  repeat: '/repeat',
  stop: '/stop',
  'now-playing': '/np',
  queue: '/queue',
  remove: '/remove',
  move: '/move',
  jump: '/jump',
  shuffle: '/shuffle',
  dedupe: '/dedupe',
  clear: '/clear',
  history: '/history',
  playlists: '/playlist list',
  'playlist-save': '/playlist save',
  'playlist-load': '/playlist load',
  'playlist-rename': '/playlist rename',
  'playlist-delete': '/playlist delete',
  join: '/join',
  leave: '/leave',
  // Discord's own channel picker in /join lists the voice channels.
  'voice-channels': '/join',
  stats: '/stats',
  settings: '/dj show',
  'dj-role': '/dj set',
  status: '/version',
  wrapped: '/wrapped',
  'alerts-channel': '/alerts set',
  lyrics: '/lyrics',
  // /stop with its after-track option.
  'stop-after': '/stop',
  'listen-links': '/share list',
  'listen-link-create': '/share create',
  'listen-link-revoke': '/share revoke',
  stay: '/stay',
  'vote-skip': '/voteskip',
  'take-turns': '/turns set',
  'turns-now': '/turns now',
  'person-limit': '/limit',
  volume: '/volume',
  sound: '/sound',
  // Discord's suggestions under /play's and /add's input, as it is typed (see Bot.onAutocomplete).
  search: '/play',
  likes: '/likes show',
  like: '/like',
  unlike: '/likes remove',
  'likes-add': '/likes add',
  autoplay: '/autoplay',
  'playlist-export': '/playlist export',
  'playlist-import': '/playlist import',
};

// One command: English name and description, Korean name and description.
function command(name: string, description: string, koName: string, koDescription: string): SlashCommandBuilder {
  return (
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setNameLocalizations({ ko: koName })
      .setDescriptionLocalizations({ ko: koDescription })
      // Server-only: a queue belongs to a server, and DMs have no voice channel.
      .setContexts(InteractionContextType.Guild)
  );
}

// The "what to play" option shared by /add and /play, with what a search finds suggested as the words are typed.
function inputOption(option: SlashCommandStringOption): SlashCommandStringOption {
  return option
    .setName('input')
    .setDescription('An address (YouTube, SoundCloud, a playlist...) or words to search for')
    .setNameLocalizations({ ko: '입력' })
    .setDescriptionLocalizations({ ko: '링크(유튜브, 사운드클라우드, 재생목록 등) 또는 검색어' })
    .setRequired(true)
    .setMaxLength(500)
    .setAutocomplete(true);
}

// A saved playlist's name, with suggestions as people type.
function playlistName(option: SlashCommandStringOption): SlashCommandStringOption {
  return option
    .setName('name')
    .setDescription('The playlist name')
    .setNameLocalizations({ ko: '이름' })
    .setDescriptionLocalizations({ ko: '플레이리스트 이름' })
    .setRequired(true)
    .setMaxLength(100)
    .setAutocomplete(true);
}

// "On" or "off", for the settings that are one or the other.
function modeOption(option: SlashCommandStringOption): SlashCommandStringOption {
  return option
    .setName('mode')
    .setDescription('On or off')
    .setNameLocalizations({ ko: '방식' })
    .setDescriptionLocalizations({ ko: '켜기 또는 끄기' })
    .setRequired(true)
    .addChoices(
      { name: 'On', value: 'on', name_localizations: { ko: '켜기' } },
      { name: 'Off', value: 'off', name_localizations: { ko: '끄기' } },
    );
}

/** Every command as Discord wants it registered. */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const commands = [
    command(
      'add',
      'Add to the queue (it starts playing if nothing is)',
      '추가',
      '대기열에 추가(재생 중이 아니면 바로 재생)',
    )
      .addStringOption(inputOption)
      .addStringOption((option) =>
        option
          .setName('where')
          .setDescription('Where in the queue (default: the end)')
          .setNameLocalizations({ ko: '위치' })
          .setDescriptionLocalizations({ ko: '대기열 어디에(기본: 맨 뒤)' })
          .addChoices(
            { name: 'At the end', value: 'end', name_localizations: { ko: '맨 뒤' } },
            { name: 'Next', value: 'next', name_localizations: { ko: '다음 곡으로' } },
          ),
      ),
    command(
      'play',
      'Play now (the current track is skipped)',
      '재생',
      '지금 바로 재생(지금 곡은 건너뜀)',
    ).addStringOption(inputOption),
    command('skip', 'Skip to the next track', '건너뛰기', '다음 곡으로'),
    // Not "삭제": next to /빼기 (remove a queued track) it would read as the same thing.
    command(
      'drop',
      'Remove the current track without adding it to the history',
      '지금곡빼기',
      '재생 기록에 남기지 않고 지금 곡 빼기',
    ),
    command('pause', 'Pause', '일시정지', '일시정지'),
    // Not "다시재생", which reads as "play again".
    command('resume', 'Play on, or start the queue', '이어재생', '이어서 재생(멈췄으면 대기열 시작)'),
    command('seek', 'Go to a place in the current track', '탐색', '지금 곡의 원하는 위치로').addStringOption((option) =>
      option
        .setName('time')
        .setDescription('Like 83, 1:23 or 1m23s')
        .setNameLocalizations({ ko: '시간' })
        .setDescriptionLocalizations({ ko: '예: 83, 1:23, 1m23s' })
        .setRequired(true)
        .setMaxLength(20),
    ),
    command(
      'repeat',
      'Repeat the current track or the whole queue',
      '반복',
      '지금 곡 또는 대기열 전체 반복',
    ).addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('What to repeat')
        .setNameLocalizations({ ko: '방식' })
        .setDescriptionLocalizations({ ko: '무엇을 반복할지' })
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off', name_localizations: { ko: '끄기' } },
          { name: 'This track', value: 'track', name_localizations: { ko: '지금 곡' } },
          { name: 'The queue', value: 'queue', name_localizations: { ko: '대기열' } },
        ),
    ),
    command('stop', 'Stop playing (the queue stays)', '정지', '재생 멈춤(대기열은 그대로)').addBooleanOption((option) =>
      option
        .setName('after-track')
        .setDescription('True: stop when this track ends instead of now; False: play on after it')
        .setNameLocalizations({ ko: '곡끝나면' })
        .setDescriptionLocalizations({ ko: 'True: 지금 말고 이 곡이 끝나면 멈춤, False: 곡이 끝나도 계속 재생' }),
    ),
    command('np', 'What is playing now', '지금곡', '지금 재생 중인 곡'),
    command('queue', 'Show the queue', '대기열', '대기열 보기').addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page')
        .setNameLocalizations({ ko: '페이지' })
        .setDescriptionLocalizations({ ko: '페이지' })
        .setMinValue(1),
    ),
    command('remove', 'Remove a track from the queue', '빼기', '대기열에서 곡 빼기').addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Its number in /queue')
        .setNameLocalizations({ ko: '번호' })
        .setDescriptionLocalizations({ ko: '/대기열에 나오는 번호' })
        .setRequired(true)
        .setMinValue(1),
    ),
    command('move', 'Move a track in the queue', '옮기기', '대기열에서 곡 옮기기')
      .addIntegerOption((option) =>
        option
          .setName('from')
          .setDescription('Its number in /queue')
          .setNameLocalizations({ ko: '번호' })
          .setDescriptionLocalizations({ ko: '/대기열에 나오는 번호' })
          .setRequired(true)
          .setMinValue(1),
      )
      .addIntegerOption((option) =>
        option
          .setName('to')
          .setDescription('The new number')
          .setNameLocalizations({ ko: '새번호' })
          .setDescriptionLocalizations({ ko: '옮길 자리 번호' })
          .setRequired(true)
          .setMinValue(1),
      ),
    command('jump', 'Play a queued track now', '바로재생', '대기열의 곡을 지금 재생').addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Its number in /queue')
        .setNameLocalizations({ ko: '번호' })
        .setDescriptionLocalizations({ ko: '/대기열에 나오는 번호' })
        .setRequired(true)
        .setMinValue(1),
    ),
    command('shuffle', 'Shuffle the queue', '섞기', '대기열 섞기'),
    command('dedupe', 'Remove tracks queued twice', '중복제거', '두 번 추가한 곡 제거'),
    command('clear', 'Empty the queue', '비우기', '대기열 비우기'),
    command('history', 'Recently played', '기록', '최근에 들은 곡'),
    command('playlist', 'Saved playlists', '플레이리스트', '저장한 플레이리스트')
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('Show the saved playlists')
          .setNameLocalizations({ ko: '목록' })
          .setDescriptionLocalizations({ ko: '저장한 플레이리스트 보기' }),
      )
      .addSubcommand((sub) =>
        sub
          .setName('save')
          .setDescription('Save the current track and the queue')
          .setNameLocalizations({ ko: '저장' })
          .setDescriptionLocalizations({ ko: '지금 곡과 대기열을 저장' })
          .addStringOption((option) => playlistName(option).setAutocomplete(false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('load')
          .setDescription('Add a saved playlist to the queue')
          .setNameLocalizations({ ko: '불러오기' })
          .setDescriptionLocalizations({ ko: '저장한 플레이리스트를 대기열에 추가' })
          .addStringOption(playlistName),
      )
      .addSubcommand((sub) =>
        sub
          .setName('rename')
          .setDescription('Rename a saved playlist')
          .setNameLocalizations({ ko: '이름바꾸기' })
          .setDescriptionLocalizations({ ko: '플레이리스트 이름 바꾸기' })
          .addStringOption(playlistName)
          .addStringOption((option) =>
            option
              .setName('new_name')
              .setDescription('The new name')
              .setNameLocalizations({ ko: '새이름' })
              .setDescriptionLocalizations({ ko: '새 이름' })
              .setRequired(true)
              .setMaxLength(100),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a saved playlist')
          .setNameLocalizations({ ko: '지우기' })
          .setDescriptionLocalizations({ ko: '플레이리스트 지우기' })
          .addStringOption(playlistName),
      )
      .addSubcommand((sub) =>
        sub
          .setName('export')
          .setDescription('A saved playlist as a file')
          .setNameLocalizations({ ko: '내보내기' })
          .setDescriptionLocalizations({ ko: '저장한 플레이리스트를 파일로 받기' })
          .addStringOption(playlistName)
          .addStringOption((option) =>
            option
              .setName('format')
              .setDescription('The kind of file (default: addresses, one per line)')
              .setNameLocalizations({ ko: '형식' })
              .setDescriptionLocalizations({ ko: '파일 형식(기본: 한 줄에 주소 하나)' })
              .addChoices(
                { name: 'Addresses (text)', value: 'text', name_localizations: { ko: '주소 목록(텍스트)' } },
                { name: 'M3U', value: 'm3u', name_localizations: { ko: 'M3U' } },
                { name: 'jukecord (JSON)', value: 'json', name_localizations: { ko: 'jukecord(JSON)' } },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Make a playlist from a file: addresses, M3U or jukecord JSON')
          .setNameLocalizations({ ko: '가져오기' })
          .setDescriptionLocalizations({ ko: '파일로 플레이리스트 만들기: 주소 목록, M3U, jukecord JSON' })
          .addStringOption((option) => playlistName(option).setAutocomplete(false))
          .addAttachmentOption((option) =>
            option
              .setName('file')
              .setDescription('The file (up to 1 MiB)')
              .setNameLocalizations({ ko: '파일' })
              .setDescriptionLocalizations({ ko: '파일(1MiB까지)' })
              .setRequired(true),
          ),
      ),
    command(
      'join',
      'Join your voice channel (or the one you name)',
      '참가',
      '내 음성 채널(또는 고른 채널)로 봇 부르기',
    ).addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('A voice channel (default: yours)')
        .setNameLocalizations({ ko: '채널' })
        .setDescriptionLocalizations({ ko: '음성 채널(기본: 내 채널)' })
        // Voice channels only: on a stage the bot would be a silent listener.
        .addChannelTypes(ChannelType.GuildVoice),
    ),
    command(
      'leave',
      'Leave the voice channel (the music goes on in the browser)',
      '퇴장',
      '음성 채널에서 나가기(브라우저에서는 계속 재생)',
    ),
    command(
      'listen',
      'Open the panel to listen along in your browser',
      '같이듣기',
      '브라우저에서 같이 듣기(패널 열기)',
    ),
    command('stats', 'Listening figures of this server', '통계', '이 서버의 청취 통계').addIntegerOption((option) =>
      option
        .setName('days')
        .setDescription('How many days back (default 30)')
        .setNameLocalizations({ ko: '기간' })
        .setDescriptionLocalizations({ ko: '며칠 전까지(기본 30일)' })
        .setMinValue(1)
        .setMaxValue(366),
    ),
    command('dj', 'Who may change the music here', '디제이', '이 서버에서 음악을 바꿀 수 있는 사람')
      // Shown in the command list only to people who can manage the server; Discord also enforces it.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('show')
          .setDescription('Show the DJ role')
          .setNameLocalizations({ ko: '보기' })
          .setDescriptionLocalizations({ ko: 'DJ 역할 보기' }),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Only members with this role may change the music')
          .setNameLocalizations({ ko: '정하기' })
          .setDescriptionLocalizations({ ko: '이 역할이 있는 사람만 음악을 바꿀 수 있음' })
          .addRoleOption((option) =>
            option
              .setName('role')
              .setDescription('The DJ role')
              .setNameLocalizations({ ko: '역할' })
              .setDescriptionLocalizations({ ko: 'DJ 역할' })
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('clear')
          .setDescription('Everyone may change the music again')
          .setNameLocalizations({ ko: '풀기' })
          .setDescriptionLocalizations({ ko: '다시 누구나 음악을 바꿀 수 있음' }),
      ),
    command('version', 'The jukecord version', '버전', 'jukecord 버전'),
    command('wrapped', "This server's year in music", '음악결산', '이 서버의 한 해 음악 결산').addStringOption(
      (option) =>
        option
          .setName('period')
          .setDescription('Which time (default: this year)')
          .setNameLocalizations({ ko: '기간' })
          .setDescriptionLocalizations({ ko: '어느 기간(기본: 올해)' })
          .addChoices(
            { name: 'This year', value: 'this-year', name_localizations: { ko: '올해' } },
            { name: 'The last 12 months', value: 'last-12-months', name_localizations: { ko: '최근 12개월' } },
            { name: 'This month', value: 'this-month', name_localizations: { ko: '이번 달' } },
            { name: 'Last month', value: 'last-month', name_localizations: { ko: '지난달' } },
            { name: 'Last year', value: 'last-year', name_localizations: { ko: '작년' } },
          ),
    ),
    command('alerts', 'Where jukecord tells this server about trouble', '알림', 'jukecord가 문제를 알릴 채널')
      // Shown in the command list only to people who can manage the server; Discord also enforces it.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('show')
          .setDescription('Show the alerts channel')
          .setNameLocalizations({ ko: '보기' })
          .setDescriptionLocalizations({ ko: '알림 채널 보기' }),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Tell this server about trouble in a channel')
          .setNameLocalizations({ ko: '정하기' })
          .setDescriptionLocalizations({ ko: '문제를 알릴 채널 정하기' })
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('A text channel the bot may post in')
              .setNameLocalizations({ ko: '채널' })
              .setDescriptionLocalizations({ ko: '봇이 글을 올릴 수 있는 텍스트 채널' })
              .setRequired(true)
              // Text channels only: that is where people read what jukecord says.
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('clear')
          .setDescription('Tell this server about trouble nowhere')
          .setNameLocalizations({ ko: '끄기' })
          .setDescriptionLocalizations({ ko: '문제를 어디에도 알리지 않음' }),
      ),
    command('lyrics', 'The lyrics of the track playing', '가사', '지금 곡의 가사').addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page')
        .setNameLocalizations({ ko: '페이지' })
        .setDescriptionLocalizations({ ko: '페이지' })
        .setMinValue(1),
    ),
    command('share', 'Links to listen along without a Discord account', '공유', '디스코드 계정 없이 같이 듣는 링크')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Make a link to listen along (only you see it)')
          .setNameLocalizations({ ko: '만들기' })
          .setDescriptionLocalizations({ ko: '같이 듣는 링크 만들기(나에게만 보임)' })
          .addIntegerOption((option) =>
            option
              .setName('days')
              .setDescription('How long it works (default: 7 days)')
              .setNameLocalizations({ ko: '기간' })
              .setDescriptionLocalizations({ ko: '쓸 수 있는 기간(기본: 7일)' })
              .addChoices(
                { name: '1 day', value: 1, name_localizations: { ko: '1일' } },
                { name: '7 days', value: 7, name_localizations: { ko: '7일' } },
                { name: '30 days', value: 30, name_localizations: { ko: '30일' } },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('The listening links that still work')
          .setNameLocalizations({ ko: '목록' })
          .setDescriptionLocalizations({ ko: '아직 쓸 수 있는 듣기 링크' }),
      )
      .addSubcommand((sub) =>
        sub
          .setName('revoke')
          .setDescription('Revoke a listening link: its guests are out at once')
          .setNameLocalizations({ ko: '폐기' })
          .setDescriptionLocalizations({ ko: '듣기 링크 폐기(손님은 바로 나감)' })
          .addIntegerOption((option) =>
            option
              .setName('number')
              .setDescription('Its number in /share list')
              .setNameLocalizations({ ko: '번호' })
              .setDescriptionLocalizations({ ko: '/공유 목록에 나오는 번호' })
              .setRequired(true)
              .setMinValue(1),
          ),
      ),
    command(
      'stay',
      'Stay in voice when everyone has left, or leave after a while alone',
      '머물기',
      '모두 나가도 음성 채널에 남기, 또는 혼자 남으면 잠시 뒤 나가기',
    )
      // A server setting: shown to people who can manage the server, as /dj is; Discord also enforces it.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(modeOption),
    command(
      'voteskip',
      'Whether Skip from someone without the DJ role is a vote (half of the listeners skip)',
      '건너뛰기투표',
      'DJ 역할이 없는 사람의 건너뛰기를 투표로 받기(듣는 사람 절반이 찬성하면 넘어감)',
    )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(modeOption),
    // Shown to everyone: "now" is for whoever may change the music; "set" is refused for those who cannot manage.
    command('turns', 'Take turns in the queue, by person', '차례', '대기열을 사람마다 번갈아 재생')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Tracks added go in turn, by person (needs Manage Server)')
          .setNameLocalizations({ ko: '정하기' })
          .setDescriptionLocalizations({ ko: '추가하는 곡을 사람마다 번갈아 배치(서버 관리 권한 필요)' })
          .addStringOption(modeOption),
      )
      .addSubcommand((sub) =>
        sub
          .setName('now')
          .setDescription('Put the queue in turns once')
          .setNameLocalizations({ ko: '맞추기' })
          .setDescriptionLocalizations({ ko: '지금 대기열을 한 번 번갈아 정렬' }),
      ),
    command(
      'limit',
      'The most tracks one person may have in the queue',
      '곡수제한',
      '한 사람이 대기열에 추가할 수 있는 곡 수',
    )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addIntegerOption((option) =>
        option
          .setName('tracks')
          .setDescription('Tracks per person (0: no limit)')
          .setNameLocalizations({ ko: '곡수' })
          .setDescriptionLocalizations({ ko: '한 사람당 곡 수(0: 제한 없음)' })
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(1000),
      ),
    command(
      'volume',
      "The voice channel's volume (browsers keep their own)",
      '음량',
      '음성 채널 음량(브라우저는 각자 따로)',
    ).addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription('0 to 200 (100 is the track as it is)')
        .setNameLocalizations({ ko: '퍼센트' })
        .setDescriptionLocalizations({ ko: '0~200(100은 원래 크기)' })
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),
    command(
      'sound',
      "The voice channel's sound (browsers listening apply it too)",
      '음색',
      '음성 채널 음색(브라우저로 듣는 사람에게도 적용)',
    ).addStringOption((option) =>
      option
        .setName('preset')
        .setDescription('How it sounds')
        .setNameLocalizations({ ko: '종류' })
        .setDescriptionLocalizations({ ko: '음색 종류' })
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off', name_localizations: { ko: '끄기' } },
          { name: 'More bass', value: 'bass', name_localizations: { ko: '저음 강조' } },
          { name: 'Clearer voices', value: 'voices', name_localizations: { ko: '목소리 또렷하게' } },
          { name: 'Brighter', value: 'bright', name_localizations: { ko: '밝게' } },
          { name: 'Softer at night', value: 'night', name_localizations: { ko: '밤에 부드럽게' } },
        ),
    ),
    command(
      'like',
      'Like the track playing now (your likes are yours alone)',
      '좋아요',
      '지금 곡에 좋아요(내 목록에만 남음)',
    ),
    command('likes', 'The tracks you liked', '좋아요목록', '내가 좋아요 한 곡')
      .addSubcommand((sub) =>
        sub
          .setName('show')
          .setDescription('Show the tracks you liked, newest first')
          .setNameLocalizations({ ko: '보기' })
          .setDescriptionLocalizations({ ko: '좋아요 한 곡 보기(최근 것부터)' })
          .addIntegerOption((option) =>
            option
              .setName('page')
              .setDescription('Page')
              .setNameLocalizations({ ko: '페이지' })
              .setDescriptionLocalizations({ ko: '페이지' })
              .setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add every track you liked to the queue')
          .setNameLocalizations({ ko: '모두추가' })
          .setDescriptionLocalizations({ ko: '좋아요 한 곡을 모두 대기열에 추가' })
          .addStringOption((option) =>
            option
              .setName('where')
              .setDescription('Where in the queue (default: the end)')
              .setNameLocalizations({ ko: '위치' })
              .setDescriptionLocalizations({ ko: '대기열 어디에(기본: 맨 뒤)' })
              .addChoices(
                { name: 'At the end', value: 'end', name_localizations: { ko: '맨 뒤' } },
                { name: 'Next', value: 'next', name_localizations: { ko: '다음 곡으로' } },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Take back a like')
          .setNameLocalizations({ ko: '빼기' })
          .setDescriptionLocalizations({ ko: '좋아요 취소' })
          .addIntegerOption((option) =>
            option
              .setName('position')
              .setDescription('Its number in /likes show')
              .setNameLocalizations({ ko: '번호' })
              .setDescriptionLocalizations({ ko: '/좋아요목록 보기에 나오는 번호' })
              .setRequired(true)
              .setMinValue(1),
          ),
      ),
    command('autoplay', 'What plays when the queue runs out', '자동재생', '대기열이 비었을 때 틀 곡').addStringOption(
      (option) =>
        option
          .setName('mode')
          .setDescription('Off, a track from this server’s plays, or one related to the last track')
          .setNameLocalizations({ ko: '방식' })
          .setDescriptionLocalizations({ ko: '끄기, 이 서버에서 들은 곡, 마지막 곡과 비슷한 곡' })
          .setRequired(true)
          .addChoices(
            { name: 'Off', value: 'off', name_localizations: { ko: '끄기' } },
            { name: "This server's plays", value: 'history', name_localizations: { ko: '이 서버에서 들은 곡' } },
            {
              name: 'Related to the last track',
              value: 'related',
              name_localizations: { ko: '마지막 곡과 비슷한 곡' },
            },
          ),
    ),
  ];
  return commands.map((builder) => builder.toJSON());
}
