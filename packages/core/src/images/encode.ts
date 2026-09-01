/**
 * The image pipeline: an original in, a published WebP out.
 *
 * ```
 * content/media/<id>.<ext>            the original, kept for ever
 *        │  validate format and decodability
 *        │  resize so the long edge is at most 1080
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
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MIN_DIMENSION,
  type AnnouncementImage,
} from '@ruood/announcement-schema';

import { imageManifestPath } from '../paths';

/** Input formats accepted. SVG is deliberately absent — it is a script vector. */
export const ACCEPTED_INPUT_FORMATS = ['png', 'jpeg', 'jpg', 'webp'] as const;

/**
 * Quality ladder.
 *
 * Stepped rather than binary-searched: four encodes is fast enough for a
 * hand-authored image, and a fixed ladder means the same input always produces
 * the same bytes — which a content-addressed filename requires.
 */
const QUALITY_LADDER = [82, 75, 68, 58] as const;

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
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  const maxDimension = options.maxDimension ?? IMAGE_MAX_DIMENSION;

  const probe = sharp(source, { failOn: 'error' });

  let metadata: sharp.Metadata;
  try {
    metadata = await probe.metadata();
  } catch (error) {
    throw new ImageEncodeError(`The file could not be decoded as an image: ${(error as Error).message}`);
  }

  assertAcceptable(metadata);

  // Only ever downscale. Enlarging a small source to reach 1080 adds bytes and
  // no detail, and `withoutEnlargement` is what keeps a 400px original at 400px.
  const resized = sharp(source, { failOn: 'error' })
    .rotate() // honour EXIF orientation before it is discarded
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' });

  for (const quality of QUALITY_LADDER) {
    const data = await resized.clone().webp({ quality, effort: 6 }).toBuffer();
    if (data.length > maxBytes) continue;

    const encoded = await sharp(data).metadata();
    const sha256 = createHash('sha256').update(data).digest('hex');

    return {
      data,
      quality,
      originalBytes: source.length,
      image: {
        path: imageManifestPath(options.id, sha256),
        width: encoded.width ?? 0,
        height: encoded.height ?? 0,
        bytes: data.length,
        sha256,
        alt: options.alt,
      },
    };
  }

  throw new ImageEncodeError(
    `Could not get this image under ${IMAGE_MAX_BYTES} bytes even at quality ` +
      `${QUALITY_LADDER[QUALITY_LADDER.length - 1]}. Crop it, or simplify it — every ` +
      'install downloads this file.',
  );
}

function assertAcceptable(metadata: sharp.Metadata): void {
  const format = metadata.format ?? 'unknown';
  if (!(ACCEPTED_INPUT_FORMATS as readonly string[]).includes(format)) {
    throw new ImageEncodeError(
      `"${format}" is not an accepted source format (${ACCEPTED_INPUT_FORMATS.join(', ')}).`,
    );
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width < IMAGE_MIN_DIMENSION || height < IMAGE_MIN_DIMENSION) {
    throw new ImageEncodeError(
      `The image is ${width}x${height}; the minimum is ${IMAGE_MIN_DIMENSION}px on each edge.`,
    );
  }

  if (metadata.pages !== undefined && metadata.pages > 1) {
    throw new ImageEncodeError(
      'Animated images are not supported. An announcement image is a still.',
    );
  }
}

export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
