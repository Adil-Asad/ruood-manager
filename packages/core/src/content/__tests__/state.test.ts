/**
 * `content/state.json`: the revision counter, and the retention setting.
 *
 * One file holding two things that are written by different people at different
 * times — the build increments the counter on every publish, and an
 * administrator sets the limit occasionally — which is exactly the shape that
 * loses data when a writer replaces the file instead of merging into it.
 *
 * That is not hypothetical: `saveState` took a whole `RepoState` and wrote it,
 * and every build ends with `saveState(paths, { revision })`. Adding a second
 * field to the file without changing that would have erased the limit on the
 * first publish after it was set, silently, in the direction that publishes
 * more rather than less.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MAX_RETAINED } from '@ruood/announcement-authoring';

import { repoPaths } from '../../paths';
import { loadContent, loadState, saveState } from '../store';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'ruood-state-'));
  const paths = repoPaths(root);
  await mkdir(paths.announcements, { recursive: true });
  return paths;
}

describe('reading', () => {
  it('reads the revision and the limit', async () => {
    const paths = await repo();
    await writeFile(paths.state, JSON.stringify({ revision: 12, maxRetained: 7 }), 'utf8');

    await expect(loadState(paths)).resolves.toEqual({ revision: 12, maxRetained: 7 });
  });

  it('treats an absent file as revision 0 and the default limit', async () => {
    const paths = await repo();
    await expect(loadState(paths)).resolves.toEqual({
      revision: 0,
      maxRetained: DEFAULT_MAX_RETAINED,
    });
  });

  it('falls back to the default for a limit that is not one', async () => {
    const paths = await repo();
    await writeFile(paths.state, JSON.stringify({ revision: 3, maxRetained: 0 }), 'utf8');

    const state = await loadState(paths);
    expect(state).toEqual({ revision: 3, maxRetained: DEFAULT_MAX_RETAINED });
  });

  it('survives a corrupt file rather than refusing to build', async () => {
    const paths = await repo();
    await writeFile(paths.state, '{ not json', 'utf8');

    // A different judgement from `retired-ids.json`, which throws: that ledger
    // failing open lets an id be reused on every device that ever saw it, while
    // this one failing open costs a number that can be set again.
    await expect(loadState(paths)).resolves.toEqual({
      revision: 0,
      maxRetained: DEFAULT_MAX_RETAINED,
    });
  });

  it('carries the limit into the content snapshot the build reads', async () => {
    const paths = await repo();
    await writeFile(paths.state, JSON.stringify({ revision: 1, maxRetained: 4 }), 'utf8');

    await expect(loadContent(paths)).resolves.toMatchObject({ revision: 1, maxRetained: 4 });
  });
});

describe('writing', () => {
  it('keeps the limit when a build writes the revision', async () => {
    const paths = await repo();
    await saveState(paths, { maxRetained: 5 });

    await saveState(paths, { revision: 26 });

    await expect(loadState(paths)).resolves.toEqual({ revision: 26, maxRetained: 5 });
  });

  it('keeps the revision when an administrator writes the limit', async () => {
    const paths = await repo();
    await saveState(paths, { revision: 26 });

    await saveState(paths, { maxRetained: 5 });

    // A revision that went backwards would make every published manifest look
    // older than the file it replaced.
    await expect(loadState(paths)).resolves.toEqual({ revision: 26, maxRetained: 5 });
  });

  it('preserves a field it does not know about', async () => {
    const paths = await repo();
    await writeFile(paths.state, JSON.stringify({ revision: 2, somethingLater: 'keep me' }), 'utf8');

    await saveState(paths, { revision: 3 });

    const written = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    expect(written.somethingLater).toBe('keep me');
  });

  it('does not invent a limit nobody set', async () => {
    const paths = await repo();
    await saveState(paths, { revision: 1 });

    // The default floats until somebody chooses a number. Writing it out on the
    // first build would pin today's default into every repository for ever.
    const written = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>;
    expect('maxRetained' in written).toBe(false);
  });
});
