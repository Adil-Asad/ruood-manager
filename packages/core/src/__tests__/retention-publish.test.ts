/**
 * The retention limit, from the setting to the published file.
 *
 * `retention.test.ts` proves the window itself; this proves the WIRING, which
 * is where the reported bug actually lived. An administrator set
 * "announcements people see" to three, the phone wrote it into
 * `content/state.json`, and RUOOD Lab went on receiving every record — with no
 * failed build, no error and nothing in any diff to read.
 *
 * Two things had to be true for that, and both are asserted here against a real
 * repository on a real filesystem, because neither is visible from a pure test:
 *
 *   1. a build reads the stored limit and applies it, so the file that reaches
 *      a device carries the newest three and nothing older;
 *   2. a publish, which ends by writing the revision back, PRESERVES the limit
 *      — the old toolchain wrote the state object whole and silently erased it,
 *      in the direction that publishes more rather than less.
 *
 * The second is the one that made the setting look as though it had never been
 * saved: it survived exactly until the next announcement was published.
 */

import { readFile } from 'node:fs/promises';

import { scaffoldRepository } from '../scaffold';
import { saveRecord, loadState, saveState } from '../content/store';
import { buildManifest } from '../build/build';
import { publish } from '../publish/publish';
import { AnnouncementRepo } from '../git/repository';
import { NOW, authored, withTempDir, iso, DAY } from './fixtures';

jest.setTimeout(60000);

/** Seven published announcements, oldest first — the reported library. */
function seven() {
  return Array.from({ length: 7 }, (_, index) =>
    authored({
      id: `announcement-${index + 1}`,
      title: `Announcement ${index + 1}`,
      // Recency is `publishedAt`, so this is what decides the window.
      publishedAt: iso(NOW - (7 - index) * DAY),
      startAt: iso(NOW - (7 - index) * DAY),
      endAt: null,
      targeting: { platforms: ['android', 'ios'], minVersion: null, maxVersion: null },
    }),
  );
}

async function repositoryOfSeven(dir: string, maxRetained?: number) {
  const { paths } = await scaffoldRepository(dir);
  for (const record of seven()) await saveRecord(paths, record);
  if (maxRetained !== undefined) await saveState(paths, { maxRetained });
  return paths;
}

describe('a limit of three', () => {
  it('publishes exactly three records', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);

      const result = await buildManifest(paths, { now: NOW });

      expect(result.ok).toBe(true);
      expect(result.maxRetained).toBe(3);
      expect(result.manifest.announcements).toHaveLength(3);
    });
  });

  it('publishes the NEWEST three, and nothing older', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);

      const result = await buildManifest(paths, { now: NOW });

      expect(result.manifest.announcements.map((record) => record.id).sort()).toEqual([
        'announcement-5',
        'announcement-6',
        'announcement-7',
      ]);
    });
  });

  it('says why each older record is out, rather than dropping it silently', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);

      const result = await buildManifest(paths, { now: NOW });

      expect(
        result.excluded
          .filter((entry) => entry.reason === 'retention')
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(['announcement-1', 'announcement-2', 'announcement-3', 'announcement-4']);
    });
  });

  it('changes nothing in content/ — the four excluded records are untouched', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);
      const before = await readFile(`${paths.announcements}/announcement-1.json`, 'utf8');

      await buildManifest(paths, { now: NOW });

      const after = await readFile(`${paths.announcements}/announcement-1.json`, 'utf8');
      expect(after).toBe(before);
    });
  });

  it('brings them straight back when the limit is raised', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);

      await saveState(paths, { maxRetained: 7 });
      const result = await buildManifest(paths, { now: NOW });

      expect(result.manifest.announcements).toHaveLength(7);
    });
  });
});

describe('the limit survives publishing', () => {
  /**
   * The half that made the setting look unsaved.
   *
   * Every publish ends with the revision being written back. A `saveState` that
   * wrote the whole object erased `maxRetained` the first time anybody
   * published anything after setting it — so the administrator found the field
   * blank and the manifest full, and the two facts looked unrelated.
   */
  it('is still in state.json after a publish writes the revision', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);
      await new AnnouncementRepo(dir).setIdentity('Test', 'test@example.com');

      const result = await publish(paths, { now: NOW, acceptWarnings: true, noPush: true });
      expect(result.status).toBe('committed');

      await expect(loadState(paths)).resolves.toMatchObject({ maxRetained: 3 });
    });
  });

  it('still governs the file that was actually committed', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);
      await new AnnouncementRepo(dir).setIdentity('Test', 'test@example.com');

      await publish(paths, { now: NOW, acceptWarnings: true, noPush: true });

      const written = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
        announcements: { id: string }[];
      };
      expect(written.announcements).toHaveLength(3);
    });
  });

  it('keeps applying after a SECOND publish, not just the first', async () => {
    // The erasure was invisible on the publish that set the limit and only bit
    // on the next one, so one publish was never enough to catch it.
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir, 3);
      await new AnnouncementRepo(dir).setIdentity('Test', 'test@example.com');

      await publish(paths, { now: NOW, acceptWarnings: true, noPush: true });

      await saveRecord(
        paths,
        authored({
          id: 'announcement-8',
          title: 'Announcement 8',
          publishedAt: iso(NOW),
          startAt: iso(NOW),
          endAt: null,
          targeting: { platforms: ['android', 'ios'], minVersion: null, maxVersion: null },
        }),
      );

      const second = await publish(paths, {
        now: NOW + 1000,
        acceptWarnings: true,
        noPush: true,
      });
      expect(second.status).toBe('committed');

      const written = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
        announcements: { id: string }[];
      };
      expect(written.announcements.map((record) => record.id).sort()).toEqual([
        'announcement-6',
        'announcement-7',
        'announcement-8',
      ]);
      await expect(loadState(paths)).resolves.toMatchObject({ maxRetained: 3 });
    });
  });
});

describe('a repository that has never set a limit', () => {
  it('publishes everything, exactly as it did before the setting existed', async () => {
    await withTempDir(async (dir) => {
      const paths = await repositoryOfSeven(dir);

      const result = await buildManifest(paths, { now: NOW });

      expect(result.manifest.announcements).toHaveLength(7);
    });
  });
});
