/**
 * An original the record does not reference yet.
 *
 * This is the whole of how a picture chosen on a phone reaches a device. The
 * Manager app has no `sharp`, no checkout and no filesystem, so it cannot
 * produce an `image` object — the size, the byte count and the sha256 in one
 * are all facts about the ENCODED WebP, which does not exist until something
 * encodes it. All the phone can do is commit the original to
 * `content/media/<id>.<ext>` beside a record with no `image`.
 *
 * Nothing joined the two. The build skipped every record without an `image`,
 * and the announcement published with no picture — silently, because an
 * announcement without one is perfectly valid. Six announcements were created
 * on the phone with pictures attached and not one of them shipped with an
 * image; the only one that ever did had been attached from a laptop with the
 * CLI.
 *
 * These are integration tests against real encoding for the same reason the
 * rest of `pipeline.test.ts` is: what is being checked is the wiring.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { scaffoldRepository } from '../../scaffold';
import { saveRecord } from '../../content/store';
import { buildManifest } from '../build';
import { NOW, authored, withTempDir } from '../../__tests__/fixtures';

jest.setTimeout(60000);

/** A 4:5 Portrait crop, the shape the Manager's default frame produces. */
async function portrait(width = 864, height = 1080): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

describe('an original with no reference', () => {
  it('is encoded, stamped onto the manifest and written to dist', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      // Exactly what the phone commits: a record with no `image`, and the
      // original beside it.
      await saveRecord(paths, authored({ image: undefined }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      const result = await buildManifest(paths, { now: NOW });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);

      const image = result.manifest.announcements[0]?.image;
      expect(image).toBeDefined();
      expect(image?.path).toMatch(/^images\/reports-center-[0-9a-f]{8}\.webp$/);
      expect(image?.sha256).toHaveLength(64);
      // The frame survives: the app reads the shape back from these two
      // numbers, because nothing else carries it.
      expect((image!.width / image!.height).toFixed(2)).toBe('0.80');

      // And the bytes are in the build, under the content-addressed name.
      expect([...result.imageFiles.keys()]).toEqual([
        `reports-center-${image!.sha256.slice(0, 8)}.webp`,
      ]);
    });
  });

  it('describes the picture with the announcement title', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ image: undefined, title: 'Reports Center' }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      const result = await buildManifest(paths, { now: NOW });

      // `alt` may not be empty and the phone does not ask for one. The title is
      // the only honest answer available, and it is already validated as
      // single-line plain text.
      expect(result.manifest.announcements[0]?.image?.alt).toBe('Reports Center');
    });
  });

  // The image-only announcement, end to end: the phone writes a record with no
  // words and no `image`, and the picture is the whole message.
  it('publishes a record with a picture and no words at all', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ image: undefined, title: '', body: '' }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      const result = await buildManifest(paths, { now: NOW });

      // It validates — the original in `content/media/` is what makes it a
      // record with content, before anything has encoded it — and it publishes.
      expect(result.errors).toEqual([]);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);

      const record = result.manifest.announcements[0]!;
      expect(record.image?.path).toMatch(/\.webp$/);
      // `alt` may not be empty and there is no title to take it from.
      expect(record.image?.alt).toBe('Announcement image');
    });
  });

  it('refuses a record with no picture, no title and no message', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored({ image: undefined, title: '', body: '' }));

      const result = await buildManifest(paths, { now: NOW });

      expect(result.ok).toBe(false);
      expect(result.errors.some((issue) => issue.code === 'content-empty')).toBe(true);
    });
  });

  it('describes a picture with the message when there is no title', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(
        paths,
        authored({ image: undefined, title: '', body: 'Eid hours\nOpen until four.' }),
      );
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      const result = await buildManifest(paths, { now: NOW });

      // Collapsed to one line, because `alt` is single-line text.
      expect(result.manifest.announcements[0]?.image?.alt).toBe('Eid hours Open until four.');
    });
  });

  it('leaves a record that already carries an image exactly as it was', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ image: undefined }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      const first = await buildManifest(paths, { now: NOW });
      const attached = first.manifest.announcements[0]!.image!;

      // Re-running is the case that matters: the build is deterministic, so the
      // second pass must reach the same bytes rather than a second file.
      const second = await buildManifest(paths, { now: NOW });
      expect(second.manifest.announcements[0]?.image).toEqual(attached);
      expect([...second.imageFiles.keys()]).toEqual([...first.imageFiles.keys()]);
    });
  });

  it('publishes no picture when there is no original', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored({ image: undefined }));

      const result = await buildManifest(paths, { now: NOW });

      expect(result.problems).toEqual([]);
      expect(result.manifest.announcements[0]?.image).toBeUndefined();
      expect(result.imageFiles.size).toBe(0);
    });
  });

  it('refuses the publish when an original cannot be encoded', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ image: undefined }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), Buffer.from('not an image'));

      const result = await buildManifest(paths, { now: NOW });

      // Somebody attached a picture. If it cannot ship, they have to be told —
      // silently publishing without it is the bug this whole file is about.
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('reports-center');
    });
  });

  it('writes nothing back into content/, which stays the authored record', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ image: undefined }));
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.jpg'), await portrait());

      await buildManifest(paths, { now: NOW });

      // The manifest is derived; the record is authored. A build that edited
      // `content/` would be an author, and the next diff would show a change
      // nobody made.
      const stored = JSON.parse(
        await import('node:fs/promises').then((fs) =>
          fs.readFile(join(paths.announcements, 'reports-center.json'), 'utf8'),
        ),
      ) as Record<string, unknown>;

      expect(stored.image).toBeUndefined();
      expect((await readdir(paths.media)).filter((name) => name !== '.gitkeep')).toEqual([
        'reports-center.jpg',
      ]);
    });
  });
});
