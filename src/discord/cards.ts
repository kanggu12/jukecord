/**
 * What the bot writes back: short cards in the person's own language (Korean or English, from Discord's locale).
 *
 * One card per answer, with only what the action changed or showed. The colour on the left edge carries the state
 * (playing, paused, added, a problem), the one place colour means something in Discord's layout.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { AddResult, SettingsView, StatsView } from '../app/actions.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import { sayNotice } from '../core/say.ts';
import type { HistoryEntry, Playlist, QueueItem } from '../core/types.ts';
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

/** The current track with a progress bar, and buttons to pause or skip. */
export function nowCard(snapshot: PlayerSnapshot, lang: Lang, panelUrl: string | null) {
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
  // The repeat mode, when one is on, under the bar.
  if (snapshot.repeat !== 'off')
    embed.setFooter({ text: snapshot.repeat === 'track' ? TEXT.repeatTrack[lang] : TEXT.repeatQueue[lang] });
  // The card's language travels in the buttons, so a press redraws the card in the language it was made in, not the
  // presser's (a card in the channel is everyone's).
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`jukecord:${snapshot.status === 'paused' ? 'resume' : 'pause'}:${lang}`)
      .setLabel(snapshot.status === 'paused' ? TEXT.resume[lang] : TEXT.pause[lang])
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`jukecord:skip:${lang}`).setLabel(TEXT.skip[lang]).setStyle(ButtonStyle.Secondary),
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

/** The DJ role, or that everyone may change the music. */
export function djCard(settings: SettingsView, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(TEXT.djRole[lang]);
  if (settings.djRoleId === null) return embed.setDescription(TEXT.everyone[lang]);
  return embed.setDescription(`<@&${settings.djRoleId}>\n${TEXT.onlyRole[lang]}`);
}

/** Where jukecord tells the server about trouble (app/alerts.ts), or that it tells it nowhere. */
export function alertsCard(settings: SettingsView, lang: Lang): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOUR.neutral).setTitle(TEXT.alerts[lang]);
  if (settings.alertsChannelId === null) return embed.setDescription(TEXT.noAlerts[lang]);
  return embed.setDescription(`<#${settings.alertsChannelId}>\n${TEXT.alertsHere[lang]}`);
}
