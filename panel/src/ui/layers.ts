/**
 * The layers above the page: toasts (inside the top bar), sheets (from under the bar to the window's end) and
 * dialogs (centred, over a dark scrim). Each is drawn by the panel, never by the browser (no alert, confirm or
 * prompt), and each closes with Escape.
 *
 * Toasts never float over the cards: they take the free space in the bar, one at a time, so they cannot cut across
 * another box's edge. Sheets hang below the bar with the scrim under the bar too, so the bar stays readable.
 */
import { h, icon } from '../dom.ts';
import type { IconName } from '../icons.ts';
import { t } from '../state.ts';

type Tone = 'play' | 'load' | 'pause' | 'bad';

let toastTimer = 0;

/** Shows a short message in the bar: what happened, in a few words. */
export function toast(message: string, tone: Tone = 'load', name: IconName = 'check'): void {
  const box = document.querySelector('.toasts');
  if (!box) return;
  window.clearTimeout(toastTimer);
  // Problems stay a little longer: they usually need reading.
  const lasts = tone === 'bad' ? 6000 : 3500;
  const element = h(
    'div',
    { class: `toast tone-${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
    icon(name),
    h('span', null, message),
  );
  // The line along its foot runs out in the same time.
  element.style.setProperty('--toast-ms', `${lasts}ms`);
  box.replaceChildren(element);
  toastTimer = window.setTimeout(() => box.replaceChildren(), lasts);
}

/** Shows an error from an action as a toast. */
export function problem(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), 'bad', 'circle-alert');
}

// The open layers (the sheet and dialogs over it), newest last. Escape closes the newest only, and Tab stays inside it:
// a rename dialog over the playlists closes alone, and the keyboard never wanders to the page under the scrim.
const layers: { element: HTMLElement; close: () => void }[] = [];

/** Whether a sheet or a dialog is open (the player's shortcuts wait while one is). */
export function layerOpen(): boolean {
  return layers.length > 0;
}

// What the keyboard can reach in a layer: enabled, and shown (a section hidden at this width is skipped).
function reachable(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'),
  ].filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
}

document.addEventListener('keydown', (event) => {
  const top = layers.at(-1);
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    top.close();
    return;
  }
  if (event.key !== 'Tab') return;
  const keys = reachable(top.element);
  const first = keys[0];
  const last = keys.at(-1);
  // From the last key forward, or the first backward, round to the other end; from outside the layer, into it.
  const inside = top.element.contains(document.activeElement);
  if (
    !inside ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
});

// Puts a layer on top; returns the function that takes it off again.
function push(element: HTMLElement, close: () => void): () => void {
  const entry = { element, close };
  layers.push(entry);
  return () => {
    const index = layers.indexOf(entry);
    if (index >= 0) layers.splice(index, 1);
  };
}

// The one open sheet, closed when another opens.
let closeSheet: (() => void) | null = null;

/** Opens a sheet from under the bar; returns its body to fill and a way to close it. */
export function sheet(options: { side?: 'left' | 'right'; label: string; onClose?: () => void }): {
  body: HTMLElement;
  close: () => void;
} {
  closeSheet?.();
  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'sheet-body scroll' });
  // A close key of its own: on a phone the sheet covers the whole width, and there is no scrim left to tap.
  const shut = h(
    'button',
    { class: 'key sm square quiet sheet-close', type: 'button', title: t().close, 'aria-label': t().close },
    icon('x'),
  );
  // A div: the dialog role is not allowed on an aside.
  const panel = h(
    'div',
    { class: `sheet ${options.side === 'left' ? 'left' : ''}`.trim(), role: 'dialog', 'aria-label': options.label },
    shut,
    body,
  );
  const previous = document.activeElement as HTMLElement | null;
  const close = () => {
    if (closeSheet !== close) return;
    closeSheet = null;
    off();
    scrim.remove();
    panel.remove();
    options.onClose?.();
    previous?.focus?.();
  };
  const off = push(panel, close);
  shut.onclick = close;
  scrim.onclick = close;
  document.body.append(scrim, panel);
  closeSheet = close;
  // The first thing to press that is shown gets the focus (the close key comes last), so the keyboard continues
  // inside the sheet.
  queueMicrotask(() => (reachable(body)[0] ?? shut).focus());
  return { body, close };
}

/** Closes whatever sheet is open. */
export function closeSheets(): void {
  closeSheet?.();
}

// Opens a dialog; resolves with what `content` decides when it closes.
function dialog<T>(
  build: (finish: (value: T) => void) => { title: string; text?: string; content?: Node; keys: Node[] },
  cancel: T,
): Promise<T> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const scrim = h('div', { class: 'scrim full' });
    let done = false;
    let off = () => {};
    const finish = (value: T) => {
      if (done) return;
      done = true;
      off();
      scrim.remove();
      box.remove();
      previous?.focus?.();
      resolve(value);
    };
    const parts = build(finish);
    const box = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': parts.title },
      h('div', { class: 'dialog-head' }, h('h2', null, parts.title)),
      parts.text ? h('p', { class: 'dialog-text' }, parts.text) : null,
      parts.content ? h('div', { class: 'dialog-content scroll' }, parts.content) : null,
      h('div', { class: 'dialog-keys' }, ...parts.keys),
    );
    off = push(box, () => finish(cancel));
    scrim.onclick = () => finish(cancel);
    document.body.append(scrim, box);
    // The input, else the first choice of a list, else the first key (Cancel, in a question).
    queueMicrotask(() => (box.querySelector('input, .choice, .key') as HTMLElement | null)?.focus());
  });
}

/** Asks before something that cannot be undone. */
export function confirmDialog(options: {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
}): Promise<boolean> {
  return dialog<boolean>(
    (finish) => ({
      title: options.title,
      text: options.text,
      keys: [
        h('button', { class: 'key', type: 'button', onclick: () => finish(false) }, t().cancel),
        h(
          'button',
          { class: `key ${options.danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => finish(true) },
          options.ok,
        ),
      ],
    }),
    false,
  );
}

/** Asks for a short text (a playlist name). */
export function askDialog(options: {
  title: string;
  text?: string;
  placeholder: string;
  value?: string;
  ok: string;
}): Promise<string | null> {
  return dialog<string | null>((finish) => {
    const input = h('input', {
      type: 'text',
      value: options.value ?? '',
      placeholder: options.placeholder,
      maxlength: '100',
      'aria-label': options.placeholder,
    });
    const submit = () => {
      const value = input.value.trim();
      if (value) finish(value);
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter') submit();
    };
    return {
      title: options.title,
      ...(options.text ? { text: options.text } : {}),
      content: h('label', { class: 'field' }, input),
      keys: [
        h('button', { class: 'key', type: 'button', onclick: () => finish(null) }, t().cancel),
        h('button', { class: 'key primary', type: 'button', onclick: submit }, options.ok),
      ],
    };
  }, null);
}

/** Shows something with a close key (the shortcuts, the playlists). */
export function showDialog(
  title: string,
  content: Node,
  keys: Node[] = [],
): { close: () => void; done: Promise<void> } {
  let closeIt: () => void = () => {};
  const done = dialog<void>((finish) => {
    closeIt = () => finish();
    return {
      title,
      content,
      keys: [...keys, h('button', { class: 'key', type: 'button', onclick: () => finish() }, t().close)],
    };
  }, undefined);
  return { close: () => closeIt(), done };
}
