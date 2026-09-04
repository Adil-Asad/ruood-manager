/**
 * Animated images, end to end through the real encoder.
 *
 * The rule every test here exists to protect: **an animation that goes in must
 * come out still moving.** `sharp(source)` without `{ animated: true }` reads
 * only the first frame and returns a perfectly valid, perfectly STILL image
 * with no error at all — so a suite that merely checked a GIF was *accepted*
 * would pass against a pipeline that had silently destroyed the animation, and
 * the bug would ship looking exactly like a success.
 *
 * So every assertion below is on the frame count of the OUTPUT bytes, read back
 * with sharp, rather than on anything the encoder reported about itself.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import {
  parseManifestText,
  ANIMATED_IMAGE_MAX_BYTES,
  ANIMATED_IMAGE_MAX_FRAMES,
  IMAGE_MAX_BYTES,
  validateAnnouncementRecord,
} from '@ruood/announcement-schema';

import { scaffoldRepository } from '../scaffold';
import { repoPaths } from '../paths';
import { saveRecord } from '../content/store';
import { buildManifest, writeBuild } from '../build/build';
import { encodeAnnouncementImage, isAnimated, sha256Of } from '../images/encode';
import { attachImage, readEncodedImage } from '../images/attach';
import { NOW, authored, withTempDir } from './fixtures';
import { animatedGif, stillGif } from './gif-fixture';

jest.setTimeout(60000);

async function samplePng(width = 800, height = 450): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 170, b: 90 } },
  })
    .png()
    .toBuffer();
}

/** Frames in these bytes, as a decoder on a device would count them. */
async function framesIn(data: Buffer): Promise<number> {
  return (await sharp(data, { animated: true }).metadata()).pages ?? 1;
}

describe('the fixture is genuinely an animation', () => {
  it('produces a real multi-frame GIF before anything touches it', async () => {
    const gif = animatedGif({ width: 400, height: 240, frames: 10 });
    const metadata = await sharp(gif, { animated: true }).metadata();

    // Without this the rest of the suite could pass over a one-frame file and
    // prove nothing at all.
    expect(metadata.format).toBe('gif');
    expect(metadata.pages).toBe(10);
    expect(metadata.width).toBe(400);
    expect(metadata.pageHeight).toBe(240);
  });

  it('produces a single-frame GIF when asked for one', async () => {
    expect(await isAnimated(stillGif(400, 240))).toBe(false);
    expect(await isAnimated(animatedGif({ width: 400, height: 240, frames: 3 }))).toBe(true);
  });
});

describe('encoding an animation', () => {
  it('keeps every frame', async () => {
    const gif = animatedGif({ width: 400, height: 240, frames: 10 });
    const encoded = await encodeAnnouncementImage(gif, { id: 'moving-notice', alt: 'It moves' });

    expect(await framesIn(encoded.data)).toBe(10);
    expect(encoded.animated).toBe(true);
    expect(encoded.frames).toBe(10);
  });

  it('emits a .webp, so there is still exactly one output format', async () => {
    const gif = animatedGif({ width: 400, height: 240, frames: 6 });
    const encoded = await encodeAnnouncementImage(gif, { id: 'moving-notice', alt: 'It moves' });

    // The whole reason animated WebP was chosen over passing GIF bytes through:
    // no second format, no second content type, no second decode path on the
    // device, and `IMAGE_PATH_PATTERN` unchanged.
    expect(encoded.image.path).toMatch(/^images\/moving-notice-[0-9a-f]{8}\.webp$/);
    expect((await sharp(encoded.data, { animated: true }).metadata()).format).toBe('webp');
  });

  it('stamps `animated` only when the output actually moves', async () => {
    const moving = await encodeAnnouncementImage(
      animatedGif({ width: 400, height: 240, frames: 4 }),
      { id: 'moving', alt: 'Moves' },
    );
    const still = await encodeAnnouncementImage(await samplePng(), { id: 'still', alt: 'Still' });

    expect(moving.image.animated).toBe(true);

    // Absent, not `false`. Every image published before animation existed is a
    // still, and none of them had to be rewritten to say so.
    expect(still.image.animated).toBeUndefined();
    expect(still.frames).toBe(1);
  });

  it('reports the height of ONE frame, not of the whole strip', async () => {
    const encoded = await encodeAnnouncementImage(
      animatedGif({ width: 400, height: 240, frames: 8 }),
      { id: 'moving', alt: 'Moves' },
    );

    // sharp reports an animated image's `height` as every frame stacked, so
    // without `pageHeight` this record would claim a 1920px-tall image and be
    // refused by the validator's dimension rule for a reason nobody could act
    // on.
    expect(encoded.image.height).toBe(240);
    expect(encoded.image.width).toBe(400);
  });

  it('downscales an oversized animation to the animated dimension cap', async () => {
    const encoded = await encodeAnnouncementImage(
      animatedGif({ width: 1000, height: 600, frames: 5 }),
      { id: 'big-moving', alt: 'Large and moving' },
    );

    // 640, not 1080: bytes scale with pixels times frames, so a 1080px
    // animation is a video with none of a video codec's compression.
    expect(encoded.image.width).toBe(640);
    expect(await framesIn(encoded.data)).toBe(5);
  });

  it('treats a single-frame GIF as an ordinary still', async () => {
    const encoded = await encodeAnnouncementImage(stillGif(400, 240), {
      id: 'not-moving',
      alt: 'A still GIF',
    });

    // A GIF is not automatically an animation, and treating it as one would
    // hand a still image a budget it has no use for.
    expect(encoded.animated).toBe(false);
    expect(encoded.image.animated).toBeUndefined();
    expect(await framesIn(encoded.data)).toBe(1);
  });

  it('refuses an animation with more frames than the cap', async () => {
    const gif = animatedGif({ width: 120, height: 80, frames: ANIMATED_IMAGE_MAX_FRAMES + 1 });

    await expect(
      encodeAnnouncementImage(gif, { id: 'too-long', alt: 'Far too long' }),
    ).rejects.toThrow(/frames; the limit is/);
  });

  it('still refuses SVG, which is a script vector whatever else changed', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"></svg>',
      'utf8',
    );

    await expect(encodeAnnouncementImage(svg, { id: 'vector', alt: 'A vector' })).rejects.toThrow();
  });
});

describe('the two byte budgets', () => {
  it('validates an animation against the animated cap', async () => {
    const encoded = await encodeAnnouncementImage(
      animatedGif({ width: 400, height: 240, frames: 10 }),
      { id: 'moving', alt: 'Moves' },
    );

    const result = validateAnnouncementRecord(authored({ id: 'moving', image: encoded.image }), {
      now: NOW,
      mode: 'authored',
    });

    expect(result.errors).toEqual([]);
    expect(encoded.image.bytes).toBeLessThanOrEqual(ANIMATED_IMAGE_MAX_BYTES);
  });

  it('does not hand a still image the animated cap', () => {
    const record = authored({
      id: 'oversized',
      image: {
        path: 'images/oversized-a1b2c3d4.webp',
        width: 800,
        height: 450,
        // Comfortably inside the animated budget, comfortably outside the still
        // one. The separate cap must not have quietly become everybody's cap.
        bytes: IMAGE_MAX_BYTES + 1,
        sha256: 'a'.repeat(64),
        alt: 'Too big',
      },
    });

    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(result.errors.map((issue) => issue.code)).toContain('image-too-large');
  });

  it('refuses an animation that is over even the animated cap', () => {
    const record = authored({
      id: 'enormous',
      image: {
        path: 'images/enormous-a1b2c3d4.webp',
        width: 640,
        height: 360,
        bytes: ANIMATED_IMAGE_MAX_BYTES + 1,
        sha256: 'a'.repeat(64),
        alt: 'Far too big',
        animated: true,
      },
    });

    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(result.errors.map((issue) => issue.code)).toContain('image-too-large');
  });

  it('refuses an animation wider than the animated dimension cap', () => {
    const record = authored({
      id: 'too-wide',
      image: {
        path: 'images/too-wide-a1b2c3d4.webp',
        width: 1000,
        height: 400,
        bytes: 200 * 1024,
        sha256: 'a'.repeat(64),
        alt: 'Too wide',
        animated: true,
      },
    });

    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(result.errors.map((issue) => issue.code)).toContain('image-dimension-invalid');
  });

  it('refuses a non-boolean `animated`', () => {
    const record = authored({
      id: 'confused',
      image: {
        path: 'images/confused-a1b2c3d4.webp',
        width: 400,
        height: 240,
        bytes: 20 * 1024,
        sha256: 'a'.repeat(64),
        alt: 'Confused',
        // Cast because the TYPE already forbids this — which is exactly why the
        // runtime check has to exist as well. A manifest arrives as JSON off a
        // network, where nothing has been typechecked.
        animated: 'yes' as unknown as boolean,
      },
    });

    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(result.errors.map((issue) => issue.path)).toContain('image.animated');
  });
});

describe('attaching an animation', () => {
  it('keeps the GIF original and re-encodes it as a moving WebP', async () => {
    await withTempDir(async (root) => {
      await scaffoldRepository(root);
      const paths = repoPaths(root);

      const result = await attachImage(paths, {
        id: 'moving-notice',
        alt: 'It moves',
        source: animatedGif({ width: 400, height: 240, frames: 6 }),
        filename: 'notice.gif',
      });

      // The original is kept as a GIF, exactly as a PNG original is kept as a
      // PNG — `content/media/` holds what the operator actually chose.
      expect(existsSync(join(paths.media, 'moving-notice.gif'))).toBe(true);
      expect(result.image.animated).toBe(true);

      // And re-encoding from that original — which is what the build does
      // whenever `dist/` is missing a file — still produces an animation. This
      // is the path that would quietly turn a published animation into a still
      // on the next rebuild.
      const reread = await readEncodedImage(paths, {
        id: 'moving-notice',
        image: result.image,
      });

      expect(reread).not.toBeNull();
      expect(await framesIn(reread!)).toBe(6);
    });
  });

  it('replaces a still original with an animated one, leaving exactly one file', async () => {
    await withTempDir(async (root) => {
      await scaffoldRepository(root);
      const paths = repoPaths(root);

      await attachImage(paths, {
        id: 'notice',
        alt: 'A still',
        source: await samplePng(),
        filename: 'notice.png',
      });

      const replaced = await attachImage(paths, {
        id: 'notice',
        alt: 'Now it moves',
        source: animatedGif({ width: 400, height: 240, frames: 5 }),
        filename: 'notice.gif',
      });

      // One original per id is load-bearing: the build finds an original by
      // matching the filename stem, and two files with the same stem make that
      // ambiguous.
      expect(replaced.replacedOriginals).toEqual(['notice.png']);
      expect(existsSync(join(paths.media, 'notice.png'))).toBe(false);
      expect(existsSync(join(paths.media, 'notice.gif'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The whole path
//
// Everything above tests one stage. This tests that the stages agree: a GIF
// attached through the filesystem, built into a manifest, and then read back by
// the CLIENT'S OWN PARSER — the same `parseManifestText` running in RUOOD Lab —
// still describes a moving picture that the parser accepts.
//
// It is the only test here that would catch the encoder and the validator
// drifting apart about which budget an animation gets.
// ---------------------------------------------------------------------------

describe('an animation, end to end', () => {
  it('survives attach → build → the client parser', async () => {
    await withTempDir(async (root) => {
      await scaffoldRepository(root);
      const paths = repoPaths(root);

      const record = authored({
        id: 'moving-notice',
        status: 'published',
        startAt: new Date(NOW - 60_000).toISOString(),
        endAt: null,
      });
      await saveRecord(paths, record);

      const attached = await attachImage(paths, {
        id: 'moving-notice',
        alt: 'It moves',
        source: animatedGif({ width: 400, height: 240, frames: 8 }),
        filename: 'notice.gif',
      });

      await saveRecord(paths, { ...record, image: attached.image });

      const built = await buildManifest(paths, { now: NOW });

      // The build refuses on any validation error, so this passing is already
      // the validator accepting an animation under the animated budget.
      expect(built.errors).toEqual([]);
      expect(built.ok).toBe(true);

      await writeBuild(paths, built);

      // Read back with the parser RUOOD Lab runs. Not a re-implementation and
      // not a looser check — literally the same function.
      const parsed = parseManifestText(await readFile(paths.manifest, 'utf8'), { now: NOW });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const published = parsed.manifest.announcements.find((entry) => entry.id === 'moving-notice');
      expect(published?.image?.animated).toBe(true);
      expect(published?.image?.path).toMatch(/\.webp$/);

      // And the file the manifest points at is still an animation, with bytes
      // that hash to what the record claims — which is exactly the pair of
      // facts the device checks before it will display anything.
      const file = join(paths.images, published!.image!.path.replace(/^images\//, ''));
      const bytes = await readFile(file);

      expect(await framesIn(bytes)).toBe(8);
      expect(sha256Of(bytes)).toBe(published!.image!.sha256);
    });
  });
});
