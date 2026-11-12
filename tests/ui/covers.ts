/**
 * Made-up album covers for the example data: eight kinds of picture, each drawn as a small SVG in colours that follow
 * from the track's number, so every track has a cover of its own and the same one on every run. They stand in for the
 * pictures real tracks bring (a video's thumbnail, an album's cover) in the panel walk and in the README's pictures,
 * so each is a whole composition, centred or edge to edge, as a cover is: on the turning disc's label, which shows the
 * cover's middle, an off-centre shape would wobble.
 *
 * Nothing here is taken from a real cover.
 */

// A colour by hue, saturation and lightness; the hue wraps round.
const hsl = (hue: number, saturation: number, lightness: number): string =>
  `hsl(${((hue % 360) + 360) % 360},${saturation}%,${lightness}%)`;

// The pictures, each from one base hue. All fill the 120 by 120 square.
const KINDS: ((hue: number) => string)[] = [
  // A low sun over water: a dusk sky, the sun cut by the lines of its own reflection.
  (hue) => {
    const sea = hsl(hue + 230, 55, 14);
    return (
      `<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue + 250, 60, 20)}"/>` +
      `<stop offset=".62" stop-color="${hsl(hue + 320, 62, 42)}"/><stop offset="1" stop-color="${hsl(hue, 80, 60)}"/></linearGradient>` +
      `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue + 40, 95, 78)}"/>` +
      `<stop offset="1" stop-color="${hsl(hue, 90, 60)}"/></linearGradient></defs>` +
      `<rect width="120" height="120" fill="url(#a)"/><circle cx="60" cy="62" r="30" fill="url(#b)"/>` +
      `<rect y="78" width="120" height="42" fill="${sea}"/>` +
      `<g fill="${hsl(hue + 20, 90, 68)}"><rect x="36" y="81" width="48" height="3"/><rect x="42" y="88" width="36" height="3"/>` +
      `<rect x="47" y="95" width="26" height="2.5"/><rect x="52" y="102" width="16" height="2"/></g>`
    );
  },
  // Rings, like a record or ripples, from the middle out.
  (hue) =>
    `<rect width="120" height="120" fill="${hsl(hue + 200, 45, 15)}"/>` +
    [58, 47, 36, 25, 14]
      .map(
        (radius, ring) => `<circle cx="60" cy="60" r="${radius}" fill="${hsl(hue + ring * 14, 72, 30 + ring * 11)}"/>`,
      )
      .join(''),
  // Bands across the corner, in neighbouring colours.
  (hue) =>
    `<rect width="120" height="120" fill="${hsl(hue, 30, 92)}"/><g transform="rotate(-38 60 60)">` +
    [0, 1, 2, 3, 4]
      .map(
        (band) =>
          `<rect x="-60" y="${18 + band * 18}" width="240" height="13" fill="${hsl(hue + band * 22, 70, 36 + band * 7)}"/>`,
      )
      .join('') +
    '</g>',
  // Hills at dusk, one behind another.
  (hue) =>
    `<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue + 30, 85, 86)}"/>` +
    `<stop offset="1" stop-color="${hsl(hue, 75, 66)}"/></linearGradient></defs><rect width="120" height="120" fill="url(#a)"/>` +
    `<circle cx="60" cy="42" r="14" fill="${hsl(hue + 45, 100, 78)}"/>` +
    `<path d="M0 74 Q30 52 60 70 T120 62 V120 H0Z" fill="${hsl(hue + 200, 35, 52)}"/>` +
    `<path d="M0 90 Q34 68 66 86 T120 80 V120 H0Z" fill="${hsl(hue + 210, 40, 36)}"/>` +
    `<path d="M0 106 Q40 88 76 102 T120 98 V120 H0Z" fill="${hsl(hue + 220, 45, 22)}"/>`,
  // Dots that grow toward the middle.
  (hue) => {
    let dots = '';
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        const x = 12 + column * 16;
        const y = 12 + row * 16;
        const far = Math.hypot(x - 60, y - 60) / 68;
        dots += `<circle cx="${x}" cy="${y}" r="${(7 - far * 5.5).toFixed(1)}"/>`;
      }
    }
    return `<rect width="120" height="120" fill="${hsl(hue + 215, 50, 16)}"/><g fill="${hsl(hue, 85, 64)}">${dots}</g>`;
  },
  // Quarter circles from one corner, one inside another.
  (hue) =>
    `<rect width="120" height="120" fill="${hsl(hue + 40, 60, 90)}"/>` +
    [118, 92, 66, 40]
      .map((radius, arc) => `<circle cx="0" cy="120" r="${radius}" fill="${hsl(hue + arc * 28, 68, 56 - arc * 9)}"/>`)
      .join(''),
  // Waves, darker toward the bottom.
  (hue) =>
    `<rect width="120" height="120" fill="${hsl(hue + 20, 80, 88)}"/>` +
    [0, 1, 2, 3, 4]
      .map((wave) => {
        const y = 34 + wave * 18;
        return `<path d="M0 ${y} Q15 ${y - 9} 30 ${y} T60 ${y} T90 ${y} T120 ${y} V120 H0Z" fill="${hsl(hue + 190 + wave * 8, 60, 62 - wave * 10)}"/>`;
      })
      .join(''),
  // Blocks of colour with a rule between them.
  (hue) =>
    `<rect width="120" height="120" fill="${hsl(hue + 40, 25, 93)}"/>` +
    `<rect width="52" height="120" fill="${hsl(hue, 72, 52)}"/>` +
    `<rect x="56" width="64" height="58" fill="${hsl(hue + 205, 55, 24)}"/>` +
    `<rect x="56" y="62" width="30" height="58" fill="${hsl(hue + 45, 90, 62)}"/>` +
    `<rect x="90" y="62" width="30" height="58" fill="${hsl(hue + 150, 45, 58)}"/>`,
];

/** The cover of the track with this number, as an address an image can show (a data: URL holding the SVG). */
export function cover(index: number): string {
  // Neighbouring tracks differ in kind and in colour, and so do two covers of the same kind: the kind turns with
  // every track, the hue steps by 47 degrees, and each time round the kinds it jumps a further 101 (a step of 47
  // alone would bring a kind back in nearly the colours it had).
  const kind = KINDS[index % KINDS.length] ?? KINDS[0];
  const picture = kind ? kind((index * 47 + Math.floor(index / KINDS.length) * 101 + 20) % 360) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${picture}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
