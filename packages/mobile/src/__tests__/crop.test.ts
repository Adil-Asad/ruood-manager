/**
 * The crop arithmetic.
 *
 * Worth testing carefully because every failure mode here is silent. A crop
 * rectangle that overhangs the source makes `expo-image-manipulator` throw, and
 * the administrator reads "that image could not be used" about an image that
 * was fine. A crop that does not preserve the chosen shape produces an
 * announcement that is the wrong format on a million phones. Neither shows up
 * in a screenshot of the editor.
 *
 * The single invariant underneath all of it: **the output is a true
 * sub-rectangle of the source, at the chosen aspect ratio.** No stretching, no
 * empty edges.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_RATIO,
  MAX_ZOOM,
  RATIOS,
  aspectOf,
  clampOffset,
  clampScale,
  clampToImage,
  cropRectFor,
  fitCover,
  frameFor,
  outputSizeFor,
  ratioById,
  type Size,
} from '../crop';

const LANDSCAPE: Size = { width: 4000, height: 3000 };
const PORTRAIT: Size = { width: 3000, height: 4000 };
const SQUARE: Size = { width: 2000, height: 2000 };

describe('the four formats', () => {
  it('is exactly the four the brief names, at 1080 wide', () => {
    expect(RATIOS.map((ratio) => [ratio.shape, ratio.output.width, ratio.output.height])).toEqual([
      ['1:1', 1080, 1080],
      ['4:5', 1080, 1350],
      ['2:3', 1080, 1620],
      ['9:16', 1080, 1920],
    ]);
  });

  it('states each ratio exactly, with no rounding', () => {
    // 1080/1350 is 4/5 and 1080/1620 is 2/3 precisely. A format whose numbers
    // did not reduce to its name would crop to something other than what the
    // label promised.
    expect(aspectOf(ratioById('1:1'))).toBeCloseTo(1, 10);
    expect(aspectOf(ratioById('4:5'))).toBeCloseTo(5 / 4, 10);
    expect(aspectOf(ratioById('2:3'))).toBeCloseTo(3 / 2, 10);
    expect(aspectOf(ratioById('9:16'))).toBeCloseTo(16 / 9, 10);
  });

  it('offers them squarest first', () => {
    const aspects = RATIOS.map(aspectOf);
    expect([...aspects].sort((a, b) => a - b)).toEqual(aspects);
  });

  it('gives every format a word, not just numbers', () => {
    // A non-technical administrator picks "Square" or "Full screen". The
    // numbers are there for anyone who wants them and are never the only label.
    for (const ratio of RATIOS) {
      expect(ratio.label).toMatch(/^[A-Z]/);
      expect(ratio.label).not.toMatch(/\d/);
    }
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(ratioById('nonsense' as never).output.width).toBe(1080);
    expect(ratioById(DEFAULT_RATIO).id).toBe(DEFAULT_RATIO);
  });
});

describe('the frame', () => {
  it('fills the width when there is height to spare', () => {
    const frame = frameFor({ width: 300, height: 900 }, ratioById('1:1'));
    expect(frame).toEqual({ width: 300, height: 300 });
  });

  it('fits the height when the shape would overflow', () => {
    // A 9:16 frame 300 wide is 533 tall. On a 400-tall space it has to be
    // height-led, or the administrator cannot see what they are cropping.
    const frame = frameFor({ width: 300, height: 400 }, ratioById('9:16'));

    expect(frame.height).toBeLessThanOrEqual(400);
    expect(frame.height / frame.width).toBeCloseTo(16 / 9, 6);
  });

  it('always has exactly the chosen shape', () => {
    for (const ratio of RATIOS) {
      const frame = frameFor({ width: 320, height: 520 }, ratio);
      expect(frame.height / frame.width).toBeCloseTo(aspectOf(ratio), 6);
    }
  });
});

describe('fitCover', () => {
  it('covers the frame on the constraining axis', () => {
    const frame = { width: 300, height: 300 };
    const scale = fitCover(LANDSCAPE, frame);

    // Landscape into a square: height is the tight axis.
    expect(LANDSCAPE.height * scale).toBeCloseTo(300, 6);
    expect(LANDSCAPE.width * scale).toBeGreaterThanOrEqual(300);
  });

  it('never leaves either axis short, for any image and any format', () => {
    const frame = { width: 300, height: 400 };

    for (const image of [LANDSCAPE, PORTRAIT, SQUARE, { width: 50, height: 4000 }]) {
      const scale = fitCover(image, frame);

      // The whole point: at the minimum zoom the image still covers, so a crop
      // can never include an empty edge.
      expect(image.width * scale).toBeGreaterThanOrEqual(frame.width - 1e-6);
      expect(image.height * scale).toBeGreaterThanOrEqual(frame.height - 1e-6);
    }
  });

  it('does not divide by zero on a degenerate image', () => {
    expect(fitCover({ width: 0, height: 0 }, { width: 300, height: 300 })).toBe(1);
  });
});

describe('clampScale', () => {
  const frame = { width: 300, height: 375 };

  it('refuses to zoom out past covering the frame', () => {
    const minimum = fitCover(LANDSCAPE, frame);
    expect(clampScale(0.0001, LANDSCAPE, frame)).toBeCloseTo(minimum, 10);
  });

  it('caps zoom at a sensible multiple', () => {
    const minimum = fitCover(LANDSCAPE, frame);
    expect(clampScale(1000, LANDSCAPE, frame)).toBeCloseTo(minimum * MAX_ZOOM, 10);
  });

  it('leaves a scale in range alone', () => {
    const minimum = fitCover(LANDSCAPE, frame);
    expect(clampScale(minimum * 2, LANDSCAPE, frame)).toBeCloseTo(minimum * 2, 10);
  });
});

describe('clampOffset', () => {
  const frame = { width: 300, height: 375 };

  it('pins both axes at the minimum zoom on the tight one', () => {
    const scale = fitCover(SQUARE, frame);
    const offset = clampOffset({ x: 999, y: 999 }, SQUARE, frame, scale);

    // A square into a 4:5 frame: height is tight, so vertical slack is zero and
    // dragging up or down must do nothing at all.
    expect(offset.y).toBeCloseTo(0, 6);
  });

  it('allows movement on the axis that has slack', () => {
    const scale = fitCover(LANDSCAPE, frame);
    const offset = clampOffset({ x: 9999, y: 0 }, LANDSCAPE, frame, scale);

    expect(offset.x).toBeGreaterThan(0);
    // And not more than the overhang, or an edge would show.
    expect(offset.x).toBeCloseTo((LANDSCAPE.width * scale - frame.width) / 2, 6);
  });

  it('never lets the image uncover the frame, however hard it is dragged', () => {
    for (const image of [LANDSCAPE, PORTRAIT, SQUARE]) {
      for (const zoom of [1, 1.5, MAX_ZOOM]) {
        const scale = fitCover(image, frame) * zoom;
        const offset = clampOffset({ x: 1e6, y: -1e6 }, image, frame, scale);

        const slackX = (image.width * scale - frame.width) / 2;
        const slackY = (image.height * scale - frame.height) / 2;

        expect(Math.abs(offset.x)).toBeLessThanOrEqual(slackX + 1e-6);
        expect(Math.abs(offset.y)).toBeLessThanOrEqual(slackY + 1e-6);
      }
    }
  });
});

describe('cropRectFor', () => {
  const frame = { width: 300, height: 375 };

  it('takes the whole of the tight axis at minimum zoom', () => {
    const scale = fitCover(PORTRAIT, frame);
    const rect = cropRectFor(PORTRAIT, frame, scale, { x: 0, y: 0 });

    // Portrait 3000x4000 into a 4:5 frame: width is tight, so the crop spans
    // the full width and is centred vertically.
    expect(rect.originX).toBe(0);
    expect(rect.width).toBe(PORTRAIT.width);
  });

  it('produces the chosen SHAPE, not merely a rectangle', () => {
    for (const ratio of RATIOS) {
      const shaped = frameFor({ width: 300, height: 600 }, ratio);
      const scale = fitCover(LANDSCAPE, shaped);
      const rect = cropRectFor(LANDSCAPE, shaped, scale, { x: 0, y: 0 });

      // Within a pixel of rounding. A crop that drifted off the ratio would
      // publish an announcement in a format nobody chose.
      expect(rect.height / rect.width).toBeCloseTo(aspectOf(ratio), 2);
    }
  });

  it('NEVER leaves the source, at any zoom or offset', () => {
    // The failure this prevents is a manipulator error the administrator reads
    // as "that image could not be used" about an image that was fine.
    for (const image of [LANDSCAPE, PORTRAIT, SQUARE, { width: 640, height: 480 }]) {
      for (const ratio of RATIOS) {
        const shaped = frameFor({ width: 320, height: 520 }, ratio);

        for (const zoom of [1, 1.3, 2.7, MAX_ZOOM]) {
          const scale = fitCover(image, shaped) * zoom;

          for (const offset of [
            { x: 0, y: 0 },
            { x: 1e6, y: 1e6 },
            { x: -1e6, y: -1e6 },
            { x: 1e6, y: -1e6 },
          ]) {
            const clamped = clampOffset(offset, image, shaped, scale);
            const rect = cropRectFor(image, shaped, scale, clamped);

            expect(rect.originX).toBeGreaterThanOrEqual(0);
            expect(rect.originY).toBeGreaterThanOrEqual(0);
            expect(rect.width).toBeGreaterThan(0);
            expect(rect.height).toBeGreaterThan(0);
            expect(rect.originX + rect.width).toBeLessThanOrEqual(image.width);
            expect(rect.originY + rect.height).toBeLessThanOrEqual(image.height);
          }
        }
      }
    }
  });

  it('returns whole pixels', () => {
    const scale = fitCover(LANDSCAPE, frame) * 1.37;
    const rect = cropRectFor(LANDSCAPE, frame, scale, { x: 11.4, y: -7.9 });

    for (const value of Object.values(rect)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('moves the crop when the image is dragged, in the opposite direction', () => {
    const scale = fitCover(LANDSCAPE, frame) * 1.5;
    const centre = cropRectFor(LANDSCAPE, frame, scale, { x: 0, y: 0 });
    const dragged = cropRectFor(LANDSCAPE, frame, scale, { x: 30, y: 0 });

    // Dragging the image right shows what was to its LEFT, so the window moves
    // left. Getting this backwards is the classic crop bug and looks correct
    // until somebody compares the preview with the result.
    expect(dragged.originX).toBeLessThan(centre.originX);
  });

  it('zooming in takes a smaller piece of the source', () => {
    const near = fitCover(LANDSCAPE, frame);
    const far = near * 2;

    expect(cropRectFor(LANDSCAPE, frame, far, { x: 0, y: 0 }).width).toBeLessThan(
      cropRectFor(LANDSCAPE, frame, near, { x: 0, y: 0 }).width,
    );
  });

  it('survives a zero scale rather than producing Infinity', () => {
    const rect = cropRectFor(LANDSCAPE, frame, 0, { x: 0, y: 0 });
    expect(Number.isFinite(rect.width)).toBe(true);
    expect(rect.width).toBeGreaterThan(0);
  });
});

describe('clampToImage', () => {
  it('shifts an overhanging rectangle rather than shrinking it', () => {
    // Shrinking would silently change the aspect ratio the administrator chose.
    const rect = clampToImage(
      { originX: 3900, originY: 0, width: 200, height: 250 },
      LANDSCAPE,
    );

    expect(rect.width).toBe(200);
    expect(rect.height).toBe(250);
    expect(rect.originX + rect.width).toBe(LANDSCAPE.width);
  });

  it('shrinks only when the rectangle is genuinely bigger than the image', () => {
    const rect = clampToImage({ originX: 0, originY: 0, width: 9999, height: 9999 }, SQUARE);
    expect(rect).toEqual({ originX: 0, originY: 0, width: 2000, height: 2000 });
  });
});

describe('outputSizeFor', () => {
  it('encodes at the format size when the crop is big enough', () => {
    const ratio = ratioById('4:5');
    const size = outputSizeFor({ originX: 0, originY: 0, width: 2000, height: 2500 }, ratio);

    expect(size).toEqual({ width: 1080, height: 1350 });
  });

  it('never upscales a small crop', () => {
    // Enlarging invented pixels to 1080 adds bytes and no detail, and the
    // encoder would then spend its quality budget on them.
    const ratio = ratioById('1:1');
    const size = outputSizeFor({ originX: 0, originY: 0, width: 540, height: 540 }, ratio);

    expect(size.width).toBe(540);
    expect(size.height).toBe(540);
  });

  it('keeps the shape when it shrinks', () => {
    const ratio = ratioById('9:16');
    const size = outputSizeFor({ originX: 0, originY: 0, width: 540, height: 960 }, ratio);

    expect(size.height / size.width).toBeCloseTo(16 / 9, 2);
  });
});

/**
 * The crop rectangle and the cropper have to measure in the SAME pixels.
 *
 * This is a source sweep rather than an arithmetic test, because the arithmetic
 * was never wrong. `cropRectFor` returned exactly the right rectangle; it was
 * expressed in a coordinate system nothing else shared.
 *
 * The bug, on a real device: `useImageSize` asked `Image.getSize`, the editor
 * laid the picture out at that size, and every pixel on screen was
 * self-consistent — frame, drag, preview, all correct. The rectangle was then
 * handed to `expo-image-manipulator`, which measures in the file's true pixels.
 * At 4:5 on a 3000x2000 test card the editor framed the centre and the
 * committed image was the top-left corner.
 *
 * Nothing failed. No error, no warning, a plausible picture. The only way to
 * see it was to put the editor and the result side by side.
 *
 * So the size is asked of the manipulator itself, and this asserts that it
 * stays that way — the one property that makes the two impossible to disagree.
 */
describe('the crop and the cropper share one coordinate system', () => {
  /**
   * Comments are removed before anything is matched, as the isolation sweeps
   * do. The file below explains at length why `Image.getSize` must not be used
   * here, and a sweep that caught its own documentation would make the useful
   * comment the thing that fails.
   */
  const read = (file: string): string =>
    readFileSync(join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('takes the source size from the manipulator, not from Image.getSize', () => {
    const cropper = read(join('components', 'image-cropper.tsx'));

    // `Image.getSize` reports something the manipulator does not agree with.
    // Any reintroduction of it here brings the whole failure back.
    expect(cropper).not.toMatch(/Image\.getSize/);
    expect(cropper).toMatch(/sourceSize/);
  });

  it('asks the manipulator with no actions, so it reports the source itself', () => {
    const media = read('media.ts');

    // `manipulateAsync(uri, [])` decodes and reports, changing nothing. It is
    // the same library, reading the same file, naming the coordinate system it
    // is about to crop in.
    expect(media).toMatch(/export async function sourceSize/);
    expect(media).toMatch(/manipulateAsync\(uri, \[\]\)/);
  });
});
