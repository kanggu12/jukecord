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
  // Discord's suggestions under /play's and /add's input, as it is typed (see Bot.onAutocomplete).
  search: '/play',
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
    .setDescriptionLocalizations({ ko: '주소(유튜브, 사운드클라우드, 재생목록 등) 또는 검색어' })
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

/** Every command as Discord wants it registered. */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const commands = [
    command(
      'add',
      'Add to the queue (it starts playing if nothing is)',
      '추가',
      '대기열에 넣기(재생 중이 아니면 바로 재생)',
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
    command('resume', 'Play on, or start the queue', '다시재생', '이어서 재생(멈췄으면 대기열 시작)'),
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
    command('stop', 'Stop playing (the queue stays)', '정지', '재생 멈춤(대기열은 그대로)'),
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
        .setDescriptionLocalizations({ ko: '/대기열 의 번호' })
        .setRequired(true)
        .setMinValue(1),
    ),
    command('move', 'Move a track in the queue', '옮기기', '대기열에서 곡 옮기기')
      .addIntegerOption((option) =>
        option
          .setName('from')
          .setDescription('Its number in /queue')
          .setNameLocalizations({ ko: '번호' })
          .setDescriptionLocalizations({ ko: '/대기열 의 번호' })
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
        .setDescriptionLocalizations({ ko: '/대기열 의 번호' })
        .setRequired(true)
        .setMinValue(1),
    ),
    command('shuffle', 'Shuffle the queue', '섞기', '대기열 섞기'),
    command('dedupe', 'Remove tracks queued twice', '중복제거', '두 번 넣은 곡 빼기'),
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
          .setDescriptionLocalizations({ ko: '저장한 플레이리스트를 대기열에 넣기' })
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
      ),
    command(
      'join',
      'Join your voice channel (or the one you name)',
      '참가',
      '내 음성 채널(또는 고른 채널)에 들어오기',
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
      '음성 채널에서 나가기(브라우저에서는 계속)',
    ),
    command(
      'listen',
      'Open the panel to listen along in your browser',
      '같이듣기',
      '브라우저에서 같이 듣기(패널 열기)',
    ),
    command('stats', 'Listening figures of this server', '통계', '이 서버에서 들은 기록 통계').addIntegerOption(
      (option) =>
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
          .setDescriptionLocalizations({ ko: '이 역할이 있는 사람만 음악을 바꿈' })
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
          .setDescriptionLocalizations({ ko: '다시 누구나 음악을 바꿈' }),
      ),
    command('version', 'The jukecord version', '버전', 'jukecord 버전'),
  ];
  return commands.map((builder) => builder.toJSON());
}
