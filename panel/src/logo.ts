/**
 * The jukecord mark: a jukebox's arch, lit in the colours that mean "playing now" across the panel, with a record
 * under it. The record takes the text colour (light on dark, dark on light) and its label ring is left open, so the
 * mark reads on any background; the same drawing is the favicon (panel/favicon.svg).
 */

// Each mark needs its own gradient ID: two marks on one page with one ID would share the first one's gradient.
let marks = 0;

/** The mark, drawn at `size` pixels. */
export function logoMark(size: number): SVGSVGElement {
  marks += 1;
  const id = `jukecord-arch-${marks}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  // A fixed drawing (no input in it), so innerHTML is safe.
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff6f61"/><stop offset=".26" stop-color="#ffb84d"/><stop offset=".5" stop-color="#4fcf86"/><stop offset=".74" stop-color="#4aa3ff"/><stop offset="1" stop-color="#a77bff"/></linearGradient></defs><path d="M12 61V31a20 20 0 0 1 40 0v30" fill="none" stroke="url(#${id})" stroke-width="7.5"/><path fill="currentColor" fill-rule="evenodd" d="M32 26.5a12.5 12.5 0 1 1 0 25a12.5 12.5 0 1 1 0-25zM32 34.4a4.6 4.6 0 1 0 0 9.2a4.6 4.6 0 1 0 0-9.2zM32 37.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z"/>`;
  return svg;
}
