/**
 * The windows with one column are said twice, in the stylesheet (the layout) and in the panel's code (where the lyrics
 * open, how the add card's results fit): the two must be the same rule, or a window between them shows two columns with
 * the lyrics in a sheet over them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { ONE_COLUMN } from '../../panel/src/columns.ts';

// The stylesheet as it is in the checkout.
const css = fs.readFileSync(new URL('../../panel/style.css', import.meta.url), 'utf8');

describe('the windows with one column', () => {
  it('are the same rule in the code and in the stylesheet', () => {
    // The rule's block in the stylesheet, found by its query as the code says it.
    const start = css.indexOf(`@media ${ONE_COLUMN} {`);
    assert.ok(start >= 0, `style.css has no @media ${ONE_COLUMN}`);
    // Its first rule is the player's grid in one column (up to the next @media, so another block's cannot answer).
    const end = css.indexOf('@media', start + 1);
    const block = css.slice(start, end < 0 ? undefined : end);
    assert.match(block, /\.main\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  });

  it('is the only rule that puts the player in one column', () => {
    // Every block that gives the player's grid one column: a second one would be a rule the code does not know.
    const blocks = [...css.matchAll(/@media ([^{]+)\{\s*\.main\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/g)];
    assert.deepEqual(
      blocks.map((match) => match[1]?.trim()),
      [ONE_COLUMN],
    );
  });
});
