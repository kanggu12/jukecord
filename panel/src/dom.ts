/**
 * Small helpers for building the page: an element maker, icons, and the formats people read (times, sizes, ago).
 *
 * No framework: each view builds its elements once and updates the parts that change, which keeps the panel light
 * and the timing of every update in plain sight.
 */
import { ICONS, type IconName } from './icons.ts';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string> };

/** Makes an element: h('button', { class: 'key', onclick }, icon('play'), 'Play'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    // Through the CSS object model: the content security policy blocks style attributes, not this.
    else if (key === 'style') element.style.cssText = String(value);
    // Event handlers are properties (onclick, oninput ...); everything else is an attribute.
    else if (key.startsWith('on') && typeof value === 'function')
      (element as unknown as Record<string, unknown>)[key] = value;
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/** Adds children, skipping the empty ones (so conditions can be written inline). */
export function append(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replaces an element's children. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/**
 * Runs `rebuild`, which replaces the rows of `list`, and gives the keyboard focus back to the same key of the same row:
 * the row is found by its data-id and the key by its data-key. A key that is no longer there (Play next on the row
 * that became first) or is hidden falls back to the row's link, never to a neighbouring key that does something else.
 */
export function keepingFocus(list: HTMLElement, rebuild: () => void): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const row = focused && list.contains(focused) ? focused.closest<HTMLElement>('[data-id]') : null;
  const id = row?.dataset.id;
  const key = focused?.dataset.key;
  rebuild();
  if (!id) return;
  const again = [...list.querySelectorAll<HTMLElement>('[data-id]')].find((element) => element.dataset.id === id);
  if (!again) return;
  // A key that can take the focus: on the page (not display: none), not held invisible, not disabled.
  const shown = (element: HTMLElement | null) =>
    element &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden' &&
    !(element as HTMLButtonElement).disabled
      ? element
      : null;
  const same = key ? shown(again.querySelector<HTMLElement>(`[data-key="${key}"]`)) : null;
  (same ?? shown(again.querySelector<HTMLElement>('a')))?.focus({ preventScroll: true });
}

/**
 * fill(), but only when `sign` (what the children show, in a few words) differs from the last time. Views redraw on
 * every snapshot, several a second while a track loads; children replaced under a pointer lose the click, and a
 * focused key that is replaced loses the keyboard focus.
 */
export function refill(parent: HTMLElement, sign: string, ...children: Child[]): void {
  if (parent.dataset.sign === sign) return;
  parent.dataset.sign = sign;
  fill(parent, ...children);
}

const SVG = 'http://www.w3.org/2000/svg';

/** A line icon. Decorative unless given a label (then screen readers read the label). */
export function icon(name: IconName, extra = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  // The shapes are fixed strings from the icon table, never input, so innerHTML is safe here.
  svg.innerHTML = ICONS[name];
  return svg;
}

/** m:ss, or h:mm:ss from an hour up. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The picture of a Discord user, or null for the default (the panel draws initials instead). */
export function avatarUrl(id: string | null, hash: string | null, size = 64): string | null {
  return id && hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${size}` : null;
}

/** The icon of a Discord server, or null. */
export function guildIconUrl(id: string, hash: string | null, size = 64): string | null {
  return hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=${size}` : null;
}

/** A round picture with the person's initials behind it, shown when the picture is missing or fails to load. */
export function face(name: string, url: string | null, extra = ''): HTMLElement {
  const box = h('span', { class: `avatar ${extra}`.trim(), title: name }, initials(name));
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onerror = () => img.remove();
    img.onload = () => box.replaceChildren(img);
  }
  return box;
}

/** One or two letters for a name ("Alice" A, "Blue Sky" BS, "한강 산책" 한산). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]?.[0], words[1]?.[0]] : [...(words[0] ?? '?')].slice(0, 1);
  return letters.join('').toUpperCase() || '?';
}

/** Throws away the current timer and starts another; returns a function that cancels it. */
export function every(ms: number, fn: () => void): () => void {
  const timer = window.setInterval(fn, ms);
  return () => window.clearInterval(timer);
}
