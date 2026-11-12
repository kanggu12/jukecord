/**
 * Wrapped as a picture to share: a story (1080 by 1920) or a square (1080 by 1080), drawn on a canvas in the panel's
 * own look. The field is lit by the song of the time, as the panel's is by the track playing (its cover, blurred far
 * out of shape); the cards are the panel's glass; the type is the panel's; the rainbow is where the panel has it: the
 * rim of the record and jukecord's mark. The colours are the panel's own tokens, read from its stylesheet as it is
 * now, so the picture is in the theme the panel shows.
 *
 * The covers come from jukecord's own address, so the canvas may be read back into a PNG. The server's icon and
 * people's pictures come from Discord and are drawn only when Discord lets them be read (otherwise their initials
 * are, as the panel does when a picture does not load).
 */
import { initials } from '../dom.ts';

/** The two shapes: a phone's story, and a square for a post. */
export type Shape = 'story' | 'square';

/** What the picture says, in words already in the person's language (wrapped.ts makes them). */
export interface PictureContent {
  /** The language they are in: English labels are set in spaced capitals, as the cards' heads are. */
  readonly lang: 'en' | 'ko';
  readonly server: { readonly name: string; readonly icon: string | null };
  /** The time, big ("2026", "November", "12 months"), and the words under it ("in music"), for the story. */
  readonly big: string;
  readonly sub: string;
  /** The same on one line, as the page's title says it ("2026 in music"), for the square. */
  readonly title: string;
  /** The first and the last day, in words. */
  readonly range: string;
  readonly song: {
    readonly label: string;
    readonly title: string;
    readonly artist: string | null;
    /** Its facts on one line ("played on 145 days · 227 plays"), and apart for when that line does not fit. */
    readonly facts: string;
    readonly factsApart: readonly string[];
    readonly cover: string | null;
  } | null;
  /** Four totals: a label, a value and the unit beside the value. */
  readonly numbers: readonly { readonly label: string; readonly value: string; readonly unit: string }[];
  readonly tracksLabel: string;
  readonly tracks: readonly {
    readonly title: string;
    readonly plays: string;
    readonly cover: string | null;
  }[];
  /** The moments: the busiest day and hour, the longest day (a label, and its value). */
  readonly moments: readonly { readonly label: string; readonly value: string }[];
  /** Who added most: up to three, each with a face and their plays. */
  readonly peopleLabel: string;
  readonly people: readonly { readonly name: string; readonly picture: string | null; readonly plays: string }[];
}

// The size of each shape, in the picture's own pixels.
const SIZES: Record<Shape, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

// The panel's colours and type as its stylesheet has them now (this theme), for drawing.
interface Look {
  readonly font: string;
  readonly bg: string;
  readonly bgTop: string;
  readonly pools: readonly string[];
  readonly panel: string;
  readonly sheen: string;
  readonly sheenStop: number;
  readonly edge: string;
  readonly rim: string;
  readonly shadow: string;
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly line: string;
  readonly raised: string;
  readonly disc: string;
  readonly groove: string;
  readonly rainbow: readonly string[];
  readonly ambient: number;
  readonly saturate: number;
  readonly brightness: number;
}

// Reads the panel's tokens from the page's root: the values its theme set there.
function lookNow(): Look {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  // The first rgb()/rgba() colour in a token that holds more (a gradient, a shadow).
  const colour = (name: string, fallback: string) => /rgba?\([^)]*\)/.exec(token(name))?.[0] ?? fallback;
  const tone = token('--ambient-tone');
  return {
    font: getComputedStyle(document.body).fontFamily || 'sans-serif',
    bg: token('--bg') || '#0d0e12',
    bgTop: token('--bg-top') || '#111318',
    pools: ['--pool-a', '--pool-b', '--pool-c'].map((name) => token(name) || 'transparent'),
    panel: token('--panel') || 'rgba(30, 32, 39, 0.55)',
    sheen: colour('--sheen', 'rgba(255, 255, 255, 0.045)'),
    sheenStop: Number(/(\d+)%\s*\)\s*$/.exec(token('--sheen'))?.[1] ?? 42) / 100,
    edge: token('--edge') || 'rgba(255, 255, 255, 0.085)',
    rim: colour('--rim', 'rgba(255, 255, 255, 0.09)'),
    shadow: colour('--shadow', 'rgba(0, 0, 0, 0.7)'),
    ink: token('--ink') || '#eef0f4',
    ink2: token('--ink-2') || '#c2c6d1',
    ink3: token('--ink-3') || '#a7acba',
    line: token('--line') || 'rgba(255, 255, 255, 0.07)',
    raised: token('--raised-2') || 'rgba(255, 255, 255, 0.1)',
    disc: token('--disc') || '#0b0c10',
    groove: token('--groove') || 'rgba(255, 255, 255, 0.045)',
    rainbow: (token('--rainbow') || '#ff6f61, #ffb84d, #4fcf86, #4aa3ff, #a77bff, #ff6f61')
      .split(',')
      .map((part) => part.trim()),
    ambient: Number(token('--ambient')) || 0.32,
    saturate: Number(/saturate\(([\d.]+)\)/.exec(tone)?.[1] ?? 1.5),
    brightness: Number(/brightness\(([\d.]+)\)/.exec(tone)?.[1] ?? 0.6),
  };
}

// A picture, loaded and decoded; null when it cannot be had in a few seconds (it is then left out, or drawn as
// initials). Pictures from elsewhere (Discord) are asked for with CORS, which is what lets the canvas be read back.
async function picture(address: string | null): Promise<HTMLImageElement | null> {
  if (!address) return null;
  const image = new Image();
  if (!address.startsWith('/')) image.crossOrigin = 'anonymous';
  image.src = address;
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('too slow')), 6000)),
    ]);
    return image;
  } catch {
    return null;
  }
}

// One kind of text: its size and weight, its colour, and the space between letters.
interface Type {
  readonly size: number;
  readonly weight: number;
  readonly colour: string;
  readonly spacing?: number;
  readonly align?: CanvasTextAlign;
}

/** Draws text and wraps it; the pieces share the canvas and the look. */
class Ink {
  readonly ctx: CanvasRenderingContext2D;
  readonly look: Look;

  constructor(ctx: CanvasRenderingContext2D, look: Look) {
    this.ctx = ctx;
    this.look = look;
  }

  // Sets the context's font and colour for one kind of text.
  private use(type: Type): void {
    // The panel's own family (Pretendard, then the system's), at the weight and size asked.
    this.ctx.font = `${type.weight} ${type.size}px ${this.look.font}`;
    this.ctx.fillStyle = type.colour;
    // Left unless said (a count at the end of its line is set from the right).
    this.ctx.textAlign = type.align ?? 'left';
    // Every y given is a baseline, as type is set.
    this.ctx.textBaseline = 'alphabetic';
    // Where the browser can space letters on a canvas (the labels in capitals are spaced, as the panel's are).
    if ('letterSpacing' in this.ctx) this.ctx.letterSpacing = `${type.spacing ?? 0}px`;
  }

  /** How wide a text is in a type. */
  width(text: string, type: Type): number {
    this.use(type);
    return this.ctx.measureText(text).width;
  }

  /**
   * The lines a text takes in a width: broken between words (Korean too, as the panel breaks it), a word longer than
   * the width broken between its letters, and the last line cut with an ellipsis when the text needs more lines.
   */
  lines(text: string, type: Type, width: number, most: number): string[] {
    this.use(type);
    const fits = (line: string) => this.ctx.measureText(line).width <= width;
    const lines: string[] = [];
    // The line being filled, word by word.
    let current = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const tried = current ? `${current} ${word}` : word;
      if (fits(tried)) {
        current = tried;
        continue;
      }
      // The word does not fit beside the others: the line ends before it.
      if (current) lines.push(current);
      // A word wider than the line on its own: as many letters as fit, line after line.
      current = '';
      for (const letter of word) {
        if (fits(current + letter)) current += letter;
        else {
          lines.push(current);
          current = letter;
        }
      }
    }
    if (current) lines.push(current);
    if (lines.length <= most) return lines;
    // Too many: the last line kept is cut short with an ellipsis, so it shows the text goes on.
    const kept = lines.slice(0, most);
    let last = `${kept[most - 1] ?? ''} ${lines[most] ?? ''}`;
    while (last.length > 1 && !fits(`${last}…`)) last = [...last].slice(0, -1).join('');
    kept[most - 1] = `${last.trimEnd()}…`;
    return kept;
  }

  /** Writes a text at a baseline, wrapped to a width in at most `most` lines; returns the last line's baseline. */
  write(text: string, x: number, y: number, type: Type, width = 10_000, most = 1, leading = 1.22): number {
    const lines = this.lines(text, type, width, most);
    this.use(type);
    // Each line a line's height under the one before.
    lines.forEach((line, index) => {
      this.ctx.fillText(line, x, y + index * type.size * leading);
    });
    return y + Math.max(0, lines.length - 1) * type.size * leading;
  }

  /** Writes the largest size of a type (down to a floor) at which a text fits a width on one line. */
  fit(text: string, x: number, y: number, type: Type, width: number, floor: number): void {
    let size = type.size;
    // Two pixels smaller at a time until it fits; at the floor, the ellipsis cuts what is left over.
    while (size > floor && this.width(text, { ...type, size }) > width) size -= 2;
    this.write(text, x, y, { ...type, size }, width, 1);
  }
}

// A rounded rectangle's path (drawn by hand: the canvas's own roundRect is newer than the browsers the panel serves).
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  // From the top edge, each corner rounded on the way round.
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The field: the page's colour falling from its top, the three soft pools of light, and the song's cover blurred far
// out of shape over it, toned for the theme (darker on the dark field, brighter on the pale one), as the panel's light.
function field(
  ctx: CanvasRenderingContext2D,
  look: Look,
  width: number,
  height: number,
  cover: HTMLImageElement | null,
) {
  // The page's own fall from its top colour to its ground, as the body's background (320 of a 1080-wide window).
  const fall = ctx.createLinearGradient(0, 0, 0, height);
  fall.addColorStop(0, look.bgTop);
  fall.addColorStop(0.3, look.bg);
  ctx.fillStyle = fall;
  ctx.fillRect(0, 0, width, height);
  // The pools where the body's background has them: up left, down right, and a faint one at the top.
  for (const [pool, x, y, r] of [
    [look.pools[0], 0.15, 0.2, 0.75],
    [look.pools[1], 0.88, 0.78, 0.65],
    [look.pools[2], 0.55, 0.05, 0.5],
  ] as const) {
    // Each pool a soft circle of its colour, fading to nothing at its edge.
    const glow = ctx.createRadialGradient(x * width, y * height, 0, x * width, y * height, r * Math.max(width, height));
    glow.addColorStop(0, pool ?? 'transparent');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }
  if (!cover) return;
  // The cover as a few pixels (its middle, as the panel's light shows it), toned, then grown back by steps: each step
  // smooths what the last left, which blurs it the way a filter would, in every browser.
  const seed = document.createElement('canvas');
  seed.width = 6;
  seed.height = 6;
  // Read back once, so the browser keeps it where reading is quick.
  const small = seed.getContext('2d', { willReadFrequently: true });
  if (!small) return;
  // The cover's middle square, shrunk to six by six (the browser averages as it shrinks).
  const side = Math.min(cover.naturalWidth, cover.naturalHeight);
  small.drawImage(cover, (cover.naturalWidth - side) / 2, (cover.naturalHeight - side) / 2, side, side, 0, 0, 6, 6);
  const pixels = small.getImageData(0, 0, 6, 6);
  const data = pixels.data;
  // CSS's saturate() and brightness(), on each of the 36 pixels.
  const s = look.saturate;
  for (let at = 0; at < data.length; at += 4) {
    const [r = 0, g = 0, b = 0] = [data[at], data[at + 1], data[at + 2]];
    const tone = (value: number) => Math.max(0, Math.min(255, value * look.brightness));
    data[at] = tone((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b);
    data[at + 1] = tone((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b);
    data[at + 2] = tone((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b);
  }
  small.putImageData(pixels, 0, 0);
  // Grown four times at a time, smoothed at each step.
  let step: HTMLCanvasElement = seed;
  for (const size of [24, 96, 384]) {
    const next = document.createElement('canvas');
    next.width = size;
    next.height = size;
    const grow = next.getContext('2d');
    if (!grow) return;
    grow.imageSmoothingEnabled = true;
    grow.imageSmoothingQuality = 'high';
    grow.drawImage(step, 0, 0, size, size);
    step = next;
  }
  ctx.save();
  // As strong as the panel's light in this theme (its --ambient).
  ctx.globalAlpha = look.ambient;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Square, as big as the picture's longer side, centred: the cover's middle lights the middle.
  const big = Math.max(width, height) * 1.1;
  ctx.drawImage(step, (width - big) / 2, (height - big) / 2, big, big);
  ctx.restore();
}

// A card of the panel's glass: its long soft shadow, the tinted pane, the sheen falling from its top, the bright line
// along its top edge, and its edge.
function glass(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, w: number, h: number): void {
  // The panel's card corner (18 pixels) at the picture's scale, about two and a half times a phone's.
  const r = 44;
  ctx.save();
  // The shadow falls long and soft under the card, as --shadow has it.
  ctx.shadowColor = look.shadow;
  ctx.shadowBlur = 72;
  ctx.shadowOffsetY = 28;
  rounded(ctx, x, y, w, h, r);
  // The pane: the panel's tinted glass, the field showing through it.
  ctx.fillStyle = look.panel;
  ctx.fill();
  ctx.restore();
  // The sheen from the top edge, gone by a little under half the card (--sheen).
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, look.sheen);
  sheen.addColorStop(look.sheenStop, 'rgba(255, 255, 255, 0)');
  rounded(ctx, x, y, w, h, r);
  ctx.fillStyle = sheen;
  ctx.fill();
  // The rim: a bright line just inside the top edge, fading out along the curve of the corners.
  ctx.save();
  rounded(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.strokeStyle = look.rim;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + r * 0.6, y + 2);
  ctx.lineTo(x + w - r * 0.6, y + 2);
  ctx.stroke();
  ctx.restore();
  // The edge, just inside the card so it is not cut by the card's own corners.
  rounded(ctx, x + 1, y + 1, w - 2, h - 2, r - 1);
  ctx.strokeStyle = look.edge;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// A picture filling a rounded square, its middle shown (as the panel's object-fit: cover).
function cover(
  ctx: CanvasRenderingContext2D,
  look: Look,
  image: HTMLImageElement | null,
  x: number,
  y: number,
  size: number,
  r: number,
): void {
  ctx.save();
  // Everything drawn next stays inside the rounded square.
  rounded(ctx, x, y, size, size, r);
  ctx.clip();
  if (image) {
    // The picture's middle square (a video's frame is wider than tall), drawn to fill the case.
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      x,
      y,
      size,
      size,
    );
  } else {
    // No picture: the case's own glass, as a row shows it, with a note in the middle.
    ctx.fillStyle = look.raised;
    ctx.fillRect(x, y, size, size);
    note(ctx, look.ink3, x + size / 2, y + size / 2, size * 0.36);
  }
  ctx.restore();
  // A faint edge, as the panel's case has one.
  rounded(ctx, x + 0.5, y + 0.5, size - 1, size - 1, r);
  ctx.strokeStyle = look.line;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// The music note the panel shows where a cover is missing (Lucide's music-2, drawn at a size).
function note(ctx: CanvasRenderingContext2D, colour: string, cx: number, cy: number, size: number): void {
  ctx.save();
  // The icon's own 24-unit grid, placed and scaled to the size asked.
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  // Its line as the panel's icons draw theirs: two units wide, round at the ends.
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The stem and its flag, then the note's head.
  ctx.stroke(new Path2D('M12 18V2l8 3.5'));
  ctx.beginPath();
  ctx.arc(8, 18, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// The record: dark vinyl with its grooves and a light falling across it, the cover on its label round the spindle
// hole, and the rainbow on its rim.
function record(
  ctx: CanvasRenderingContext2D,
  look: Look,
  image: HTMLImageElement | null,
  cx: number,
  cy: number,
  radius: number,
): void {
  // The rainbow rim, travelling round the record as the panel's does (still, here).
  const rim = typeof ctx.createConicGradient === 'function' ? ctx.createConicGradient(-Math.PI / 3, cx, cy) : null;
  // The mark's colours evenly round the circle, ending where they began (--rainbow).
  if (rim)
    for (const [index, stop] of look.rainbow.entries()) rim.addColorStop(index / (look.rainbow.length - 1), stop);
  // A disc a little larger than the record, which the record then covers but for its rim (one colour where a browser
  // has no conic gradient).
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 9, 0, Math.PI * 2);
  ctx.fillStyle = rim ?? look.rainbow[3] ?? '#4aa3ff';
  ctx.fill();
  // The vinyl, in the panel's disc colour.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = look.disc;
  ctx.fill();
  // The grooves: thin rings across the vinyl.
  ctx.strokeStyle = look.groove;
  ctx.lineWidth = Math.max(1.5, radius * 0.012);
  for (const at of [0.62, 0.7, 0.78, 0.86, 0.94]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * at, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The light across it, from the upper left.
  const light = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.44, 0, cx, cy, radius);
  light.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
  light.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = light;
  ctx.fill();
  // The label: the cover again, round.
  const label = radius * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, label, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    // The cover's middle square on the round label, as the panel's disc shows it.
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      cx - label,
      cy - label,
      label * 2,
      label * 2,
    );
  } else {
    // No cover: the plain label the panel's disc has without one.
    const plain = ctx.createLinearGradient(cx - label, cy - label, cx + label, cy + label);
    plain.addColorStop(0, '#3a3d48');
    plain.addColorStop(1, '#23252d');
    ctx.fillStyle = plain;
    ctx.fillRect(cx - label, cy - label, label * 2, label * 2);
  }
  ctx.restore();
  // The spindle hole, dark with a thin light ring.
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = '#08090c';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// The song's album: the record half out of its case, behind it, and the cover in the case (a row's album, big).
function album(
  ctx: CanvasRenderingContext2D,
  look: Look,
  image: HTMLImageElement | null,
  x: number,
  y: number,
  size: number,
) {
  // The record a little smaller than the case, its middle past the case's edge: half of it shows.
  const radius = size * 0.46;
  record(ctx, look, image, x + size * 0.62 + radius, y + size / 2, radius);
  ctx.save();
  // The case's shadow on the record behind it, as a row's album has one.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  rounded(ctx, x, y, size, size, size * 0.08);
  ctx.fillStyle = look.disc;
  ctx.fill();
  ctx.restore();
  // The cover in the case, over it.
  cover(ctx, look, image, x, y, size, size * 0.08);
}

// A face: the picture in a circle, or the initials on the panel's raised glass.
function face(
  ctx: CanvasRenderingContext2D,
  look: Look,
  ink: Ink,
  image: HTMLImageElement | null,
  name: string,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.save();
  // A circle, everything inside it.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  // The field's colour under it, so the glass over the light does not show through a face.
  ctx.fillStyle = look.bg;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  if (image) {
    ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    // As the panel's .avatar: the raised glass, the initials in the second ink, in the middle.
    ctx.fillStyle = look.raised;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ink.write(initials(name), cx, cy + radius * 0.34, {
      size: Math.round(radius * 0.9),
      weight: 600,
      colour: look.ink2,
      align: 'center',
    });
  }
  ctx.restore();
}

// jukecord's mark: the arch in the rainbow and the record under it, in the text's colour (as panel/src/logo.ts draws
// it), `size` pixels square.
function mark(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 64, size / 64);
  const arch = ctx.createLinearGradient(12, 0, 52, 0);
  // The mark's own five colours, as panel/src/logo.ts has them.
  for (const [index, stop] of ['#ff6f61', '#ffb84d', '#4fcf86', '#4aa3ff', '#a77bff'].entries())
    arch.addColorStop(index / 4, stop);
  ctx.strokeStyle = arch;
  ctx.lineWidth = 7.5;
  ctx.stroke(new Path2D('M12 61V31a20 20 0 0 1 40 0v30'));
  ctx.fillStyle = look.ink;
  ctx.fill(
    new Path2D(
      'M32 26.5a12.5 12.5 0 1 1 0 25a12.5 12.5 0 1 1 0-25zM32 34.4a4.6 4.6 0 1 0 0 9.2a4.6 4.6 0 1 0 0-9.2zM32 37.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z',
    ),
    'evenodd',
  );
  ctx.restore();
}

// A card's head as the panel's are: its words as written, in the second ink. Spaced capitals read as decoration, and
// the panel has none.
function head(ink: Ink, text: string, x: number, y: number, size: number, width: number) {
  ink.write(text, x, y, { size, weight: 650, colour: ink.look.ink2 }, width);
}

/** Draws the picture of a time in one shape; resolves with the canvas, ready to be saved. */
export async function drawPicture(content: PictureContent, shape: Shape): Promise<HTMLCanvasElement> {
  const look = lookNow();
  const { width, height } = SIZES[shape];
  // Every word drawn, so the font's pieces that hold their letters are loaded before any is drawn (a canvas does not
  // wait for a font as a page does).
  const words = [
    content.server.name,
    content.big,
    content.sub,
    content.title,
    content.range,
    content.song?.label,
    content.song?.title,
    content.song?.artist,
    content.song?.facts,
    ...(content.song?.factsApart ?? []),
    content.tracksLabel,
    content.peopleLabel,
    ...content.numbers.flatMap((entry) => [entry.label, entry.value, entry.unit]),
    ...content.tracks.flatMap((entry) => [entry.title, entry.plays]),
    ...content.moments.flatMap((entry) => [entry.label, entry.value]),
    ...content.people.flatMap((entry) => [entry.name, initials(entry.name), entry.plays]),
    'jukecord…0123456789',
  ]
    .filter(Boolean)
    .join(' ');
  await Promise.all(
    [400, 650].map((weight) => document.fonts.load(`${weight} 40px ${look.font}`, words).catch(() => [])),
  );
  // The pictures, all at once: the song's cover, the server's icon, the tracks' covers and the faces.
  const [songCover, icon, ...rest] = await Promise.all([
    picture(content.song?.cover ?? null),
    picture(content.server.icon),
    ...content.tracks.map((entry) => picture(entry.cover)),
    ...content.people.map((entry) => picture(entry.picture)),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const ink = new Ink(ctx, look);
  const pictures: Pictures = {
    songCover: songCover ?? null,
    icon: icon ?? null,
    trackCovers: rest.slice(0, content.tracks.length),
    faces: rest.slice(content.tracks.length),
  };
  field(ctx, look, width, height, pictures.songCover);
  if (shape === 'story') story(ctx, ink, content, pictures);
  else square(ctx, ink, content, pictures);
  return canvas;
}

// The pictures a layout draws.
interface Pictures {
  readonly songCover: HTMLImageElement | null;
  readonly icon: HTMLImageElement | null;
  readonly trackCovers: readonly (HTMLImageElement | null)[];
  readonly faces: readonly (HTMLImageElement | null)[];
}

// The server: its icon (or its first letter, as the panel's bar shows one without an icon) and its name.
function server(ink: Ink, content: PictureContent, icon: HTMLImageElement | null, x: number, y: number, size: number) {
  const { ctx, look } = ink;
  const name = content.server.name;
  ctx.save();
  // The icon round, as the panel's bar shows it.
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = look.raised;
  ctx.fillRect(x, y, size, size);
  if (icon) ctx.drawImage(icon, x, y, size, size);
  // No icon (or one Discord would not let be read): the name's first letter.
  else
    ink.write([...name][0]?.toUpperCase() ?? '?', x + size / 2, y + size * 0.67, {
      size: Math.round(size * 0.46),
      weight: 650,
      colour: look.ink2,
      align: 'center',
    });
  ctx.restore();
  // The name beside it, on one line (cut with an ellipsis past the width a picture has for it).
  ink.write(name, x + size + 22, y + size * 0.68, { size: Math.round(size * 0.5), weight: 650, colour: look.ink }, 760);
}

// A card of totals side by side: each a label over a big value with its unit, thin lines between them.
function numbers(ink: Ink, content: PictureContent, x: number, y: number, w: number, h: number, big: number) {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const cells = content.numbers;
  // The card's width shared evenly; each cell's words start a little inside it.
  const each = w / cells.length;
  const labelSize = Math.round(big * 0.4);
  cells.forEach((cell, index) => {
    const left = x + index * each + 34;
    const room = each - 52;
    // The label as large as fits its cell, down to a floor.
    ink.fit(cell.label, left, y + h * 0.36, { size: labelSize, weight: 500, colour: look.ink2 }, room, labelSize - 6);
    // The value big, its unit beside it smaller; a long one is made smaller to fit.
    const unitType: Type = { size: Math.round(big * 0.42), weight: 500, colour: look.ink2 };
    // A little apart from the value, as the panel's tiles set it.
    const gap = Math.round(big * 0.1);
    const unitWidth = cell.unit ? ink.width(cell.unit, unitType) + gap : 0;
    let size = big;
    // Big and bold, set a touch tight as the panel's tiles are.
    const valueType = () => ({ size, weight: 700, colour: look.ink, spacing: -size * 0.02 });
    while (size > big * 0.6 && ink.width(cell.value, valueType()) + unitWidth > room) size -= 2;
    // Under the label by the value's own size.
    const baseline = y + h * 0.36 + size * 1.12;
    ink.write(cell.value, left, baseline, valueType());
    if (cell.unit) ink.write(cell.unit, left + ink.width(cell.value, valueType()) + gap, baseline, unitType, room);
    // A thin line before every cell but the first.
    if (index > 0) {
      ctx.fillStyle = look.line;
      ctx.fillRect(x + index * each, y + 28, 2, h - 56);
    }
  });
}

// The song of the time: its label, its album (the record half out of the case), and its title, artist and facts
// beside it, centred on the album.
function songCard(
  ink: Ink,
  content: PictureContent,
  cover: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
) {
  const song = content.song;
  if (!song) return;
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 44 * scale;
  head(ink, song.label, x + pad, y + 66 * scale, Math.round(26 * scale), w - pad * 2);
  // The album fills the card's height under its head, square.
  const size = h - 150 * scale;
  const top = y + 96 * scale;
  album(ctx, look, cover, x + pad, top, size);
  // The album takes its case and the record's half beyond it, with the rim.
  const left = x + pad + size * 1.54 + 36 * scale;
  const room = x + w - pad - left;
  // As the playing card sets a track: the title big and bold, the artist and the rest in the second ink.
  const titleType: Type = { size: Math.round(44 * scale), weight: 700, colour: look.ink, spacing: -0.5 };
  const artistType: Type = { size: Math.round(29 * scale), weight: 500, colour: look.ink2 };
  const factType: Type = { size: Math.round(27 * scale), weight: 500, colour: look.ink2 };
  // A long title takes up to three lines, the last cut short.
  const titles = ink.lines(song.title, titleType, room, 3);
  // The facts on one line when they fit, else each on its own.
  const facts = ink.width(song.facts, factType) <= room ? [song.facts] : [...song.factsApart];
  // How tall the words are, to centre them.
  const tall =
    titles.length * titleType.size * 1.2 +
    (song.artist ? artistType.size * 1.6 : 0) +
    12 * scale +
    facts.length * factType.size * 1.35;
  // The block of words centred on the album.
  let line = top + size / 2 - tall / 2 + titleType.size * 0.9;
  for (const title of titles) {
    ink.write(title, left, line, titleType);
    line += titleType.size * 1.2;
  }
  if (song.artist) {
    line += artistType.size * 0.35;
    ink.write(song.artist, left, line, artistType, room);
    line += artistType.size * 1.25;
  }
  line += 12 * scale;
  for (const fact of facts) {
    line += factType.size * 0.1;
    ink.write(fact, left, line, factType, room);
    line += factType.size * 1.25;
  }
}

// A card listing tracks on their covers (or people on their faces), each with its count at the end of the line.
function listCard(
  ink: Ink,
  title: string,
  rows: readonly {
    readonly text: string;
    readonly count: string;
    readonly draw: (x: number, y: number, size: number) => void;
  }[],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 44 * scale;
  head(ink, title, x + pad, y + 62 * scale, Math.round(25 * scale), w - pad * 2);
  const rowHeight = 56 * scale;
  const picture = 42 * scale;
  // The name in the ink, its count in the second ink at the end of the line, as the panel's ranks.
  const textType: Type = { size: Math.round(29 * scale), weight: 600, colour: look.ink };
  const countType: Type = { size: Math.round(27 * scale), weight: 500, colour: look.ink2, align: 'right' };
  rows.forEach((row, index) => {
    const top = y + 86 * scale + index * rowHeight;
    // Everything on the row is set on its middle: the baseline a little under it.
    const middle = top + rowHeight / 2;
    // The rank, faint, as the panel's.
    ink.write(String(index + 1), x + pad, middle + 10 * scale, {
      size: Math.round(26 * scale),
      weight: 600,
      colour: look.ink3,
    });
    row.draw(x + pad + 36 * scale, middle - picture / 2, picture);
    const countWidth = ink.width(row.count, countType);
    ink.write(row.count, x + w - pad, middle + 10 * scale, countType);
    // The name takes what is left between its picture and its count, cut short when long.
    const left = x + pad + 36 * scale + picture + 18 * scale;
    ink.write(row.text, left, middle + 10 * scale, textType, x + w - pad - countWidth - 20 * scale - left);
  });
}

// The moments, one under another: each a small label over its value.
function momentsCard(ink: Ink, content: PictureContent, x: number, y: number, w: number, h: number): void {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 40;
  // The card's height shared evenly between the moments.
  const each = (h - 28) / Math.max(1, content.moments.length);
  content.moments.forEach((moment, index) => {
    const top = y + 14 + index * each;
    // The label, then its value under it, the pair in the middle of its row.
    const middle = top + each / 2;
    ink.fit(moment.label, x + pad, middle - 8, { size: 22, weight: 500, colour: look.ink2 }, w - pad * 2, 16);
    ink.fit(
      moment.value,
      x + pad,
      middle + 30,
      { size: 30, weight: 700, colour: look.ink, spacing: -0.4 },
      w - pad * 2,
      20,
    );
    // A thin line between one moment and the next.
    if (index > 0) {
      ctx.fillStyle = look.line;
      ctx.fillRect(x + pad, top, w - pad * 2, 2);
    }
  });
}

// jukecord's mark and name at the foot, with the time's days at the other end.
function foot(ink: Ink, content: PictureContent, x: number, baseline: number, w: number, scale: number): void {
  const size = 44 * scale;
  // The mark beside its name, as the panel's bar has them, sitting on the name's baseline.
  mark(ink.ctx, ink.look, x, baseline - size * 0.86, size);
  ink.write('jukecord', x + size + 14 * scale, baseline, {
    size: Math.round(32 * scale),
    weight: 700,
    colour: ink.look.ink,
    spacing: -0.4,
  });
  // The time's days, faint, at the other end.
  ink.write(content.range, x + w, baseline, {
    size: Math.round(24 * scale),
    weight: 500,
    colour: ink.look.ink3,
    align: 'right',
  });
}

// The rows of the most played: each on its cover.
function trackRows(ink: Ink, content: PictureContent, covers: readonly (HTMLImageElement | null)[], most: number) {
  return content.tracks.slice(0, most).map((track, index) => ({
    text: track.title,
    count: track.plays,
    draw: (x: number, y: number, size: number) =>
      cover(ink.ctx, ink.look, covers[index] ?? null, x, y, size, size * 0.18),
  }));
}

// The rows of who added most: each on their face.
function peopleRows(ink: Ink, content: PictureContent, faces: readonly (HTMLImageElement | null)[]) {
  return content.people.map((person, index) => ({
    text: person.name,
    count: person.plays,
    draw: (x: number, y: number, size: number) =>
      face(ink.ctx, ink.look, ink, faces[index] ?? null, person.name, x + size / 2, y + size / 2, size / 2),
  }));
}

// How tall a card listing `rows` is, at a scale.
function listHeight(rows: number, scale: number): number {
  return Math.round((86 + rows * 56 + 18) * scale);
}

// The story: the server and the time at the top, the song of the time on its record, the totals, the most played,
// who added most beside the moments, and jukecord's mark at the foot. The cards are one block, set in the middle of
// the room between the time and the foot, so a time with a few plays sits as well as a full year.
function story(ctx: CanvasRenderingContext2D, ink: Ink, content: PictureContent, pictures: Pictures): void {
  const { look } = ink;
  const m = 72;
  const w = 1080 - m * 2;
  const gap = 28;
  server(ink, content, pictures.icon, m, 128, 72);
  ink.fit(content.big, m - 6, 384, { size: 184, weight: 800, colour: look.ink, spacing: -5 }, w, 96);
  ink.write(content.sub, m, 458, { size: 56, weight: 650, colour: look.ink, spacing: -1 }, w);
  // The block's parts and their heights: the bottom row as tall as the taller of its two cards.
  const song = content.song ? 392 : 0;
  const totals = 156;
  const tracks = listHeight(content.tracks.length, 1);
  const low = Math.max(listHeight(Math.max(content.people.length, 3), 0.88), 36 + content.moments.length * 78);
  const block = (song ? song + gap : 0) + totals + gap + tracks + gap + low;
  const room = { top: 498, bottom: 1784 };
  let y = room.top + Math.max(0, (room.bottom - room.top - block) / 2);
  if (content.song) {
    songCard(ink, content, pictures.songCover, m, y, w, song, 1);
    y += song + gap;
  }
  numbers(ink, content, m, y, w, totals, 58);
  y += totals + gap;
  listCard(ink, content.tracksLabel, trackRows(ink, content, pictures.trackCovers, 5), m, y, w, tracks, 1);
  y += tracks + gap;
  // Who added most, and the moments, side by side.
  const half = (w - gap) / 2;
  if (content.people.length > 0)
    listCard(ink, content.peopleLabel, peopleRows(ink, content, pictures.faces), m, y, half, low, 0.88);
  momentsCard(ink, content, m + half + gap, y, half, low);
  foot(ink, content, m, 1846, w, 1);
  void ctx;
}

// The square: the server and the time across the top, the song of the time, the totals, the three most played beside
// who added most, and jukecord's mark at the foot; the cards a block in the middle of their room, as in the story.
function square(ctx: CanvasRenderingContext2D, ink: Ink, content: PictureContent, pictures: Pictures): void {
  const { look } = ink;
  const m = 56;
  const w = 1080 - m * 2;
  const gap = 24;
  server(ink, content, pictures.icon, m, 48, 60);
  ink.fit(content.title, m - 3, 194, { size: 84, weight: 800, colour: look.ink, spacing: -2 }, w, 48);
  const song = content.song ? 316 : 0;
  const totals = 140;
  const low = listHeight(3, 0.8);
  const block = (song ? song + gap : 0) + totals + gap + low;
  const room = { top: 228, bottom: 988 };
  let y = room.top + Math.max(0, (room.bottom - room.top - block) / 2);
  if (content.song) {
    songCard(ink, content, pictures.songCover, m, y, w, song, 0.86);
    y += song + gap;
  }
  numbers(ink, content, m, y, w, totals, 50);
  y += totals + gap;
  const half = (w - gap) / 2;
  listCard(ink, content.tracksLabel, trackRows(ink, content, pictures.trackCovers, 3), m, y, half, low, 0.8);
  if (content.people.length > 0)
    listCard(ink, content.peopleLabel, peopleRows(ink, content, pictures.faces), m + half + gap, y, half, low, 0.8);
  foot(ink, content, m, 1036, w, 0.8);
  void ctx;
}
