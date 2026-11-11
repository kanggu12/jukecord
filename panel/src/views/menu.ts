/**
 * The two sheets that hang from the top bar: the servers to switch between (left), and the menu (right) with this
 * browser's choices (theme, language, motion), the server's DJ role, API tokens, the shortcuts and logging out.
 */
import { api, logOut, type Settings, type Token } from '../api.ts';
import { avatarUrl, face, fill, guildIconUrl, h, icon } from '../dom.ts';
import { pickLang } from '../i18n.ts';
import { keep, state, t, update } from '../state.ts';
import { confirmDialog, problem, sheet, showDialog } from '../ui/layers.ts';
import { act, ago } from './player.ts';

/** The servers this login can open, in a dialog; picking one switches the panel to it. */
export function serversSheet(choose: (id: string) => void): void {
  const words = t();
  const list = h('div', { role: 'menu' });
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
          role: 'menuitemradio',
          'aria-checked': String(guild.id === state.guild?.id),
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

// A row of choices where one is on (theme, language).
function segmented<T extends string>(options: [T, string][], current: T, choose: (value: T) => void): HTMLElement {
  const box = h('div', { class: 'seg', role: 'group' });
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
export function menuSheet(navigate: (path: string) => void): void {
  const words = t();
  const { body, close } = sheet({ label: words.menu });
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
      const button = h('button', { class: 'choice', type: 'button' }, icon(name as 'music-2'), label);
      button.onclick = () => {
        close();
        navigate(path as string);
      };
      return button;
    }),
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
    ),
    h('h3', { style: 'margin-top:14px' }, words.language),
    segmented(
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
        // The menu's own words follow at once.
        close();
        menuSheet(navigate);
      },
    ),
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
  fill(body, who, pages, look, dj, tokens, end);

  // The DJ role, for people who can manage the server (and only with Discord: browser-only has no roles).
  const guild = state.guild;
  if (guild?.mayManage && state.status?.mode === 'discord') void drawDj(dj, guild.id);
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
      { class: 'choice', type: 'button', role: 'menuitemradio', 'aria-checked': String(settings.djRoleId === id) },
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
  const name = h('input', {
    type: 'text',
    maxlength: '100',
    placeholder: words.tokenName,
    'aria-label': words.tokenName,
  });
  let scope: Token['scope'] = 'control';
  const make = h('button', { class: 'key', type: 'button' }, icon('plus'), words.create);
  make.onclick = async () => {
    const label = name.value.trim();
    if (!label) {
      name.focus();
      return;
    }
    const created = await act(make, () => api['token-create'](label, scope));
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
  fill(
    box,
    h('h3', null, words.tokens),
    h('p', { class: 'faint', style: 'margin:0 0 8px' }, words.tokensHint),
    ...(list.length === 0
      ? [h('div', { class: 'faint', style: 'padding:6px 0' }, words.noTokens)]
      : list.map((token) => {
          const revoke = h('button', { class: 'key sm quiet bad', type: 'button' }, words.revoke);
          revoke.onclick = async () => {
            const ok = await confirmDialog({
              title: words.revokeTitle(token.name),
              text: words.revokeText,
              ok: words.revoke,
              danger: true,
            });
            if (ok && (await act(revoke, () => api['token-revoke'](token.id))) !== undefined) void drawTokens(box);
          };
          const scopeName = { read: words.scopeRead, control: words.scopeControl, admin: words.scopeAdmin }[
            token.scope
          ];
          return h(
            'div',
            { class: 'line' },
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
    h('div', { class: 'line', style: 'margin-top:8px' }, h('label', { class: 'field' }, name)),
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
        (value) => {
          scope = value;
        },
      ),
      h('span', { class: 'grow' }),
      make,
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
