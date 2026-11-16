/**
 * What another app shared, to put in the queue. The installed panel is a share target: a phone's YouTube app (or any
 * other) shares a video's address to /add?url=…&text=…, and this page finds the address in what came, says which
 * server's queue it goes to, and adds it when the person presses a key. A page any site could send a browser to must
 * not change the queue by itself, so nothing is added before that press. Someone who may not change the music is told
 * why, and a browser not logged in logs in first and comes back here. Cancel (or, for whoever may not add, a key back)
 * leaves for the player without a change.
 */
import { api } from '../api.ts';
import { fill, h, icon } from '../dom.ts';
import { lookOnlyWhy, mayControl, state, t, watch } from '../state.ts';
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

/**
 * The name the sharing app gave what it shared (a video's title), to show over its address: only beside an address,
 * and only a name (not an address itself, not the words that are added).
 */
export function sharedName(params: URLSearchParams, input: string | null): string | null {
  const title = (params.get('title') ?? '').trim();
  if (!input || !ADDRESS.test(input) || !title || ADDRESS.test(title) || title === input) return null;
  return title.slice(0, 200);
}

/** The page: what was shared, the server it goes to, and the keys that add it or leave it. */
export function addPage(navigate: (path: string) => void, chooseServer: () => void): HTMLElement {
  const params = new URLSearchParams(location.search);
  const input = sharedInput(params);
  const named = sharedName(params, input);
  const title = h('h1');
  const content = h('section', { class: 'card share-card' });
  // One task, so one column in the middle of the window, its title over the card (on a wide window the card hugged the
  // left with half the window empty beside it).
  const page = h('main', { class: 'page share' }, h('div', { class: 'page-head' }, title), content);

  const draw = () => {
    const words = t();
    // Who may not add: a guest, someone without the DJ role, a View login (known once a server is shown: before, the
    // page would be titled for a guest a moment, then for the host). Said in words a touch screen shows too.
    const why = state.me?.kind === 'guest' ? words.guestOnly : state.guild && !mayControl() ? lookOnlyWhy() : null;
    // The page as what it is for the person: adding to the queue for whoever may add, the link that came for whoever
    // may not (a guest's page was titled "Add to the queue", over the queue it would go to, and then said a guest
    // cannot add).
    title.textContent = why === null ? words.shareTitle : words.shareFound;
    // Back to the player, adding nothing: Cancel beside the keys that add, or for whoever may not add the one way on
    // (a guest had three keys that did nothing, and the logo to get back).
    const leave = (label: string) => {
      const key = h('button', { class: 'key share-leave', type: 'button', 'data-act': 'share-leave' }, label);
      key.onclick = () => navigate('/');
      return key;
    };
    if (!input) {
      fill(
        content,
        h('div', { class: 'empty' }, icon('link'), words.shareNothing),
        h('div', { class: 'share-keys' }, leave(words.shareBack)),
      );
      return;
    }
    const server = state.guild;
    // The keys that add, for whoever may (none that do nothing): Add first and the main key, as in the player's add
    // card, since what is shared joins a queue others hear and Play now cuts off what they hear.
    const keys =
      why === null && server
        ? (['end', 'next', 'now'] as const).map((at) => {
            const key = h(
              'button',
              { class: `key ${at === 'end' ? 'primary' : ''}`.trim(), type: 'button', 'data-act': `share-${at}` },
              icon(at === 'now' ? 'play' : at === 'next' ? 'arrow-up-to-line' : 'list-plus'),
              at === 'now' ? words.playNow : at === 'next' ? words.playNext : words.add,
            );
            key.onclick = async () => {
              const result = await act(key, () =>
                at === 'now' ? api['play-now'](server.id, input) : api.add(server.id, input, at),
              );
              if (!result) return;
              toast(words.added(result.items.length));
              navigate('/');
            };
            return key;
          })
        : [];
    const other = h('button', { class: 'key sm quiet', type: 'button' }, words.shareOther);
    other.onclick = chooseServer;
    other.hidden = state.guilds.length <= 1;
    const address = ADDRESS.test(input);
    fill(
      content,
      // What it is, over it: for whoever may not add, the page's title says it.
      why === null ? h('p', { class: 'faint share-label' }, words.shareFound) : null,
      // What came, as words to read rather than a box to type in (it looked like a field that could be changed): its
      // name over its address when the app gave one, a link's mark or a search's before it.
      h(
        'div',
        { class: 'share-item' },
        icon(address ? 'link' : 'search'),
        h(
          'div',
          { class: 'grow' },
          named ? h('div', { class: 'share-name' }, named) : null,
          h('div', { class: `share-input ${named ? 'faint' : ''}`.trim() }, input),
        ),
      ),
      // The queue it goes to, for whoever may add it there.
      why === null
        ? h(
            'div',
            { class: 'line share-server' },
            icon('list-music'),
            h('span', { class: 'grow' }, server ? words.shareServer(server.name) : ''),
            other,
          )
        : null,
      why ? h('p', { class: 'look-only share-why' }, why) : null,
      h('div', { class: 'share-keys' }, leave(keys.length > 0 ? words.cancel : words.shareBack), ...keys),
    );
  };
  watch(['lang', 'guild', 'me', 'guilds'], draw);
  draw();
  return page;
}
