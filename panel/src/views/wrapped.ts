/**
 * Wrapped: a server's year in music (or a month, or the last 12 months), a page under the statistics. The song of the
 * time on its record, the first track, the totals, the most played tracks and who added most, and the moments: the
 * busiest day of the week and hour of the day, the longest day, the days with music. "Save as picture" draws it into
 * a PNG to share (picture.ts).
 *
 * The time is in the page's address (/stats/wrapped?period=2026-03), so a link (the Discord card's) opens that time;
 * choosing another puts it there too, and Back goes to the one before.
 */
import { api, coverUrl, type Guild, type Wrapped } from '../api.ts';
import { avatarUrl, cssUrl, face, fill, guildIconUrl, h, icon, subLine } from '../dom.ts';
import { state, t, watch } from '../state.ts';
import { goTo, problem, showDialog } from '../ui/layers.ts';
import { listened } from './pages.ts';
import { drawPicture, type PictureContent, type Shape } from './picture.ts';
import { album } from './player.ts';

/** A time's name inside a sentence, in the panel's language: "2026", "November 2026", "the last 12 months". */
export function timeName(period: Wrapped['period']): string {
  const words = t();
  if (period.kind === 'last-12-months') return words.wrappedTwelve;
  const [year = '', month] = period.key.split('-');
  return month ? words.wrappedMonth(year, Number(month)) : words.wrappedYear(year);
}

/** A day of the time as people say it ("June 24", "6월 24일"), with its year when the time spans two. */
export function dayName(day: string, period: Wrapped['period']): string {
  const [year = '', month, date] = day.split('-');
  return t().dayOf(Number(month), Number(date), period.kind === 'last-12-months' ? year : null);
}

/** A count as people read it: "1,806" ("1,806" in Korean too). */
export function count(value: number): string {
  return value.toLocaleString(state.lang === 'ko' ? 'ko-KR' : 'en-US');
}

/** The busiest of a list of counts (the first of the most), or -1 when all are zero. */
export function busiest(values: readonly number[]): number {
  const top = Math.max(0, ...values);
  return top > 0 ? values.indexOf(top) : -1;
}

// The time asked for in the page's address, when there is one.
function periodInAddress(): string | undefined {
  const asked = new URLSearchParams(location.search).get('period');
  return asked && /^(\d{4}|\d{4}-\d{2}|last-12-months)$/.test(asked) ? asked : undefined;
}

// A small chart of counts (plays by day of the week, by hour), the busiest column in full colour. It is a picture of
// the numbers, named whole for screen readers ("Plays by day of the week: Sunday 12, ..."); the busiest is said in
// words beside it.
function spark(values: readonly number[], labels: readonly string[], name: string): HTMLElement {
  const top = Math.max(1, ...values);
  const most = busiest(values);
  return h(
    'div',
    {
      class: 'spark',
      role: 'img',
      'aria-label': `${name}: ${values.map((value, index) => `${labels[index]} ${value}`).join(', ')}`,
    },
    ...values.map((value, index) =>
      h('i', {
        class: index === most ? 'top' : value === 0 ? 'zero' : '',
        style: `height:${Math.max(4, (value / top) * 100)}%`,
      }),
    ),
  );
}

/** The page. */
export function wrappedPage(): HTMLElement {
  let period = periodInAddress();
  let shown: Wrapped | null = null;
  const title = h('h1');
  const range = h('span', { class: 'faint num wrapped-range' });
  // Back to the statistics: the page this one is under (a link the panel follows without reloading).
  const back = h('a', { class: 'key quiet back-key', href: '/stats', 'data-route': 'stats' });
  const periodKey = h('button', { class: 'key period-key', type: 'button', 'data-act': 'period' });
  const save = h('button', { class: 'key primary', type: 'button', 'data-act': 'picture' });
  const content = h('div', { class: 'page-body wrapped-body' });
  // The page's own main landmark (the player's is hidden while this one shows).
  const page = h(
    'main',
    { class: 'page wrapped' },
    h(
      'div',
      { class: 'page-head' },
      back,
      h('div', { class: 'wrapped-heading' }, title, range),
      h('div', { class: 'page-tools' }, periodKey, save),
    ),
    content,
  );

  // The head's words, which follow the language and the time shown.
  const drawHead = () => {
    const words = t();
    fill(back, icon('chevron-left'), h('span', { class: 'label' }, words.stats));
    back.title = words.stats;
    const time = shown ? timeName(shown.period) : '';
    title.textContent = shown ? words.wrappedTitle(time) : words.wrapped;
    range.textContent = shown ? words.wrappedRange(shown.period.from, shown.period.to) : '';
    // The key says the time shown, and what it chooses (for screen readers, which hear its name).
    const label = shown
      ? `${time.charAt(0).toUpperCase()}${time.slice(1)}`
      : (period ?? String(new Date().getFullYear()));
    fill(periodKey, icon('calendar'), h('span', { class: 'label' }, label), icon('chevron-down'));
    periodKey.setAttribute('aria-label', `${words.wrappedPeriods}: ${label}`);
    periodKey.disabled = !shown;
    fill(save, icon('image-down'), h('span', { class: 'label' }, words.savePicture));
    save.title = words.savePicture;
    save.disabled = !shown || shown.plays === 0;
  };

  const draw = (wrapped: Wrapped) => {
    const words = t();
    const time = timeName(wrapped.period);
    if (wrapped.plays === 0) {
      fill(content, h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('gift'), words.statsEmpty)));
      return;
    }
    const [hours, rest] = listened(wrapped.playedMs);
    // The song of the time, on its record: the cover in its case with the record half out of it, as a row's album,
    // made big; the cover's colours glow behind it, as behind the turning disc.
    const song = wrapped.song;
    const songCard = song
      ? h(
          'section',
          { class: 'card wrapped-song', 'aria-labelledby': 'wrapped-song-h' },
          h('div', { class: 'card-head' }, h('h2', { id: 'wrapped-song-h' }, words.wrappedSong(time))),
          h(
            'div',
            { class: 'song' },
            record(wrapped),
            h(
              'div',
              { class: 'info' },
              h(
                'h3',
                { class: 'title' },
                h('a', { href: song.track.url, target: '_blank', rel: 'noopener noreferrer' }, song.track.title),
              ),
              song.track.uploader ? h('div', { class: 'meta' }, song.track.uploader) : null,
              h('div', { class: 'facts' }, words.songFacts(song.days, song.plays)),
            ),
          ),
        )
      : null;
    // The first track of the time: what it began with, and when.
    const first = wrapped.firstTrack;
    const firstCard = first
      ? h(
          'section',
          { class: 'card wrapped-first', 'aria-labelledby': 'wrapped-first-h' },
          h('div', { class: 'card-head' }, h('h2', { id: 'wrapped-first-h' }, words.firstTrack)),
          h(
            'ol',
            { class: 'list' },
            h(
              'li',
              { class: 'row', dataset: { id: `first-${first.track.id}` } },
              album(first.track),
              h(
                'div',
                { class: 'text' },
                h(
                  'div',
                  { class: 'name' },
                  h('a', { href: first.track.url, target: '_blank', rel: 'noopener noreferrer' }, first.track.title),
                ),
                subLine(
                  h('span', null, firstWhen(first.playedAt, wrapped.period)),
                  // Who added it: a person, the host, or autoplay (which played it when the queue ran out).
                  h(
                    'span',
                    null,
                    first.addedBy === 'autoplay'
                      ? words.byAutoplay
                      : first.addedBy
                        ? words.addedBy(first.addedByName ?? first.addedBy)
                        : words.byHost,
                  ),
                ),
              ),
            ),
          ),
        )
      : null;
    // The totals, as the statistics show them.
    const tiles = h(
      'div',
      { class: 'tiles' },
      ...(
        [
          [words.tilePlays, count(wrapped.plays), ''],
          [words.tileListened, hours, rest],
          [words.tileTracks, count(wrapped.tracks), ''],
          [words.tilePeople, count(wrapped.people), ''],
        ] as const
      ).map(([label, value, unit]) =>
        h(
          'div',
          { class: 'card tile' },
          h('div', { class: 'k' }, label),
          h('div', { class: 'v' }, value, unit ? h('small', null, unit) : null),
        ),
      ),
    );
    // The most played, each on its album, with its plays.
    const topTracks = h(
      'ol',
      { class: 'list wrapped-tracks' },
      ...wrapped.topTracks.map((entry, index) =>
        h(
          'li',
          { class: 'row', dataset: { id: `top-${entry.track.id}` } },
          h('span', { class: 'pos' }, index + 1),
          album(entry.track),
          h(
            'div',
            { class: 'text' },
            h(
              'div',
              { class: 'name' },
              h('a', { href: entry.track.url, target: '_blank', rel: 'noopener noreferrer' }, entry.track.title),
            ),
            entry.track.uploader ? subLine(h('span', null, entry.track.uploader)) : null,
          ),
          h('span', { class: 'n' }, words.playsCount(entry.plays)),
        ),
      ),
    );
    // Who added most: faces and meters, as on the statistics.
    const most = Math.max(1, ...wrapped.topPeople.map((entry) => entry.plays));
    const topPeople = h(
      'ol',
      { class: 'ranks' },
      ...wrapped.topPeople.map((entry, index) =>
        h(
          'li',
          { class: 'rank' },
          h('span', { class: 'faint num' }, index + 1),
          h(
            'span',
            { class: 'who' },
            // The host has no picture; its initial is "H", not the initials of the words "the host".
            face(entry.name ?? 'Host', avatarUrl(entry.userId, entry.avatar), 'sm'),
            entry.name ?? words.theHost,
          ),
          h('span', { class: 'n' }, count(entry.plays)),
          h(
            'span',
            { class: 'meter', 'aria-hidden': 'true' },
            h('i', { style: `width:${(entry.plays / most) * 100}%` }),
          ),
        ),
      ),
    );
    // The moments: the busiest day of the week and hour of the day with their small charts, the longest day, and the
    // days with music.
    const day = busiest(wrapped.weekdays);
    const hour = busiest(wrapped.hours);
    const longest = wrapped.longestDay;
    const moment = (label: string, value: string, sub: string | null, chart: HTMLElement | null) =>
      h(
        'div',
        { class: 'card tile moment' },
        h('div', { class: 'k' }, label),
        h('div', { class: 'v' }, value),
        sub ? h('div', { class: 'sub' }, sub) : null,
        chart,
      );
    const moments = h(
      'div',
      { class: 'tiles moments' },
      moment(
        words.busiestDay,
        words.weekdaysMany[day] ?? '',
        words.playsCount(wrapped.weekdays[day] ?? 0),
        spark(wrapped.weekdays, words.weekdays, words.byWeekday),
      ),
      moment(
        words.busiestHour,
        `${hour}:00`,
        words.playsCount(wrapped.hours[hour] ?? 0),
        spark(
          wrapped.hours,
          wrapped.hours.map((_, index) => `${index}:00`),
          words.byHour,
        ),
      ),
      longest
        ? moment(
            words.longestDay,
            dayName(longest.day, wrapped.period),
            `${listenedWords(longest.playedMs)} · ${words.playsCount(longest.plays)}`,
            null,
          )
        : null,
      moment(words.tileDays, `${count(wrapped.days)}${state.lang === 'ko' ? words.daysUnit : ''}`, null, null),
    );
    fill(
      content,
      // The history reaches back only so far: said once, at the top.
      wrapped.keptFrom
        ? h('p', { class: 'faint wrapped-kept' }, words.keptFrom(wrapped.keptFrom, count(10_000)))
        : null,
      h('div', { class: 'wrapped-hero' }, songCard, firstCard),
      tiles,
      h(
        'div',
        { class: 'charts wrapped-tops' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, words.mostPlayed)), topTracks),
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, words.addedMost)),
          h('div', { class: 'chart' }, topPeople),
        ),
      ),
      moments,
    );
  };

  // Each request is numbered: only the latest one draws (choosing two times quickly shows the second).
  let asked = 0;
  const load = async () => {
    const guild = state.guild?.id;
    if (!guild) return;
    asked += 1;
    const mine = asked;
    try {
      const wrapped = await api.wrapped(guild, period);
      if (mine !== asked) return;
      shown = wrapped;
      drawHead();
      draw(wrapped);
    } catch (error) {
      if (mine === asked) problem(error);
    }
  };

  // The times there are, newest first: this year, the last 12 months, the other years, then each month with plays.
  periodKey.onclick = () => {
    if (!shown) return;
    const words = t();
    const thisYear = String(new Date().getFullYear());
    const choices: [string, string][] = [
      [thisYear, words.wrappedThisYear(words.wrappedYear(thisYear))],
      ['last-12-months', capital(words.wrappedTwelve)],
      ...shown.years
        .filter((year) => year !== thisYear)
        .map((year): [string, string] => [year, words.wrappedYear(year)]),
      ...shown.months.map((month): [string, string] => {
        const [year = '', number] = month.split('-');
        return [month, words.wrappedMonth(year, Number(number))];
      }),
    ];
    const list = h('div', { class: 'menu-list' });
    const dialog = showDialog(words.wrappedPeriods, list);
    const current = shown.period.key;
    fill(
      list,
      ...choices.map(([key, label]) => {
        const button = h(
          'button',
          {
            class: 'choice',
            type: 'button',
            'aria-current': key === current ? 'true' : 'false',
            dataset: { period: key },
          },
          h('span', { class: 'grow' }, label),
          icon('check', 'check'),
        );
        button.onclick = () => {
          dialog.close();
          if (key === current) return;
          period = key;
          // The address says the time shown: a reload or a link opens it, and Back goes to the one before.
          goTo(`/stats/wrapped?period=${encodeURIComponent(key)}`);
          void load();
        };
        return button;
      }),
    );
  };
  save.onclick = () => {
    if (shown && shown.plays > 0) pictureDialog(shown);
  };

  drawHead();
  void load();
  watch(['guild'], () => void load());
  watch(['lang'], () => {
    drawHead();
    if (shown) draw(shown);
  });
  return page;
}

// "The last 12 months", as a choice of its own.
function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// Time listened in words: "1 h 5 min" ("1시간 5분").
function listenedWords(ms: number): string {
  const [big, rest] = listened(ms);
  return state.lang === 'ko' ? `${big}${rest}` : `${big} ${rest}`;
}

// When the first track played: its day of the time and its time of day, in this browser's time zone.
function firstWhen(at: number, period: Wrapped['period']): string {
  const when = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  const day = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
  return `${dayName(day, period)} ${two(when.getHours())}:${two(when.getMinutes())}`;
}

// The song of the time on its record: its album made big (the cover in its case, the record half out of it with the
// cover on its label), and the cover's colours glowing behind.
function record(wrapped: Wrapped): HTMLElement {
  const song = wrapped.song;
  const box = h('div', { class: 'record', 'aria-hidden': 'true' }, song ? album(song.track) : null);
  const cover = song && state.guild ? coverUrl(state.guild.id, song.track) : null;
  if (cover) box.style.setProperty('--glow', cssUrl(cover));
  return box;
}

// The picture to share: its shape (a story or a square), drawn here, and saved (or shared, where the system can).
function pictureDialog(wrapped: Wrapped): void {
  const words = t();
  const guild = state.guild;
  if (!guild) return;
  let shape: Shape = 'story';
  let blob: Blob | null = null;
  let address: string | null = null;
  const shapes = h('div', { class: 'seg', role: 'group', 'aria-label': words.pictureShape });
  // The picture is shown as it was drawn, the canvas itself (the page's rules allow no blob: pictures), named for
  // screen readers as a picture.
  const frame = h('div', { class: 'picture-frame' });
  const status = h('p', { class: 'picture-status', role: 'status' });
  const save = h('button', { class: 'key primary', type: 'button', 'data-act': 'save-picture' });
  fill(save, icon('image-down'), words.save);
  // Sharing a file is offered where the system can take one (phones, mostly): the picture goes to its share sheet.
  const probe = typeof File === 'function' ? new File([new Uint8Array(1)], 'x.png', { type: 'image/png' }) : null;
  const canShare = Boolean(probe && navigator.canShare?.({ files: [probe] }));
  const share = canShare ? h('button', { class: 'key', type: 'button', 'data-act': 'share-picture' }) : null;
  if (share) fill(share, icon('share-2'), words.share);
  const dialog = showDialog(words.savePicture, h('div', { class: 'picture' }, shapes, frame, status), [
    ...(share ? [share] : []),
    save,
  ]);
  const name = () => `jukecord-${wrapped.period.key}-${shape}.png`;
  // Draws the picture in the shape chosen; a newer drawing replaces an older one still under way.
  let drawing = 0;
  const draw = async () => {
    drawing += 1;
    const mine = drawing;
    save.disabled = true;
    if (share) share.disabled = true;
    fill(frame);
    status.hidden = false;
    fill(status, icon('loader-circle', 'spin'), words.drawing);
    try {
      const canvas = await drawPicture(pictureContent(wrapped, guild), shape);
      const made = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (mine !== drawing) return;
      if (!made) throw new Error('no picture');
      blob = made;
      if (address) URL.revokeObjectURL(address);
      address = URL.createObjectURL(made);
      canvas.className = `picture-preview ${shape}`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', words.pictureAlt(words.wrappedTitle(timeName(wrapped.period)), guild.name));
      fill(frame, canvas);
      status.hidden = true;
      save.disabled = false;
      if (share) share.disabled = false;
    } catch {
      if (mine === drawing) fill(status, icon('circle-alert'), words.notDrawn);
    }
  };
  for (const [value, label] of [
    ['story', words.story],
    ['square', words.square],
  ] as const) {
    const button = h('button', { type: 'button', 'aria-pressed': String(value === shape) }, label);
    button.onclick = () => {
      if (shape === value) return;
      shape = value;
      for (const other of shapes.children) other.setAttribute('aria-pressed', String(other === button));
      void draw();
    };
    shapes.append(button);
  }
  save.onclick = () => {
    if (!address) return;
    // A link to the drawn picture, pressed: the browser saves it under its name.
    const link = h('a', { href: address, download: name() });
    document.body.append(link);
    link.click();
    link.remove();
  };
  if (share) {
    share.onclick = () => {
      if (!blob) return;
      const file = new File([blob], name(), { type: 'image/png' });
      // Closed without sharing is the person's choice, not a problem to report.
      navigator.share({ files: [file], title: words.wrappedTitle(timeName(wrapped.period)) }).catch(() => {});
    };
  }
  // The drawn picture is let go with the dialog.
  void dialog.done.then(() => {
    drawing += 1;
    if (address) URL.revokeObjectURL(address);
  });
  void draw();
}

// What the picture says, in the panel's language: the server, the time, the song, the totals, the most played, the
// moments and who added most.
function pictureContent(wrapped: Wrapped, guild: Guild): PictureContent {
  const words = t();
  const time = timeName(wrapped.period);
  const [year = '', month] = wrapped.period.key.split('-');
  // The time, big: the year, the month's name, or the last 12 months; the words beside it name the rest.
  const big =
    wrapped.period.kind === 'last-12-months' ? words.twelveMonths : month ? words.monthName(Number(month)) : year;
  const sub = words.inMusic(wrapped.period.kind === 'month' ? year : null);
  const [hours, rest] = listened(wrapped.playedMs);
  const day = busiest(wrapped.weekdays);
  const hour = busiest(wrapped.hours);
  const song = wrapped.song;
  return {
    lang: state.lang,
    server: { name: guild.name, icon: guildIconUrl(guild.id, guild.icon, 128) },
    big,
    sub,
    title: words.wrappedTitle(time),
    range: words.wrappedRange(wrapped.period.from, wrapped.period.to),
    song: song
      ? {
          label: words.wrappedSong(time),
          title: song.track.title,
          artist: song.track.uploader,
          facts: words.songFacts(song.days, song.plays),
          factsApart: words.songFactsApart(song.days, song.plays),
          cover: coverUrl(guild.id, song.track),
        }
      : null,
    numbers: [
      { label: words.tilePlays, value: count(wrapped.plays), unit: '' },
      { label: words.tileListened, value: hours, unit: rest },
      { label: words.tileTracks, value: count(wrapped.tracks), unit: '' },
      { label: words.tileDays, value: count(wrapped.days), unit: state.lang === 'ko' ? words.daysUnit : '' },
    ],
    tracksLabel: words.mostPlayed,
    tracks: wrapped.topTracks.map((entry) => ({
      title: entry.track.title,
      plays: count(entry.plays),
      cover: coverUrl(guild.id, entry.track),
    })),
    moments: [
      { label: words.busiestDay, value: words.weekdaysMany[day] ?? '' },
      { label: words.busiestHour, value: `${hour}:00-${hour + 1}:00` },
      ...(wrapped.longestDay
        ? [
            {
              label: words.longestDay,
              // Without its year: the days at the foot give it, and twelve months hold each date once.
              value: `${dayName(wrapped.longestDay.day, { ...wrapped.period, kind: 'year' })} · ${listenedWords(wrapped.longestDay.playedMs)}`,
            },
          ]
        : []),
    ],
    peopleLabel: words.addedMost,
    people: wrapped.topPeople.slice(0, 3).map((entry) => ({
      // The host has no picture and no Discord name: "Host" in the panel's words.
      name: entry.name ?? words.theHost,
      picture: avatarUrl(entry.userId, entry.avatar, 128),
      plays: count(entry.plays),
    })),
  };
}
