/**
 * The panel's QR codes: the smallest version that holds the text, the patterns where the standard puts them, the
 * format information the same in both its copies and valid, and one code as it was drawn when a separate decoder
 * (jsQR 1.4.0, with 142 other texts over every version from 1 to 15) read each of them back. A change to the encoder
 * that changes this code has to be read back the same way again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { qrCode } from '../../panel/src/qr.ts';

const LINK = 'https://music.example.com/listen#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg';
// Its code (version 5, 37 modules a side), dark as #.
const GOLDEN = [
  '#######..#...#....##.#.###.#..#######',
  '#.....#.##.##.##.#.#######.##.#.....#',
  '#.###.#..###.####......#..#.#.#.###.#',
  '#.###.#..##.#.##..##...#..#.#.#.###.#',
  '#.###.#.#.####.##.#..###.###..#.###.#',
  '#.....#..#.##..#..####.##..##.#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#.#.#######',
  '.........#...###.#...#..##.##........',
  '#.#.#.#..#.#####.#..####.##.....#..#.',
  '#..##..##.#..###.#..#.#..####.....#.#',
  '##.######...#....##.##..#.#.##....###',
  '.#.#...#.#.##.##.#.####.####...#...#.',
  '#.######..#...#.#...##..##.####...###',
  '.#..##.##.#....###......##..#.#....##',
  '####.###.#.#.##.##..#.#...#.#.##..###',
  '.#..##.#####..##.##.###..#..#.#.#...#',
  '###.#.#.##.######.###....###.###.#...',
  '#..###...#.#######..#.#...#.#.#...#.#',
  '......#.#....#.####..........########',
  '####...##....##.###..#.####.#..#...#.',
  '#.#.####.##.#..###..##..##..###......',
  '.#.##...##.#..#.#...#...###...##.#.#.',
  '.#.####.#.#####..#...#..#.#..###..###',
  '.#..##.....#.##.#..####.###..#..#..##',
  '#...###.#.#..#......####.##..#####...',
  '.#...#......#..#.#..#....####.....###',
  '#.######.#..........#.#.#.#.#.#.#..##',
  '.#.#...###.###.#.#...#####..#.##...##',
  '#.##.###.##...#.#...##..##..#####.##.',
  '........#..##..###..#.#..#.##...##.##',
  '#######..#.#....#.#.#....####.#.##.##',
  '#.....#...##..#.##########..#...##...',
  '#.###.#.#.##..#.#.#.##...##.######...',
  '#.###.#..#.##.#####.##....#....##.##.',
  '#.###.#.#.##..###....##.........##.##',
  '#.....#..#####..####.##..#..#..##..#.',
  '#######.##.#...###...#..##.####..#.##',
];

describe('qrCode', () => {
  it('draws a link as it was drawn when a separate decoder read it back', () => {
    const code = qrCode(LINK);
    assert.ok(code);
    assert.deepEqual(
      code.dark.map((row) => row.map((on) => (on ? '#' : '.')).join('')),
      GOLDEN,
    );
  });

  it('takes the smallest version that holds the text, up to version 15', () => {
    // Level M holds 14 bytes in version 1, 84 in version 5, 412 in version 15.
    assert.equal(qrCode('x'.repeat(14))?.size, 21);
    assert.equal(qrCode('x'.repeat(15))?.size, 25);
    assert.equal(qrCode('x'.repeat(84))?.size, 37);
    assert.equal(qrCode('x'.repeat(412))?.size, 77);
    assert.equal(qrCode('x'.repeat(413)), null);
    // Korean is UTF-8: three bytes a letter.
    assert.equal(qrCode('가'.repeat(5))?.size, 25);
  });

  it('puts the finders, the timing and the format information where the standard does', () => {
    const code = qrCode('https://example.com/');
    assert.ok(code);
    const at = (x: number, y: number) => code.dark[y]?.[x] ?? false;
    const size = code.size;
    // A finder's dark ring and centre, and the light ring between, in each of three corners.
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      assert.equal(at(x, y), true);
      assert.equal(at(x + 1, y + 1), false);
      assert.equal(at(x + 3, y + 3), true);
      // The separator: light all round.
      assert.equal(at(x === 0 ? 7 : x - 1, y + 3), false);
    }
    // Timing: alternating along row 6 between the finders.
    for (let x = 8; x < size - 8; x += 1) assert.equal(at(x, 6), x % 2 === 0);
    // The dark module beside the lower-left finder.
    assert.equal(at(8, size - 8), true);
    // The format information read from both copies: the same 15 bits, a valid code word for level M.
    const bits = (cells: [number, number][]) => cells.reduce((word, [x, y], i) => word | (Number(at(x, y)) << i), 0);
    const first = bits([
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
    ]);
    const second = bits([
      ...Array.from({ length: 8 }, (_, i) => [size - 1 - i, 8] as [number, number]),
      ...Array.from({ length: 7 }, (_, i) => [8, size - 7 + i] as [number, number]),
    ]);
    assert.equal(first, second);
    const word = first ^ 0x5412;
    // Level M is 00 in the two highest bits of the five data bits; the ten after them check the five.
    assert.equal(word >>> 13, 0b00);
    let rem = word >>> 10;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(rem & 0x3ff, word & 0x3ff);
  });
});
