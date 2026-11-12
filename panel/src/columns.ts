/**
 * The windows that show the player in one column: narrow ones, short ones up to 1100 px wide, and touch screens short of
 * height (their keys are a finger's size). Everywhere else the player has two columns.
 *
 * It must say exactly what the rule for one column in style.css says (tests/unit/columns.test.ts holds the two
 * together): the code asks it where the layout itself cannot answer, the lyrics opening as a sheet where there is no
 * column beside the player to show them in, and the add card's results lengthening a page that scrolls.
 */
export const ONE_COLUMN =
  '(max-width: 900px), (max-width: 1100px) and (max-height: 720px), (pointer: coarse) and (max-height: 820px)';
