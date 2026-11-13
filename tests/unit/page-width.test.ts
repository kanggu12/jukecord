/**
 * The widest the pages' content grows (--page-max) and the window from which a sheet hangs in the page's side (390 px
 * on either side of the content: room for the sheet and half a gap) are said apart in the stylesheet: they must agree,
 * or between the two a sheet's edge cuts across the right column's cards, or a sheet hangs narrower than a phone's.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

// The stylesheet as it is in the checkout.
const css = fs.readFileSync(new URL('../../panel/style.css', import.meta.url), 'utf8');

describe('the page at its widest', () => {
  it('lets a sheet hang in its side from the window that has room for it', () => {
    const widest = Number(/--page-max:\s*(\d+)px;/.exec(css)?.[1]);
    // The window from which the sheet hangs in the page's side, and below which a guest's player steps aside for it.
    const hangs = Number(/@media \(min-width: (\d+)px\) \{\s*\.sheet:not\(\.left\)/.exec(css)?.[1]);
    const stepsAside = Number(
      /@media \(width < (\d+)px\) \{\s*body:has\(> \.sheet:not\(\.left\)\) \.main\.guest/.exec(css)?.[1],
    );
    assert.ok(widest > 0 && hangs > 0 && stepsAside > 0, 'the three rules are in the stylesheet');
    assert.equal(hangs, widest + 2 * 390);
    assert.equal(stepsAside, hangs);
  });
});
