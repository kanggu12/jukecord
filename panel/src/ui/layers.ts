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
  box.replaceChildren(
    h(
      'div',
      { class: `toast tone-${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
      icon(name),
      h('span', null, message),
    ),
  );
  // Problems stay a little longer: they usually need reading.
  toastTimer = window.setTimeout(() => box.replaceChildren(), tone === 'bad' ? 6000 : 3500);
}

/** Shows an error from an action as a toast. */
export function problem(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), 'bad', 'circle-alert');
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
  const panel = h(
    'aside',
    { class: `sheet ${options.side === 'left' ? 'left' : ''}`.trim(), role: 'dialog', 'aria-label': options.label },
    body,
  );
  const previous = document.activeElement as HTMLElement | null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  const close = () => {
    if (closeSheet !== close) return;
    closeSheet = null;
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey);
    options.onClose?.();
    previous?.focus?.();
  };
  scrim.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, panel);
  closeSheet = close;
  // The first thing to press gets the focus, so the keyboard continues inside the sheet.
  queueMicrotask(() => (panel.querySelector('button, input, a') as HTMLElement | null)?.focus());
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
    const finish = (value: T) => {
      if (done) return;
      done = true;
      scrim.remove();
      box.remove();
      document.removeEventListener('keydown', onKey);
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(cancel);
      // Tab stays inside the dialog.
      if (event.key === 'Tab') {
        const focusable = [...box.querySelectorAll<HTMLElement>('button, input, a[href]')].filter(
          (el) => !el.hasAttribute('disabled'),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    scrim.onclick = () => finish(cancel);
    document.addEventListener('keydown', onKey);
    document.body.append(scrim, box);
    queueMicrotask(() => (box.querySelector('input, .key.primary, .key.danger, .key') as HTMLElement | null)?.focus());
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
