/**
 * A guest's card under the player on a window with one column (a phone): who is listening in browsers (the guest among
 * them), and until when the guest's listening link works. It takes the right column's place that the voice channel and
 * the history have for members, whose channels and plays a guest does not see. On a window with two columns a guest's
 * player stands alone in the middle (style.css, .main.guest): the listening bar shows who listens there, and the menu
 * until when the link works.
 */
import { fill, h, icon } from '../dom.ts';
import { state, t, watch } from '../state.ts';
import { when } from './invite.ts';
import { listenerFace, listenerName } from './player.ts';

/** The card: the people listening, then the guest's link. */
export function guestCard(): HTMLElement {
  const count = h('span', { class: 'count' });
  const people = h('ul', { class: 'guest-people' });
  const until = h('p', { class: 'guest-until' });
  const card = h(
    'section',
    // As tall as what it holds: it shows under the queue, in a page that scrolls.
    { class: 'card guest-card', 'aria-labelledby': 'guest-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'guest-h' }), count),
    people,
    until,
  );
  const draw = () => {
    const words = t();
    (card.querySelector('#guest-h') as HTMLElement).textContent = words.listeningHere;
    count.textContent = state.listeners.count > 0 ? words.listeners(state.listeners.count) : '';
    // Each person with their face and name (a guest and a friend in the panel's words). Nobody yet is said as the
    // other cards say an empty list, an icon over the words in the card's middle.
    fill(
      people,
      ...(state.listeners.people.length === 0
        ? [h('li', { class: 'empty' }, icon('headphones'), words.nobodyListening)]
        : state.listeners.people.map((person) =>
            h('li', null, listenerFace(person), h('span', { class: 'name' }, listenerName(person))),
          )),
    );
    const link = state.me?.guest;
    fill(until, icon('link'), link ? words.guestUntil(when(link.expiresAt)) : '');
  };
  watch(['listeners', 'lang', 'me'], draw);
  draw();
  return card;
}
