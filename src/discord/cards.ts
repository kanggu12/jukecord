/**
 * What the bot writes back: short cards in the person's own language (Korean or English, from Discord's locale).
 *
 * One card per answer, with only what the action changed or showed. The colour on the left edge carries the state
 * (playing, paused, added, a problem), the one place colour means something in Discord's layout.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { PlayerSnapshot } from '../core/player.ts';
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
  nothing: { en: 'Nothing is playing', ko: '재생 중인 곡 없음' },
  queue: { en: 'Queue', ko: '대기열' },
  empty: { en: 'The queue is empty', ko: '대기열이 비어 있음' },
  history: { en: 'Recently played', ko: '최근에 들은 곡' },
  noHistory: { en: 'Nothing has been played yet', ko: '아직 들은 곡 없음' },
  playlists: { en: 'Playlists', ko: '플레이리스트' },
  noPlaylists: { en: 'No saved playlists', ko: '저장한 플레이리스트 없음' },
  addedBy: { en: 'added by', ko: '넣은 사람' },
  page: { en: 'page', ko: '쪽' },
  total: { en: 'total', ko: '모두' },
  pause: { en: 'Pause', ko: '일시정지' },
  resume: { en: 'Resume', ko: '다시재생' },
  skip: { en: 'Skip', ko: '건너뛰기' },
  panel: { en: 'Open the panel', ko: '패널 열기' },
  done: { en: 'Done', ko: '했음' },
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

/** What was added, and where it landed in the queue. */
export function addedCard(items: readonly QueueItem[], lang: Lang): EmbedBuilder {
  const first = items[0];
  const embed = new EmbedBuilder().setColor(COLOUR.added).setTitle(TEXT.added[lang](items.length));
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
  if (!snapshot.track) {
    return { embeds: [new EmbedBuilder().setColor(COLOUR.neutral).setDescription(TEXT.nothing[lang])], components: [] };
  }
  const state =
    snapshot.status === 'playing'
      ? TEXT.playingNow[lang]
      : snapshot.status === 'paused'
        ? TEXT.paused[lang]
        : TEXT.loading[lang];
  const colour =
    snapshot.status === 'playing' ? COLOUR.playing : snapshot.status === 'paused' ? COLOUR.paused : COLOUR.neutral;
  const embed = new EmbedBuilder()
    .setColor(colour)
    .setAuthor({ name: state })
    .setDescription(
      `${line(snapshot.track.title, snapshot.track.url, null, snapshot.addedBy, lang)}\n${bar(snapshot.positionMs, snapshot.durationMs)}`,
    );
  if (snapshot.track.thumbnail) embed.setThumbnail(snapshot.track.thumbnail);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(snapshot.status === 'paused' ? 'jukecord:resume' : 'jukecord:pause')
      .setLabel(snapshot.status === 'paused' ? TEXT.resume[lang] : TEXT.pause[lang])
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('jukecord:skip').setLabel(TEXT.skip[lang]).setStyle(ButtonStyle.Secondary),
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
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle(`${TEXT.queue[lang]} (${items.length})`)
    .setDescription(
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
    .setDescription(playlists.map((playlist) => `**${playlist.name}** · ${playlist.size}`).join('\n'));
}

/** "Done" in the person's language. */
export function done(lang: Lang): EmbedBuilder {
  return note(lang, TEXT.done.en, TEXT.done.ko);
}
