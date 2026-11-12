/**
 * A guest's card beside the player: who is listening in browsers (the guest among them), and until when the guest's
 * listening link works. It takes the right column's place that the voice channel and the history have for members,
 * whose channels and plays a guest does not see.
 */
import { avatarUrl, face, fill, h, icon } from '../dom.ts';
import { state, t, watch } from '../state.ts';
import { when } from './invite.ts';
import { listenerName } from './player.ts';

/** The card: the people listening, then the guest's link. */
export function guestCard(): HTMLElement {
  const count = h('span', { class: 'count' });
  const people = h('ul', { class: 'guest-people' });
  const until = h('p', { class: 'guest-until' });
  const card = h(
    'section',
    // It fills the column beside the player where there are two (style.css), as the history does for members.
    { class: 'card fill guest-card', 'aria-labelledby': 'guest-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'guest-h' }), count),
    people,
    until,
  );
  const draw = () => {
    const words = t();
    (card.querySelector('#guest-h') as HTMLElement).textContent = words.listeningHere;
    count.textContent = state.listeners.count > 0 ? words.listeners(state.listeners.count) : '';
    // Each person with their face and name (a guest and a friend in the panel's words); nobody yet says so.
    fill(
      people,
      ...(state.listeners.people.length === 0
        ? [h('li', { class: 'faint' }, words.nobody)]
        : state.listeners.people.map((person) =>
            h(
              'li',
              null,
              face(listenerName(person), avatarUrl(person.id, person.avatar), 'sm'),
              h('span', { class: 'name' }, listenerName(person)),
            ),
          )),
    );
    const link = state.me?.guest;
    fill(until, icon('link'), link ? words.guestUntil(when(link.expiresAt)) : '');
  };
  watch(['listeners', 'lang', 'me'], draw);
  draw();
  return card;
}
