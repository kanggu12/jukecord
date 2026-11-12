/**
 * What another app shared, to put in the queue. The installed panel is a share target: a phone's YouTube app (or any
 * other) shares a video's address to /add?url=…&text=…, and this page finds the address in what came, says which
 * server's queue it goes to, and adds it when the person presses a key. A page any site could send a browser to must
 * not change the queue by itself, so nothing is added before that press. Someone who may not change the music is told
 * why, and a browser not logged in logs in first and comes back here.
 */
import { api } from '../api.ts';
import { fill, h, icon } from '../dom.ts';
import { mayControl, state, t, watch } from '../state.ts';
import { toast } from '../ui/layers.ts';
import { act } from './player.ts';

// An address in shared text: http(s) up to the first space, without the punctuation a sentence puts after it.
const ADDRESS = /https?:\/\/[^\s<>"]+/i;

/** What to add from what was shared: an address in the url, the text or the title (in that order), else the words. */
export function sharedInput(params: URLSearchParams): string | null {
  for (const field of ['url', 'text', 'title']) {
    const found = ADDRESS.exec(params.get(field) ?? '')?.[0];
    if (found) return found.replace(/[).,;:!?'"]+$/, '');
  }
  // No address: the words shared are what the add field takes too (a search), as typed there.
  const words = (params.get('text') ?? params.get('title') ?? '').trim();
  return words ? words.slice(0, 500) : null;
}

/** The page: what was shared, the server it goes to, and the keys that add it. */
export function addPage(navigate: (path: string) => void, chooseServer: () => void): HTMLElement {
  const input = sharedInput(new URLSearchParams(location.search));
  const title = h('h1');
  const content = h('section', { class: 'card share-card' });
  const page = h('main', { class: 'page' }, h('div', { class: 'page-head' }, title), content);

  const draw = () => {
    const words = t();
    title.textContent = words.shareTitle;
    if (!input) {
      fill(content, h('div', { class: 'empty' }, icon('link'), words.shareNothing));
      return;
    }
    const server = state.guild;
    // Who may not: a guest, someone without the DJ role. Said in words a touch screen shows too.
    const why = state.me?.kind === 'guest' ? words.guestOnly : !mayControl() ? words.lookOnlyHint : null;
    const keys = (['end', 'next', 'now'] as const).map((at) => {
      const key = h(
        'button',
        { class: `key ${at === 'now' ? 'primary' : ''}`.trim(), type: 'button', 'data-act': `share-${at}` },
        icon(at === 'now' ? 'play' : at === 'next' ? 'arrow-up-to-line' : 'list-plus'),
        at === 'now' ? words.playNow : at === 'next' ? words.playNext : words.add,
      );
      key.disabled = why !== null || !server;
      key.onclick = async () => {
        if (!server) return;
        const result = await act(key, () =>
          at === 'now' ? api['play-now'](server.id, input) : api.add(server.id, input, at),
        );
        if (!result) return;
        toast(words.added(result.items.length), 'play');
        navigate('/');
      };
      return key;
    });
    const other = h('button', { class: 'key sm quiet', type: 'button' }, words.shareOther);
    other.onclick = chooseServer;
    other.hidden = state.guilds.length <= 1;
    fill(
      content,
      h('p', { class: 'faint share-label' }, words.shareFound),
      h('div', { class: 'secret share-input' }, input),
      h(
        'div',
        { class: 'line share-server' },
        icon('list-music'),
        h('span', { class: 'grow' }, server ? words.shareServer(server.name) : ''),
        other,
      ),
      why ? h('p', { class: 'look-only share-why' }, why) : null,
      h('div', { class: 'share-keys' }, ...keys),
    );
  };
  watch(['lang', 'guild', 'me', 'guilds'], draw);
  draw();
  return page;
}
