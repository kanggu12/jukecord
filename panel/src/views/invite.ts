/**
 * Inviting, in one place: a listening link for guests (anyone with it listens along to this server without a Discord
 * account, changing nothing) and, for the host, a login link for a friend (one browser, once, within ten minutes, to
 * view or to control). Each link comes with a QR code drawn here, for a phone's camera, and a copy key; nothing outside
 * jukecord sees a link. A listening link is shown once (only its hash is kept); the ones that still work are listed
 * under it, with their guests and a key to revoke each.
 */
import { api, type ListenLink } from '../api.ts';
import { fill, h, icon } from '../dom.ts';
import { type QrCode, qrCode } from '../qr.ts';
import { mayControl, state, t } from '../state.ts';
import { confirmDialog, problem, showDialog } from '../ui/layers.ts';
import { act } from './player.ts';

// How many browsers a listening link takes (the server's GUESTS_PER_LINK; its answers carry it too).
const GUESTS = 25;

/** Whether this login may invite: listening links for whoever may change the music, login links for the host. */
export function mayInvite(): boolean {
  return Boolean(state.guild) && (mayControl() || state.me?.kind === 'host');
}

// A link made on the server for its own address: when that is this machine (no public address set) but the panel was
// opened at another one (a LAN address), the link is given at the panel's address, which reaches the same jukecord.
function reachable(url: string): string {
  try {
    const link = new URL(url);
    const here = new URL(location.href);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(link.hostname);
    return local && here.hostname !== link.hostname ? `${here.origin}${link.pathname}${link.search}${link.hash}` : url;
  } catch {
    return url;
  }
}

/** A date and time in the panel's language ("Nov 20, 2026, 9:41 PM", "2026. 11. 20. 오후 9:41"). */
export function when(ms: number, timeOnly = false): string {
  const locale = state.lang === 'ko' ? 'ko-KR' : 'en-US';
  return new Date(ms).toLocaleString(
    locale,
    timeOnly ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
  );
}

/** The code as an SVG: dark modules on a light square, with the four-module quiet zone the standard asks for. */
export function qrSvg(code: QrCode, label: string): SVGSVGElement {
  const side = code.size + 8;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  // One path for every dark module, a square each, so the code is one shape.
  let path = '';
  code.dark.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    });
  });
  const back = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  back.setAttribute('width', String(side));
  back.setAttribute('height', String(side));
  back.setAttribute('class', 'qr-back');
  const marks = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  marks.setAttribute('d', path);
  marks.setAttribute('class', 'qr-marks');
  svg.append(back, marks);
  return svg;
}

// A link just made: its QR code, the link itself (selectable), a copy key, and what it is good for.
function made(url: string, notes: string[]): HTMLElement {
  const words = t();
  const code = qrCode(url);
  const link = h('div', { class: 'secret invite-url' }, url);
  // What Copy did, said in the dialog itself (a message in the bar would sit under the dialog's shade).
  const result = h('p', { class: 'copy-result', role: 'status' });
  const copy = h(
    'button',
    { class: 'key primary', type: 'button', 'data-act': 'invite-copy' },
    icon('copy'),
    words.copy,
  );
  copy.onclick = async () => {
    try {
      // Browsers give pages on plain http (a LAN address) no clipboard at all.
      if (!navigator.clipboard) throw new Error('no clipboard here');
      await navigator.clipboard.writeText(url);
      result.className = 'copy-result';
      fill(result, icon('check'), words.copied);
    } catch {
      // Not copied: the link is selected instead, ready for Ctrl+C, and the words say so.
      const range = document.createRange();
      range.selectNodeContents(link);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      result.className = 'copy-result text-bad';
      fill(result, icon('circle-alert'), words.linkNotCopied);
    }
  };
  return h(
    'div',
    { class: 'invite-made' },
    code ? h('div', { class: 'qr-box' }, qrSvg(code, words.inviteQr(url))) : null,
    h(
      'div',
      { class: 'invite-link' },
      h('p', { class: 'faint invite-note' }, words.inviteShownOnce),
      link,
      h('div', { class: 'line' }, copy, h('span', { class: 'grow' })),
      result,
      ...notes.map((note) => h('p', { class: 'faint invite-note' }, note)),
    ),
  );
}

// A row of choices where one is on (the link's length, a friend's rights), named for screen readers.
function choices<T extends string | number>(
  options: [T, string][],
  current: T,
  name: string,
  choose: (value: T) => void,
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

/** The Invite dialog: listening links for guests, and for the host a login link for a friend. */
export function inviteDialog(): void {
  const words = t();
  const guild = state.guild;
  if (!guild) return;
  const host = state.me?.kind === 'host';
  const body = h('div', { class: 'invite' });
  showDialog(words.invite, body);

  // Guests: a listening link to this server, and the ones that still work.
  const guests = h('div', { class: 'invite-pane', 'data-pane': 'guests' });
  const list = h('ul', { class: 'list invite-links' });
  const guestResult = h('div');
  let days: 1 | 7 | 30 = 7;
  const makeGuest = h(
    'button',
    { class: 'key primary', type: 'button', 'data-act': 'invite-make' },
    icon('user-plus'),
    words.inviteMake,
  );
  makeGuest.onclick = async () => {
    const created = await act(makeGuest, () => api['listen-link-create'](guild.id, days));
    if (!created) return;
    fill(guestResult, made(reachable(created.url), [words.inviteUntil(when(created.link.expiresAt))]));
    void drawLinks();
  };
  // The links that still work: the person's own, or every one for people who can manage the server.
  const drawLinks = async () => {
    let links: ListenLink[];
    try {
      links = await api['listen-links'](guild.id);
    } catch (error) {
      problem(error);
      return;
    }
    if (links.length === 0) {
      fill(list, h('li', { class: 'empty' }, icon('user-plus'), words.inviteNoLinks));
      return;
    }
    fill(
      list,
      ...links.map((link) => {
        const revoke = h(
          'button',
          {
            class: 'key sm quiet bad',
            type: 'button',
            dataset: { key: 'revoke' },
            // Which link, for screen readers: the key's word alone would not say.
            'aria-label': `${words.revoke}: ${when(link.expiresAt)}`,
          },
          words.revoke,
        );
        revoke.onclick = async () => {
          const ok = await confirmDialog({
            title: words.inviteRevokeTitle,
            text: words.inviteRevokeText,
            ok: words.revoke,
            danger: true,
          });
          if (ok && (await act(null, () => api['listen-link-revoke'](guild.id, link.id))) !== undefined) {
            void drawLinks();
          }
        };
        const by = link.createdBy ? (link.createdByName ?? link.createdBy) : words.host;
        return h(
          'li',
          { class: 'channel', dataset: { id: String(link.id) } },
          h(
            'span',
            { class: 'name' },
            h('b', null, words.inviteUntil(when(link.expiresAt))),
            h(
              'span',
              { class: 'faint' },
              ` · ${words.inviteGuestsIn(link.guests, link.maxGuests)} · ${words.inviteBy(by)}`,
            ),
          ),
          revoke,
        );
      }),
    );
  };
  fill(
    guests,
    h('p', { class: 'faint invite-hint' }, words.inviteGuestsHint(guild.name, GUESTS)),
    h(
      'div',
      { class: 'line invite-form' },
      choices<1 | 7 | 30>(
        [
          [1, words.inviteDays(1)],
          [7, words.inviteDays(7)],
          [30, words.inviteDays(30)],
        ],
        days,
        words.inviteLength,
        (value) => {
          days = value;
        },
      ),
      h('span', { class: 'grow' }),
      makeGuest,
    ),
    guestResult,
    h('h3', null, words.inviteLinks),
    list,
  );

  // A friend (the host only): a one-time login link to view or to control.
  const friend = h('div', { class: 'invite-pane', 'data-pane': 'friend', hidden: true });
  const friendResult = h('div');
  let scope: 'read' | 'control' = 'read';
  const makeFriend = h(
    'button',
    { class: 'key primary', type: 'button', 'data-act': 'invite-friend' },
    icon('key-round'),
    words.inviteMake,
  );
  makeFriend.onclick = async () => {
    const created = await act(makeFriend, () => api['login-link'](scope));
    if (created) fill(friendResult, made(reachable(created.url), [words.inviteOnce(when(created.expiresAt, true))]));
  };
  fill(
    friend,
    h('p', { class: 'faint invite-hint' }, words.inviteFriendHint),
    h(
      'div',
      { class: 'line invite-form' },
      choices<'read' | 'control'>(
        [
          ['read', words.scopeRead],
          ['control', words.scopeControl],
        ],
        scope,
        words.tokenAccess,
        (value) => {
          scope = value;
        },
      ),
      h('span', { class: 'grow' }),
      makeFriend,
    ),
    friendResult,
  );

  // Which of the two, for the host; anyone else has the guests' alone.
  const tabs = host
    ? choices<'guests' | 'friend'>(
        [
          ['guests', words.inviteGuests],
          ['friend', words.inviteFriend],
        ],
        'guests',
        words.invite,
        (value) => {
          guests.hidden = value !== 'guests';
          friend.hidden = value !== 'friend';
        },
      )
    : null;
  // Someone who may not make listening links here (the host always may) sees no guests' pane.
  if (!mayControl() && !host) guests.hidden = true;
  fill(body, tabs ? h('div', { class: 'invite-tabs' }, tabs) : null, guests, host ? friend : null);
  void drawLinks();
}
