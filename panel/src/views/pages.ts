/**
 * The other pages: listening statistics, the log (for the host), and the login page.
 *
 * The charts follow one set of rules: columns at most 24px wide, rounded at the data end and square on the baseline,
 * 2px apart, one colour for the one measure (plays), checked for contrast on both themes; the whole column is the
 * hover and focus target, every value is in the tooltip and in the table view, and text never takes the bar colour.
 */
import { api, type LogRecord, type Stats, type Status } from '../api.ts';
import { avatarUrl, clock, face, fill, h, icon } from '../dom.ts';
import { logoMark } from '../logo.ts';
import { state, t, watch } from '../state.ts';
import { problem } from '../ui/layers.ts';

// Hours and minutes as people say them ("12 h 5 min", "45 min").
function listened(ms: number): [string, string] {
  const words = t();
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  // "5 h 38 min" in English, "5시간 38분" in Korean: the number big, the rest beside it.
  const rest =
    state.lang === 'ko'
      ? `${words.hoursShort} ${minutes % 60}${words.minutesShort}`
      : `${words.hoursShort} ${minutes % 60} ${words.minutesShort}`;
  return hours > 0 ? [String(hours), rest] : [String(minutes), words.minutesShort];
}

// "11-07" from "2026-11-07", in the order people of each language read dates.
function shortDay(day: string): string {
  const [, month, date] = day.split('-');
  return state.lang === 'ko' ? `${Number(month)}.${Number(date)}` : `${month}-${date}`;
}

// Clean axis ticks: the top is the maximum rounded up to a tidy number.
function niceTop(max: number): number {
  if (max <= 4) return Math.max(1, max);
  const step = 10 ** Math.floor(Math.log10(max));
  for (const factor of [1, 2, 2.5, 5, 10]) if (factor * step >= max) return factor * step;
  return 10 * step;
}

// A column chart with a y axis, a tooltip on each column and a table view.
function columns(
  values: { label: string; tip: string; value: number }[],
  axis: string[],
  tableHead: [string, string],
): { plot: HTMLElement; table: HTMLElement } {
  const top = niceTop(Math.max(0, ...values.map((entry) => entry.value)));
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const bars = h('div', { class: 'bars', role: 'list' });
  for (const entry of values) {
    const slot = h(
      'div',
      {
        class: `slot ${entry.value === 0 ? 'zero' : ''}`.trim(),
        tabindex: '0',
        role: 'listitem',
        'aria-label': `${entry.label}: ${entry.value}`,
      },
      h('div', { class: 'b', style: `height:${(entry.value / top) * 100}%` }),
    );
    const show = () => {
      tip.hidden = false;
      fill(tip, h('b', { class: 'value' }, String(entry.value)), entry.tip);
      // Above the column, kept inside the chart so it never crosses the card's edge.
      const box = slot.getBoundingClientRect();
      const frame = plot.getBoundingClientRect();
      const half = tip.offsetWidth / 2;
      const x = Math.min(frame.width - half, Math.max(half, box.left - frame.left + box.width / 2));
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(tip.offsetHeight, box.top - frame.top + box.height * (1 - entry.value / top) - 6)}px`;
    };
    slot.onpointerenter = show;
    slot.onfocus = show;
    slot.onpointerleave = () => (tip.hidden = true);
    slot.onblur = () => (tip.hidden = true);
    bars.append(slot);
  }
  const plot = h(
    'div',
    { class: 'plot' },
    h(
      'div',
      { class: 'yaxis', 'aria-hidden': 'true' },
      h('span', null, String(top)),
      h('span', null, String(top / 2)),
      h('span', null, '0'),
    ),
    h(
      'div',
      null,
      bars,
      h('div', { class: 'axis', 'aria-hidden': 'true' }, ...axis.map((label) => h('span', null, label))),
    ),
    tip,
  );
  const table = h(
    'table',
    { class: 'chart-table' },
    h('thead', null, h('tr', null, h('th', null, tableHead[0]), h('th', null, tableHead[1]))),
    h(
      'tbody',
      null,
      ...values.map((entry) => h('tr', null, h('td', null, entry.label), h('td', { class: 'n' }, String(entry.value)))),
    ),
  );
  return { plot, table };
}

// A chart card with a key that switches between the chart and its table.
function chartCard(title: string, chart: { plot: HTMLElement; table: HTMLElement }): HTMLElement {
  const body = h('div', { class: 'chart' }, chart.plot);
  const words = t();
  // Labelled in every chart (style.css keeps the label even in narrow cards), with the same icon.
  const table = h(
    'button',
    { class: 'key sm quiet table-key', type: 'button', 'aria-pressed': 'false' },
    icon('table'),
    h('span', { class: 'label' }, words.table),
  );
  table.title = words.tableHint;
  table.onclick = () => {
    const showing = table.getAttribute('aria-pressed') === 'true';
    table.setAttribute('aria-pressed', String(!showing));
    fill(body, showing ? chart.plot : chart.table);
  };
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, title), h('div', { class: 'tools' }, table)),
    body,
  );
}

/** Listening statistics of the server shown. */
export function statsPage(): HTMLElement {
  let days = 30;
  const content = h('div', { class: 'page-body', style: 'display:flex;flex-direction:column;gap:var(--gap)' });
  const range = h('div', { class: 'seg', role: 'group' });
  const title = h('h1');
  // The page's own main landmark (the player's is hidden while this one shows).
  const page = h(
    'main',
    { class: 'page' },
    h('div', { class: 'page-head' }, title, h('div', { class: 'page-tools' }, range)),
    content,
  );

  const drawRange = () => {
    const words = t();
    title.textContent = words.stats;
    fill(
      range,
      ...(
        [
          [7, words.days7],
          [30, words.days30],
          [90, words.days90],
          [365, words.days365],
        ] as const
      ).map(([value, label]) => {
        const button = h('button', { type: 'button', 'aria-pressed': String(value === days) }, label);
        button.onclick = () => {
          days = value;
          drawRange();
          void load();
        };
        return button;
      }),
    );
  };

  const draw = (stats: Stats) => {
    const words = t();
    const [hours, rest] = listened(stats.playedMs);
    const tiles = h(
      'div',
      { class: 'tiles' },
      ...(
        [
          [words.tilePlays, String(stats.plays), ''],
          [words.tileListened, hours, rest],
          [words.tileTracks, String(stats.tracks), ''],
          [words.tilePeople, String(stats.people), ''],
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
    if (stats.plays === 0) {
      fill(
        content,
        tiles,
        h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('chart-column'), words.statsEmpty)),
      );
      return;
    }
    // Per day, or per week over a year (365 bars would be hairlines): labels at the start, the middle and the end.
    const span = days >= 365 ? 7 : 1;
    const buckets: { first: string; last: string; plays: number; playedMs: number }[] = [];
    // Counted back from today, so the newest bar is a whole week and a short one, if any, is the oldest.
    for (let end = stats.days.length; end > 0; end -= span) {
      const chunk = stats.days.slice(Math.max(0, end - span), end);
      buckets.unshift({
        first: chunk[0]?.day ?? '',
        last: chunk.at(-1)?.day ?? '',
        plays: chunk.reduce((sum, day) => sum + day.plays, 0),
        playedMs: chunk.reduce((sum, day) => sum + day.playedMs, 0),
      });
    }
    // A week is written as a range that cannot be read as one date ("11-05 – 11-11", Korean "11.5~11.11"): short in
    // the tooltip, with the year in the table and for screen readers (a year of weeks has two of each month and day).
    const range = (bucket: (typeof buckets)[number], write: (day: string) => string) =>
      span > 1 && bucket.first !== bucket.last
        ? `${write(bucket.first)}${state.lang === 'ko' ? '~' : ' – '}${write(bucket.last)}`
        : write(bucket.first);
    const dayValues = buckets.map((bucket) => ({
      label: range(bucket, (day) => day),
      tip: `${range(bucket, shortDay)} · ${clock(bucket.playedMs)}`,
      value: bucket.plays,
    }));
    const middle = buckets[Math.floor(buckets.length / 2)]?.first ?? '';
    const perDayTitle = span > 1 ? words.perWeek : words.perDay;
    const perDay = columns(
      dayValues,
      [shortDay(buckets[0]?.first ?? ''), shortDay(middle), shortDay(buckets.at(-1)?.first ?? '')],
      [perDayTitle, words.playsUnit],
    );
    const hourValues = stats.hours.map((value, hour) => ({
      label: `${hour}:00`,
      tip: `${hour}:00-${hour + 1}:00`,
      value,
    }));
    const perHour = columns(hourValues, ['0', '6', '12', '18', '23'], [words.perHour, words.playsUnit]);
    // Ranked lists with a meter each, longest first; the count beside the name, in text colours.
    const topPlays = Math.max(1, ...stats.topTracks.map((entry) => entry.plays));
    const tracks = h(
      'ol',
      { class: 'ranks' },
      ...stats.topTracks.map((entry, index) =>
        h(
          'li',
          { class: 'rank' },
          h('span', { class: 'faint num' }, index + 1),
          h(
            'a',
            {
              href: entry.track.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: 'text-decoration:none;min-width:0',
            },
            entry.track.title,
          ),
          h('span', { class: 'n' }, entry.plays),
          h(
            'span',
            { class: 'meter', 'aria-hidden': 'true' },
            h('i', { style: `width:${(entry.plays / topPlays) * 100}%` }),
          ),
        ),
      ),
    );
    const topPeople = Math.max(1, ...stats.topPeople.map((entry) => entry.plays));
    const people = h(
      'ol',
      { class: 'ranks' },
      ...stats.topPeople.map((entry, index) =>
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
          h('span', { class: 'n' }, entry.plays),
          h(
            'span',
            { class: 'meter', 'aria-hidden': 'true' },
            h('i', { style: `width:${(entry.plays / topPeople) * 100}%` }),
          ),
        ),
      ),
    );
    fill(
      content,
      tiles,
      h('div', { class: 'charts' }, chartCard(perDayTitle, perDay), chartCard(words.perHour, perHour)),
      h(
        'div',
        { class: 'charts' },
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, words.mostPlayed)),
          h('div', { class: 'chart' }, tracks),
        ),
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, words.addedMost)),
          h('div', { class: 'chart' }, people),
        ),
      ),
    );
  };

  // Each request is numbered: only the latest one draws (pressing "A year" then "7 days" shows the 7 days).
  let asked = 0;
  const load = async () => {
    const guild = state.guild?.id;
    if (!guild) return;
    asked += 1;
    const mine = asked;
    try {
      const stats = await api.stats(guild, days);
      if (mine === asked) draw(stats);
    } catch (error) {
      if (mine === asked) problem(error);
    }
  };
  drawRange();
  void load();
  watch(['guild'], () => void load());
  watch(['lang'], () => {
    drawRange();
    void load();
  });
  return page;
}

/** The log, newest at the bottom, with filters; for the host. */
export function logsPage(): HTMLElement {
  let level = 'info';
  let records: LogRecord[] = [];
  const title = h('h1');
  const levels = h('div', { class: 'seg', role: 'group' });
  const component = h('input', { type: 'search', autocomplete: 'off' });
  const refresh = h('button', { class: 'key', type: 'button' });
  const older = h('button', { class: 'key', type: 'button' });
  // A named region the keyboard can enter, so the records can be scrolled without a mouse.
  const list = h('div', { class: 'logs scroll', style: 'flex:1;min-height:0', role: 'region', tabindex: '0' });
  // Older records go above the ones shown, so the key that brings them sits at the top of the list (its row is hidden
  // when there is nothing older).
  const olderHead = h('div', { class: 'card-head log-older', hidden: true }, older);
  const card = h('section', { class: 'card fill' }, olderHead, list);
  // The page's own main landmark (the player's is hidden while this one shows).
  const page = h(
    'main',
    { class: 'page', style: 'height:calc(100dvh - var(--bar-h) - var(--listen-h))' },
    h(
      'div',
      { class: 'page-head' },
      title,
      h(
        'div',
        { class: 'page-tools' },
        levels,
        h('label', { class: 'field log-filter' }, icon('search'), component),
        refresh,
      ),
    ),
    card,
  );

  const row = (record: LogRecord) => {
    const tone = { debug: 'idle', info: 'load', warn: 'pause', error: 'bad' }[record.level];
    const words = t();
    // The level in the panel's words; debug has none of its own.
    const levelName = { debug: 'debug', info: words.levelInfo, warn: words.levelWarn, error: words.levelError }[
      record.level
    ];
    const fields = Object.entries(record.fields)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    return h(
      'div',
      { class: 'log' },
      // Times in the panel's language, whatever the browser's.
      h('span', { class: 'faint' }, new Date(record.time).toLocaleString(state.lang === 'ko' ? 'ko-KR' : 'en-GB')),
      h('span', null, h('span', { class: `badge tone-${tone}` }, levelName)),
      h('span', { class: 'muted' }, record.component),
      h('span', null, record.msg, fields ? h('span', { class: 'fields' }, ` ${fields}`) : null),
    );
  };
  const drawList = () => {
    if (records.length === 0) fill(list, h('div', { class: 'empty' }, icon('scroll-text'), t().noLogs));
    else fill(list, ...records.map(row));
  };
  // Each request is numbered: only the latest one draws (typing in the filter sends one per pause, and an older,
  // slower answer must not replace the list for what is typed now).
  let asked = 0;
  const load = async (before?: string) => {
    asked += 1;
    const mine = asked;
    try {
      const page = await api.logs({
        level,
        component: component.value.trim(),
        limit: 200,
        ...(before ? { before } : {}),
      });
      if (mine !== asked) return;
      // Older records go on top; the ones being read stay where they were on the screen.
      const fromBottom = list.scrollHeight - list.scrollTop;
      records = before ? [...page, ...records] : page;
      // A page shorter than asked for was the last one: there is nothing older to bring.
      olderHead.hidden = page.length < 200 || records.length === 0;
      drawList();
      list.scrollTop = before ? list.scrollHeight - fromBottom : list.scrollHeight;
    } catch (error) {
      if (mine === asked) problem(error);
    }
  };
  const draw = () => {
    const words = t();
    title.textContent = words.logs;
    list.setAttribute('aria-label', words.logs);
    fill(
      levels,
      ...(
        [
          ['debug', words.levelAll],
          ['info', words.levelInfo],
          ['warn', words.levelWarn],
          ['error', words.levelError],
        ] as const
      ).map(([value, label]) => {
        const button = h('button', { type: 'button', 'aria-pressed': String(value === level) }, label);
        button.onclick = () => {
          level = value;
          draw();
          void load();
        };
        return button;
      }),
    );
    component.placeholder = words.component;
    component.setAttribute('aria-label', words.component);
    fill(refresh, icon('refresh-cw'), words.refresh);
    fill(older, icon('history'), words.older);
  };
  // The filter follows the typing, a moment after the last key.
  let typing = 0;
  component.oninput = () => {
    window.clearTimeout(typing);
    typing = window.setTimeout(() => void load(), 300);
  };
  refresh.onclick = () => void load();
  older.onclick = () => void load(records[0]?.time);
  draw();
  void load();
  watch(['lang'], () => {
    draw();
    drawList();
  });
  return page;
}

/** The login page: Discord login when it is set up, and how to get a login link from the host. */
/**
 * The page shown while the panel cannot start yet: jukecord has just started and does not know its Discord servers
 * (it answers 503 for a few seconds), or it is not answering at all. The words say which; the panel asks again.
 */
export function waitingPage(status: Status | null, text: string): HTMLElement {
  return h(
    'main',
    { class: 'login' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'brand' },
        logoMark(40),
        h('b', null, 'jukecord'),
        status ? h('span', { class: 'version' }, `v${status.version}`) : null,
      ),
      // The page's level-one heading, for screen readers: the name the mark and the words beside it show.
      h('h1', { class: 'sr' }, 'jukecord'),
      h('div', { class: 'notice tone-load', role: 'status' }, icon('loader-circle', 'spin'), text),
    ),
  );
}

export function loginPage(status: Status | null, error: string | null): HTMLElement {
  const words = t();
  const next = new URLSearchParams(location.search).get('next') ?? '/';
  const message = error ? (words.loginErrors[error] ?? error) : null;
  return h(
    'main',
    { class: 'login' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'brand' },
        logoMark(40),
        h('b', null, 'jukecord'),
        status ? h('span', { class: 'version' }, `v${status.version}`) : null,
      ),
      h('h1', { class: 'sr' }, words.loginTitle),
      message ? h('div', { class: 'notice tone-bad', role: 'alert' }, icon('circle-alert'), message) : null,
      status?.login.discord
        ? h(
            'a',
            { class: 'key primary', href: `/auth/login?next=${encodeURIComponent(next)}`, style: 'height:40px' },
            icon('log-in'),
            words.loginDiscord,
          )
        : null,
      h('p', null, words.loginHost),
      // Which command, by how jukecord was installed.
      h(
        'dl',
        { class: 'login-commands' },
        h('dt', null, words.loginCompose),
        h('dd', null, h('code', null, './jukecord open')),
        h('dt', null, words.loginElsewhere),
        h('dd', null, h('code', null, 'jukecord link')),
      ),
    ),
  );
}
