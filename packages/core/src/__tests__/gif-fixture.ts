/**
 * A real animated GIF, built byte by byte.
 *
 * It is here rather than as a checked-in binary because the pipeline test needs
 * to vary the frame count and the size — a 200-frame GIF to prove the frame cap
 * bites, a small one to prove a short animation stays small — and a fixture you
 * can parameterise is worth more than a file somebody has to regenerate by hand
 * and cannot diff.
 *
 * `sharp` is deliberately not used to produce it. It reads animations perfectly
 * well and has no supported way to *create* one from raw pixels, so a fixture
 * built with sharp would end up being whatever sharp could be persuaded to
 * emit — which is exactly the wrong thing to test a sharp-based decoder with.
 * These are ordinary GIF89a bytes, the kind any phone would hand the operator.
 *
 * The image data is stored uncompressed: LZW with a code size above the palette
 * size lets every pixel be its own code, with a clear code before the run and
 * an end code after it. That is a legal LZW stream, every decoder accepts it,
 * and it takes about twenty lines instead of a compressor.
 */

/** Two entries is the smallest legal palette, and enough to see motion. */
const PALETTE = [
  [0xe0, 0x40, 0x30],
  [0x20, 0x60, 0xd0],
  [0xf0, 0xd0, 0x40],
  [0x30, 0xa0, 0x60],
];

export interface GifOptions {
  width: number;
  height: number;
  frames: number;
  /** Hundredths of a second between frames. */
  delay?: number;
}

/**
 * An animated GIF89a whose frames differ, so a decoder that keeps only the
 * first is visibly wrong rather than accidentally right.
 */
export function animatedGif(options: GifOptions): Buffer {
  const { width, height, frames } = options;
  const delay = options.delay ?? 8;

  const parts: Buffer[] = [];

  parts.push(Buffer.from('GIF89a', 'ascii'));

  // Logical screen descriptor. `0xF1` = global colour table present, 4 entries.
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0xf1;
  screen[5] = 0;
  screen[6] = 0;
  parts.push(screen);

  for (const [r, g, b] of PALETTE) parts.push(Buffer.from([r!, g!, b!]));

  // Netscape looping extension. Without it some decoders treat the file as a
  // single-play animation, which is still animated but is not what an
  // announcement wants.
  parts.push(
    Buffer.from([
      0x21, 0xff, 0x0b,
      ...Buffer.from('NETSCAPE2.0', 'ascii'),
      0x03, 0x01, 0x00, 0x00,
      0x00,
    ]),
  );

  for (let frame = 0; frame < frames; frame += 1) {
    // Graphic control extension: the delay is what makes it an animation
    // rather than a multi-image file.
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x00;
    gce.writeUInt16LE(delay, 4);
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);

    // Image descriptor, full frame, no local colour table.
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0;
    parts.push(descriptor);

    // Each frame is a flat colour, cycling through the palette, so consecutive
    // frames genuinely differ.
    parts.push(uncompressedImageData(width * height, frame % PALETTE.length));
  }

  parts.push(Buffer.from([0x3b]));

  return Buffer.concat(parts);
}

/** The same GIF, with one frame. Still a GIF; not an animation. */
export function stillGif(width: number, height: number): Buffer {
  return animatedGif({ width, height, frames: 1 });
}

/**
 * An LZW stream that never actually compresses.
 *
 * With a minimum code size of 7 over a 4-colour palette, no code the encoder
 * emits can ever reach the point where the dictionary would need to grow, so
 * every pixel is emitted as its own literal code and the stream stays valid
 * without a dictionary at all. Clear code is 128, end code is 129, and codes
 * are 8 bits — which lands each one on a byte boundary and removes the bit
 * packing entirely.
 */
function uncompressedImageData(pixels: number, colour: number): Buffer {
  const MIN_CODE_SIZE = 7;
  const CLEAR = 1 << MIN_CODE_SIZE;
  const END = CLEAR + 1;

  const codes: number[] = [CLEAR];
  for (let i = 0; i < pixels; i += 1) {
    codes.push(colour);

    // The dictionary fills as codes are emitted; clearing it before it would
    // need a ninth bit is what keeps every code exactly 8 bits wide.
    if (codes.length % 100 === 0) codes.push(CLEAR);
  }
  codes.push(END);

  const stream = Buffer.from(codes);

  // Sub-blocks: a length byte, up to 255 bytes, repeated, then a zero.
  const blocks: Buffer[] = [Buffer.from([MIN_CODE_SIZE])];
  for (let at = 0; at < stream.length; at += 255) {
    const chunk = stream.subarray(at, at + 255);
    blocks.push(Buffer.from([chunk.length]), chunk);
  }
  blocks.push(Buffer.from([0x00]));

  return Buffer.concat(blocks);
}
