import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

import { encodeAnnouncementImage, touch } from '@ruood/announcement-core';

import { flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { paths, requireRecord, writeRecord } from './shared';

/**
 * Encodes an image and attaches it to a record.
 *
 * Encoding happens HERE rather than at build time, deliberately. The record
 * carries the finished `image` object — path, dimensions, bytes and hash — so
 * the build has only to make sure the file exists, and the diff can show an
 * image change as a change to the record rather than as a mysterious byte
 * delta.
 *
 * The original is copied into `content/media/` and kept. Throwing away the
 * source of an encoded image is irreversible, and you will want it when the
 * byte budget changes or a crop turns out wrong.
 */
export async function runImage(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0];
  const file = ctx.args.positionals[1];

  if (!id || !file) {
    ctx.err('image requires an announcement id and a path to an image file.');
    return 2;
  }

  if (!existsSync(file)) {
    ctx.err(`No such file: ${file}`);
    return 2;
  }

  const found = await requireRecord(ctx, id);
  if (!found) return 1;

  const alt = flagString(ctx.args, 'alt') ?? found.record.image?.alt;
  if (!alt) {
    ctx.err(
      '--alt <text> is required the first time an image is attached. It is what a screen ' +
        'reader announces, and it is the only description if the image fails to load.',
    );
    return 2;
  }

  const source = await readFile(file);

  let encoded;
  try {
    encoded = await encodeAnnouncementImage(source, { id, alt });
  } catch (error) {
    ctx.err((error as Error).message);
    return 1;
  }

  const repo = paths(ctx);
  await mkdir(repo.media, { recursive: true });
  await copyFile(file, join(repo.media, `${id}${extname(file).toLowerCase()}`));

  await writeRecord(ctx, touch(found.record, { image: encoded.image }, ctx.now));

  const saved = Math.round((1 - encoded.image.bytes / encoded.originalBytes) * 100);

  ctx.out(`Attached an image to "${id}".`);
  ctx.out(
    `  ${encoded.image.width}x${encoded.image.height} WebP, ` +
      `${encoded.image.bytes} bytes (${saved}% smaller than the original), quality ${encoded.quality}`,
  );
  ctx.out(`  ${encoded.image.path}`);
  ctx.out(`  original kept at content/media/${id}${extname(file).toLowerCase()}`);
  ctx.out('');
  ctx.out(
    'The filename carries the content hash, so replacing this image later writes a new file ' +
      'and the old one is pruned on the next build.',
  );

  return 0;
}
