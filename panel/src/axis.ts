/**
 * The top of a chart's y axis. Kept apart from the pages (which need a browser) so that it can be tested as it is.
 */

/** Clean axis ticks: the top is the maximum rounded up to a tidy number whose half (the middle line) is whole too,
 * close enough above the tallest bar that the bars use most of the height (52 gives 60, not 100). */
export function niceTop(max: number): number {
  if (max <= 2) return 2;
  if (max < 10) return Math.ceil(max / 2) * 2;
  const step = 10 ** Math.floor(Math.log10(max));
  // Rounded: 1.2 and 1.6 are not exact in binary, and the axis shows whole numbers.
  for (const factor of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10])
    if (Math.round(factor * step) >= max) return Math.round(factor * step);
  return 10 * step;
}
