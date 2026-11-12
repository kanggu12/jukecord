/**
 * The layout instrument, injected into the panel by tests/ui/walk.mjs: it measures what a person would notice and
 * returns each finding with where it is.
 *
 * - clipped: text cut off by its box (ellipsis or hidden overflow), unless marked data-clip="ok" with a title
 *   that carries the whole text;
 * - spills: a key whose icon and words run out of its own box (a width made for the icon alone, say);
 * - page-wide: the page scrolls sideways;
 * - overlap: two pieces of text drawn over each other;
 * - contrast: text below 4.5:1 against what is really behind it (translucent layers composited), 3:1 when large;
 * - align: the controls of one row (keys, fields, pickers, rows of choices, menus) at different heights, or with the
 *   labels and words standing in that row, at different centres;
 * - icon: an icon (or a lamp, a face, a swatch) off the centre of the line of words beside it;
 * - cards: cards side by side that do not share their top and their bottom (the player's two columns too);
 * - column: things stacked in a frame (a card, a sheet, a dialog, a page) whose left edges, or the right edges of boxes
 *   that end together, almost meet: a few pixels apart, which reads as a mistake rather than an indent;
 * - baseline: words side by side on one line (a title and its count, a name and its version) on different baselines;
 * - spacing: a padding, a margin or a gap off the spacing scale;
 * All of these to half a pixel: a careful eye sees one.
 * - crossing: a floating layer (toast, sheet, chart tip) whose edge cuts across another box;
 * - covered: the middle of a sheet, a dialog or a toast is not that layer (something is drawn over it: a sheet over
 *   the bar's toast, a dialog's shade over the bar); of dialogs opened one over another, the newest;
 * - small-target: on a touch screen, a control smaller than 44 x 44;
 * - lone-key: the playing card's keys wrapped so that the last row holds one key alone (it reads as a close key);
 * - unreachable: a box whose content scrolls that the keyboard cannot reach: not focusable itself, with nothing in it
 *   that is (the shortcuts' list in a short dialog), unless it is a listbox a combobox's field moves through;
 * - unmarked: a state told by a fill alone that is drawn the same as its absence: the choice in use of a row of
 *   choices or a key that is on like one that is not, the seek bar's played part, its knob, the switch's track or a
 *   chart's bar in the canvas's own colour (a contrast theme paints every background in its canvas colour);
 * - unsafe: on a screen with a notch, rounded corners or a home bar (safe-area insets), a key, a field or a card
 *   under them (the bars' keys within the insets above and below, everything within those at the sides);
 * - cramped: a list that scrolls inside its card (the queue, the history) holding more rows than it shows, but with
 *   room for fewer than three whole rows (a short window left the queue one row beside the cards above it, or none);
 * - adrift: the listen bar off the foot of the window: the page ran past the window and its bars scrolled with it (the
 *   search's results once pushed the queue's column 170 px past a 900 px window, and nothing above said so);
 * - sizes: the font sizes in use (reported, not a finding);
 * - distinct: how many different font sizes, control heights, corner radii, paddings and gaps the page shows (reported,
 *   not a finding: the fewer, the more the page reads as one system).
 *
 * Colours are read through a canvas, so any CSS colour (oklch, color-mix) becomes plain sRGB.
 */
window.__audit = () => {
  const findings = [];
  const add = (kind, element, detail) => {
    findings.push({ kind, where: describe(element), detail });
  };

  // A short, readable name for an element: its tag, id or first classes, and its text.
  function describe(element) {
    if (!element?.tagName) return String(element);
    const id = element.id ? `#${element.id}` : '';
    const classes = [...(element.classList ?? [])]
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('');
    const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${element.tagName.toLowerCase()}${id}${classes}${text ? ` "${text}"` : ''}`;
  }

  // Whether an element is drawn at all.
  function shown(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
    }
    return true;
  }

  // Any CSS colour as [r, g, b, a] (0-255, a 0-1), through a 1x1 canvas.
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext('2d', { willReadFrequently: true });
  const colourCache = new Map();
  function rgba(colour) {
    if (colourCache.has(colour)) return colourCache.get(colour);
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = '#000';
    paint.fillStyle = colour;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    const value = [r, g, b, a / 255];
    colourCache.set(colour, value);
    return value;
  }
  // Paints `top` over `bottom` (both [r,g,b,a]); the result is opaque when bottom is.
  function over(top, bottom) {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  }
  function luminance([r, g, b]) {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  function ratio(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }
  // What is behind an element: the page's colour with every ancestor's background painted over it, in order.
  function backdrop(element) {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
    }
    let result = rgba(getComputedStyle(document.body).backgroundColor);
    result = [result[0], result[1], result[2], 1];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  }

  // What of an element can be seen: its box, cut by every ancestor that clips its content (a scrolling list), by the
  // window, and (for the page's content) by the top bar and the listening bar, which are drawn over it.
  const topBar = document.querySelector('.bar');
  const bottomBar = document.querySelector('.listen');
  function visibleRect(element) {
    let box = element.getBoundingClientRect();
    let rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    const cut = (other) => {
      rect = {
        left: Math.max(rect.left, other.left),
        top: Math.max(rect.top, other.top),
        right: Math.min(rect.right, other.right),
        bottom: Math.min(rect.bottom, other.bottom),
      };
    };
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') cut(node.getBoundingClientRect());
    }
    cut({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    const floating = element.closest('.bar, .listen, .sheet, .dialog, .scrim, .chart-tip, .toast');
    if (!floating) {
      if (topBar && shown(topBar))
        cut({ left: -1e6, top: topBar.getBoundingClientRect().bottom, right: 1e6, bottom: 1e6 });
      if (bottomBar && shown(bottomBar))
        cut({ left: -1e6, top: -1e6, right: 1e6, bottom: bottomBar.getBoundingClientRect().top });
    }
    box = rect;
    return box.right - box.left > 0.5 && box.bottom - box.top > 0.5 ? box : null;
  }

  // Elements that draw text themselves (a direct text node that is not only spaces).
  const texts = [...document.querySelectorAll('body *')].filter(
    (element) =>
      !['SCRIPT', 'STYLE', 'svg', 'path'].includes(element.tagName) &&
      [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) &&
      shown(element),
  );

  // Font sizes in use.
  const sizes = new Map();
  for (const element of texts) {
    const size = getComputedStyle(element).fontSize;
    sizes.set(size, (sizes.get(size) ?? 0) + 1);
  }

  // Clipped text.
  for (const element of texts) {
    const style = getComputedStyle(element);
    const clips = style.overflowX !== 'visible' || style.textOverflow === 'ellipsis';
    if (!clips || element.closest('.sr')) continue;
    if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 2) {
      // Allowed only where the whole text is also given (a title), and marked as such.
      const allowed = element.closest('[data-clip="ok"]')?.getAttribute('title');
      if (!allowed)
        add(
          'clipped',
          element,
          `${element.scrollWidth}x${element.scrollHeight} in ${element.clientWidth}x${element.clientHeight}`,
        );
    }
  }

  // Keys whose content runs out of their box: drawn over the key's edge, it is not clipped, so the check above misses
  // it.
  // Badges too: a word that breaks inside its small pill spills out over and under it.
  for (const key of document.querySelectorAll('button, a.key, .key, .badge, .pill')) {
    if (!visibleRect(key) || key.closest('.sr')) continue;
    if (key.scrollWidth > key.clientWidth + 2) add('spills', key, `${key.scrollWidth} wide in ${key.clientWidth}`);
    if (key.matches('.badge, .pill') && key.scrollHeight > key.clientHeight + 2)
      add('spills', key, `${key.scrollHeight} high in ${key.clientHeight}`);
  }

  // Sideways scrolling of the page. Against the screen's width, not innerWidth: a phone's browser (and its emulation)
  // grows the layout viewport with a page that is too wide, so innerWidth would agree with the page.
  const screenWidth = Math.min(
    window.innerWidth,
    window.screen?.width || window.innerWidth,
    document.documentElement.clientWidth,
  );
  if (document.documentElement.scrollWidth > screenWidth + 1) {
    add(
      'page-wide',
      document.documentElement,
      `${document.documentElement.scrollWidth} wide in a ${screenWidth} screen`,
    );
  }

  // Text drawn over other text (outside the floating layers, which are meant to be on top).
  const flat = texts.filter((element) => !element.closest('.sheet, .dialog, .chart-tip, .tip, .toast'));
  const boxes = flat.map((element) => ({ element, box: visibleRect(element) })).filter((entry) => entry.box !== null);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      // People's faces are stacked a little over each other on purpose, each ringed in the card's colour; their
      // initials sit in the middle and never touch.
      const stack = a.element.closest('.faces');
      if (stack && stack === b.element.closest('.faces')) continue;
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      // More than a couple of pixels each way is a real overlap, not touching line boxes.
      if (x > 2 && y > 3) add('overlap', a.element, `with ${describe(b.element)}`);
    }
  }

  // Contrast of text against what is really behind it.
  for (const element of texts) {
    if (!visibleRect(element)) continue;
    const style = getComputedStyle(element);
    const colour = rgba(style.color);
    const behind = backdrop(element);
    const text = over(colour, behind);
    const value = ratio(text, behind);
    const size = Number.parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 600;
    const needed = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    // Disabled controls are exempt (WCAG 1.4.3 says so); they look disabled on purpose.
    if (element.closest(':disabled, [aria-disabled="true"]')) continue;
    if (value < needed) add('contrast', element, `${value.toFixed(2)}:1 (needs ${needed})`);
  }

  // (The rows of controls, icons, cards, columns, baselines and spacing are measured together further down.)

  // Floating layers must not cut across other boxes' edges.
  const solid = [...document.querySelectorAll('.card, .row, .channel, .bar, .listen, .tile')].filter(shown);
  const layers = [...document.querySelectorAll('.toast, .sheet, .chart-tip')].filter(shown);
  for (const layer of layers) {
    const a = layer.getBoundingClientRect();
    if (layer.matches('.toast')) {
      // Said in a dialog (its shade covers the bar): inside the dialog's own box.
      const dialog = layer.closest('.dialog')?.getBoundingClientRect();
      if (dialog) {
        const out =
          a.left < dialog.left - 0.5 ||
          a.right > dialog.right + 0.5 ||
          a.top < dialog.top - 0.5 ||
          a.bottom > dialog.bottom + 0.5;
        if (out) add('crossing', layer, 'outside its dialog');
        continue;
      }
      // A toast lives inside the top bar, or (on a narrow window) in the strip hanging right under it, as wide as the
      // window: the strip is part of the bar, and content passes under both.
      const barElement = document.querySelector('.bar');
      const bar = barElement.getBoundingClientRect();
      const strip = layer.closest('.toasts')?.getBoundingClientRect();
      // The strip hangs from the bar's inner edge, so it starts on the bar's bottom line (covering it) or right under.
      const line = Number.parseFloat(getComputedStyle(barElement).borderBottomWidth) || 0;
      const hanging =
        strip &&
        strip.top >= bar.bottom - line - 0.5 &&
        strip.top <= bar.bottom + 0.5 &&
        strip.left <= 0.5 &&
        strip.right >= document.documentElement.clientWidth - 0.5;
      // With a sheet open on a narrow window the strip hangs at the bottom of the window instead, right above the
      // listening bar and as wide as the window: under the bar it covered the sheet's first row and close key.
      const listen = document.querySelector('.listen')?.getBoundingClientRect();
      const above =
        strip &&
        listen &&
        document.querySelector('.sheet') &&
        Math.abs(strip.bottom - listen.top) <= 1.5 &&
        strip.left <= 0.5 &&
        strip.right >= document.documentElement.clientWidth - 0.5;
      if (above) {
        if (a.top < strip.top - 0.5 || a.bottom > strip.bottom + 0.5) add('crossing', layer, 'outside its strip');
        continue;
      }
      const bottom = hanging ? strip.bottom : bar.bottom;
      if (a.top < bar.top - 0.5 || a.bottom > bottom + 0.5) add('crossing', layer, 'outside the top bar');
      continue;
    }
    let crossed = 0;
    const names = [];
    for (const box of solid) {
      if (box.contains(layer) || layer.contains(box)) continue;
      if (layer.matches('.chart-tip') && box.contains(layer.parentElement)) continue;
      const b = visibleRect(box);
      if (!b) continue;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x <= 0.5 || y <= 0.5) continue;
      const inside =
        b.left >= a.left - 0.5 && b.right <= a.right + 0.5 && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5;
      // The bar the sheet hangs from and boxes entirely under the layer do not count.
      if (inside || box.matches('.bar')) continue;
      crossed += 1;
      if (names.length < 3) names.push(describe(box));
    }
    if (crossed > 0) add('crossing', layer, `${crossed} boxes: ${names.join(', ')}`);
  }

  // The middle of a sheet, a dialog or a toast must be that layer (not a scrim or a sheet drawn over it). A dialog
  // opened over another one (a playlist's file kinds over the playlists, a rename) covers the one under it by design:
  // only the newest dialog, the last in the page, is held to it.
  const dialogs = [...document.querySelectorAll('.dialog')].filter(shown);
  for (const layer of [...document.querySelectorAll('.sheet, .dialog, .toast')].filter(shown)) {
    if (layer.matches('.dialog') && layer !== dialogs.at(-1)) continue;
    const box = layer.getBoundingClientRect();
    const hit = document.elementsFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 120))[0];
    if (!layer.contains(hit)) add('covered', layer, `the middle is ${describe(hit)}`);
  }

  // The playing card's keys: wrapped onto more rows, the last row must not hold one key alone under several.
  for (const keys of document.querySelectorAll('.now .keys')) {
    if (!shown(keys)) continue;
    const rows = new Map();
    for (const key of [...keys.children].filter(shown)) {
      const top = Math.round(key.getBoundingClientRect().top / 8);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    const counts = [...rows.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    if (counts.length > 1 && counts.at(-1) === 1 && Math.max(...counts) > 1)
      add('lone-key', keys, `keys in rows of ${counts.join(' + ')}`);
  }

  // A box that scrolls must be within the keyboard's reach: itself, or something in it.
  const focusable =
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element);
    if (!/auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    if (element.scrollHeight <= element.clientHeight + 2 && element.scrollWidth <= element.clientWidth + 2) continue;
    if (!shown(element) || element.matches(focusable) || element.querySelector(focusable)) continue;
    // A listbox that a combobox controls is reached from its field, whose arrow keys move through it (and scroll it).
    if (
      element.matches('[role="listbox"][id]') &&
      document.querySelector(`[role="combobox"][aria-controls="${element.id}"]`)
    )
      continue;
    add('unreachable', element, `${element.scrollHeight} high in ${element.clientHeight}, with nothing to stop on`);
  }

  // States told apart by a fill alone must still be told apart, and what a fill alone draws must not be the
  // canvas's colour (in a contrast theme every background is).
  const look = (element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.backgroundImage, style.color, style.borderTopColor, style.outlineStyle].join();
  };
  for (const on of document.querySelectorAll('.seg [aria-pressed="true"], .key[aria-pressed="true"]')) {
    if (!shown(on)) continue;
    const off = [...on.parentElement.children].find(
      (other) =>
        other !== on && other.matches('button') && other.getAttribute('aria-pressed') !== 'true' && shown(other),
    );
    if (off && !off.matches('.primary, .quiet') && look(on) === look(off))
      add('unmarked', on, `drawn as ${describe(off)} is, which is not on`);
  }
  // The page's own colour (the canvas's, in a contrast theme).
  const ground = rgba(getComputedStyle(document.body).backgroundColor);
  const filled = [
    ['.track .fill', null, "the seek bar's played part"],
    ['.track .knob', null, "the seek bar's knob"],
    ['.switch', '::before', "the switch's track"],
    ['.bars .slot:not(.zero) .b', null, "a chart's bar"],
    ['.rank .meter i', null, "a rank's meter"],
  ];
  for (const [selector, pseudo, what] of filled) {
    const element = [...document.querySelectorAll(selector)].find(shown);
    if (!element) continue;
    const style = getComputedStyle(element, pseudo);
    if (style.backgroundImage !== 'none' || Number.parseFloat(style.borderTopWidth) > 0) continue;
    const colour = rgba(style.backgroundColor);
    const same =
      Math.abs(colour[0] - ground[0]) + Math.abs(colour[1] - ground[1]) + Math.abs(colour[2] - ground[2]) < 8;
    if (colour[3] < 0.05 || same) add('unmarked', element, `${what} is drawn in the canvas's colour`);
  }

  // The safe area: what the screen's notch, corners and home bar leave (read from the browser itself, through a
  // probe of env(), so a page that ignores the insets is measured too).
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.append(probe);
  const inset = getComputedStyle(probe);
  const safe = {
    top: Number.parseFloat(inset.paddingTop),
    right: Number.parseFloat(inset.paddingRight),
    bottom: Number.parseFloat(inset.paddingBottom),
    left: Number.parseFloat(inset.paddingLeft),
  };
  probe.remove();
  if (safe.top + safe.right + safe.bottom + safe.left > 0) {
    const things = document.querySelectorAll(
      '.bar button, .bar a, .bar .pill, .listen button, .listen input, .listen .what, .main .card, .sheet button',
    );
    for (const thing of things) {
      if (!shown(thing)) continue;
      const box = thing.getBoundingClientRect();
      // Cards scroll with the page under the bars: only the sides count for them.
      const fixed = thing.closest('.bar, .listen');
      const out =
        box.left < safe.left - 0.5 ||
        box.right > window.innerWidth - safe.right + 0.5 ||
        (fixed && (box.top < safe.top - 0.5 || box.bottom > window.innerHeight - safe.bottom + 0.5));
      if (out)
        add(
          'unsafe',
          thing,
          `${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)}`,
        );
    }
  }

  // Lists that scroll inside their card must show at least three whole rows when they hold more than they show.
  for (const list of document.querySelectorAll('.card .list.scroll')) {
    if (!shown(list) || list.scrollHeight <= list.clientHeight + 1) continue;
    const rows = [...list.children].filter((row) => row.matches('li.row') && shown(row));
    if (rows.length < 4) continue;
    const box = list.getBoundingClientRect();
    const whole = rows.filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    }).length;
    if (whole < 3) add('cramped', list, `${whole} whole rows in ${Math.round(box.height)}px`);
  }

  // Touch targets on touch screens.
  if (matchMedia('(pointer: coarse)').matches) {
    // Every control a finger presses: keys, fields, the switch and the sliders (the seek bar too), and links that
    // are not words in a sentence (the logo, the page links).
    for (const control of document.querySelectorAll(
      'button, a.key, a.brand, .nav a, .field, input[type="range"], .switch, [role="slider"]',
    )) {
      if (!shown(control) || !visibleRect(control)) continue;
      const box = control.getBoundingClientRect();
      // A slider is wider than tall by nature: its height alone must reach a finger's.
      const short = control.matches('input[type="range"], [role="slider"]')
        ? box.height < 43.5
        : box.width < 43.5 || box.height < 43.5;
      if (short) add('small-target', control, `${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }

  // The listen bar stands at the foot of the window in every layout (the page scrolls under it on a phone).
  const listen = document.querySelector('.listen');
  if (listen && shown(listen)) {
    const foot = listen.getBoundingClientRect().bottom;
    if (Math.abs(foot - window.innerHeight) > 1)
      add('adrift', listen, `its foot at ${Math.round(foot)} in a window ${window.innerHeight}px tall`);
  }

  // ---- rows and columns ---------------------------------------------------------------------------------------------
  // What the eye lines up, held to half a pixel (a careful eye sees one): the controls of one row share one height and
  // one centre, an icon shares the centre of its words, cards side by side share their top and bottom, what is stacked
  // in a frame starts at one left edge, words side by side sit on one baseline, and every space comes from one scale.
  const HALF = 0.5;
  // What a person presses or fills in. One inside another (a field's clear key, the buttons of a row of choices) is
  // measured as part of the one around it, not as a control of the row.
  const CONTROL = [
    'button',
    'a.key',
    '.key',
    '.field',
    '.seg',
    'select',
    'textarea',
    'input:not([type="range"], [type="checkbox"], [type="radio"], [type="hidden"])',
    '.server',
    '.account',
    '.nav a',
    '.pick',
  ].join(', ');
  // What stands in a row at a height of its own, centred in it as the controls are: a label, a switch, a slider, the
  // bar's divider and its logo, a mark (an icon, a lamp, a face, a swatch).
  const LABEL =
    '.pill, .badge, .switch, input[type="range"], .divider, .brand, svg.icon, .dot, .avatar, .guild-icon, .swatch';
  // What is a row of its own, not one control among others: a choice in a list, a line of lyrics, a search's result
  // (and what floats over the page, which nothing else lines up with).
  const APART = '.choice, .lyric, .result, [role="option"], .chart-tip, .tip, .toasts, .sr';
  // The marks that sit beside words.
  const MARK = 'svg.icon, .dot, .avatar, .guild-icon, .swatch';

  // The page does not change while it is measured: what is worked out once for an element is kept (thousands of
  // elements are asked about several times each).
  const fadedMemo = new Map();
  const clipMemo = new Map();
  const seenMemo = new Map();
  // Whether an element or one around it is all but transparent.
  function faded(node) {
    if (!node || node === document.documentElement) return false;
    if (!fadedMemo.has(node))
      fadedMemo.set(node, Number(getComputedStyle(node).opacity) < 0.05 || faded(node.parentElement));
    return fadedMemo.get(node);
  }
  // The part of the window what is inside a node can be seen in: the window, cut by every box around it that clips.
  function clipOf(node) {
    if (!node || node === document.documentElement)
      return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    if (!clipMemo.has(node)) {
      let rect = clipOf(node.parentElement);
      const style = getComputedStyle(node);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const box = node.getBoundingClientRect();
        rect = {
          left: Math.max(rect.left, box.left),
          top: Math.max(rect.top, box.top),
          right: Math.min(rect.right, box.right),
          bottom: Math.min(rect.bottom, box.bottom),
        };
      }
      clipMemo.set(node, rect);
    }
    return clipMemo.get(node);
  }
  // The bars' edges: the page's content passes under them.
  const barFoot = topBar && shown(topBar) ? topBar.getBoundingClientRect().bottom : 0;
  const listenTop = bottomBar && shown(bottomBar) ? bottomBar.getBoundingClientRect().top : window.innerHeight;
  // Whether an element is drawn where it can be seen: shown(), but a decoration hidden from screen readers counts (the
  // eye sees it), and only what is not scrolled away or under a bar.
  function seen(element) {
    if (seenMemo.has(element)) return seenMemo.get(element);
    let result = element instanceof Element && !element.closest('[hidden], .sr');
    if (result) {
      const style = getComputedStyle(element);
      result = style.display !== 'none' && style.visibility !== 'hidden' && !faded(element);
    }
    if (result) {
      const box = element.getBoundingClientRect();
      const clip = clipOf(element.parentElement);
      // What is not inside a bar or a layer is covered where the bars are.
      const floating = element.closest('.bar, .listen, .sheet, .dialog, .scrim, .chart-tip, .toast');
      const top = Math.max(box.top, clip.top, floating ? -1e6 : barFoot);
      const bottom = Math.min(box.bottom, clip.bottom, floating ? 1e6 : listenTop);
      const width = Math.min(box.right, clip.right) - Math.max(box.left, clip.left);
      result = box.width >= 1 && box.height >= 1 && width > 0.5 && bottom - top > 0.5;
    }
    seenMemo.set(element, result);
    return result;
  }
  // Whether an element draws a box of its own (a fill, a picture, a shadow or a ring, borders at its sides): its edges
  // are then what is seen of it. A line along its foot alone (a card's head) is a rule across it, not a box.
  function drawsBox(element) {
    const style = getComputedStyle(element);
    if (rgba(style.backgroundColor)[3] > 0.02 || style.backgroundImage !== 'none' || style.boxShadow !== 'none')
      return true;
    const side = (width, colour) => Number.parseFloat(width) > 0 && rgba(colour)[3] > 0.02;
    return side(style.borderLeftWidth, style.borderLeftColor) && side(style.borderRightWidth, style.borderRightColor);
  }
  // Whether an element lays out its children side by side: a flex row, or a grid of more than one column.
  function isRow(element) {
    const style = getComputedStyle(element);
    if (style.display.includes('flex')) return !style.flexDirection.startsWith('column');
    if (style.display.includes('grid')) return style.gridTemplateColumns.trim().split(/\s+/).length > 1;
    return false;
  }
  // The words' baseline as a share of their box: per typeface, read once from a probe (a box set on the baseline beside
  // a letter), so the panel's face and the code's monospace each give their own.
  const ascents = new Map();
  function ascent(family) {
    if (ascents.has(family)) return ascents.get(family);
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;font:100px/normal ${family}`;
    const letter = document.createTextNode('H');
    const foot = document.createElement('span');
    foot.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    probe.append(letter, foot);
    // On the root, not the body: the stylesheet's rules on what the body holds (body:has(> .sheet)) stay as they are.
    document.documentElement.append(probe);
    const range = document.createRange();
    range.selectNodeContents(letter);
    const box = range.getBoundingClientRect();
    const share = (foot.getBoundingClientRect().bottom - box.top) / box.height;
    probe.remove();
    ascents.set(family, share);
    return share;
  }
  // Whether an element is drawn at all, wherever it is (scrolled away or not): its lines are its lines.
  const drawn = (element) => {
    if (element.closest('[hidden], .sr') || faded(element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  // The lines of words an element draws, top to bottom: each one box (the content area of its letters, which the line
  // is centred on) and its baseline. Words inside a control or a label within it belong to that one, not to these.
  function linesOf(element, own = element) {
    const rects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent.trim() || !parent || !drawn(parent)) continue;
      // Inside a control or a framed label of its own, other than the element measured: not its words.
      const holder = parent.closest(`${CONTROL}, .pill, .badge, .avatar, .guild-icon`);
      if (holder && holder !== own && own.contains(holder)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const style = getComputedStyle(parent);
      const share = ascent(style.fontFamily);
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        rects.push({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          base: rect.top + share * rect.height,
          size: rect.height,
        });
      }
    }
    rects.sort((a, b) => a.top - b.top);
    const lines = [];
    for (const rect of rects) {
      const last = lines.at(-1);
      const shared = last ? Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top) : 0;
      // On the line before when it overlaps it by half the smaller height.
      if (last && shared > Math.min(last.bottom - last.top, rect.bottom - rect.top) / 2) {
        // The line's baseline is its largest letters'.
        if (rect.size > last.size) Object.assign(last, { base: rect.base, size: rect.size });
        Object.assign(last, {
          left: Math.min(last.left, rect.left),
          right: Math.max(last.right, rect.right),
          top: Math.min(last.top, rect.top),
          bottom: Math.max(last.bottom, rect.bottom),
        });
      } else lines.push({ ...rect });
    }
    return lines;
  }
  const middle = (box) => box.top + (box.bottom - box.top) / 2;
  const height = (box) => box.bottom - box.top;
  // How much two boxes share vertically, as a share of the shorter one.
  const sharedHeight = (a, b) =>
    (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / Math.min(height(a), height(b));
  // Groups items into the lines they stand on: items sharing half the shorter one's height are on one line.
  function bands(items, box = (item) => item.box) {
    const groups = [];
    for (const item of items) {
      const group = groups.find((members) => members.some((other) => sharedHeight(box(item), box(other)) >= 0.5));
      if (group) group.push(item);
      else groups.push([item]);
    }
    return groups;
  }
  const names = (items) =>
    items
      .slice(0, 4)
      .map((item) => describe(item.element))
      .join(', ');
  const px = (value) => `${Math.round(value * 10) / 10}`;

  // The controls of one row. What stands in a row: its controls and labels, the words of an item of one line (of its
  // first line, in a row that lines its items up at their tops), and what stands in a wrapper that is a row of its own
  // with no box (a card head's tools). Wrappers measured as part of their row are not measured again on their own.
  const inRow = new Set();
  function members(row, top) {
    const out = [];
    for (const item of row.children) {
      if (getComputedStyle(item).display === 'contents') {
        out.push(...members(item, top));
        continue;
      }
      if (!seen(item) || item.matches(APART)) continue;
      if (item.matches(CONTROL)) out.push({ element: item, box: item.getBoundingClientRect(), control: true });
      else if (item.matches(LABEL)) out.push({ element: item, box: item.getBoundingClientRect(), control: false });
      else if (isRow(item) && !drawsBox(item) && !/baseline/.test(getComputedStyle(item).alignItems)) {
        inRow.add(item);
        out.push(...members(item, top));
      } else if (isRow(item) && !item.querySelector(CONTROL)) {
        // Words set on one baseline (a title and its dates): one line of words in the row, whatever their sizes.
        const lines = linesOf(item);
        if (lines.length > 0) {
          const box = {
            left: Math.min(...lines.map((line) => line.left)),
            right: Math.max(...lines.map((line) => line.right)),
            top: Math.min(...lines.map((line) => line.top)),
            bottom: Math.max(...lines.map((line) => line.bottom)),
          };
          out.push({ element: item, box, control: false, words: box });
        }
      } else if (!item.querySelector(CONTROL)) {
        const lines = linesOf(item);
        if (lines.length === 1 || (top && lines.length > 1))
          out.push({ element: item, box: lines[0], control: false, words: lines[0] });
      }
    }
    return out;
  }
  for (const row of document.querySelectorAll('body *')) {
    if (inRow.has(row) || !isRow(row) || !seen(row) || row.closest(APART)) continue;
    // A row inside a control (a key's icon and words) is the icon check's.
    if (row.matches(CONTROL) || row.parentElement?.closest(CONTROL)) continue;
    const top = ['flex-start', 'start', 'self-start', 'baseline', 'first baseline'].includes(
      getComputedStyle(row).alignItems,
    );
    for (const line of bands(members(row, top))) {
      // A row of controls: at least one control and something beside it.
      const controls = line.filter((item) => item.control);
      if (controls.length === 0 || line.length < 2) continue;
      const heights = controls.map((item) => height(item.box));
      if (Math.max(...heights) - Math.min(...heights) > HALF)
        add('align', row, `controls of one row ${[...new Set(heights.map(px))].join('/')} px high: ${names(controls)}`);
      const centres = line.map((item) => middle(item.box));
      if (Math.max(...centres) - Math.min(...centres) > HALF) {
        const low = line[centres.indexOf(Math.min(...centres))];
        const high = line[centres.indexOf(Math.max(...centres))];
        add('align', row, `centres ${px(Math.max(...centres) - Math.min(...centres))} px apart: ${names([low, high])}`);
      }
    }
  }
  // A control inside another one (a field's clear key) stands in its middle.
  for (const inner of document.querySelectorAll(CONTROL)) {
    const outer = inner.parentElement?.closest(CONTROL);
    if (!outer || !seen(inner) || outer.matches('.seg') || inner.matches('input, select, textarea')) continue;
    const off = middle(inner.getBoundingClientRect()) - middle(outer.getBoundingClientRect());
    if (Math.abs(off) > HALF) add('align', inner, `${px(off)} px off the middle of ${describe(outer)}`);
  }

  // An icon and its words: the mark's centre on the centre of the line beside it (the first line, when the words take
  // more). A mark with no words beside it on its line (above them, or alone in a key) has nothing to line up with.
  for (const mark of document.querySelectorAll(MARK)) {
    if (!seen(mark) || mark.closest('.disc, .album, .faces, .chart-tip')) continue;
    // A mark inside a mark (a face's initials) is part of it.
    if (mark.parentElement?.closest(MARK)) continue;
    const holder = mark.parentElement;
    const box = mark.getBoundingClientRect();
    // The lines of the holder's own words beside the mark: on its line, starting or ending within 24 px of it.
    const beside = linesOf(holder, holder.closest(CONTROL) ?? holder).filter(
      (line) =>
        !(line.left >= box.left - 0.5 && line.right <= box.right + 0.5) &&
        Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top) > 0 &&
        (Math.abs(line.left - box.right) < 24 || Math.abs(box.left - line.right) < 24),
    );
    if (beside.length === 0) continue;
    // The first of them: an icon belongs on the first line of what it marks. A mark taller than that line (a face
    // beside a name and the line under it) cannot stand on one line: it is centred on the lines beside it.
    // A line's height is the distance from one line to the next (the boxes read are the letters', inside their lines).
    const block = { top: beside[0].top, bottom: beside.at(-1).bottom };
    const pitch = beside.length > 1 ? beside[1].top - beside[0].top : Number.POSITIVE_INFINITY;
    const target = height(box) > pitch + HALF ? block : beside[0];
    const off = middle(box) - middle(target);
    if (Math.abs(off) > HALF) add('icon', holder, `${describe(mark)} ${px(off)} px off its words' centre`);
  }

  // Cards side by side: one top and one bottom (the room left over is inside a card, not under it).
  const cardsOf = (parent) => [...parent.children].filter((child) => child.matches('.card, .tile') && seen(child));
  const parents = new Set([...document.querySelectorAll('.card, .tile')].map((card) => card.parentElement));
  for (const parent of parents) {
    for (const line of bands(cardsOf(parent).map((element) => ({ element, box: element.getBoundingClientRect() })))) {
      if (line.length < 2) continue;
      const tops = line.map((item) => item.box.top);
      const bottoms = line.map((item) => item.box.bottom);
      if (Math.max(...tops) - Math.min(...tops) > HALF)
        add('cards', parent, `tops ${px(Math.max(...tops) - Math.min(...tops))} px apart: ${names(line)}`);
      if (Math.max(...bottoms) - Math.min(...bottoms) > HALF)
        add('cards', parent, `bottoms ${px(Math.max(...bottoms) - Math.min(...bottoms))} px apart: ${names(line)}`);
    }
  }
  // The player's two columns: their first cards share a top and their last cards a bottom.
  for (const main of document.querySelectorAll('.main')) {
    const columns = [...main.children]
      .filter((child) => child.matches('.col') && seen(child))
      .map((column) => cardsOf(column));
    if (columns.length !== 2 || columns.some((cards) => cards.length === 0)) continue;
    const [left, right] = columns.map((cards) => ({
      first: cards[0].getBoundingClientRect(),
      last: cards.at(-1).getBoundingClientRect(),
    }));
    // Side by side only (one column stacks them).
    if (left.first.right > right.first.left) continue;
    if (Math.abs(left.first.top - right.first.top) > HALF)
      add('cards', main, `the columns' first cards' tops ${px(Math.abs(left.first.top - right.first.top))} px apart`);
    if (Math.abs(left.last.bottom - right.last.bottom) > HALF)
      add(
        'cards',
        main,
        `the columns' last cards' bottoms ${px(Math.abs(left.last.bottom - right.last.bottom))} px apart`,
      );
  }

  // What is stacked in a column starts at one left edge, and the boxes that end its lines end at one right edge: the
  // children of one container laid out one under another (a card's head and its body, a card's rows, a sheet's
  // sections, the cards of a column) are meant to line up. Each child's left edge is what is seen first in it: words, a
  // picture, a mark, a box that draws itself (a key, a field); a card's is where its insides start, and a row's where
  // its words start (the pane behind a row under the pointer is not its edge). Its right edge is the box that ends it,
  // when one does (words end where they end). Two edges a few pixels apart (more than half a pixel, up to 6) almost
  // meet: no one indents by 3 px on purpose.
  // What is not part of a column: a layer, a tooltip, a chart's axis labels (each under its own bar), and what floats
  // over its box (positioned absolutely: a close key in a corner, a slider's knob).
  const OFF_COLUMN = '.sr, .chart-tip, .tip, .toasts, .scrim, .axis, .yaxis, .ambient';
  // Whether an element is laid out in its parent's flow.
  const inFlow = (element) => !['absolute', 'fixed'].includes(getComputedStyle(element).position);
  // Whether an element centres what it holds (an empty state, a key's insides): its left edge is wherever the middle
  // puts it, not a column.
  const centres = (style) =>
    ['center', 'right', 'end', '-webkit-center'].includes(style.textAlign) ||
    [style.justifyContent, style.justifyItems].some((value) => /center/.test(value));
  // What is seen inside an element: lines of words, pictures and marks, and boxes that draw themselves (not looked
  // into). A slider is one box (its knob moves). `own`: the element's own box counts when it draws one.
  function leavesOf(element, own) {
    const leaves = [];
    const walk = (node, centred) => {
      for (const child of node.children) {
        if (child.matches(OFF_COLUMN) || !inFlow(child)) continue;
        if (getComputedStyle(child).display === 'contents') {
          walk(child, centred);
          continue;
        }
        if (!seen(child)) continue;
        const box = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        if (
          child.matches('img, svg, canvas, video, input, select, textarea, .disc, .album, .switch, [role="slider"]') ||
          drawsBox(child)
        ) {
          if (!centred) leaves.push({ element: child, box, drawn: true });
          continue;
        }
        const middling = centred || centres(style);
        for (const text of child.childNodes) {
          if (text.nodeType !== 3 || !text.textContent.trim() || middling) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects())
            if (rect.width > 0.5) leaves.push({ element: child, box: rect, drawn: false });
        }
        walk(child, middling);
      }
    };
    if (own && drawsBox(element)) return [{ element, box: element.getBoundingClientRect(), drawn: true }];
    walk(element, centres(getComputedStyle(element)));
    return leaves;
  }
  // A row of a list: its edge is its words', whatever pane is behind it.
  const ROWISH = 'li, .row, .result, .choice, .channel, [role="option"]';
  for (const column of document.querySelectorAll('body *')) {
    if (!seen(column) || column.closest(APART) || column.matches(`${OFF_COLUMN}, svg, svg *`)) continue;
    if (column.parentElement?.closest(CONTROL) || column.matches(CONTROL)) continue;
    // Laid out side by side, it is a row (the rows check's); a column holds its children one under another.
    if (isRow(column) || centres(getComputedStyle(column))) continue;
    const children = [...column.children].filter(
      (child) =>
        !child.matches(OFF_COLUMN) && inFlow(child) && seen(child) && getComputedStyle(child).display !== 'contents',
    );
    if (children.length < 2) continue;
    const edges = children
      .map((child) => {
        // A card's edges are where its insides start and end; a row's where its words do; anything else's what is
        // seen first and last in it.
        const card = child.matches('.card, .tile, .sheet, .dialog');
        const leaves = leavesOf(child, !card && !child.matches(ROWISH));
        if (leaves.length === 0) return null;
        const left = Math.min(...leaves.map((leaf) => leaf.box.left));
        // The right edge: the box that ends its lines, when the last thing is a box set at the end of its row, and that
        // row at the end of what holds it, up to the child (a key pushed to the right of its row); a box that merely
        // comes last (a heart after a title) ends nowhere in particular.
        const last = leaves.reduce((end, leaf) => (leaf.box.right > end.box.right ? leaf : end));
        let flush = last.drawn;
        let node = last.element;
        let right = last.box.right;
        while (flush && node !== child && node.parentElement) {
          const parent = node.parentElement;
          const style = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          const inner = box.right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
          flush = Math.abs(right - inner) <= 1;
          node = parent;
          right = box.right;
        }
        return { element: child, box: child.getBoundingClientRect(), left, right: flush ? last.box.right : null };
      })
      .filter(Boolean);
    const said = new Set();
    for (const a of edges)
      for (const b of edges) {
        // One under the other only.
        if (a === b || !(b.box.top >= a.box.bottom - 2)) continue;
        for (const [edge, what] of [
          ['left', 'left edges'],
          ['right', 'right edges'],
        ]) {
          if (a[edge] === null || b[edge] === null) continue;
          const gap = Math.abs(a[edge] - b[edge]);
          const key = `${edge}|${px(Math.min(a[edge], b[edge]))}|${px(Math.max(a[edge], b[edge]))}`;
          if (gap <= HALF || gap > 6 || said.has(key)) continue;
          said.add(key);
          add('column', column, `${what} ${px(gap)} px apart: ${describe(a.element)}, ${describe(b.element)}`);
        }
      }
  }

  // A row that wraps onto more lines (a card's head with its tools under its title) starts each line at one left
  // edge, the first thing seen on each, as a column does: nothing indents a wrapped line on purpose, so any difference
  // counts (up to 24 px; a row that centres or right-aligns its lines is not held to it).
  for (const row of document.querySelectorAll('body *')) {
    if (!isRow(row) || !seen(row) || row.closest(APART) || row.matches(CONTROL) || row.parentElement?.closest(CONTROL))
      continue;
    const style = getComputedStyle(row);
    if (style.flexWrap !== 'wrap' || !/^(normal|flex-start|start|left)$/.test(style.justifyContent)) continue;
    const items = [...row.children]
      .filter((child) => inFlow(child) && seen(child) && !child.matches(OFF_COLUMN))
      .map((child) => ({ element: child, box: child.getBoundingClientRect() }));
    // The first item of each line: the leftmost of the items sharing a line.
    const firsts = bands(items).map((line) => line.reduce((a, b) => (b.box.left < a.box.left ? b : a)));
    if (firsts.length < 2) continue;
    const starts = firsts
      .map((first) => {
        const leaves = leavesOf(first.element, !first.element.matches(ROWISH));
        return leaves.length
          ? { element: first.element, left: Math.min(...leaves.map((leaf) => leaf.box.left)) }
          : null;
      })
      .filter(Boolean);
    const lefts = starts.map((start) => start.left);
    const spread = Math.max(...lefts) - Math.min(...lefts);
    if (spread > HALF && spread <= 24)
      add(
        'column',
        row,
        `its wrapped lines start ${px(spread)} px apart: ${starts
          .map((start) => describe(start.element))
          .slice(0, 3)
          .join(', ')}`,
      );
  }

  // Words side by side on one line share a baseline: a name and its version, a title and its count, a label and its
  // value. Words inside a control or a label are centred in its box, and are not held to it.
  for (const row of document.querySelectorAll('body *')) {
    if (!isRow(row) || !seen(row) || row.closest(APART) || row.matches(CONTROL) || row.parentElement?.closest(CONTROL))
      continue;
    const words = [];
    for (const item of row.children) {
      if (!seen(item) || item.matches(`${CONTROL}, ${LABEL}, ${APART}`) || item.querySelector(CONTROL)) continue;
      const lines = linesOf(item);
      if (lines.length > 0) words.push({ element: item, box: lines[0], base: lines[0].base });
    }
    for (const line of bands(words)) {
      if (line.length < 2) continue;
      const bases = line.map((item) => item.base);
      if (Math.max(...bases) - Math.min(...bases) > HALF)
        add('baseline', row, `baselines ${px(Math.max(...bases) - Math.min(...bases))} px apart: ${names(line)}`);
    }
  }

  // The space between things comes from one scale. Read as the stylesheet resolved it (the typed object model gives
  // "auto" as a word, where the plain computed style gives the room it took).
  // A 4 px grid up to 24 (with 2 and 6 for the tightest), an 8 px one beyond.
  const SCALE = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96];
  const offScale = new Map();
  // Every value seen, for the counts below.
  const used = { paddings: new Set(), gaps: new Set(), radii: new Set(), controls: new Set() };
  const lengthOf = (map, property) => {
    const value = map.get(property);
    return value instanceof CSSUnitValue && value.unit === 'px' ? value.value : null;
  };
  for (const element of document.querySelectorAll('body *')) {
    // The field's light is a picture scaled over the window, not a layout.
    if (element.closest('svg, .ambient') || !seen(element)) continue;
    const map = element.computedStyleMap();
    const style = getComputedStyle(element);
    const spaces = [];
    // The room a screen's notch, corners or home bar take (its safe-area insets) is the device's, not the design's.
    const device = (value) => Object.values(safe).some((inset) => inset > 0 && Math.abs(value - inset) < 0.05);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const padding = lengthOf(map, `padding-${side}`);
      if (padding && !device(padding)) {
        spaces.push(['padding', padding]);
        used.paddings.add(px(padding));
      }
      const margin = lengthOf(map, `margin-${side}`);
      if (margin && !device(Math.abs(margin))) {
        spaces.push(['margin', Math.abs(margin)]);
        used.gaps.add(px(Math.abs(margin)));
      }
    }
    // A gap counts where it stands between two things.
    if (/flex|grid/.test(style.display) && [...element.children].filter(seen).length > 1)
      for (const property of ['row-gap', 'column-gap']) {
        const gap = lengthOf(map, property);
        if (gap) {
          spaces.push(['gap', gap]);
          used.gaps.add(px(gap));
        }
      }
    for (const [what, value] of spaces) {
      if (SCALE.some((step) => Math.abs(value - step) < 0.05)) continue;
      const key = px(value);
      if (!offScale.has(key)) offScale.set(key, []);
      const places = offScale.get(key);
      const place = `${what} of ${describe(element).split(' ')[0]}`;
      if (!places.includes(place)) places.push(place);
    }
    // Corners of what draws a box: a corner as round as the box is "round", whatever its number.
    if (drawsBox(element)) {
      const box = element.getBoundingClientRect();
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      used.radii.add(radius >= Math.min(box.width, box.height) / 2 - 0.5 ? 'round' : px(radius));
    }
  }
  for (const [value, places] of offScale)
    add(
      'spacing',
      document.body,
      `${value} px off the scale: ${places.slice(0, 4).join(', ')}${places.length > 4 ? ` and ${places.length - 4} more` : ''}`,
    );
  // The heights of the controls a person sees (one inside another is part of it).
  // A field of many lines (a list to paste) is as tall as what it holds, not a control of a row's height.
  for (const control of document.querySelectorAll(CONTROL))
    if (seen(control) && !control.parentElement?.closest(CONTROL) && !control.matches(`${APART}, textarea`))
      used.controls.add(px(control.getBoundingClientRect().height));
  const sorted = (set) => [...set].sort((a, b) => (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0));
  const distinct = {
    // The sizes of words a person sees (a heading kept for screen readers alone is a pixel wide).
    fonts: sorted(
      new Set(
        texts
          .filter((element) => !element.closest('.sr'))
          .map((element) => px(Number.parseFloat(getComputedStyle(element).fontSize))),
      ),
    ),
    controls: sorted(used.controls),
    radii: sorted(used.radii),
    paddings: sorted(used.paddings),
    gaps: sorted(used.gaps),
  };

  return { findings, sizes: Object.fromEntries([...sizes.entries()].sort((a, b) => b[1] - a[1])), distinct };
};
