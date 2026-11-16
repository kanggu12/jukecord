/**
 * Wrapped as a picture to share: a story (1080 by 1920) or a square (1080 by 1080), drawn on a canvas in the panel's
 * own look. The field is lit by the song of the time, as the panel's is by the track playing (its cover, blurred far
 * out of shape); the cards are the panel's glass; the type is the panel's. The picture says what the Wrapped page
 * says, as the page draws it: the records plain (the rainbow is the panel's sign of a track playing now, and on the
 * page these are not; it stays in jukecord's mark), each person's face in their own colour, places shared in a tie.
 * The colours are the panel's own tokens and rules, read from its stylesheet as it is now, so the picture is in the
 * theme the panel shows.
 *
 * The covers come from jukecord's own address, so the canvas may be read back into a PNG. The server's icon and
 * people's pictures come from Discord and are drawn only when Discord lets them be read (otherwise their initials
 * are, as the panel does when a picture does not load).
 */
import { hueOf, initials } from '../dom.ts';

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
  /** The track on the record, whose cover lights the picture: the song of the time, or with none its first track. */
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
    /** Its place, as the page numbers it (shared in a tie). */
    readonly rank: number;
    readonly cover: string | null;
  }[];
  /**
   * The moments' head, and the moments: the busiest day and hour (where they are habits), the longest day. In the card
   * of moments each says itself on one line under its label (`value`: "Jun 26 · 1 h 21 min"); a moment alone there (a
   * time too short for a habit has only its longest day) is drawn as the page's tile, its `main` big ("Jun 26") with
   * its `sub` under it ("1 h 21 min · 46 plays").
   */
  readonly momentsLabel: string;
  readonly moments: readonly {
    readonly label: string;
    readonly value: string;
    readonly main: string;
    readonly sub: string;
  }[];
  /** Whose picks played most: up to three, each with a face and the plays of what they added (a role, the host, with a
   * person for a face). */
  readonly peopleLabel: string;
  readonly people: readonly {
    readonly name: string;
    readonly picture: string | null;
    readonly plays: string;
    readonly rank: number;
    readonly role?: boolean;
  }[];
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
    ambient: Number(token('--ambient')) || 0.24,
    saturate: Number(/saturate\(([\d.]+)\)/.exec(tone)?.[1] ?? 0.45),
    brightness: Number(/brightness\(([\d.]+)\)/.exec(tone)?.[1] ?? 0.7),
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

  /** The largest size of a type (down to a floor) at which a text fits a width on one line. */
  fitSize(text: string, type: Type, width: number, floor: number): number {
    let size = type.size;
    // Two pixels smaller at a time until it fits; at the floor, the ellipsis cuts what is left over.
    while (size > floor && this.width(text, { ...type, size }) > width) size -= 2;
    return size;
  }

  /** Writes a text at the largest size of a type (down to a floor) at which it fits a width on one line. */
  fit(text: string, x: number, y: number, type: Type, width: number, floor: number): void {
    this.write(text, x, y, { ...type, size: this.fitSize(text, type, width, floor) }, width, 1);
  }

  /** How far a text's letters rise over its baseline in a type (its capitals', or its tallest letters'). */
  ascent(text: string, type: Type): number {
    this.use(type);
    return this.ctx.measureText(text).actualBoundingBoxAscent;
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

// The record as the Wrapped page draws its albums' (style.css .album .vinyl): dark vinyl with its grooves, a light
// falling across it and a faint edge, the cover on its label round the spindle hole. No rainbow on its rim: that is
// the panel's sign of a track playing now, which the page's records are not.
function record(
  ctx: CanvasRenderingContext2D,
  look: Look,
  image: HTMLImageElement | null,
  cx: number,
  cy: number,
  radius: number,
): void {
  // The vinyl, in the panel's disc colour.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = look.disc;
  ctx.fill();
  // Its faint edge, so it reads as one against a dark field too (the page's 1 px line, at the picture's scale).
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 3;
  ctx.stroke();
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

// A face's colours as the panel's stylesheet paints them (.avatar: a colour of the person's own, from their name, with
// white letters; .avatar.role: a grey with the person in the second ink), read from an element made for the purpose,
// so the picture's faces are the page's (they were all the raised glass's grey).
function faceColours(name: string, role: boolean): { back: string; ink: string } {
  const probe = document.createElement('span');
  probe.className = role ? 'avatar role' : 'avatar';
  // Never seen: only its computed colours are read.
  probe.hidden = true;
  // The person's hue, as dom.ts face() sets it (a role has none).
  if (!role) probe.style.setProperty('--hue', String(hueOf(name)));
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const colours = { back: style.backgroundColor, ink: style.color };
  probe.remove();
  return colours;
}

// A face: the picture in a circle, or the person's initials on their own colour; a role (the host: no account, so no
// name to take letters from) has a person there on its grey. As the panel's own faces show them.
function face(
  ctx: CanvasRenderingContext2D,
  look: Look,
  ink: Ink,
  image: HTMLImageElement | null,
  name: string,
  cx: number,
  cy: number,
  radius: number,
  role = false,
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
    ctx.restore();
    return;
  }
  const colours = faceColours(name, role);
  // The face's colour (the raised glass first, kept by a browser whose canvas would not take the colour as written).
  ctx.fillStyle = look.raised;
  ctx.fillStyle = colours.back;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  if (role) {
    // The panel's person icon (Lucide's user, 24 units a side), seven tenths of the face across with lines of 2.4
    // units, as the panel's own role faces have it (style.css .avatar.role).
    const side = radius * 2 * 0.7;
    ctx.translate(cx - side / 2, cy - side / 2);
    ctx.scale(side / 24, side / 24);
    // The second ink first, kept where the canvas would not take the stylesheet's colour as written.
    ctx.strokeStyle = look.ink2;
    ctx.strokeStyle = colours.ink;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'));
    ctx.beginPath();
    ctx.arc(12, 7, 4, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // The initials in the face's ink, in the middle.
    ink.write(initials(name), cx, cy + radius * 0.34, {
      size: Math.round(radius * 0.9),
      weight: 600,
      colour: colours.ink,
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
    content.momentsLabel,
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
  const room = each - 52;
  // The labels at one size, the largest at which each fits its cell (down to a floor): fitted one by one, a drawing
  // made larger set "Plays" larger than "Days with music".
  const labelType: Type = { size: Math.round(big * 0.4), weight: 500, colour: look.ink2 };
  const labelSize = Math.min(...cells.map((cell) => ink.fitSize(cell.label, labelType, room, labelType.size - 6)));
  cells.forEach((cell, index) => {
    const left = x + index * each + 34;
    ink.write(cell.label, left, y + h * 0.36, { ...labelType, size: labelSize }, room);
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

// A list card's parts at its scale: its head's baseline, where its first row starts, a row's height, and the room
// under its last row. A card of moments beside a list sets its own rows on the same lines (momentsCard).
const LIST = { head: 62, top: 86, row: 56, foot: 18 } as const;

// A card listing tracks on their covers (or people on their faces), each with its count at the end of the line; its
// rows `pitch` apart (a row's height at the card's scale unless said).
function listCard(
  ink: Ink,
  title: string,
  rows: readonly {
    readonly text: string;
    readonly count: string;
    /** Its place, as the page numbers it (shared in a tie). */
    readonly rank: number;
    readonly draw: (x: number, y: number, size: number) => void;
  }[],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  pitch = LIST.row * scale,
): void {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 44 * scale;
  head(ink, title, x + pad, y + LIST.head * scale, Math.round(25 * scale), w - pad * 2);
  const picture = 42 * scale;
  // The name in the ink, its count in the second ink at the end of the line, as the panel's ranks.
  const textType: Type = { size: Math.round(29 * scale), weight: 600, colour: look.ink };
  const countType: Type = { size: Math.round(27 * scale), weight: 500, colour: look.ink2, align: 'right' };
  rows.forEach((row, index) => {
    const top = y + LIST.top * scale + index * pitch;
    // Everything on the row is set on its middle: the baseline a little under it.
    const middle = top + pitch / 2;
    // The place, faint, as the panel's.
    ink.write(String(row.rank), x + pad, middle + 10 * scale, {
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

// The moments, one under another, as the list card beside them sets its rows: the same head on the same baseline, the
// first moment where its first row starts, each in a row of the same height (`pitch`). A moment is its label over its
// value, the two lines in the middle of their row, and a thin line between one moment and the next.
function momentsCard(
  ink: Ink,
  content: PictureContent,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  pitch: number,
): void {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 44 * scale;
  head(ink, content.momentsLabel, x + pad, y + LIST.head * scale, Math.round(25 * scale), w - pad * 2);
  content.moments.forEach((moment, index) => {
    const top = y + LIST.top * scale + index * pitch;
    // The two lines' block centred on the row: the label's baseline a little over the middle, the value's under it.
    const middle = top + pitch / 2;
    ink.fit(
      moment.label,
      x + pad,
      middle - 9 * scale,
      { size: Math.round(22 * scale), weight: 500, colour: look.ink2 },
      w - pad * 2,
      Math.round(16 * scale),
    );
    ink.fit(
      moment.value,
      x + pad,
      middle + 25 * scale,
      { size: Math.round(30 * scale), weight: 700, colour: look.ink, spacing: -0.4 },
      w - pad * 2,
      Math.round(20 * scale),
    );
    // A thin line between one moment and the next, on the line where the row starts.
    if (index > 0) {
      ctx.fillStyle = look.line;
      ctx.fillRect(x + pad, top, w - pad * 2, 2);
    }
  });
}

// A moment alone, as the page's tile shows one: its label for the card's head (on the line of the head beside it), its
// main fact big and the rest under it ("Nov 23", "3 min · 1 play"), the two lines in the middle of the room the rows
// beside it take.
function momentTile(
  ink: Ink,
  moment: PictureContent['moments'][number],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  pitch: number,
): void {
  const { ctx, look } = ink;
  glass(ctx, look, x, y, w, h);
  const pad = 44 * scale;
  head(ink, moment.label, x + pad, y + LIST.head * scale, Math.round(25 * scale), w - pad * 2);
  // Big and bold as a total's figure, set a touch tight; its line under it in the second ink, as a row's count.
  const mainType: Type = { size: Math.round(52 * scale), weight: 700, colour: look.ink, spacing: -0.6 };
  const subType: Type = { size: Math.round(27 * scale), weight: 500, colour: look.ink2 };
  const main = { ...mainType, size: ink.fitSize(moment.main, mainType, w - pad * 2, Math.round(30 * scale)) };
  // The room the rows beside it take, from the first row's top to the card's foot.
  const top = y + LIST.top * scale;
  const room = Math.max(pitch, y + h - LIST.foot * scale - top);
  // The two lines' block: the main fact's letters, the step to the line under it, and that line's foot.
  const rise = ink.ascent(moment.main, main);
  const step = subType.size * 1.6;
  const tall = rise + step + subType.size * 0.25;
  const baseline = top + (room - tall) / 2 + rise;
  ink.write(moment.main, x + pad, baseline, main, w - pad * 2);
  ink.write(moment.sub, x + pad, baseline + step, subType, w - pad * 2);
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
    rank: track.rank,
    draw: (x: number, y: number, size: number) =>
      cover(ink.ctx, ink.look, covers[index] ?? null, x, y, size, size * 0.18),
  }));
}

// The rows of whose picks played most: each on their face.
function peopleRows(ink: Ink, content: PictureContent, faces: readonly (HTMLImageElement | null)[]) {
  return content.people.map((person, index) => ({
    text: person.name,
    count: person.plays,
    rank: person.rank,
    draw: (x: number, y: number, size: number) =>
      face(
        ink.ctx,
        ink.look,
        ink,
        faces[index] ?? null,
        person.name,
        x + size / 2,
        y + size / 2,
        size / 2,
        person.role,
      ),
  }));
}

// How tall a card listing `rows` is, at a scale, its rows `pitch` apart (a row's height at the scale unless said).
function listHeight(rows: number, scale: number, pitch = LIST.row * scale): number {
  return Math.round((LIST.top + LIST.foot) * scale + rows * pitch);
}

/** A card's place in a picture: its top and its height, in the picture's pixels. */
export interface Place {
  readonly y: number;
  readonly h: number;
}

/**
 * Where a picture's cards go, top to bottom, and the scale they are drawn at (1 is the year's): the cards are one
 * block, as large as fills the room between the time's words and the foot, so a time with a few plays shows its few
 * things larger and sits as a full year does (set in the middle of the room at the year's size, the first month's
 * cards had 150 px of nothing over them and under them, the year's 33). At most 1.4 times the year's size; past that,
 * in the middle of the room.
 */
export interface Block {
  readonly scale: number;
  /** The song of the time (or with none the first track) on its record; null when there is neither. */
  readonly song: Place | null;
  /** The totals side by side. */
  readonly totals: Place;
  /** The story's most played; the square has none of its own (its lists share the low row). */
  readonly tracks: Place | null;
  /** The last row: the story's whose picks played most beside the moments, the square's two lists side by side. */
  readonly low: Place;
}

// The parts of a picture's block as content has them.
type Parts = Pick<PictureContent, 'song' | 'tracks' | 'people' | 'moments'>;

// The largest a block is made, in times the year's size.
const MOST = 1.4;

// A block's cards one under another from a top, `gap` apart, each as tall as said (0: no such card).
function stack(top: number, gap: number, heights: readonly number[]): (Place | null)[] {
  let y = top;
  return heights.map((h) => {
    if (h === 0) return null;
    const place = { y: Math.round(y), h };
    y += h + gap;
    return place;
  });
}

// The scale that fills a room with a block whose height at a scale is `height(scale)`: up to MOST, and found again at
// the rounded heights so the block's foot meets the room's within a pixel or two.
function filling(room: number, height: (scale: number) => number): number {
  const scale = Math.min(MOST, room / height(1));
  return Math.min(MOST, scale * (room / height(scale)));
}

/**
 * The story's block under the time's words (`top`, where the room begins) down to the foot: the song, the totals, the
 * five most played, and whose picks played most beside the moments, those two sharing their head and their rows'
 * lines, as many rows as the longer has.
 */
export function storyBlock(content: Parts, top: number): Block {
  const rows = Math.max(1, Math.min(3, content.people.length), content.moments.length);
  const heights = (scale: number) => ({
    song: content.song ? Math.round(360 * scale) : 0,
    totals: Math.round(156 * scale),
    tracks: listHeight(Math.min(5, content.tracks.length), scale),
    low: listHeight(rows, 0.88 * scale, 70 * scale),
    gap: Math.round(28 * scale),
  });
  const tall = (scale: number) => {
    const part = heights(scale);
    return (part.song ? part.song + part.gap : 0) + part.totals + part.gap + part.tracks + part.gap + part.low;
  };
  const room = STORY.bottom - top;
  const scale = filling(room, tall);
  const part = heights(scale);
  // In the middle of the room, which it fills unless it is at its largest.
  const [song, totals, tracks, low] = stack(top + Math.max(0, (room - tall(scale)) / 2), part.gap, [
    part.song,
    part.totals,
    part.tracks,
    part.low,
  ]);
  return { scale, song: song ?? null, totals: totals as Place, tracks: tracks ?? null, low: low as Place };
}

/** The square's block under its title: the song, the totals, and the three most played beside whose picks did. */
export function squareBlock(content: Parts): Block {
  // The two lists' cards as tall as the longer one's rows, three at most (always three tall, two rows of a time with
  // few plays had 80 px of nothing under them).
  const rows = Math.max(1, Math.min(3, content.tracks.length), Math.min(3, content.people.length));
  const heights = (scale: number) => ({
    song: content.song ? Math.round(316 * scale) : 0,
    totals: Math.round(140 * scale),
    low: listHeight(rows, 0.8 * scale),
    gap: Math.round(24 * scale),
  });
  const tall = (scale: number) => {
    const part = heights(scale);
    return (part.song ? part.song + part.gap : 0) + part.totals + part.gap + part.low;
  };
  const room = SQUARE.bottom - SQUARE.top;
  const scale = filling(room, tall);
  const part = heights(scale);
  const [song, totals, low] = stack(SQUARE.top + Math.max(0, (room - tall(scale)) / 2), part.gap, [
    part.song,
    part.totals,
    part.low,
  ]);
  return { scale, song: song ?? null, totals: totals as Place, tracks: null, low: low as Place };
}

// The story's frame: its margin, the server's row, the time's words (its big line's top a little under the server's
// row, whatever size the words fit at), where the cards' room ends, and the foot's baseline.
const STORY = { margin: 72, server: 128, bigTop: 250, bottom: 1784, foot: 1846 } as const;
// The square's: its margin, the server's row, the title's baseline, the cards' room and the foot's baseline.
const SQUARE = { margin: 56, server: 48, title: 194, top: 228, bottom: 988, foot: 1036 } as const;

// The story: the server and the time at the top, the song of the time on its record, the totals, the most played,
// whose picks played most beside the moments, and jukecord's mark at the foot.
function story(ctx: CanvasRenderingContext2D, ink: Ink, content: PictureContent, pictures: Pictures): void {
  const { look } = ink;
  const m = STORY.margin;
  const w = 1080 - m * 2;
  server(ink, content, pictures.icon, m, STORY.server, 72);
  // The time, big: as large as fits the width (184 px at most), its letters' top where a year's or a month's are, so a
  // long name set smaller ("The last 12 months") leaves no hole over itself; its words under it.
  const bigType: Type = { size: 184, weight: 800, colour: look.ink, spacing: -5 };
  const size = ink.fitSize(content.big, bigType, w, 96);
  const baseline = STORY.bigTop + ink.ascent(content.big, { ...bigType, size });
  ink.write(content.big, m - 6, baseline, { ...bigType, size }, w);
  const sub = baseline + 74;
  ink.write(content.sub, m, sub, { size: 56, weight: 650, colour: look.ink, spacing: -1 }, w);
  // The cards, filling the room from a little under the words to the foot.
  const block = storyBlock(content, sub + 40);
  const scale = block.scale;
  if (content.song && block.song) songCard(ink, content, pictures.songCover, m, block.song.y, w, block.song.h, scale);
  numbers(ink, content, m, block.totals.y, w, block.totals.h, 58 * scale);
  if (block.tracks)
    listCard(
      ink,
      content.tracksLabel,
      trackRows(ink, content, pictures.trackCovers, 5),
      m,
      block.tracks.y,
      w,
      block.tracks.h,
      scale,
    );
  // Whose picks played most, and the moments, side by side; either alone (no person added any, all autoplay) across
  // the row. Their rows share their lines: a row tall enough for a moment's two lines.
  const { y, h } = block.low;
  const gap = Math.round(28 * scale);
  const half = (w - gap) / 2;
  const people = content.people.length > 0;
  const moments = content.moments.length > 0;
  const lowScale = 0.88 * scale;
  const pitch = 70 * scale;
  if (people) {
    const width = moments ? half : w;
    listCard(ink, content.peopleLabel, peopleRows(ink, content, pictures.faces), m, y, width, h, lowScale, pitch);
  }
  if (moments) {
    const left = people ? m + half + gap : m;
    const width = people ? half : w;
    // A moment alone is a card of its own, as the page's tile: under "When it played most", the longest day alone
    // sat on the first row of a card two rows tall.
    const lone = content.moments.length === 1 ? content.moments[0] : undefined;
    if (lone) momentTile(ink, lone, left, y, width, h, lowScale, pitch);
    else momentsCard(ink, content, left, y, width, h, lowScale, pitch);
  }
  foot(ink, content, m, STORY.foot, w, 1);
  void ctx;
}

// The square: the server and the time across the top, the song of the time, the totals, the three most played beside
// whose picks played most, and jukecord's mark at the foot; the cards filling the room between them, as in the story.
function square(ctx: CanvasRenderingContext2D, ink: Ink, content: PictureContent, pictures: Pictures): void {
  const { look } = ink;
  const m = SQUARE.margin;
  const w = 1080 - m * 2;
  const gap = 24;
  server(ink, content, pictures.icon, m, SQUARE.server, 60);
  ink.fit(content.title, m - 3, SQUARE.title, { size: 84, weight: 800, colour: look.ink, spacing: -2 }, w, 48);
  const block = squareBlock(content);
  const scale = block.scale;
  if (content.song && block.song)
    songCard(ink, content, pictures.songCover, m, block.song.y, w, block.song.h, 0.86 * scale);
  numbers(ink, content, m, block.totals.y, w, block.totals.h, 50 * scale);
  // The most played the wider, three fifths of the row, as the page sets them (a title is longer than a name, and each
  // count says "plays"); alone across the row when no person added any.
  const people = content.people.length > 0;
  const between = Math.round(gap * scale);
  const wide = people ? Math.round((w - between) * 0.6) : w;
  const { y, h } = block.low;
  listCard(ink, content.tracksLabel, trackRows(ink, content, pictures.trackCovers, 3), m, y, wide, h, 0.8 * scale);
  if (people)
    listCard(
      ink,
      content.peopleLabel,
      peopleRows(ink, content, pictures.faces),
      m + wide + between,
      y,
      w - between - wide,
      h,
      0.8 * scale,
    );
  foot(ink, content, m, SQUARE.foot, w, 0.8);
  void ctx;
}
