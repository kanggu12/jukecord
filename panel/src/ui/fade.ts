/**
 * A box whose content scrolls fades out at an edge with more beyond it, over as much as there is beyond, up to about a
 * row of what it holds (its --fade in style.css), so a row the edge cuts reads as one going on out of sight, not as one
 * cut through its words: the log's first record sliced through its letters, a sliver of a cover at the queue's foot,
 * a dialog's list ending on a whole row with two more hidden under it and nothing saying so.
 *
 * The page tells the stylesheet how much there is beyond each edge (--fade-above and --fade-below, in pixels), and the
 * stylesheet draws the fade (a mask over the box, while it scrolls at all): from nothing at the start of a list to its
 * full height a row on, so a list moved by two pixels is not faded as if half its first row were gone.
 */

// Each box's way to look again, for the one listener below (the boxes are found in the page, so a box gone from it
// is forgotten with it).
const lookers = new WeakMap<HTMLElement, () => void>();
// A font coming in (a weight or a part of the alphabet first used now) changes what a box holds by its lines' lengths,
// with nothing added or removed and the box itself as large: every box looks again.
document.fonts.addEventListener('loadingdone', () => {
  for (const box of document.querySelectorAll<HTMLElement>('.scroll, .found-list')) lookers.get(box)?.();
});

/** Keeps a scrolling box's edges faded as it scrolls, grows, shrinks or changes what it holds. */
export function fadeEdges(box: HTMLElement): void {
  // One look per frame at most: scrolling, a resize and a redraw may all ask in one.
  let asked = 0;
  // What the box was last told, so a scroll that changes nothing writes nothing.
  let said = '';
  const look = () => {
    asked = 0;
    // The fade at its fullest (a length: style.css registers it), so a list scrolled far from its ends, faded fully at
    // both, writes nothing as it goes on scrolling.
    const most = Number.parseFloat(getComputedStyle(box).getPropertyValue('--fade')) || 0;
    // How far it is from each end (the box's own size, as its scrollbar sees it; a hidden box is 0 by 0), up to that.
    const above = Math.min(most, Math.max(0, box.scrollTop));
    const below = Math.min(most, Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop));
    // Within a pixel of an end is at it (a zoomed page leaves fractions).
    const scrolls = box.scrollHeight > box.clientHeight + 1;
    const now = scrolls ? `${Math.round(above)}|${Math.round(below)}` : '';
    if (now === said) return;
    said = now;
    if (!scrolls) {
      // Nothing to scroll: no mask at all (a mask costs the box a layer of its own).
      delete box.dataset.fade;
      box.style.removeProperty('--fade-above');
      box.style.removeProperty('--fade-below');
      return;
    }
    box.dataset.fade = '';
    // As much as lies beyond each edge, up to the box's --fade (lengths that its rows do not inherit: style.css).
    box.style.setProperty('--fade-above', `${Math.round(above)}px`);
    box.style.setProperty('--fade-below', `${Math.round(below)}px`);
  };
  const soon = () => {
    if (!asked) asked = window.requestAnimationFrame(look);
  };
  // Scrolled by anything (a wheel, a finger, the keyboard, the panel keeping a line in sight).
  box.addEventListener('scroll', soon, { passive: true });
  // Its own size changed (the window, a card above it growing, the box shown at last).
  new ResizeObserver(soon).observe(box);
  // What it holds changed (rows drawn, lines of new lyrics, records added): its length beyond the edges with them.
  new MutationObserver(soon).observe(box, { childList: true, subtree: true });
  lookers.set(box, soon);
  soon();
}
