/**
 * The image pipeline: an original in, a published WebP out.
 *
 * ```
 * content/media/<id>.<ext>            the original, kept for ever
 *        │  validate format and decodability
 *        │  resize so the long edge is at most 1080 (640 if animated)
 *        │  flatten onto white (a phone dialog has no transparency to sit on)
 *        │  encode WebP, stepping quality down until it fits the byte budget
 *        │  sha256 the OUTPUT bytes
 *        ▼
 * dist/images/<id>-<hash8>.webp       content-addressed, immutable
 * ```
 *
 * The hash is of the encoded output, not the original, because the output is
 * what the client downloads and verifies. That also makes the filename change
 * whenever the bytes change, which is what lets an image be cached for ever.
 *
 * ## Animation
 *
 * A GIF may be attached, and if it moves it keeps moving. What ships is still a
 * single `.webp` — WebP is an animated format as well as a still one, so
 * accepting GIF input added **no** second output format, no second content
 * type, no second decode path on the device, and no change to
 * `IMAGE_PATH_PATTERN`. A GIF is decoded to frames, the frames are re-encoded,
 * and the result is a `.webp` exactly like every other image here.
 *
 * That is why animated WebP was chosen over passing GIF bytes straight through.
 * A `.gif` in `dist/` would have meant two formats to validate, two content
 * types to serve, two things a client must decode, and files several times the
 * size — for a picture nobody can tell apart on a phone.
 *
 * The single most important rule in this file: **an animation must not be
 * flattened into one frame.** `sharp(source)` without `{ animated: true }`
 * silently reads only the first frame, which produces a perfectly valid,
 * perfectly still image and no error at all. `pipeline.test.ts` asserts the
 * frame count of the OUTPUT for exactly that reason — a test that only checked
 * the file was accepted would pass against a pipeline that had quietly thrown
 * the animation away.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';

import {
  ANIMATED_IMAGE_MAX_BYTES,
  ANIMATED_IMAGE_MAX_DIMENSION,
  ANIMATED_IMAGE_MAX_FRAMES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MIN_DIMENSION,
  type AnnouncementImage,
} from '@ruood/announcement-schema';

import { imageManifestPath } from '../paths';

/**
 * Input formats accepted.
 *
 * SVG is deliberately absent — it is a script vector. GIF is present, and only
 * because the output stays WebP: accepting a format is a decision about what
 * can be decoded, not about what is shipped.
 */
export const ACCEPTED_INPUT_FORMATS = ['png', 'jpeg', 'jpg', 'webp', 'gif'] as const;

/**
 * Quality ladder.
 *
 * Stepped rather than binary-searched: four encodes is fast enough for a
 * hand-authored image, and a fixed ladder means the same input always produces
 * the same bytes — which a content-addressed filename requires.
 */
const QUALITY_LADDER = [82, 75, 68, 58] as const;

/**
 * The ladder for an animation, which needs more room to move.
 *
 * It starts lower and goes further down, because the byte cost of a frame is
 * multiplied by every other frame: a quality that costs a still image 40 KB
 * costs a 60-frame animation something nobody should download. Ending at 40 is
 * still watchable at the size a dialog draws it.
 */
const ANIMATED_QUALITY_LADDER = [72, 62, 52, 40] as const;

export class ImageEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageEncodeError';
  }
}

export interface EncodedImage {
  /** The bytes to write to `dist/images/`. */
  data: Buffer;
  /** The `image` object to stamp onto the record. */
  image: AnnouncementImage;
  /** Which rung of the ladder was used — reported so a soft image is visible. */
  quality: number;
  originalBytes: number;
  /** Whether the OUTPUT moves. Read from the encoded file, never from the input. */
  animated: boolean;
  /** Frames in the output. `1` for a still. */
  frames: number;
}

export interface EncodeOptions {
  id: string;
  alt: string;
  maxBytes?: number;
  maxDimension?: number;
}

export async function encodeAnnouncementImage(
  source: Buffer,
  options: EncodeOptions,
): Promise<EncodedImage> {
  // Probed with `animated: true` so `pages` is the real frame count rather than
  // the 1 that a still read would report for every GIF in existence.
  const probe = sharp(source, { failOn: 'error', animated: true });

  let metadata: sharp.Metadata;
  try {
    metadata = await probe.metadata();
  } catch (error) {
    throw new ImageEncodeError(`The file could not be decoded as an image: ${(error as Error).message}`);
  }

  const frames = metadata.pages ?? 1;
  const animated = frames > 1;

  assertAcceptable(metadata, frames, animated);

  const maxBytes =
    options.maxBytes ?? (animated ? ANIMATED_IMAGE_MAX_BYTES : IMAGE_MAX_BYTES);
  const maxDimension =
    options.maxDimension ?? (animated ? ANIMATED_IMAGE_MAX_DIMENSION : IMAGE_MAX_DIMENSION);

  const ladder = animated ? ANIMATED_QUALITY_LADDER : QUALITY_LADDER;

  for (const quality of ladder) {
    // Rebuilt per rung rather than cloned, because a sharp instance opened with
    // `animated: true` carries frame state that does not survive being reused
    // across encodes. Four decodes of one hand-picked image is not a cost worth
    // optimising against a class of bug that reads as "the animation broke".
    const data = await pipelineFor(source, animated, maxDimension)
      .webp({ quality, effort: 6 })
      .toBuffer();

    if (data.length > maxBytes) continue;

    // Read back from the OUTPUT. Everything stamped on the record describes the
    // file the device will download, not the file the operator chose — which is
    // the same reason `sha256` is over the output too.
    const encoded = await sharp(data, { animated: true }).metadata();
    const outputFrames = encoded.pages ?? 1;
    const sha256 = createHash('sha256').update(data).digest('hex');

    // The one failure this whole file exists to make impossible. An animation
    // that arrived with frames and left with one has not been optimised, it has
    // been destroyed — and it would ship looking entirely correct.
    if (animated && outputFrames <= 1) {
      throw new ImageEncodeError(
        'The animation was lost during encoding: the input had ' +
          `${frames} frames and the output has ${outputFrames}. This is a bug in the image ` +
          'pipeline, not a problem with the image — publishing a still frame in place of an ' +
          'animation would look like a success.',
      );
    }

    return {
      data,
      quality,
      originalBytes: source.length,
      animated,
      frames: outputFrames,
      image: {
        path: imageManifestPath(options.id, sha256),
        // `height` on an animated WebP read with `animated: true` is the height
        // of the whole frame STRIP — every frame stacked. `pageHeight` is the
        // height of one frame, which is what a renderer draws and what the
        // validator's dimension rule is about.
        width: encoded.width ?? 0,
        height: (animated ? encoded.pageHeight : encoded.height) ?? encoded.height ?? 0,
        bytes: data.length,
        sha256,
        alt: options.alt,
        // Stamped from what was produced, never from what was asked for. The
        // validator picks the byte budget off this field, so a flag that could
        // disagree with the file would be a budget granted to the wrong thing.
        ...(animated ? { animated: true } : {}),
      },
    };
  }

  const cap = animated ? ANIMATED_IMAGE_MAX_BYTES : IMAGE_MAX_BYTES;
  throw new ImageEncodeError(
    `Could not get this image under ${cap} bytes even at quality ` +
      `${ladder[ladder.length - 1]}. ` +
      (animated
        ? 'Shorten the animation, crop it, or use fewer frames — every install downloads ' +
          'this file.'
        : 'Crop it, or simplify it — every install downloads this file.'),
  );
}

/**
 * The decode-and-resize half, built fresh for each quality rung.
 *
 * `animated: true` is what makes `resize` operate on every frame instead of the
 * first. Without it sharp reads frame one and returns a still image with no
 * error whatsoever, which is the quiet failure this pipeline is built around.
 */
function pipelineFor(source: Buffer, animated: boolean, maxDimension: number): sharp.Sharp {
  const image = sharp(source, { failOn: 'error', ...(animated ? { animated: true } : {}) });

  // EXIF orientation applies to photographs, and `rotate()` on an animated
  // frame strip rotates the strip rather than the frames. Stills only.
  if (!animated) image.rotate();

  return (
    image
      .resize({
        // Only ever downscale. Enlarging a small source adds bytes and no
        // detail, and `withoutEnlargement` is what keeps a 400px original 400px.
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
  );
}

function assertAcceptable(metadata: sharp.Metadata, frames: number, animated: boolean): void {
  const format = metadata.format ?? 'unknown';
  if (!(ACCEPTED_INPUT_FORMATS as readonly string[]).includes(format)) {
    throw new ImageEncodeError(
      `"${format}" is not an accepted source format (${ACCEPTED_INPUT_FORMATS.join(', ')}).`,
    );
  }

  const width = metadata.width ?? 0;
  // For an animated source `height` is the whole strip; one frame is `pageHeight`.
  const height = (animated ? metadata.pageHeight : metadata.height) ?? metadata.height ?? 0;

  if (width < IMAGE_MIN_DIMENSION || height < IMAGE_MIN_DIMENSION) {
    throw new ImageEncodeError(
      `The image is ${width}x${height}; the minimum is ${IMAGE_MIN_DIMENSION}px on each edge.`,
    );
  }

  // A cap on frames as well as on bytes, because they constrain different
  // failures: bytes protect the download, frames protect the decode. A long
  // animation that happens to compress well still costs every device the memory
  // to hold the un-optimised strip.
  if (frames > ANIMATED_IMAGE_MAX_FRAMES) {
    throw new ImageEncodeError(
      `The animation has ${frames} frames; the limit is ${ANIMATED_IMAGE_MAX_FRAMES}. ` +
        'Shorten it, or export it at a lower frame rate.',
    );
  }
}

export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Whether these bytes hold more than one frame.
 *
 * Exported because the *server* has to answer this about an upload before it
 * trusts anything a client said about it — §26's rule that a filename and a
 * declared MIME type are not evidence.
 */
export async function isAnimated(source: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(source, { animated: true }).metadata();
    return (metadata.pages ?? 1) > 1;
  } catch {
    return false;
  }
}
