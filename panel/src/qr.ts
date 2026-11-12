/**
 * QR codes, drawn by the panel itself: a phone's camera opens a link shown on a screen without anyone typing it, and
 * no outside service sees the link.
 *
 * Byte mode, error correction level M (a code still reads with about 15 % of it damaged), versions 1 to 15 (up to 412
 * bytes: any link the panel makes). The steps are the standard's (ISO/IEC 18004): the data with its mode and length,
 * Reed-Solomon error correction over GF(256) in blocks, interleaved; the finder, timing and alignment patterns, the
 * format and version information; the data placed in its zigzag; and of the eight masks the one with the lowest
 * penalty. The layout follows Project Nayuki's QR Code generator (MIT), the usual reference.
 */

// Error correction codewords per block, and blocks, for level M, by version (index 0 unused).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const VERSION_MAX = 15;

/** A code as a square of modules, true for dark, with its side in modules (without the quiet zone). */
export interface QrCode {
  readonly size: number;
  readonly dark: readonly (readonly boolean[])[];
}

// How many modules of a version carry data and error correction (everything but the patterns and the information).
function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

// How many data codewords a version holds at level M.
function dataCodewords(version: number): number {
  return Math.floor(rawModules(version) / 8) - (ECC_PER_BLOCK[version] ?? 0) * (BLOCKS[version] ?? 0);
}

// Multiplies in GF(256) with the QR polynomial (x^8 + x^4 + x^3 + x^2 + 1).
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// The Reed-Solomon divisor of a degree: the product of (x - 2^i) for i below it, highest coefficient left out.
function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = multiply(root, 0x02);
  }
  return result;
}

// The error correction codewords of a block: the remainder of its data divided by the divisor.
function remainder(data: readonly number[], by: readonly number[]): number[] {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    by.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ multiply(coefficient, factor);
    });
  }
  return result;
}

/** The QR code of a text, or null when it is longer than version 15 holds. */
export function qrCode(text: string): QrCode | null {
  const bytes = [...new TextEncoder().encode(text)];
  // The smallest version the bytes fit in: the mode (4 bits), the length (8 bits up to version 9, 16 from 10), data.
  let version = 1;
  for (; version <= VERSION_MAX; version += 1) {
    const bits = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(version) * 8) break;
  }
  if (version > VERSION_MAX) return null;
  const capacity = dataCodewords(version) * 8;
  // The bit stream: byte mode, the length, the bytes, then a terminator, padding to a byte and the pad bytes.
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  // The blocks, short ones first, each with its error correction; then read across them, codeword by codeword.
  const blocks = BLOCKS[version] ?? 1;
  const eccLength = ECC_PER_BLOCK[version] ?? 0;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const by = divisor(eccLength);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const chunk = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += chunk.length;
    const ecc = remainder(chunk, by);
    // A place held in a short block, so every block is as long as the long ones (skipped when reading across).
    if (i < shortBlocks) chunk.push(0);
    parts.push([...chunk, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < (parts[0]?.length ?? 0); i += 1) {
    parts.forEach((part, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(part[i] ?? 0);
    });
  }

  // The square, with the patterns drawn and marked as not data.
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => {
    const row = dark[y];
    const marks = fixed[y];
    if (!row || !marks || x < 0 || x >= size) return;
    row[x] = on;
    marks[x] = true;
  };
  // Timing: alternate along row and column 6.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finders in three corners, with their light separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  // Alignment patterns at every crossing of their positions but the finders' corners.
  if (version > 1) {
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const at = [6];
    for (let place = size - 7; at.length < count; place -= step) at.splice(1, 0, place);
    at.forEach((x, i) => {
      at.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) return;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
  }
  // The format information's places, reserved now and written with the mask below; the dark module beside them.
  const format = (mask: number) => {
    // Level M is 00, then the mask; a BCH code over it, and the standard's pattern over all of it.
    const value = (0b00 << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const word = ((value << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((word >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  // The version information, from version 7: two copies of 18 bits beside the finders.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const word = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const on = ((word >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // The data, in pairs of columns from the right, up and down in turn, round the patterns.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        const row = dark[y];
        if (!row || fixed[y]?.[x] || index >= codewords.length * 8) continue;
        row[x] = (((codewords[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) !== 0;
        index += 1;
      }
    }
  }

  // Each mask in turn on the data (applying it twice takes it off again); the one with the lowest penalty stays.
  const flip = (mask: number) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (fixed[y]?.[x]) continue;
        const on = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask];
        const row = dark[y];
        if (on && row) row[x] = !row[x];
      }
    }
  };
  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    flip(mask);
    format(mask);
    const score = penalty(dark, size);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    flip(mask);
  }
  flip(best);
  format(best);
  return { size, dark };
}

// The standard's penalty of a masked code: runs of one colour, 2x2 blocks, finder-like patterns, dark and light out of
// balance. The lower, the easier for a camera.
function penalty(dark: readonly (readonly boolean[])[], size: number): number {
  let score = 0;
  const lines = (vertical: boolean) => {
    for (let a = 0; a < size; a += 1) {
      let colour = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const add = (length: number) => {
        // A run at the line's start counts the light border before it.
        history.pop();
        history.unshift(history[0] === 0 && history.every((value) => value === 0) ? length + size : length);
      };
      const finders = () => {
        const n = history[1] ?? 0;
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (
          (core && (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n ? 1 : 0) +
          (core && (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n ? 1 : 0)
        );
      };
      for (let b = 0; b < size; b += 1) {
        const on = vertical ? (dark[b]?.[a] ?? false) : (dark[a]?.[b] ?? false);
        if (on === colour) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          add(run);
          if (!colour) score += finders() * 40;
          colour = on;
          run = 1;
        }
      }
      // The line's end: the light border after it ends the last run.
      if (colour) {
        add(run);
        run = 0;
      }
      add(run + size);
      score += finders() * 40;
    }
  };
  lines(false);
  lines(true);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const on = dark[y]?.[x];
      if (on === dark[y]?.[x + 1] && on === dark[y + 1]?.[x] && on === dark[y + 1]?.[x + 1]) score += 3;
    }
  }
  let count = 0;
  for (const row of dark) for (const on of row) if (on) count += 1;
  const total = size * size;
  score += (Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1) * 10;
  return score;
}
