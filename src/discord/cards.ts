/**
 * What the bot writes back: short cards in the person's own language (Korean or English, from Discord's locale).
 *
 * One card per answer, with only what the action changed or showed. The colour on the left edge carries the state
 * (playing, paused, added, a problem), the one place colour means something in Discord's layout.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { AddResult, SettingsView, StatsView, WrappedView } from '../app/actions.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import { sayNotice } from '../core/say.ts';
import type { Sound } from '../core/sound.ts';
import type { HistoryEntry, Playlist, QueueItem } from '../core/types.ts';
import type { LyricsAnswer } from '../media/lyrics.ts';
import type { ListenLinkRow } from '../store/store.ts';
import { formatDuration } from '../util/time.ts';

/** The two languages the bot answers in; anything else gets English. */
export type Lang = 'en' | 'ko';

/** Picks the reply language from the locale Discord reports for the person ("ko", "en-US", ...). */
export function langOf(locale: string | null | undefined): Lang {
  return locale?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

// State colours, matched to the panel's: playing green, paused amber, added blue, problem red, neutral grey.
const COLOUR = { playing: 0x2fa66a, paused: 0xd49a2a, added: 0x3d7be0, problem: 0xd0473f, neutral: 0x6b7078 } as const;

// The texts, side by side so a missing translation shows up in review.
const TEXT = {
  added: {
    en: (n: number) => (n === 1 ? 'Added' : `Added ${n} tracks`),
    ko: (n: number) => (n === 1 ? '추가함' : `${n}곡 추가함`),
  },
  playingNow: { en: 'Playing now', ko: '지금 재생' },
  paused: { en: 'Paused', ko: '일시정지' },
  loading: { en: 'Getting it ready', ko: '준비 중' },
  waiting: { en: 'Waiting for its turn', ko: '차례를 기다리는 중' },
  nothing: { en: 'Nothing is playing', ko: '재생 중인 곡 없음' },
  queue: { en: 'Queue', ko: '대기열' },
  empty: { en: 'The queue is empty', ko: '대기열이 비어 있음' },
  history: { en: 'Recently played', ko: '최근에 들은 곡' },
  noHistory: { en: 'Nothing has been played yet', ko: '아직 들은 곡 없음' },
  playlists: { en: 'Playlists', ko: '플레이리스트' },
  noPlaylists: { en: 'No saved playlists', ko: '저장한 플레이리스트 없음' },
  addedBy: { en: 'added by', ko: '추가한 사람' },
  page: { en: 'page', ko: '페이지' },
  total: { en: 'total', ko: '총' },
  pause: { en: 'Pause', ko: '일시정지' },
  resume: { en: 'Resume', ko: '이어서 재생' },
  skip: { en: 'Skip', ko: '건너뛰기' },
  panel: { en: 'Open the panel', ko: '패널 열기' },
  repeatTrack: { en: 'Repeating this track', ko: '지금 곡 반복' },
  repeatQueue: { en: 'Repeating the queue', ko: '대기열 반복' },
  statsTitle: { en: (days: number) => `The last ${days} days`, ko: (days: number) => `최근 ${days}일` },
  plays: { en: 'plays', ko: '재생' },
  listened: { en: 'listened', ko: '들은 시간' },
  distinct: { en: 'tracks', ko: '곡' },
  topTracks: { en: 'Most played', ko: '많이 들은 곡' },
  topPeople: { en: 'Added most', ko: '많이 추가한 사람' },
  nobody: { en: 'the host', ko: '호스트' },
  noStats: { en: 'Nothing was played in this time', ko: '이 기간에 들은 곡 없음' },
  djRole: { en: 'DJ role', ko: 'DJ 역할' },
  everyone: { en: 'Everyone in the server may change the music', ko: '서버의 누구나 음악을 바꿀 수 있음' },
  onlyRole: { en: 'Only members with this role may change the music', ko: '이 역할이 있는 사람만 음악을 바꿀 수 있음' },
  alerts: { en: 'Alerts channel', ko: '알림 채널' },
  alertsHere: { en: 'jukecord tells this server about trouble here', ko: 'jukecord가 이 서버의 문제를 여기에 알림' },
  noAlerts: { en: 'jukecord tells this server about trouble nowhere', ko: 'jukecord가 이 서버에 문제를 알리지 않음' },
  lyrics: { en: 'Lyrics', ko: '가사' },
  noLyrics: { en: 'No lyrics found for this track', ko: '이 곡의 가사를 찾지 못함' },
  instrumental: { en: 'Instrumental: no words', ko: '연주곡: 가사 없음' },
  lyricsFrom: { en: 'Lyrics from LRCLIB', ko: '가사 출처: LRCLIB' },
  stopsAfter: { en: 'Stops after this track', ko: '이 곡이 끝나면 멈춤' },
  listenLink: { en: 'A link to listen along', ko: '같이 듣는 링크' },
  listenLinkHint: {
    en: 'Anyone with it listens along in a browser without a Discord account and changes nothing. It is shown once.',
    ko: '이 링크가 있으면 디스코드 계정 없이 브라우저에서 같이 듣고, 아무것도 바꿀 수 없음. 이번 한 번만 보임.',
  },
  listenLinks: { en: 'Listening links', ko: '듣기 링크' },
  noListenLinks: { en: 'No listening links', ko: '듣기 링크 없음' },
  until: { en: 'until', ko: '만료' },
  guests: { en: 'guests', ko: '손님' },
  on: { en: 'on', ko: '켬' },
  off: { en: 'off', ko: '끔' },
  voteSkip: { en: 'Vote to skip', ko: '건너뛰기 투표' },
  takeTurns: { en: 'Take turns', ko: '차례대로 넣기' },
  personLimit: { en: 'Tracks per person', ko: '한 사람당 곡 수' },
  noLimit: { en: 'no limit', ko: '제한 없음' },
  stay: { en: 'Stay in voice', ko: '음성 채널에 머물기' },
  volume: { en: 'Voice volume', ko: '음성 채널 음량' },
  sound: { en: 'Sound', ko: '음색' },
  presets: {
    en: { off: 'off', bass: 'more bass', voices: 'clearer voices', bright: 'brighter', night: 'softer at night' },
    ko: { off: '끔', bass: '저음 강조', voices: '목소리 또렷하게', bright: '밝게', night: '밤에 부드럽게' },
  },
  skipVotes: {
    en: (votes: number, needed: number) => `Skip (${votes} of ${needed})`,
    ko: (votes: number, needed: number) => `건너뛰기 (${votes}/${needed})`,
  },
  votesLine: {
    en: (votes: number, needed: number) => `Votes to skip: ${votes} of ${needed}`,
    ko: (votes: number, needed: number) => `건너뛰기 투표: ${needed}표 중 ${votes}표`,
  },
} as const;

/** A short confirmation ("Done", "Removed 3 duplicates") in the person's language. */
export function note(lang: Lang, en: string, ko: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOUR.neutral).setDescription(lang === 'ko' ? ko : en);
}

/** A problem, shown only to the person who asked. */
export function problem(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOUR.problem).setDescription(message);
}

// "Title" linked to its page, with length and who added it.
function line(title: string, url: string, durationMs: number | null, addedBy: string | null, lang: Lang): string {
  const length = durationMs === null ? '' : ` · ${formatDuration(durationMs)}`;
  const who = addedBy ? ` · ${TEXT.addedBy[lang]} <@${addedBy}>` : '';
  // Square brackets in titles would break Discord's link syntax.
  return `[${title.replace(/[[\]]/g, '')}](${url})${length}${who}`;
}

/** What was added, and where it landed in the queue; `playingNow` for /play, which plays it at once. */
export function addedCard(result: AddResult, lang: Lang, playingNow = false): EmbedBuilder {
  const items = result.items;
  const first = items[0];
  const embed = new EmbedBuilder()
    .setColor(COLOUR.added)
    .setTitle(playingNow ? TEXT.playingNow[lang] : TEXT.added[lang](items.length));
  if (items.length === 1 && first) {
    embed.setDescription(
      `${first.position + 1}. ${line(first.track.title, first.track.url, first.track.durationMs, first.addedBy, lang)}`,
    );
    if (first.track.thumbnail) embed.setThumbnail(first.track.thumbnail);
  } else {
    // A playlist: the first five, then how many more.
    const shown = items
      .slice(0, 5)
      .map(
        (item) => `${item.position + 1}. ${line(item.track.title, item.track.url, item.track.durationMs, null, lang)}`,
      );
    if (items.length > 5) shown.push(`+${items.length - 5}`);
    embed.setDescription(shown.join('\n'));
  }
  // What was left out, and why, so a short count is not a mystery.
  const left: string[] = [];
  if (result.skippedTooLong > 0)
    left.push(
      lang === 'ko'
        ? `너무 긴 곡 ${result.skippedTooLong}곡은 추가하지 않음`
        : `${result.skippedTooLong} too long, left out`,
    );
  if (result.skippedFull > 0)
    left.push(
      lang === 'ko'
        ? `대기열이 차서 ${result.skippedFull}곡은 추가하지 못함`
        : `${result.skippedFull} did not fit, the queue is full`,
    );
  if (result.skippedLimit > 0)
    left.push(
      lang === 'ko'
        ? `한 사람당 곡 수 제한으로 ${result.skippedLimit}곡 못 넣음`
        : `${result.skippedLimit} did not fit, the limit per person`,
    );
  if (left.length > 0) embed.setFooter({ text: left.join(' · ') });
  return embed;
}

// A text progress bar for the card: 20 cells, the played part filled.
function bar(position: number, duration: number | null): string {
  if (!duration) return '';
  const cells = 20;
  const filled = Math.min(cells, Math.round((position / duration) * cells));
  return `\`${'━'.repeat(filled)}${'─'.repeat(cells - filled)}\` ${formatDuration(position)} / ${formatDuration(duration)}`;
}

/**
 * The current track with a progress bar, and buttons to pause or skip. With a vote to skip it under way, the Skip
 * button and the line under the bar say how the vote stands.
 */
export function nowCard(
  snapshot: PlayerSnapshot,
  lang: Lang,
  panelUrl: string | null,
  votes: { readonly votes: number; readonly needed: number } | null = null,
) {
  // What the player did by itself (a track taken out of the loop), in the card's language, on a line of its own.
  const notice = snapshot.notice ? `\n${sayNotice(snapshot.notice, lang)}` : '';
  if (!snapshot.track) {
    return {
      embeds: [new EmbedBuilder().setColor(COLOUR.neutral).setDescription(`${TEXT.nothing[lang]}${notice}`)],
      components: [],
    };
  }
  const state =
    snapshot.status === 'playing'
      ? TEXT.playingNow[lang]
      : snapshot.status === 'paused'
        ? TEXT.paused[lang]
        : snapshot.waiting
          ? TEXT.waiting[lang]
          : TEXT.loading[lang];
  const colour =
    snapshot.status === 'playing' ? COLOUR.playing : snapshot.status === 'paused' ? COLOUR.paused : COLOUR.neutral;
  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: state })
    .setDescription(
      `${line(snapshot.track.title, snapshot.track.url, null, snapshot.addedBy, lang)}\n${bar(snapshot.positionMs, snapshot.durationMs)}${notice}`,
    );
  if (snapshot.track.thumbnail) embed.setThumbnail(snapshot.track.thumbnail);
  // The repeat mode, when one is on, a stop asked for after this track, and a vote to skip under way, under the bar.
  const footer: string[] = [];
  if (snapshot.repeat !== 'off')
    footer.push(snapshot.repeat === 'track' ? TEXT.repeatTrack[lang] : TEXT.repeatQueue[lang]);
  if (snapshot.stopAfter) footer.push(TEXT.stopsAfter[lang]);
  if (votes) footer.push(TEXT.votesLine[lang](votes.votes, votes.needed));
  if (footer.length > 0) embed.setFooter({ text: footer.join(' · ') });
  // The card's language travels in the buttons, so a press redraws the card in the language it was made in, not the
  // presser's (a card in the channel is everyone's).
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`jukecord:${snapshot.status === 'paused' ? 'resume' : 'pause'}:${lang}`)
      .setLabel(snapshot.status === 'paused' ? TEXT.resume[lang] : TEXT.pause[lang])
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      // The track the card shows rides along: a press after it has gone skips nothing more (see Actions.skip).
      .setCustomId(`jukecord:skip:${lang}:${snapshot.track.id}`)
      .setLabel(votes ? TEXT.skipVotes[lang](votes.votes, votes.needed) : TEXT.skip[lang])
      .setStyle(ButtonStyle.Secondary),
  );
  // The panel link only when there is an address people can reach.
  if (panelUrl)
    buttons.addComponents(new ButtonBuilder().setLabel(TEXT.panel[lang]).setStyle(ButtonStyle.Link).setURL(panelUrl));
  return { embeds: [embed], components: [buttons] };
}

/** One page of the queue (10 per page) with the total length. */
export function queueCard(items: readonly QueueItem[], page: number, lang: Lang): EmbedBuilder {
  if (items.length === 0) return new EmbedBuilder().setColor(COLOUR.neutral).setDescription(TEXT.empty[lang]);
  const pages = Math.max(1, Math.ceil(items.length / 10));
  const current = Math.min(Math.max(1, page), pages);
  const shown = items.slice((current - 1) * 10, current * 10);
  const total = items.reduce((sum, item) => sum + (item.track.durationMs ?? 0), 0);
  // A page past the end shows the last one, and says so first: shown without a word, it read as that page.
  const past =
    page > pages
      ? lang === 'ko'
        ? `${page}페이지는 없음: 대기열은 ${pages}페이지까지 있음\n`
        : `There is no page ${page}: the queue has ${pages === 1 ? '1 page' : `${pages} pages`}\n`
      : '';
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(`${TEXT.queue[lang]} (${items.length})`)
    .setDescription(
      past +
        shown
          .map(
            (item) =>
              `${item.position + 1}. ${line(item.track.title, item.track.url, item.track.durationMs, item.addedBy, lang)}`,
          )
          .join('\n'),
    )
    .setFooter({ text: `${TEXT.page[lang]} ${current}/${pages} · ${TEXT.total[lang]} ${formatDuration(total)}` });
}

/** The ten most recent plays. */
export function historyCard(entries: readonly HistoryEntry[], lang: Lang): EmbedBuilder {
  if (entries.length === 0) return new EmbedBuilder().setColor(COLOUR.neutral).setDescription(TEXT.noHistory[lang]);
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(TEXT.history[lang])
    .setDescription(
      entries
        .map(
          (entry) =>
            `<t:${Math.floor(entry.playedAt / 1000)}:R> ${line(entry.track.title, entry.track.url, entry.track.durationMs, entry.addedBy, lang)}`,
        )
        .join('\n'),
    );
}

/** The saved playlists with their sizes. */
export function playlistsCard(playlists: readonly Playlist[], lang: Lang): EmbedBuilder {
  if (playlists.length === 0) return new EmbedBuilder().setColor(COLOUR.neutral).setDescription(TEXT.noPlaylists[lang]);
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(TEXT.playlists[lang])
    .setDescription(
      playlists
        .map((playlist) => `**${playlist.name}** · ${lang === 'ko' ? `${playlist.size}곡` : playlist.size}`)
        .join('\n'),
    );
}

// Listening time as people say it: "3 h 12 min", "45 min".
function hoursMinutes(ms: number, lang: Lang): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (lang === 'ko') return hours > 0 ? `${hours}시간 ${rest}분` : `${rest}분`;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

// Plays per day as a row of block characters (the tallest day is a full block), in a code span so it lines up.
function sparkline(days: StatsView['days']): string {
  const blocks = '▁▂▃▄▅▆▇█';
  const top = Math.max(1, ...days.map((day) => day.plays));
  // Zero days get a space, so a quiet week looks quiet instead of like a floor of low bars.
  return days
    .map((day) => (day.plays === 0 ? ' ' : blocks[Math.min(7, Math.floor((day.plays / top) * 7.999))]))
    .join('');
}

/** Listening figures: totals, plays per day, the most played tracks and who added most. */
export function statsCard(stats: StatsView, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(TEXT.statsTitle[lang](stats.span));
  if (stats.plays === 0) return embed.setDescription(TEXT.noStats[lang]);
  // The totals in each language's own order: "12 plays · listened 3 h · 9 tracks", "재생 12회 · 들은 시간 3시간 · 9곡".
  const totals =
    lang === 'ko'
      ? `재생 **${stats.plays}**회 · 들은 시간 **${hoursMinutes(stats.playedMs, lang)}** · **${stats.tracks}**곡`
      : `**${stats.plays}** ${TEXT.plays[lang]} · ${TEXT.listened[lang]} **${hoursMinutes(stats.playedMs, lang)}** · **${stats.tracks}** ${TEXT.distinct[lang]}`;
  const lines = [
    totals,
    // The last 30 days at most: a card is narrow, and longer spans are what the panel's chart is for.
    `\`${sparkline(stats.days.slice(-30))}\``,
  ];
  if (stats.topTracks.length > 0) {
    lines.push('', `**${TEXT.topTracks[lang]}**`);
    for (const [index, entry] of stats.topTracks.slice(0, 5).entries()) {
      lines.push(`${index + 1}. ${line(entry.track.title, entry.track.url, null, null, lang)} · ${entry.plays}`);
    }
  }
  if (stats.topPeople.length > 0) {
    lines.push('', `**${TEXT.topPeople[lang]}**`);
    for (const entry of stats.topPeople.slice(0, 3)) {
      lines.push(`${entry.userId ? `<@${entry.userId}>` : TEXT.nobody[lang]} · ${entry.plays}`);
    }
  }
  return embed.setDescription(lines.join('\n'));
}

/** The voice channel's sound after a change: its volume and preset. */
export function soundCard(sound: Sound, lang: Lang): EmbedBuilder {
  return note(
    lang,
    `Voice volume ${sound.volume}%, sound: ${TEXT.presets.en[sound.preset]}`,
    `음성 채널 음량 ${sound.volume}%, 음색: ${TEXT.presets.ko[sound.preset]}`,
  );
}

/** The DJ role, or that everyone may change the music, and the server's other settings under it. */
export function djCard(settings: SettingsView, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(TEXT.djRole[lang]);
  const role = settings.djRoleId === null ? TEXT.everyone[lang] : `<@&${settings.djRoleId}>\n${TEXT.onlyRole[lang]}`;
  // How the server's people share the music and how its voice channel sounds, one line each.
  const onOff = (on: boolean) => (on ? TEXT.on[lang] : TEXT.off[lang]);
  const lines = [
    `${TEXT.voteSkip[lang]}: ${onOff(settings.voteSkip)}`,
    `${TEXT.takeTurns[lang]}: ${onOff(settings.takeTurns)}`,
    `${TEXT.personLimit[lang]}: ${settings.personLimit === 0 ? TEXT.noLimit[lang] : settings.personLimit}`,
    `${TEXT.stay[lang]}: ${onOff(settings.stay)}`,
    `${TEXT.volume[lang]}: ${settings.volume}%`,
    `${TEXT.sound[lang]}: ${TEXT.presets[lang][settings.sound]}`,
  ];
  return embed.setDescription(`${role}\n\n${lines.join('\n')}`);
}

/**
 * A /wrapped choice as the time it names, for a person `offsetMinutes` east of UTC: this year ("2026"), the last 12
 * months, this month or the last ("2026-11"), or last year.
 */
export function relativePeriod(choice: string | null, offsetMinutes: number, now = Date.now()): string {
  const date = new Date(now + offsetMinutes * 60_000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const two = (value: number) => String(value).padStart(2, '0');
  if (choice === 'last-12-months') return choice;
  if (choice === 'this-month') return `${year}-${two(month)}`;
  // January's last month is the December before it.
  if (choice === 'last-month') return month === 1 ? `${year - 1}-12` : `${year}-${two(month - 1)}`;
  if (choice === 'last-year') return String(year - 1);
  return String(year);
}

// Wrapped's words, side by side as above.
const WRAPPED = {
  title: { en: (time: string) => `${time} in music`, ko: (time: string) => `${time} 음악 결산` },
  song: { en: (time: string) => `Song of ${time}`, ko: (time: string) => `${time}의 노래` },
  songFacts: {
    en: (days: number, plays: number) =>
      `played on ${days === 1 ? '1 day' : `${days} days`}, ${plays === 1 ? 'once' : `${plays} times`}`,
    ko: (days: number, plays: number) => `${days}일에 걸쳐 ${plays}번 재생`,
  },
  lastYear: { en: 'the last 12 months', ko: '최근 12개월' },
  busiestDay: { en: 'Busiest day', ko: '가장 많이 들은 요일' },
  busiestHour: { en: 'Busiest hour', ko: '가장 많이 들은 시간' },
  longestDay: { en: 'Longest day', ko: '가장 오래 들은 날' },
  firstTrack: { en: 'First track', ko: '첫 곡' },
  weekdays: {
    en: ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'],
    ko: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
  },
  kept: { en: (day: string) => `The history goes back to ${day}`, ko: (day: string) => `기록은 ${day}부터 남아 있음` },
  between: { en: 'to', ko: '~' },
} as const;

// A time's name in a sentence: "2026", "November 2026" or "the last 12 months" (Korean "2026년", "2026년 11월",
// "최근 12개월").
function timeName(period: WrappedView['period'], lang: Lang): string {
  if (period.kind === 'last-12-months') return WRAPPED.lastYear[lang];
  const [year, month] = period.key.split('-');
  if (!month) return lang === 'ko' ? `${year}년` : String(year);
  if (lang === 'ko') return `${year}년 ${Number(month)}월`;
  const name = new Date(Date.UTC(2000, Number(month) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${year}`;
}

// A day of the time as people say it ("June 24", "6월 24일"), with its year when the time spans two.
function dayName(day: string, period: WrappedView['period'], lang: Lang): string {
  const [year, month, date] = day.split('-').map(Number);
  const withYear = period.kind === 'last-12-months';
  if (lang === 'ko') return `${withYear ? `${year}년 ` : ''}${month}월 ${date}일`;
  const name = new Date(Date.UTC(2000, (month ?? 1) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${date}${withYear ? `, ${year}` : ''}`;
}

/**
 * A server's time in music: the totals, the song of the time, the top five tracks and people, and its moments (the
 * busiest day and hour, the longest day, the first track), with a key to the panel's page of it.
 */
export function wrappedCard(
  view: WrappedView,
  lang: Lang,
  guildName: string,
  panelUrl: string | null,
  offsetMinutes: number,
) {
  const time = timeName(view.period, lang);
  // The title begins with a capital in English ("The last 12 months in music").
  const title = WRAPPED.title[lang](lang === 'en' ? `${time.charAt(0).toUpperCase()}${time.slice(1)}` : time);
  const embed = new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(guildName ? `${guildName} · ${title}` : title)
    .setFooter({ text: `${view.period.from} ${WRAPPED.between[lang]} ${view.period.to}` });
  // The panel's page of the same time, where it can be saved as a picture.
  const components = panelUrl
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel(TEXT.panel[lang])
            .setStyle(ButtonStyle.Link)
            .setURL(`${panelUrl}/stats/wrapped?period=${encodeURIComponent(view.period.key)}`),
        ),
      ]
    : [];
  if (view.plays === 0) return { embeds: [embed.setDescription(TEXT.noStats[lang])], components };
  const count = (value: number) => value.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US');
  const totals =
    lang === 'ko'
      ? `재생 **${count(view.plays)}**회 · 들은 시간 **${hoursMinutes(view.playedMs, lang)}** · **${count(view.tracks)}**곡 · **${count(view.people)}**명 · 음악을 들은 날 **${count(view.days)}**일`
      : `**${count(view.plays)}** ${view.plays === 1 ? 'play' : 'plays'} · listened **${hoursMinutes(view.playedMs, lang)}** · **${count(view.tracks)}** ${view.tracks === 1 ? 'track' : 'tracks'} · **${count(view.people)}** ${view.people === 1 ? 'person' : 'people'} · music on **${count(view.days)}** ${view.days === 1 ? 'day' : 'days'}`;
  const lines = [totals];
  if (view.song) {
    const song = view.song;
    lines.push(
      '',
      `**${WRAPPED.song[lang](time)}**`,
      `${line(song.track.title, song.track.url, null, null, lang)} · ${WRAPPED.songFacts[lang](song.days, song.plays)}`,
    );
    // The song's picture as the card's: Discord fetches it from the site itself (it cannot reach jukecord's address).
    const picture = song.track.thumbnail;
    if (picture && /^https?:\/\//.test(picture)) embed.setThumbnail(picture);
  }
  lines.push('', `**${TEXT.topTracks[lang]}**`);
  for (const [index, entry] of view.topTracks.entries())
    lines.push(`${index + 1}. ${line(entry.track.title, entry.track.url, null, null, lang)} · ${count(entry.plays)}`);
  lines.push('', `**${TEXT.topPeople[lang]}**`);
  for (const [index, entry] of view.topPeople.entries())
    lines.push(`${index + 1}. ${entry.userId ? `<@${entry.userId}>` : TEXT.nobody[lang]} · ${count(entry.plays)}`);
  if (view.keptFrom) lines.push('', WRAPPED.kept[lang](view.keptFrom));
  embed.setDescription(lines.join('\n'));
  // The moments, side by side: the busiest day of the week and hour of the day (the first of the most), the longest
  // day, the first track.
  const weekday = view.weekdays.indexOf(Math.max(...view.weekdays));
  const hour = view.hours.indexOf(Math.max(...view.hours));
  embed.addFields(
    { name: WRAPPED.busiestDay[lang], value: WRAPPED.weekdays[lang][weekday] ?? '', inline: true },
    { name: WRAPPED.busiestHour[lang], value: `${hour}:00-${hour + 1}:00`, inline: true },
  );
  if (view.longestDay) {
    const day = view.longestDay;
    embed.addFields({
      name: WRAPPED.longestDay[lang],
      value: `${dayName(day.day, view.period, lang)} · ${hoursMinutes(day.playedMs, lang)}`,
      inline: true,
    });
  }
  if (view.firstPlay) {
    const first = view.firstPlay;
    // Its day where the person is, as the time's days are counted.
    const day = new Date(first.playedAt + offsetMinutes * 60_000).toISOString().slice(0, 10);
    embed.addFields({
      name: WRAPPED.firstTrack[lang],
      value: `${line(first.track.title, first.track.url, null, null, lang)} · ${dayName(day, view.period, lang)}`,
    });
  }
  return { embeds: [embed], components };
}
/** Where jukecord tells the server about trouble (app/alerts.ts), or that it tells it nowhere. */
export function alertsCard(settings: SettingsView, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(TEXT.alerts[lang]);
  if (settings.alertsChannelId === null) return embed.setDescription(TEXT.noAlerts[lang]);
  return embed.setDescription(`<#${settings.alertsChannelId}>\n${TEXT.alertsHere[lang]}`);
}

// How many characters of lyrics one page of the card holds: an embed takes 4096, and a page this long reads whole.
const LYRICS_PAGE = 1800;

/** One page of the lyrics of the track playing, the words only (no timings), with the source credited. */
export function lyricsCard(lyrics: LyricsAnswer, title: string, page: number, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(`${TEXT.lyrics[lang]} · ${title}`.slice(0, 256));
  if (lyrics.kind === 'none') return embed.setDescription(TEXT.noLyrics[lang]);
  if (lyrics.kind === 'instrumental')
    return embed.setDescription(TEXT.instrumental[lang]).setFooter({ text: TEXT.lyricsFrom[lang] });
  // Pages of whole lines: each line goes on the page it starts on, unless that page is full.
  const pages: string[] = [];
  let current = '';
  for (const line of (lyrics.text ?? '').split('\n')) {
    // A line longer than a page (it happens with words written without line breaks) is cut into pieces of a page.
    for (let at = 0; at < Math.max(1, line.length); at += LYRICS_PAGE) {
      const piece = line.slice(at, at + LYRICS_PAGE);
      if (current.length + piece.length + 1 > LYRICS_PAGE && current) {
        pages.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current.trim()) pages.push(current);
  const count = Math.max(1, pages.length);
  const shown = Math.min(Math.max(1, page), count);
  return embed
    .setDescription(pages[shown - 1]?.trim() || TEXT.noLyrics[lang])
    .setFooter({ text: `${TEXT.page[lang]} ${shown}/${count} · ${TEXT.lyricsFrom[lang]}` });
}

/** A listening link just made, with when it stops working and how many guests it takes. */
export function listenLinkCard(url: string, link: ListenLinkRow, lang: Lang): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOUR.added)
    .setTitle(TEXT.listenLink[lang])
    .setDescription(`${url}\n\n${TEXT.listenLinkHint[lang]}`)
    .setFooter({
      text: `#${link.id} · ${TEXT.guests[lang]} ${link.maxGuests}`,
    })
    .setTimestamp(link.expiresAt);
}

/** The listening links that still work: their numbers (for /share revoke), until when, their guests, who made them. */
export function listenLinksCard(links: readonly ListenLinkRow[], lang: Lang): EmbedBuilder {
  if (links.length === 0) return new EmbedBuilder().setColor(COLOUR.neutral).setDescription(TEXT.noListenLinks[lang]);
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(TEXT.listenLinks[lang])
    .setDescription(
      links
        .slice(0, 25)
        .map(
          (link) =>
            `**${link.id}** · ${TEXT.until[lang]} <t:${Math.floor(link.expiresAt / 1000)}:R> · ${TEXT.guests[lang]} ${link.guests}/${link.maxGuests} · ${link.createdBy ? `<@${link.createdBy}>` : TEXT.nobody[lang]}`,
        )
        .join('\n'),
    );
}
