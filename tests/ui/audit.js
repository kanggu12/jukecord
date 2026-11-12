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
 * - align: controls on one row of a group that differ in height or centre by more than 1px;
 * - crossing: a floating layer (toast, sheet, chart tip) whose edge cuts across another box;
 * - covered: the middle of a sheet, a dialog or a toast is not that layer (something is drawn over it: a sheet over
 *   the bar's toast, a dialog's shade over the bar);
 * - small-target: on a touch screen, a control smaller than 44 x 44;
 * - lone-key: the playing card's keys wrapped so that the last row holds one key alone (it reads as a close key);
 * - cramped: a list that scrolls inside its card (the queue, the history) holding more rows than it shows, but with
 *   room for fewer than three whole rows (a short window left the queue one row beside the cards above it, or none);
 * - sizes: the font sizes in use (reported, not a finding).
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

  // Alignment of controls on one row of a group.
  const groups = document.querySelectorAll(
    '.add, .now .keys, .card-head, .bar, .listen, .line, .page-head, .dialog-keys, .acts',
  );
  for (const group of groups) {
    if (!shown(group)) continue;
    const controls = [...group.children].filter(
      (child) => shown(child) && child.matches('button, .key, .field, .seg, input, .server, .account, .pill, .switch'),
    );
    const rows = new Map();
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      const key = Math.round(box.top / 8);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ control, box });
    }
    for (const row of rows.values()) {
      const kinds = row.filter((entry) => !entry.control.matches('.pill, .switch'));
      const heights = new Set(kinds.map((entry) => Math.round(entry.box.height)));
      if (heights.size > 1) add('align', group, `heights ${[...heights].join('/')}`);
      const centres = row.map((entry) => entry.box.top + entry.box.height / 2);
      if (Math.max(...centres) - Math.min(...centres) > 1.5)
        add('align', group, `centres differ by ${(Math.max(...centres) - Math.min(...centres)).toFixed(1)}px`);
    }
  }

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

  // The middle of a sheet, a dialog or a toast must be that layer (not a scrim or a sheet drawn over it).
  for (const layer of [...document.querySelectorAll('.sheet, .dialog, .toast')].filter(shown)) {
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

  return { findings, sizes: Object.fromEntries([...sizes.entries()].sort((a, b) => b[1] - a[1])) };
};
