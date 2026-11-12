/**
 * Made-up album covers for the example data: eight kinds of picture, each drawn in colours that follow from the
 * track's number, so every track has a cover of its own and the same one on every run. They stand in for the pictures
 * real tracks bring (a video's thumbnail, an album's cover) in the panel walk and in the README's pictures, so each is
 * a whole composition, centred or edge to edge, as a cover is: on the turning disc's label, which shows the cover's
 * middle, an off-centre shape would wobble.
 *
 * They are drawn as PNG, by the small painter below (rectangles, circles and paths, filled flat or with a gradient
 * from top to bottom, three by three samples to a pixel), because jukecord keeps only raster pictures as covers (an
 * SVG can carry script). The seed puts each one in the media cache, where jukecord would have kept the cover it
 * fetched.
 *
 * Nothing here is taken from a real cover.
 */
import zlib from 'node:zlib';

// The drawings are made on a 120 by 120 square, as the SVG covers before them were.
const BOX = 120;

/** A paint: one colour, or colours from top to bottom between two heights (with where each one is, 0 to 1). */
type Paint = string | { readonly from: number; readonly to: number; readonly stops: readonly [number, string][] };

// A colour by hue, saturation and lightness; the hue wraps round.
const hsl = (hue: number, saturation: number, lightness: number): string =>
  `hsl(${((hue % 360) + 360) % 360},${saturation}%,${lightness}%)`;

// An hsl() colour as red, green and blue from 0 to 1 (the usual conversion).
function rgbOf(colour: string): [number, number, number] {
  const [hue = 0, saturation = 0, lightness = 0] = (colour.match(/[\d.]+/g) ?? []).map(Number);
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** A square picture drawn on the 120-unit square, painted shape after shape, each over the ones before. */
class Painter {
  private readonly side: number;
  private readonly grid: number;
  // Three by three samples to a pixel, each red, green and blue.
  private readonly samples: Float32Array;
  private readonly over = 3;

  constructor(side: number) {
    this.side = side;
    this.grid = side * this.over;
    this.samples = new Float32Array(this.grid * this.grid * 3);
  }

  // The colour of a paint at a height.
  private colour(paint: Paint, y: number): [number, number, number] {
    if (typeof paint === 'string') return rgbOf(paint);
    const at = Math.min(1, Math.max(0, (y - paint.from) / (paint.to - paint.from)));
    const stops = paint.stops;
    for (let index = 1; index < stops.length; index += 1) {
      const [end, endColour] = stops[index] ?? [1, '#000'];
      const [start, startColour] = stops[index - 1] ?? [0, '#000'];
      if (at <= end || index === stops.length - 1) {
        const t = end === start ? 0 : Math.min(1, Math.max(0, (at - start) / (end - start)));
        const a = rgbOf(startColour);
        const b = rgbOf(endColour);
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return rgbOf(stops[0]?.[1] ?? '#000');
  }

  // Paints the samples of each row between the spans a shape covers there (pairs of x, in units).
  private fill(paint: Paint, top: number, bottom: number, spans: (y: number) => number[]): void {
    const unit = this.grid / BOX;
    const first = Math.max(0, Math.floor(top * unit));
    const last = Math.min(this.grid - 1, Math.ceil(bottom * unit));
    for (let row = first; row <= last; row += 1) {
      const y = (row + 0.5) / unit;
      const [r, g, b] = this.colour(paint, y);
      const edges = spans(y);
      for (let pair = 0; pair + 1 < edges.length; pair += 2) {
        const from = Math.max(0, Math.ceil((edges[pair] ?? 0) * unit - 0.5));
        const to = Math.min(this.grid - 1, Math.floor((edges[pair + 1] ?? 0) * unit - 0.5));
        for (let column = from; column <= to; column += 1) {
          const at = (row * this.grid + column) * 3;
          this.samples[at] = r;
          this.samples[at + 1] = g;
          this.samples[at + 2] = b;
        }
      }
    }
  }

  rect(x: number, y: number, width: number, height: number, paint: Paint): void {
    this.fill(paint, y, y + height, (row) => (row >= y && row <= y + height ? [x, x + width] : []));
  }

  circle(cx: number, cy: number, r: number, paint: Paint): void {
    this.fill(paint, cy - r, cy + r, (row) => {
      const half = r * r - (row - cy) ** 2;
      return half < 0 ? [] : [cx - Math.sqrt(half), cx + Math.sqrt(half)];
    });
  }

  /** A closed shape through these points, filled by the even-odd rule. */
  polygon(points: readonly [number, number][], paint: Paint): void {
    const ys = points.map((point) => point[1]);
    this.fill(paint, Math.min(...ys), Math.max(...ys), (row) => {
      const crossings: number[] = [];
      for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index] ?? [0, 0];
        const [x2, y2] = points[(index + 1) % points.length] ?? [0, 0];
        // Where this edge crosses the row's height (an edge's lower end counts, its upper end does not).
        if (y1 <= row !== y2 <= row) crossings.push(x1 + ((row - y1) / (y2 - y1)) * (x2 - x1));
      }
      return crossings.sort((a, b) => a - b);
    });
  }

  /** A path of absolute M, Q, T, V, H and Z commands (the ones these covers use), its curves cut into short lines. */
  path(d: string, paint: Paint): void {
    const words = d.match(/[MQTVHZ]|-?[\d.]+/g) ?? [];
    const points: [number, number][] = [];
    let x = 0;
    let y = 0;
    // The last curve's control point, which T mirrors.
    let control: [number, number] = [0, 0];
    let command = '';
    const take = () => Number(words.shift());
    while (words.length > 0) {
      if (/[A-Z]/.test(words[0] ?? '')) command = words.shift() ?? '';
      if (command === 'Z') break;
      if (command === 'M') {
        x = take();
        y = take();
        points.push([x, y]);
        control = [x, y];
      } else if (command === 'V') {
        y = take();
        points.push([x, y]);
      } else if (command === 'H') {
        x = take();
        points.push([x, y]);
      } else {
        const c: [number, number] = command === 'Q' ? [take(), take()] : [2 * x - control[0], 2 * y - control[1]];
        const end: [number, number] = [take(), take()];
        for (let step = 1; step <= 16; step += 1) {
          const t = step / 16;
          const u = 1 - t;
          points.push([u * u * x + 2 * u * t * c[0] + t * t * end[0], u * u * y + 2 * u * t * c[1] + t * t * end[1]]);
        }
        control = c;
        [x, y] = end;
      }
    }
    this.polygon(points, paint);
  }

  /** The picture as a PNG: each pixel the mean of its samples. */
  png(): Buffer {
    const row = this.side * 3 + 1;
    const raw = Buffer.alloc(row * this.side);
    for (let py = 0; py < this.side; py += 1) {
      for (let px = 0; px < this.side; px += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
          let sum = 0;
          for (let sy = 0; sy < this.over; sy += 1)
            for (let sx = 0; sx < this.over; sx += 1)
              sum += this.samples[((py * this.over + sy) * this.grid + px * this.over + sx) * 3 + channel] ?? 0;
          raw[py * row + 1 + px * 3 + channel] = Math.round((sum / (this.over * this.over)) * 255);
        }
      }
    }
    // Each chunk: its length, its name, its data and the CRC of the name and the data.
    const chunk = (name: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.side, 0);
    header.writeUInt32BE(this.side, 4);
    // Eight bits a channel, red green blue, no interlacing.
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

// The point (x, y) turned by `degrees` round (cx, cy), as SVG's rotate() turns it.
function turned(x: number, y: number, degrees: number, cx: number, cy: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
}

// The pictures, each from one base hue. All fill the 120 by 120 square.
const KINDS: ((paint: Painter, hue: number) => void)[] = [
  // A low sun over water: a dusk sky, the sun cut by the lines of its own reflection.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, {
      from: 0,
      to: 120,
      stops: [
        [0, hsl(hue + 250, 60, 20)],
        [0.62, hsl(hue + 320, 62, 42)],
        [1, hsl(hue, 80, 60)],
      ],
    });
    paint.circle(60, 62, 30, {
      from: 32,
      to: 92,
      stops: [
        [0, hsl(hue + 40, 95, 78)],
        [1, hsl(hue, 90, 60)],
      ],
    });
    paint.rect(0, 78, 120, 42, hsl(hue + 230, 55, 14));
    for (const [x, y, width, height] of [
      [36, 81, 48, 3],
      [42, 88, 36, 3],
      [47, 95, 26, 2.5],
      [52, 102, 16, 2],
    ] as const)
      paint.rect(x, y, width, height, hsl(hue + 20, 90, 68));
  },
  // Rings, like a record or ripples, from the middle out.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue + 200, 45, 15));
    for (const [ring, radius] of [58, 47, 36, 25, 14].entries())
      paint.circle(60, 60, radius, hsl(hue + ring * 14, 72, 30 + ring * 11));
  },
  // Bands across the corner, in neighbouring colours.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue, 30, 92));
    for (let band = 0; band < 5; band += 1) {
      const y = 18 + band * 18;
      const corners: [number, number][] = [
        [-60, y],
        [180, y],
        [180, y + 13],
        [-60, y + 13],
      ];
      paint.polygon(
        corners.map(([x, cornerY]) => turned(x, cornerY, -38, 60, 60)),
        hsl(hue + band * 22, 70, 36 + band * 7),
      );
    }
  },
  // Hills at dusk, one behind another.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, {
      from: 0,
      to: 120,
      stops: [
        [0, hsl(hue + 30, 85, 86)],
        [1, hsl(hue, 75, 66)],
      ],
    });
    paint.circle(60, 42, 14, hsl(hue + 45, 100, 78));
    paint.path('M0 74 Q30 52 60 70 T120 62 V120 H0Z', hsl(hue + 200, 35, 52));
    paint.path('M0 90 Q34 68 66 86 T120 80 V120 H0Z', hsl(hue + 210, 40, 36));
    paint.path('M0 106 Q40 88 76 102 T120 98 V120 H0Z', hsl(hue + 220, 45, 22));
  },
  // Dots that grow toward the middle.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue + 215, 50, 16));
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        const x = 12 + column * 16;
        const y = 12 + row * 16;
        const far = Math.hypot(x - 60, y - 60) / 68;
        paint.circle(x, y, 7 - far * 5.5, hsl(hue, 85, 64));
      }
    }
  },
  // Quarter circles from one corner, one inside another.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue + 40, 60, 90));
    for (const [arc, radius] of [118, 92, 66, 40].entries())
      paint.circle(0, 120, radius, hsl(hue + arc * 28, 68, 56 - arc * 9));
  },
  // Waves, darker toward the bottom.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue + 20, 80, 88));
    for (let wave = 0; wave < 5; wave += 1) {
      const y = 34 + wave * 18;
      paint.path(
        `M0 ${y} Q15 ${y - 9} 30 ${y} T60 ${y} T90 ${y} T120 ${y} V120 H0Z`,
        hsl(hue + 190 + wave * 8, 60, 62 - wave * 10),
      );
    }
  },
  // Blocks of colour with a rule between them.
  (paint, hue) => {
    paint.rect(0, 0, 120, 120, hsl(hue + 40, 25, 93));
    paint.rect(0, 0, 52, 120, hsl(hue, 72, 52));
    paint.rect(56, 0, 64, 58, hsl(hue + 205, 55, 24));
    paint.rect(56, 62, 30, 58, hsl(hue + 45, 90, 62));
    paint.rect(90, 62, 30, 58, hsl(hue + 150, 45, 58));
  },
];

/** The cover of the track with this number, as a PNG `side` pixels square (360 by default). */
export function cover(index: number, side = 360): Buffer {
  // Neighbouring tracks differ in kind and in colour, and so do two covers of the same kind: the kind turns with
  // every track, the hue steps by 47 degrees, and each time round the kinds it jumps a further 101 (a step of 47
  // alone would bring a kind back in nearly the colours it had).
  const kind = KINDS[index % KINDS.length] ?? KINDS[0];
  const painter = new Painter(side);
  kind?.(painter, (index * 47 + Math.floor(index / KINDS.length) * 101 + 20) % 360);
  return painter.png();
}
