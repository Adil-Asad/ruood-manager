/**
 * The pipeline end to end, against a real filesystem, real image encoding and a
 * real git repository.
 *
 * These are integration tests on purpose. The pure parts are unit-tested
 * elsewhere; what is left is exactly the wiring that a unit test cannot prove —
 * that a scaffolded repository builds, that a publish is one commit, that
 * `dist/` is reconstructible, and that a rejected publish writes nothing.
 */

import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';
import { parseManifestText } from '@ruood/announcement-schema';

import { scaffoldRepository } from '../scaffold';
import { repoPaths } from '../paths';
import { saveRecord, loadContent, deleteRecord } from '../content/store';
import { buildManifest, readPublished, writeBuild } from '../build/build';
import { encodeAnnouncementImage } from '../images/encode';
import { publish } from '../publish/publish';
import { AnnouncementRepo } from '../git/repository';
import { NOW, authored, withTempDir } from './fixtures';

jest.setTimeout(60000);

async function repoWithIdentity(root: string): Promise<AnnouncementRepo> {
  const repo = new AnnouncementRepo(root);
  await repo.setIdentity('Test', 'test@example.com');
  return repo;
}

async function samplePng(width = 800, height = 450): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 170, b: 90 } },
  })
    .png()
    .toBuffer();
}

describe('scaffolding', () => {
  it('creates a repository that builds immediately', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      expect(existsSync(paths.announcements)).toBe(true);
      expect(existsSync(paths.retiredIds)).toBe(true);
      expect(await new AnnouncementRepo(dir).isRepository()).toBe(true);

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(true);
      expect(result.manifest.announcements).toHaveLength(0);
    });
  });

  it('writes a valid empty manifest, so a client fetching early gets a file not a 404', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const raw = await readFile(paths.manifest, 'utf8');
      expect(parseManifestText(raw, { now: NOW }).ok).toBe(true);
    });
  });

  it('creates its OWN repository even inside another checkout', async () => {
    // Found by an end-to-end run: plain checkIsRepo() is true for any
    // subdirectory of a repository, so init was skipped and every later
    // publish committed into the ENCLOSING repository instead.
    await withTempDir(async (outer) => {
      await new AnnouncementRepo(outer).init();

      const nested = join(outer, 'announcements');
      const result = await scaffoldRepository(nested);

      expect(existsSync(join(nested, '.git'))).toBe(true);
      expect(await new AnnouncementRepo(nested).isRepository()).toBe(true);
      expect(result.nestedInsideRepository).toBe(true);
    });
  });

  it('does not report nesting for a standalone repository', async () => {
    await withTempDir(async (dir) => {
      expect((await scaffoldRepository(dir)).nestedInsideRepository).toBe(false);
    });
  });

  it('is idempotent', async () => {
    await withTempDir(async (dir) => {
      await scaffoldRepository(dir);
      const second = await scaffoldRepository(dir);
      expect(second.created).toEqual([]);
      expect(second.alreadyExisted).toBe(true);
    });
  });
});

describe('build', () => {
  it('publishes only what should be published', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);

      await saveRecord(paths, authored({ id: 'live' }));
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));
      await saveRecord(paths, authored({ id: 'archived-one', status: 'archived' }));

      const result = await buildManifest(paths, { now: NOW });

      expect(result.ok).toBe(true);
      expect(result.manifest.announcements.map((r) => r.id)).toEqual(['live']);
      expect(result.excluded.map((e) => e.id).sort()).toEqual(['a-draft', 'archived-one']);
    });
  });

  it('is deterministic — the same content and clock produce the same bytes', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored());

      const first = await buildManifest(paths, { now: NOW, keepRevision: true });
      const second = await buildManifest(paths, { now: NOW, keepRevision: true });
      expect(first.serialised).toBe(second.serialised);
    });
  });

  it('refuses to build a record that would not validate', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored({ title: '' }));

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.errors.some((issue) => issue.code === 'text-empty')).toBe(true);
    });
  });

  it('surfaces a file that will not parse rather than skipping it silently', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await writeFile(join(paths.announcements, 'broken.json'), '{ not json', 'utf8');

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('broken.json');
    });
  });

  it('catches a filename that disagrees with the record id', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await writeFile(
        join(paths.announcements, 'wrong-name.json'),
        JSON.stringify(authored({ id: 'reports-center' })),
        'utf8',
      );

      const content = await loadContent(paths);
      expect(content.failures[0]!.error).toMatch(/Filename says/);
    });
  });

  it('bumps the revision, and keepRevision does not', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored());

      expect((await buildManifest(paths, { now: NOW })).manifest.revision).toBe(1);
      expect((await buildManifest(paths, { now: NOW, keepRevision: true })).manifest.revision).toBe(0);
    });
  });
});

describe('images', () => {
  it('encodes to WebP under the byte cap and names the file by its hash', async () => {
    const encoded = await encodeAnnouncementImage(await samplePng(), {
      id: 'reports-center',
      alt: 'A screen',
    });

    expect(encoded.image.bytes).toBeLessThanOrEqual(150 * 1024);
    expect(encoded.image.path).toMatch(/^images\/reports-center-[0-9a-f]{8}\.webp$/);
    expect(encoded.image.path).toContain(encoded.image.sha256.slice(0, 8));
    expect((await sharp(encoded.data).metadata()).format).toBe('webp');
  });

  it('downscales an oversized image but never enlarges a small one', async () => {
    const big = await encodeAnnouncementImage(await samplePng(3000, 2000), {
      id: 'big',
      alt: 'x',
    });
    expect(big.image.width).toBe(1080);

    const small = await encodeAnnouncementImage(await samplePng(320, 200), {
      id: 'small',
      alt: 'x',
    });
    expect(small.image.width).toBe(320);
  });

  it('is deterministic, which content addressing requires', async () => {
    const source = await samplePng();
    const a = await encodeAnnouncementImage(source, { id: 'x', alt: 'x' });
    const b = await encodeAnnouncementImage(source, { id: 'x', alt: 'x' });
    expect(a.image.sha256).toBe(b.image.sha256);
  });

  it('refuses something that is not an image', async () => {
    await expect(
      encodeAnnouncementImage(Buffer.from('this is not an image'), { id: 'x', alt: 'x' }),
    ).rejects.toThrow(/could not be decoded/);
  });

  it('refuses an image too small to be worth showing', async () => {
    await expect(
      encodeAnnouncementImage(await samplePng(8, 8), { id: 'x', alt: 'x' }),
    ).rejects.toThrow(/minimum/);
  });

  it('writes exactly the referenced images and prunes the rest', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const encoded = await encodeAnnouncementImage(await samplePng(), {
        id: 'reports-center',
        alt: 'A screen',
      });

      await mkdir(paths.images, { recursive: true });
      await writeFile(join(paths.images, 'orphan-deadbeef.webp'), Buffer.from([1, 2, 3]));
      await writeFile(join(paths.images, encoded.image.path.replace('images/', '')), encoded.data);
      await saveRecord(paths, authored({ image: encoded.image }));

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(true);
      await writeBuild(paths, result);

      const present = await readdir(paths.images);
      expect(present).toEqual([encoded.image.path.replace('images/', '')]);
    });
  });

  it('rebuilds a missing image from the kept original', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const source = await samplePng();
      const encoded = await encodeAnnouncementImage(source, { id: 'reports-center', alt: 'A screen' });

      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.png'), source);
      await saveRecord(paths, authored({ image: encoded.image }));

      // dist/ is disposable: delete it entirely and the build reconstructs it.
      await rm(paths.dist, { recursive: true, force: true });

      const result = await buildManifest(paths, { now: NOW });
      expect(result.problems).toEqual([]);
      expect(result.imageFiles.size).toBe(1);
    });
  });

  it('refuses when a referenced image exists nowhere', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(
        paths,
        authored({
          image: {
            path: 'images/reports-center-aaaaaaaa.webp',
            width: 800,
            height: 450,
            bytes: 1000,
            sha256: 'a'.repeat(64),
            alt: 'Missing',
          },
        }),
      );

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('neither the built file nor an original');
    });
  });
});

describe('publish', () => {
  it('makes one commit containing the manifest and its images', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const repo = await repoWithIdentity(dir);
      await repo.commitPaths(['.'], 'Initial');

      const encoded = await encodeAnnouncementImage(await samplePng(), {
        id: 'reports-center',
        alt: 'A screen',
      });
      await mkdir(paths.media, { recursive: true });
      await writeFile(join(paths.media, 'reports-center.png'), await samplePng());
      await saveRecord(paths, authored({ image: encoded.image }));

      const result = await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });

      expect(result.status).toBe('committed');
      expect(result.commit).toBeTruthy();

      // The whole point: JSON and images land together or not at all.
      const log = await repo.log(1);
      expect(log).toHaveLength(1);
      expect((await repo.status()).clean).toBe(true);
    });
  });

  it('writes nothing when the build is refused', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const repo = await repoWithIdentity(dir);
      await repo.commitPaths(['.'], 'Initial');

      await saveRecord(paths, authored({ title: '' }));
      const before = await readFile(paths.manifest, 'utf8');

      const result = await publish(paths, { now: NOW, noPush: true });

      expect(result.status).toBe('blocked');
      expect(await readFile(paths.manifest, 'utf8')).toBe(before);
      expect((await repo.log(1))[0]!.message).toContain('Initial');
    });
  });

  it('blocks on outstanding warnings until they are accepted', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));

      // No end date is a warning, not an error.
      await saveRecord(paths, authored({ endAt: null }));

      const blocked = await publish(paths, { now: NOW, noPush: true });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockedBy).toContain('warning');

      const accepted = await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });
      expect(accepted.status).toBe('committed');
    });
  });

  it('writes nothing on a dry run', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored());
      const before = await readFile(paths.manifest, 'utf8');

      const result = await publish(paths, { now: NOW, dryRun: true, acceptWarnings: true });

      expect(result.status).toBe('dry-run');
      expect(result.diff.added.map((r) => r.id)).toEqual(['reports-center']);
      expect(await readFile(paths.manifest, 'utf8')).toBe(before);
    });
  });

  it('reports no-changes rather than making an empty commit', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });
      const second = await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });

      expect(second.status).toBe('no-changes');
    });
  });

  it('reports "committed, not pushed" when there is no remote, rather than failing', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      const result = await publish(paths, { now: NOW, acceptWarnings: true });

      // Nothing is half-published: the commit is intact and can be pushed later.
      expect(result.status).toBe('committed');
      expect(result.push).toMatchObject({ pushed: false, reason: 'no-remote' });
      expect(result.commit).toBeTruthy();
    });
  });

  it('produces a manifest the client can read, at every step', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });

      const raw = await readFile(paths.manifest, 'utf8');
      const parsed = parseManifestText(raw, { now: NOW });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.skipped).toEqual([]);
      expect(parsed.ok && parsed.manifest.announcements).toHaveLength(1);
    });
  });

  it('carries the kill switch into the published file', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true, paused: true });

      const published = await readPublished(paths);
      expect(published.manifest?.paused).toBe(true);
    });
  });

  it('carries the kill switch forward across an ordinary publish', async () => {
    // Found by an end-to-end run: paused defaulted to false, so publishing a
    // fix during an incident silently turned the switch back on for everyone.
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true, paused: true });
      expect((await readPublished(paths)).manifest?.paused).toBe(true);

      await saveRecord(paths, authored({ title: 'An edit' }));
      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });

      expect((await readPublished(paths)).manifest?.paused).toBe(true);
    });
  });

  it('clears the kill switch only when asked', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await repoWithIdentity(dir).then((r) => r.commitPaths(['.'], 'Initial'));
      await saveRecord(paths, authored());

      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true, paused: true });
      await publish(paths, { now: NOW, noPush: true, acceptWarnings: true, paused: false });

      expect((await readPublished(paths)).manifest?.paused).toBe(false);
    });
  });

  it('reverts a publish, restoring dist/ and content/ together', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      const repo = await repoWithIdentity(dir);
      await repo.commitPaths(['.'], 'Initial');
      await saveRecord(paths, authored());

      const first = await publish(paths, { now: NOW, noPush: true, acceptWarnings: true });
      expect((await readPublished(paths)).manifest?.announcements).toHaveLength(1);

      await repo.revert(first.commit!);

      expect((await readPublished(paths)).manifest?.announcements).toHaveLength(0);
      expect((await repo.status()).clean).toBe(true);
    });
  });
});

describe('deleting a record', () => {
  it('retires the id so it can never be reused', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored({ id: 'reports-center' }));

      await deleteRecord(paths, 'reports-center');

      const content = await loadContent(paths);
      expect(content.records).toHaveLength(0);
      expect(content.retiredIds).toEqual(['reports-center']);
    });
  });

  it('refuses to publish a record reusing a retired id', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored({ id: 'reports-center' }));
      await deleteRecord(paths, 'reports-center');

      await saveRecord(paths, authored({ id: 'reports-center' }));

      const result = await buildManifest(paths, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.errors.some((issue) => issue.code === 'id-retired')).toBe(true);
    });
  });

  it('refuses to build at all when the ledger is unreadable', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await writeFile(paths.retiredIds, 'corrupt', 'utf8');

      // Reading it as "nothing is retired" would silently permit the reuse the
      // ledger exists to prevent.
      await expect(loadContent(paths)).rejects.toThrow(/unreadable/);
    });
  });
});

describe('the repository is self-contained', () => {
  it('reconstructs dist/ from content/ alone', async () => {
    await withTempDir(async (dir) => {
      const { paths } = await scaffoldRepository(dir);
      await saveRecord(paths, authored());

      const first = await buildManifest(paths, { now: NOW, keepRevision: true });
      await writeBuild(paths, first);
      const original = await readFile(paths.manifest, 'utf8');

      await rm(paths.dist, { recursive: true, force: true });

      const rebuilt = await buildManifest(paths, { now: NOW, keepRevision: true });
      await writeBuild(paths, rebuilt);

      expect(await readFile(paths.manifest, 'utf8')).toBe(original);
    });
  });
});
