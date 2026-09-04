/**
 * The four announcement formats, and the arithmetic behind cropping to one.
 *
 * Pure, and separated from the gesture handling for the usual reason: this is
 * the part that can be wrong in a way nobody notices until an announcement is
 * on a million phones with a black stripe down one side. The component that
 * drags fingers around is not testable; this is.
 *
 * ## The one rule everything here serves
 *
 * **Never stretch, never letterbox.** The image is scaled by ONE factor on both
 * axes — there is no separate `scaleX` and `scaleY` anywhere in this file, and
 * there must not be — and it is always at least large enough to cover the
 * frame. Those two together mean the output is a true sub-rectangle of the
 * source: no distortion, and no empty edges.
 *
 * `fitCover` is what guarantees the second half, and `clampOffset` is what
 * keeps it true while somebody drags.
 *
 * ## Why 1080 wide
 *
 * Every format is 1080 on its short edge, which is the width of a modern phone
 * screen at 3x and the point past which more pixels are bytes nobody can see.
 * The publish pipeline will re-encode and may shrink further; these are the
 * dimensions the administrator is composing against.
 */

/** A size in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A rectangle in SOURCE-image pixel coordinates, for `expo-image-manipulator`. */
export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export type RatioId = '1:1' | '4:5' | '2:3' | '9:16';

export interface Ratio {
  id: RatioId;
  /** What the administrator reads. Never "aspect ratio". */
  label: string;
  /** A word for the shape, so the four are tellable apart at a glance. */
  shape: string;
  /** The published size. */
  output: Size;
}

/**
 * The four formats, in the order they are offered.
 *
 * Squarest first, tallest last, so the row reads as a progression rather than a
 * list somebody has to parse. The labels are the shapes; the numbers are there
 * for anyone who wants them and are never the primary text.
 */
export const RATIOS: readonly Ratio[] = [
  { id: '1:1', label: 'Square', shape: '1:1', output: { width: 1080, height: 1080 } },
  { id: '4:5', label: 'Portrait', shape: '4:5', output: { width: 1080, height: 1350 } },
  { id: '2:3', label: 'Tall', shape: '2:3', output: { width: 1080, height: 1620 } },
  { id: '9:16', label: 'Full screen', shape: '9:16', output: { width: 1080, height: 1920 } },
];

export const DEFAULT_RATIO: RatioId = '4:5';

export function ratioById(id: RatioId): Ratio {
  return RATIOS.find((ratio) => ratio.id === id) ?? RATIOS[1]!;
}

/** Height divided by width. The number the frame is laid out from. */
export function aspectOf(ratio: Ratio): number {
  return ratio.output.height / ratio.output.width;
}

/**
 * The frame the image is composed inside, given the space available.
 *
 * Width-led until the frame would be taller than the space allows, then
 * height-led. Without the second half a 9:16 frame on a short screen runs off
 * the bottom and the administrator cannot see what they are cropping.
 */
export function frameFor(available: Size, ratio: Ratio): Size {
  const aspect = aspectOf(ratio);
  const byWidth = { width: available.width, height: available.width * aspect };

  if (byWidth.height <= available.height) return byWidth;
  return { width: available.height / aspect, height: available.height };
}

/**
 * The smallest scale at which the image still covers the frame.
 *
 * This is the floor for zoom. Below it the image would not fill the frame and
 * the crop would include nothing — which is the letterboxing this file exists
 * to prevent.
 */
export function fitCover(image: Size, frame: Size): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.max(frame.width / image.width, frame.height / image.height);
}

/** How far past `fitCover` somebody may zoom. Four times is plenty for framing. */
export const MAX_ZOOM = 4;

export function clampScale(scale: number, image: Size, frame: Size): number {
  const minimum = fitCover(image, frame);
  return Math.min(Math.max(scale, minimum), minimum * MAX_ZOOM);
}

/**
 * The offset, pulled back so the image still covers the frame.
 *
 * `offset` is the centre of the image relative to the centre of the frame, in
 * frame pixels. The slack on each axis is half of whatever the scaled image has
 * beyond the frame; at exactly `fitCover` one axis has zero slack and does not
 * move at all, which is correct and is what stops a drag revealing an edge.
 */
export function clampOffset(
  offset: { x: number; y: number },
  image: Size,
  frame: Size,
  scale: number,
): { x: number; y: number } {
  const scaled = { width: image.width * scale, height: image.height * scale };

  // `max(0, …)` because floating point can make a "covering" image a fraction
  // of a pixel short, and a negative slack would invert the clamp and let the
  // image drift away entirely.
  const slackX = Math.max(0, (scaled.width - frame.width) / 2);
  const slackY = Math.max(0, (scaled.height - frame.height) / 2);

  return {
    x: Math.min(Math.max(offset.x, -slackX), slackX),
    y: Math.min(Math.max(offset.y, -slackY), slackY),
  };
}

/**
 * The crop rectangle, in SOURCE pixels.
 *
 * The inverse of what the screen is doing: the frame is a window onto an image
 * that has been scaled by `scale` and shifted by `offset`, so the window's
 * position in source coordinates is that transform undone.
 *
 * Rounded, and then clamped to the image bounds. `expo-image-manipulator`
 * fails outright on a rectangle that leaves the source — a half-pixel of
 * rounding at maximum zoom is enough to do it — and a failure here reads to the
 * administrator as "that image could not be used", which would be untrue.
 */
export function cropRectFor(
  image: Size,
  frame: Size,
  scale: number,
  offset: { x: number; y: number },
): CropRect {
  const safeScale = scale > 0 ? scale : 1;

  // Frame size expressed in source pixels.
  const width = frame.width / safeScale;
  const height = frame.height / safeScale;

  // The image's centre sits `offset` away from the frame's centre, so the
  // frame's top-left in source coordinates is the image centre, minus the
  // offset, minus half the window.
  const originX = image.width / 2 - offset.x / safeScale - width / 2;
  const originY = image.height / 2 - offset.y / safeScale - height / 2;

  const rounded = {
    originX: Math.round(originX),
    originY: Math.round(originY),
    width: Math.round(width),
    height: Math.round(height),
  };

  return clampToImage(rounded, image);
}

/**
 * A rectangle pulled inside the image.
 *
 * Shifted before it is shrunk: moving a rectangle that overhangs keeps the
 * requested size, and therefore the requested shape, where trimming it would
 * silently change the aspect ratio the administrator chose.
 */
export function clampToImage(rect: CropRect, image: Size): CropRect {
  const width = Math.max(1, Math.min(rect.width, image.width));
  const height = Math.max(1, Math.min(rect.height, image.height));

  return {
    width,
    height,
    originX: Math.min(Math.max(rect.originX, 0), image.width - width),
    originY: Math.min(Math.max(rect.originY, 0), image.height - height),
  };
}

/**
 * The size to encode a crop at.
 *
 * Never enlarged past what the crop actually contains: upscaling a small
 * selection to 1080 adds bytes and no detail, and the encoder would then spend
 * its quality budget on invented pixels. The aspect ratio is preserved either
 * way, so a small crop is simply a smaller file of the same shape.
 */
export function outputSizeFor(crop: CropRect, ratio: Ratio): Size {
  const target = ratio.output;
  if (crop.width >= target.width) return target;

  const scale = crop.width / target.width;
  return {
    width: Math.max(1, Math.round(target.width * scale)),
    height: Math.max(1, Math.round(target.height * scale)),
  };
}
