/**
 * The two sheets that hang from the top bar: the servers to switch between (left), and the menu (right) with this
 * browser's choices (theme, language, motion), the server's DJ role, API tokens, the shortcuts and logging out.
 */
import { api, logOut, type Settings, type Token } from '../api.ts';
import { avatarUrl, face, fill, guildIconUrl, h, icon, keepingFocus } from '../dom.ts';
import { pickLang } from '../i18n.ts';
import { keep, state, t, update } from '../state.ts';
import { confirmDialog, problem, sheet, showDialog } from '../ui/layers.ts';
import { act, ago } from './player.ts';

/** The servers this login can open, in a dialog; picking one switches the panel to it. */
export function serversSheet(choose: (id: string) => void): void {
  const words = t();
  // A list of keys, the current server marked: arrow keys are not promised, so no menu role either.
  const list = h('div', { class: 'menu-list' });
  const dialog = showDialog(words.servers, list);
  fill(
    list,
    ...state.guilds.map((guild) => {
      const iconUrl = guildIconUrl(guild.id, guild.icon);
      const button = h(
        'button',
        {
          class: 'choice',
          type: 'button',
          'aria-current': guild.id === state.guild?.id ? 'true' : 'false',
        },
        h('span', { class: 'guild-icon' }, iconUrl ? h('img', { src: iconUrl, alt: '' }) : guild.name.slice(0, 1)),
        h('span', { class: 'grow' }, guild.name),
        guild.mayControl ? null : h('span', { class: 'badge tone-pause' }, words.lookOnly),
        icon('check', 'check'),
      );
      button.onclick = () => {
        dialog.close();
        choose(guild.id);
      };
      return button;
    }),
  );
}

// A row of choices where one is on (theme, language), named for screen readers (two of them have an "Auto").
function segmented<T extends string>(
  options: [T, string][],
  current: T,
  choose: (value: T) => void,
  name: string,
): HTMLElement {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': name });
  for (const [value, label] of options) {
    const button = h('button', { type: 'button', 'aria-pressed': String(value === current) }, label);
    button.onclick = () => {
      for (const other of box.children) other.setAttribute('aria-pressed', String(other === button));
      choose(value);
    };
    box.append(button);
  }
  return box;
}

// The page shown, by the address's first part ("/" is the player's).
function currentPage(): string {
  if (location.pathname.startsWith('/stats')) return '/stats';
  if (location.pathname.startsWith('/logs')) return '/logs';
  return '/';
}

/** Applies the theme and motion choices to the page. */
export function applyLook(): void {
  const root = document.documentElement;
  if (state.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = state.theme;
  if (state.motion) delete root.dataset.motion;
  else root.dataset.motion = 'off';
  root.lang = state.lang;
}

/** The menu. */
/** What the menu tells the key that opens it: that it opened, and that it closed. */
export interface MenuHooks {
  opened(): void;
  closed(): void;
}

export function menuSheet(navigate: (path: string) => void, hooks?: MenuHooks, focusLanguage = false): void {
  const words = t();
  const { body, close } = sheet({ label: words.menu, ...(hooks ? { onClose: hooks.closed } : {}) });
  hooks?.opened();
  const me = state.me;
  if (!me) return;
  // The host has no Discord name: one line, "Host" in the panel's language. A Discord login: the name, and how.
  const host = me.kind === 'host';
  const who = h(
    'div',
    { class: 'section' },
    h(
      'div',
      { class: 'line' },
      face(host ? words.host : me.name, avatarUrl(me.id, me.avatar)),
      h(
        'div',
        { class: 'grow' },
        h('b', null, host ? words.host : me.name),
        host ? null : h('div', { class: 'faint' }, words.discordLogin),
      ),
    ),
  );
  // The pages, for narrow windows where the bar has no room for them.
  const pages = h(
    'div',
    { class: 'section pages' },
    ...[
      ['/', 'music-2', words.player],
      ['/stats', 'chart-column', words.stats],
      ...(me.kind === 'host' ? [['/logs', 'scroll-text', words.logs]] : []),
    ].map(([path, name, label]) => {
      // The page in use is marked, as the bar's links mark it on a wide window.
      const button = h(
        'button',
        { class: 'choice', type: 'button', 'aria-current': path === currentPage() ? 'page' : null },
        icon(name as 'music-2'),
        label,
      );
      button.onclick = () => {
        close();
        navigate(path as string);
      };
      return button;
    }),
  );
  const language = segmented(
    [
      ['auto', words.languageAuto],
      ['en', 'English'],
      ['ko', '한국어'],
    ],
    state.langChoice,
    (choice) => {
      keep('lang', choice);
      update({ langChoice: choice, lang: pickLang(choice === 'auto' ? null : choice) });
      applyLook();
      // The menu's own words follow at once (the key stays shown as holding it open), and the keyboard stays on the
      // language just chosen.
      close();
      menuSheet(navigate, hooks, true);
    },
    words.language,
  );
  const look = h(
    'div',
    { class: 'section' },
    h('h3', null, words.theme),
    segmented(
      [
        ['system', words.themeSystem],
        ['light', words.themeLight],
        ['dark', words.themeDark],
      ],
      state.theme,
      (theme) => {
        update({ theme });
        keep('theme', theme);
        applyLook();
      },
      words.theme,
    ),
    h('h3', { style: 'margin-top:14px' }, words.language),
    language,
    h(
      'div',
      { class: 'line', style: 'margin-top:10px' },
      h('div', { class: 'grow' }, h('div', null, words.motion), h('div', { class: 'faint' }, words.motionHint)),
      (() => {
        const toggle = h('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(state.motion),
          'aria-label': words.motion,
        });
        toggle.onclick = () => {
          const on = !state.motion;
          toggle.setAttribute('aria-checked', String(on));
          update({ motion: on });
          keep('motion', on ? 'on' : 'off');
          applyLook();
        };
        return toggle;
      })(),
    ),
  );
  const dj = h('div', { class: 'section', hidden: true });
  const share = h('div', { class: 'section settings', hidden: true });
  const tokens = h('div', { class: 'section' });
  const end = h('div', { class: 'section' });
  // Keyboard shortcuts mean nothing on a touch screen without a keyboard; style.css hides this item there.
  const shortcuts = h(
    'button',
    { class: 'choice', type: 'button', 'data-act': 'shortcuts' },
    icon('keyboard'),
    words.shortcuts,
  );
  shortcuts.onclick = () => {
    close();
    shortcutsDialog();
  };
  const out = h('button', { class: 'choice', type: 'button' }, icon('log-out'), words.logOut);
  out.onclick = async () => {
    await logOut();
    location.assign('/login');
  };
  fill(end, shortcuts, out);
  fill(body, who, pages, look, dj, share, tokens, end);
  // Opened again for a new language: the focus goes back to the language chosen (after the sheet's own first focus,
  // which runs in the same turn).
  if (focusLanguage) {
    queueMicrotask(() => language.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus());
  }

  // The DJ role, for people who can manage the server (and only with Discord: browser-only has no roles).
  const guild = state.guild;
  if (guild?.mayManage && state.status?.mode === 'discord') void drawDj(dj, guild.id);
  // How the server's people share the music: for the same people, and only with Discord too (browser-only has the
  // host alone, and no voice channel).
  if (guild?.mayManage && state.status?.mode === 'discord') void drawShare(share, guild.id);
  void drawTokens(tokens);
}

// The DJ role choice: everyone, or one role.
async function drawDj(box: HTMLElement, guild: string): Promise<void> {
  let settings: Settings;
  try {
    settings = await api.settings(guild);
  } catch (error) {
    problem(error);
    return;
  }
  const words = t();
  const choose = (roleId: string | null) => async () => {
    // A list left from another server (the server was switched meanwhile) changes nothing.
    if (state.guild?.id !== guild) return;
    const saved = await act(null, () => api['dj-role'](guild, roleId));
    if (saved && state.guild?.id === guild) void drawDj(box, guild);
  };
  const option = (id: string | null, name: string, color: number) => {
    const button = h(
      'button',
      { class: 'choice', type: 'button', 'aria-pressed': String(settings.djRoleId === id) },
      id
        ? h('span', {
            class: 'swatch',
            style: `background:${color ? `#${color.toString(16).padStart(6, '0')}` : 'var(--ink-3)'}`,
          })
        : icon('users'),
      h('span', { class: 'grow' }, name),
      icon('check', 'check'),
    );
    button.onclick = choose(id);
    return button;
  };
  box.hidden = false;
  fill(
    box,
    h('h3', null, words.djRole),
    h('p', { class: 'faint', style: 'margin:0 0 8px' }, words.djHint),
    option(null, words.everyone, 0),
    ...settings.roles.map((role) => option(role.id, role.name, role.color)),
  );
}

// A setting that is on or off: its name and what it does, and its switch, saved at each press. A refusal puts the
// switch back and says why.
function switchLine(name: string, hint: string, on: boolean, save: (on: boolean) => Promise<unknown>): HTMLElement {
  const toggle = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': name,
  });
  toggle.onclick = async () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    // Shown at once; not made busy (a disabled switch would drop the keyboard focus).
    toggle.setAttribute('aria-checked', String(next));
    if ((await act(null, () => save(next))) === undefined) toggle.setAttribute('aria-checked', String(!next));
  };
  return h(
    'div',
    { class: 'line' },
    h('div', { class: 'grow' }, h('div', null, name), h('div', { class: 'faint' }, hint)),
    toggle,
  );
}

// The limit of tracks one person may have queued: a few choices in a row (none, 1, 2, 3, 5, 10), and the limit set by
// other means (the command line, say) among them when it is none of those. Saved at each press; a refusal puts the
// choice back and says why.
function limitLine(current: number, save: (tracks: number) => Promise<unknown>): HTMLElement {
  const words = t();
  // The words a choice shows.
  const label = (tracks: number) => (tracks === 0 ? words.noLimit : String(tracks));
  const choices = [...new Set([0, 1, 2, 3, 5, 10, current])].sort((a, b) => a - b);
  let chosen = current;
  const row = segmented(
    choices.map((tracks) => [String(tracks), label(tracks)] as [string, string]),
    String(current),
    async (value) => {
      const before = chosen;
      chosen = Number(value);
      if ((await act(null, () => save(chosen))) !== undefined) return;
      // Refused: the choice in use goes back to the one saved.
      chosen = before;
      for (const button of row.children)
        button.setAttribute('aria-pressed', String(button.textContent === label(before)));
    },
    words.personLimit,
  );
  return h(
    'div',
    { class: 'line limit' },
    h('div', { class: 'grow' }, h('div', null, words.personLimit), h('div', { class: 'faint' }, words.personLimitHint)),
    row,
  );
}

// How the server's people share the music: each setting saved as it is changed, for people who can manage the server.
async function drawShare(box: HTMLElement, guild: string): Promise<void> {
  let settings: Settings;
  try {
    settings = await api.settings(guild);
  } catch (error) {
    problem(error);
    return;
  }
  // The server was switched while jukecord answered: this section belongs to the one left behind.
  if (state.guild?.id !== guild) return;
  const words = t();
  box.hidden = false;
  fill(
    box,
    h('h3', null, words.serverSettings),
    // Votes first, under the DJ role they go with; the queue's two rules next; staying in voice last.
    switchLine(words.voteSkip, words.voteSkipHint, settings.voteSkip, (on) => api['vote-skip'](guild, on)),
    switchLine(words.takeTurns, words.takeTurnsHint, settings.takeTurns, (on) => api['take-turns'](guild, on)),
    limitLine(settings.personLimit, (tracks) => api['person-limit'](guild, tracks)),
    switchLine(words.stay, words.stayHint, settings.stay, (on) => api.stay(guild, on)),
  );
}

// API tokens: the list, making one (shown once), revoking.
async function drawTokens(box: HTMLElement): Promise<void> {
  const words = t();
  if (state.me?.scope !== 'admin') {
    box.hidden = true;
    return;
  }
  let list: Token[];
  try {
    list = await api.tokens();
  } catch (error) {
    problem(error);
    return;
  }
  // The field and the key are made anew at each drawing: their data-key lets the focus find them again.
  const name = h('input', {
    type: 'text',
    maxlength: '100',
    placeholder: words.tokenName,
    'aria-label': words.tokenName,
    dataset: { key: 'token-name' },
  });
  let scope: Token['scope'] = 'control';
  const make = h(
    'button',
    { class: 'key', type: 'button', dataset: { key: 'token-create' } },
    icon('plus'),
    words.create,
  );
  // A token being made: a second press meanwhile makes nothing more. The key is not disabled for it (a disabled key
  // drops the keyboard focus, and the focus is to come back to this key when the token's dialog closes).
  let making = false;
  make.onclick = async () => {
    const label = name.value.trim();
    if (!label) {
      name.focus();
      return;
    }
    if (making) return;
    making = true;
    make.setAttribute('aria-disabled', 'true');
    const created = await act(null, () => api['token-create'](label, scope));
    making = false;
    make.removeAttribute('aria-disabled');
    if (!created) return;
    const secret = h('div', { class: 'secret' }, created.token);
    // The result of Copy, said in the dialog itself (a message in the top bar would sit under the dialog's shade).
    const result = h('p', { class: 'copy-result', role: 'status' });
    const copy = h('button', { class: 'key primary', type: 'button' }, icon('copy'), words.copy);
    copy.onclick = async () => {
      try {
        // Browsers give pages on plain http (a LAN address) no clipboard at all.
        if (!navigator.clipboard) throw new Error('no clipboard here');
        await navigator.clipboard.writeText(created.token);
        result.className = 'copy-result';
        fill(result, icon('check'), words.copied);
      } catch {
        // Not copied: the token is selected instead, ready for Ctrl+C, and the words say so.
        const range = document.createRange();
        range.selectNodeContents(secret);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        result.className = 'copy-result text-bad';
        fill(result, icon('circle-alert'), words.notCopied);
      }
    };
    showDialog(
      created.info.name,
      h('div', null, h('p', { class: 'faint', style: 'margin:0 0 8px' }, words.shownOnce), secret, result),
      [copy],
    );
    void drawTokens(box);
  };
  // Drawn again after a token is made or revoked: the focus stays on the same key, or (its token revoked) moves to the
  // Revoke of the token now in its place, or to the name field when none is left.
  keepingFocus(
    box,
    () =>
      fillTokens(box, list, name, make, scope, (value) => {
        scope = value;
      }),
    () => name,
  );
}

// The tokens' section: the list, then the form for a new one.
function fillTokens(
  box: HTMLElement,
  list: Token[],
  name: HTMLInputElement,
  make: HTMLButtonElement,
  scope: Token['scope'],
  setScope: (value: Token['scope']) => void,
): void {
  const words = t();
  fill(
    box,
    h('h3', null, words.tokens),
    h('p', { class: 'faint', style: 'margin:0 0 8px' }, words.tokensHint),
    ...(list.length === 0
      ? [h('div', { class: 'faint', style: 'padding:6px 0' }, words.noTokens)]
      : list.map((token) => {
          const revoke = h(
            'button',
            {
              class: 'key sm quiet bad',
              type: 'button',
              dataset: { key: 'revoke' },
              // Which token, for screen readers: the key's word alone would not say.
              'aria-label': `${words.revoke}: ${token.name}`,
            },
            words.revoke,
          );
          revoke.onclick = async () => {
            const ok = await confirmDialog({
              title: words.revokeTitle(token.name),
              text: words.revokeText,
              ok: words.revoke,
              danger: true,
            });
            // Not made busy: a disabled key drops the keyboard focus, which the drawing after must pass on.
            if (ok && (await act(null, () => api['token-revoke'](token.id))) !== undefined) void drawTokens(box);
          };
          const scopeName = { read: words.scopeRead, control: words.scopeControl, admin: words.scopeAdmin }[
            token.scope
          ];
          return h(
            'div',
            { class: 'line', dataset: { id: String(token.id) } },
            icon('key-round'),
            h(
              'div',
              { class: 'grow' },
              h('div', null, token.name),
              h(
                'div',
                { class: 'faint' },
                // "used 3 h ago", in the panel's language whatever the browser's.
                `${scopeName} · ${token.usedAt ? words.usedAgo(ago(token.usedAt)) : words.neverUsed}`,
              ),
            ),
            revoke,
          );
        })),
    // A new token: its name, then what it may do and the key that makes it, the two lines apart (on a touch screen
    // both are a finger's height, and the field touched the choices under it).
    h(
      'div',
      { class: 'token-new' },
      h('div', { class: 'line' }, h('label', { class: 'field' }, name)),
      h(
        'div',
        { class: 'line' },
        segmented(
          [
            ['read', words.scopeRead],
            ['control', words.scopeControl],
            ['admin', words.scopeAdmin],
          ],
          scope,
          setScope,
          words.tokenAccess,
        ),
        h('span', { class: 'grow' }),
        make,
      ),
    ),
  );
}

/** The keyboard shortcuts. */
export function shortcutsDialog(): void {
  const words = t();
  const rows: [string[], string][] = [
    [['Space'], words.keyPlayPause],
    [['←', '→'], words.keySeek],
    [['N'], words.keyNext],
    [['Alt', '↑', '↓'], words.keyMove],
    [['/'], words.keySearch],
    [['?'], words.keyHelp],
  ];
  showDialog(
    words.shortcuts,
    h(
      'div',
      null,
      ...rows.map(([keys, label]) =>
        h('div', { class: 'line' }, h('span', { class: 'grow' }, label), ...keys.map((key) => h('kbd', null, key))),
      ),
    ),
  );
}
