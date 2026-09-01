/**
 * Attaching an image to a record: encode it, and keep exactly one original.
 *
 * The encoding half is `encodeAnnouncementImage`. This is the filesystem half,
 * and it exists because of a rule the build depends on: `content/media/` holds
 * **one** original per id.
 *
 * The build re-encodes from the original whenever `dist/` is missing a file,
 * and it finds that original by matching the filename stem against the id. Two
 * files with the same stem and different extensions — a `reports-center.png`
 * left behind when a `reports-center.jpg` replaced it — make that match
 * ambiguous, and whichever one the directory listing happens to return first is
 * the one the build re-encodes. When it is the stale one the bytes will not
 * hash to what the record says, and the build refuses every publish with a
 * message about re-attaching an image that was, in fact, attached correctly.
 *
 * So replacing an image removes the original it replaces. Nothing else in the
 * repository is deleted by an authoring operation, which is why it is spelled
 * out in the result rather than done quietly.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

import type { AnnouncementImage } from '@ruood/announcement-schema';

import { imageName, type RepoPaths } from '../paths';
import {
  ACCEPTED_INPUT_FORMATS,
  encodeAnnouncementImage,
  ImageEncodeError,
  sha256Of,
  type EncodedImage,
} from './encode';

export interface AttachImageInput {
  id: string;
  /** What a screen reader announces, and the only description if it fails to load. */
  alt: string;
  /**
   * The original bytes. Taken as a buffer rather than a path so the Manager can
   * attach an upload it never wrote to disk.
   */
  source: Buffer;
  /** Used only for its extension, and only after the bytes themselves decode. */
  filename: string;
}

export interface AttachImageResult {
  image: AnnouncementImage;
  encoded: EncodedImage;
  /** Where the original was kept, absolute. */
  originalPath: string;
  /** Originals for this id that were replaced, by name. */
  replacedOriginals: string[];
}

export async function attachImage(
  paths: RepoPaths,
  input: AttachImageInput,
): Promise<AttachImageResult> {
  const extension = acceptedExtension(input.filename);

  // Encode FIRST. It is the step that can legitimately refuse — an animated
  // image, one too small, one that will not fit the byte budget — and nothing
  // should have been written to content/ by the time it does.
  const encoded = await encodeAnnouncementImage(input.source, {
    id: input.id,
    alt: input.alt,
  });

  await mkdir(paths.media, { recursive: true });

  const originalName = `${input.id}${extension}`;
  const replacedOriginals = await removeOriginals(paths, input.id, originalName);

  const originalPath = join(paths.media, originalName);
  await writeFile(originalPath, input.source);

  return { image: encoded.image, encoded, originalPath, replacedOriginals };
}

/** Every `content/media/<id>.*` except the one about to be written. */
async function removeOriginals(
  paths: RepoPaths,
  id: string,
  keep: string,
): Promise<string[]> {
  if (!existsSync(paths.media)) return [];

  const removed: string[] = [];

  for (const entry of await readdir(paths.media)) {
    if (entry === keep) continue;
    if (entry.replace(/\.[^.]+$/, '') !== id) continue;

    await rm(join(paths.media, entry));
    removed.push(entry);
  }

  return removed;
}

/**
 * Removes the original when an image is detached.
 *
 * The record is what makes an image published; an orphaned original would only
 * be bytes in the repository that nothing will ever reference again.
 */
export async function removeOriginalsFor(paths: RepoPaths, id: string): Promise<string[]> {
  return removeOriginals(paths, id, '');
}

function acceptedExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  const format = extension.replace(/^\./, '');

  if (!(ACCEPTED_INPUT_FORMATS as readonly string[]).includes(format)) {
    throw new ImageEncodeError(
      `"${filename}" is not an accepted source format (${ACCEPTED_INPUT_FORMATS.join(', ')}). ` +
        'SVG is deliberately absent — it is a script vector.',
    );
  }

  return extension;
}

/**
 * The kept original for an id, or `null`.
 *
 * Matching is by filename stem, which is exactly why `attachImage` keeps only
 * one file per stem: this function has no way to choose between two.
 */
export async function findOriginalFor(paths: RepoPaths, id: string): Promise<Buffer | null> {
  if (!existsSync(paths.media)) return null;

  for (const entry of await readdir(paths.media)) {
    if (entry.replace(/\.[^.]+$/, '') === id) {
      return readFile(join(paths.media, entry));
    }
  }

  return null;
}

/**
 * The encoded bytes for a record's image, for showing one.
 *
 * `dist/` when it holds a file that still matches the record's hash, otherwise
 * re-encoded from the original — the same fallback `buildManifest` makes, and
 * for the same reason: `dist/` is disposable and reconstructible from
 * `content/` alone. So an image previews correctly before a build has ever run.
 *
 * `null` means there is nothing to show, which is never a reason to hide the
 * announcement — an image is optional at display time on the device too.
 */
export async function readEncodedImage(
  paths: RepoPaths,
  record: { id: string; image?: AnnouncementImage },
): Promise<Buffer | null> {
  if (!record.image) return null;

  const distFile = join(paths.images, imageName(record.id, record.image.sha256));
  if (existsSync(distFile)) {
    const data = await readFile(distFile);
    if (sha256Of(data) === record.image.sha256) return data;
  }

  const original = await findOriginalFor(paths, record.id);
  if (!original) return null;

  try {
    const encoded = await encodeAnnouncementImage(original, {
      id: record.id,
      alt: record.image.alt,
    });
    return encoded.data;
  } catch {
    // A preview that cannot be produced is a missing picture, not an error
    // worth failing a screen over. The build says so properly.
    return null;
  }
}
