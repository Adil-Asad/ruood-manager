/**
 * The announcements repository, read and written as announcements.
 *
 * Two rules carry most of the weight here, and both are about what lands in a
 * SINGLE commit:
 *
 *   - a record and its image, so the build never sees a record whose picture
 *     has not arrived yet;
 *   - a deletion and the retired-id ledger, so an id is never briefly free for
 *     reuse.
 *
 * The third is that a corrupt ledger stops the load. Reading it as "nothing is
 * retired" is the one failure this project has refused everywhere else, and it
 * would be just as quiet here.
 */

import { canonicalJson, type AuthoredAnnouncement } from '@ruood/announcement-schema';
import { encodeBase64, type Http, type HttpRequestInit } from '@ruood/announcement-client';

import { DEFAULT_MAX_RETAINED } from '@ruood/announcement-authoring';

import { createGitHubClient, GitHubError } from '../repository';
import {
  deleteRecord,
  emptyCache,
  idRegistryOf,
  loadContent,
  saveRecord,
  saveSettings,
} from '../content';

const REPOSITORY = { owner: 'adil-asad', repo: 'ruood-announcements', branch: 'main' };

function record(overrides: Partial<AuthoredAnnouncement> = {}): AuthoredAnnouncement {
  return {
    id: 'reports-center',
    rev: 1,
    minSchema: 1,
    title: 'Reports Center',
    body: 'Eight new library reports are available under Tools.',
    category: 'feature',
    priority: 50,
    startAt: '2026-09-14T12:00:00Z',
    endAt: null,
    display: {
      surface: 'modal',
      trigger: 'next-launch',
      maxImpressions: 3,
      minIntervalHours: 24,
      dismiss: 'permanent',
    },
    targeting: { platforms: ['android'], minVersion: null, maxVersion: null },
    status: 'published',
    createdAt: '2026-09-14T12:00:00Z',
    updatedAt: '2026-09-14T12:00:00Z',
    ...overrides,
  } as AuthoredAnnouncement;
}

interface Repo {
  /** path -> blob content, as text. */
  files: Record<string, string>;
}

/** A GitHub backed by an in-memory tree, so a commit can be read back. */
function fakeGitHub(repo: Repo): Http & { calls: { url: string; method: string; body: unknown }[] } {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const blobs = new Map<string, string>();

  const shaOf = (path: string): string => `sha-${path.replace(/[^a-z0-9]/gi, '-')}`;
  for (const [path, content] of Object.entries(repo.files)) blobs.set(shaOf(path), content);

  return {
    calls,
    async fetch(url: string, init?: HttpRequestInit) {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });

      const json = (value: unknown, status = 200) => ({
        status,
        ok: status < 300,
        text: async () => JSON.stringify(value),
      });

      if (/\/git\/ref\/heads\//.test(url)) return json({ object: { sha: 'head-sha' } });
      if (/\/git\/commits\/head-sha$/.test(url)) return json({ tree: { sha: 'tree-sha' } });

      if (/\/git\/trees\/tree-sha/.test(url)) {
        return json({
          truncated: false,
          tree: Object.keys(repo.files).map((path) => ({
            path,
            type: 'blob',
            sha: shaOf(path),
            size: repo.files[path]!.length,
          })),
        });
      }

      const blob = /\/git\/blobs\/(.+)$/.exec(url);
      if (blob && method === 'GET') {
        const content = blobs.get(blob[1]!);
        if (content === undefined) return json({ message: 'Not Found' }, 404);
        return json({ content: encodeBase64(content), encoding: 'base64' });
      }

      if (/\/git\/blobs$/.test(url)) return json({ sha: 'written-blob' });
      if (/\/git\/trees$/.test(url)) return json({ sha: 'written-tree' });
      if (/\/git\/commits$/.test(url)) return json({ sha: 'written-commit' });
      if (/\/git\/refs\/heads\//.test(url)) return json({});

      return json({ message: `no route for ${method} ${url}` }, 404);
    },
  };
}

function clientFor(repo: Repo) {
  const http = fakeGitHub(repo);
  return { http, client: createGitHubClient({ http, token: 'gho_x', repository: REPOSITORY }) };
}

/** The tree entries a commit sent, as a path -> sha map. */
function treeOf(http: { calls: { url: string; body: unknown }[] }): Record<string, unknown> {
  const tree = http.calls.find((call) => call.url.endsWith('/git/trees'))!;
  const entries = (tree.body as { tree: { path: string; sha: string | null }[] }).tree;

  return Object.fromEntries(entries.map((entry) => [entry.path, entry.sha]));
}

// ---------------------------------------------------------------------------

describe('loading', () => {
  it('reads records and the media that belongs to them', async () => {
    const { client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.gif': 'GIF89a...',
        'content/state.json': '{"revision":4}',
      },
    });

    const snapshot = await loadContent(client);

    expect(snapshot.records.map((entry) => entry.id)).toEqual(['reports-center']);
    expect(snapshot.media['reports-center']).toMatchObject({
      path: 'content/media/reports-center.gif',
      extension: '.gif',
    });
    expect(snapshot.commit).toBe('head-sha');
  });

  it('reports an unreadable record without losing the rest', async () => {
    const { client } = clientFor({
      files: {
        'content/announcements/good.json': canonicalJson(record({ id: 'good' })),
        'content/announcements/broken.json': '{ not json',
      },
    });

    const snapshot = await loadContent(client);

    // One bad file must not take the list down. It is surfaced, and the rest
    // still load — the same rule the on-disk loader keeps.
    expect(snapshot.records.map((entry) => entry.id)).toEqual(['good']);
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]!.path).toBe('content/announcements/broken.json');
  });

  it('never fetches the same blob twice', async () => {
    const files = {
      'content/announcements/reports-center.json': canonicalJson(record()),
    };

    const cache = emptyCache();
    const first = clientFor({ files });
    await loadContent(first.client, cache);

    const second = clientFor({ files });
    await loadContent(second.client, cache);

    // A blob sha IS a content hash, so unchanged content needs no request. On a
    // refresh where nothing moved this is zero blob fetches.
    const blobReads = second.http.calls.filter(
      (call) => /\/git\/blobs\//.test(call.url) && call.method === 'GET',
    );
    expect(blobReads).toHaveLength(0);
  });

  it('reads the retired-id ledger', async () => {
    const { client } = clientFor({
      files: { 'content/retired-ids.json': canonicalJson(['old-notice']) },
    });

    const snapshot = await loadContent(client);
    expect(snapshot.retiredIds).toEqual(['old-notice']);
  });

  it('treats an ABSENT ledger as nothing retired, which is legitimate', async () => {
    const { client } = clientFor({ files: {} });
    await expect(loadContent(client)).resolves.toMatchObject({ retiredIds: [] });
  });

  it('REFUSES a corrupt ledger rather than reading it as empty', async () => {
    const { client } = clientFor({ files: { 'content/retired-ids.json': '{ not a list' } });

    // A reused id inherits the previous announcement's impression counters on
    // every device for sixty days. Failing closed is the only safe direction.
    await expect(loadContent(client)).rejects.toThrow(GitHubError);
    await expect(loadContent(client)).rejects.toThrow(/never be\s+reused/);
  });

  it('refuses a ledger that is a list of the wrong thing', async () => {
    const { client } = clientFor({ files: { 'content/retired-ids.json': '[1, 2, 3]' } });
    await expect(loadContent(client)).rejects.toThrow(/not a list of ids/);
  });

  it('gives the validator both halves of the id question', async () => {
    const { client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/retired-ids.json': canonicalJson(['gone']),
      },
    });

    const registry = idRegistryOf(await loadContent(client));

    expect(registry).toEqual({ active: ['reports-center'], retired: ['gone'] });
  });
});

describe('saving', () => {
  it('writes a record and its image in ONE commit', async () => {
    const { http, client } = clientFor({ files: {} });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, {
      record: record(),
      image: { base64: 'R0lGODlh', extension: '.gif' },
      message: 'Add Reports Center',
    });

    expect(Object.keys(treeOf(http)).sort()).toEqual([
      'content/announcements/reports-center.json',
      'content/media/reports-center.gif',
    ]);

    // One ref update. A repository observed between two commits would show a
    // record whose image had not arrived, which the build refuses.
    expect(http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('removes the previous original when the format changes', async () => {
    const { http, client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.png': 'old still',
      },
    });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, {
      record: record(),
      image: { base64: 'R0lGODlh', extension: '.gif' },
      message: 'Replace with an animation',
    });

    const tree = treeOf(http);
    // `content/media/` holds exactly ONE original per id — the build matches by
    // filename stem, and two files with the same stem make that ambiguous.
    expect(tree['content/media/reports-center.png']).toBeNull();
    expect(tree['content/media/reports-center.gif']).toBe('written-blob');
  });

  it('leaves the original alone when no new image was chosen', async () => {
    const { http, client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.gif': 'kept',
      },
    });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, { record: record({ title: 'New title' }), message: 'Edit' });

    expect(Object.keys(treeOf(http))).toEqual(['content/announcements/reports-center.json']);
  });

  it('removes the original when the image is removed', async () => {
    const { http, client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.jpg': 'the picture',
      },
    });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, {
      record: record(),
      removeImage: true,
      message: 'Remove the picture',
    });

    // Clearing `record.image` is not enough: the publishing build attaches an
    // original that no record references — which is how a picture chosen on a
    // phone gets encoded at all — so bytes left behind come back on the next
    // publish.
    expect(treeOf(http)['content/media/reports-center.jpg']).toBeNull();
  });

  it('keeps the original when a replacement is chosen in the same save', async () => {
    const { http, client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.jpg': 'the old picture',
      },
    });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, {
      record: record(),
      image: { base64: 'R0lGODlh', extension: '.jpg' },
      removeImage: true,
      message: 'Replace the picture',
    });

    // A replacement is a write, not a removal, whatever the flag says.
    expect(treeOf(http)['content/media/reports-center.jpg']).toBe('written-blob');
  });

  it('writes the record canonically, so a diff shows the field that changed', async () => {
    const { http, client } = clientFor({ files: {} });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, { record: record(), message: 'Add' });

    const blob = http.calls.find((call) => call.url.endsWith('/git/blobs'))!;
    const written = (blob.body as { content: string }).content;

    // Canonical key order means a record edited on a phone and one edited by
    // the CLI produce identical bytes — the history shows an edit, not a
    // reshuffle.
    expect(written).toBe(canonicalJson(record()));
  });

  it('builds on the commit the snapshot was read at', async () => {
    const { http, client } = clientFor({ files: {} });
    const snapshot = await loadContent(client);

    await saveRecord(client, snapshot, { record: record(), message: 'Add' });

    const commit = http.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/git/commits'),
    )!;
    expect((commit.body as { parents: string[] }).parents).toEqual([snapshot.commit]);
  });
});

describe('deleting', () => {
  it('removes the record, its image and retires the id in ONE commit', async () => {
    const { http, client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/media/reports-center.gif': 'bytes',
        'content/retired-ids.json': canonicalJson(['older']),
      },
    });
    const snapshot = await loadContent(client);

    await deleteRecord(client, snapshot, 'reports-center', 'Delete Reports Center');

    const tree = treeOf(http);
    expect(tree['content/announcements/reports-center.json']).toBeNull();
    expect(tree['content/media/reports-center.gif']).toBeNull();
    expect(tree['content/retired-ids.json']).toBe('written-blob');

    // The removal and the ledger entry must land together: between them the id
    // is free for reuse, which is the exact state the ledger exists to prevent.
    expect(http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('writes the ledger sorted and de-duplicated', async () => {
    const { http, client } = clientFor({
      files: { 'content/retired-ids.json': canonicalJson(['zulu', 'alpha']) },
    });
    const snapshot = await loadContent(client);

    await deleteRecord(client, snapshot, 'mike', 'Delete');

    const ledger = http.calls
      .filter((call) => call.url.endsWith('/git/blobs'))
      .map((call) => (call.body as { content: string }).content)
      .find((content) => content.includes('alpha'))!;

    expect(JSON.parse(ledger)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('does not grow the ledger when an id is already retired', async () => {
    const { http, client } = clientFor({
      files: { 'content/retired-ids.json': canonicalJson(['mike']) },
    });
    const snapshot = await loadContent(client);

    await deleteRecord(client, snapshot, 'mike', 'Delete again');

    const ledger = http.calls
      .filter((call) => call.url.endsWith('/git/blobs'))
      .map((call) => (call.body as { content: string }).content)
      .find((content) => content.includes('mike'))!;

    expect(JSON.parse(ledger)).toEqual(['mike']);
  });
});

describe('the retention setting', () => {
  /** The content of the blob a commit wrote to `content/state.json`. */
  function written(http: { calls: { url: string; body: unknown }[] }): Record<string, unknown> {
    const blob = http.calls
      .filter((call) => call.url.endsWith('/git/blobs'))
      .map((call) => (call.body as { content: string }).content)
      .at(-1)!;

    return JSON.parse(blob) as Record<string, unknown>;
  }

  it('reads it from the settings file', async () => {
    const { client } = clientFor({
      files: { 'content/state.json': '{"revision":24,"maxRetained":5}' },
    });

    await expect(loadContent(client)).resolves.toMatchObject({
      settings: { maxRetained: 5 },
    });
  });

  it('is the default when the file has never said', async () => {
    const { client } = clientFor({ files: { 'content/state.json': '{"revision":24}' } });

    const snapshot = await loadContent(client);
    expect(snapshot.settings.maxRetained).toBe(DEFAULT_MAX_RETAINED);
    expect(snapshot.failures).toHaveLength(0);
  });

  it('is the default when there is no file at all, which is an ordinary repository', async () => {
    const { client } = clientFor({ files: {} });

    await expect(loadContent(client)).resolves.toMatchObject({
      settings: { maxRetained: DEFAULT_MAX_RETAINED, stored: {} },
    });
  });

  it('PRESERVES the revision counter, which nothing else may touch', async () => {
    const { http, client } = clientFor({
      files: { 'content/state.json': '{"revision":24,"maxRetained":20}' },
    });
    const snapshot = await loadContent(client);

    await saveSettings(client, snapshot, { maxRetained: 5 }, 'Keep the newest 5');

    // A manifest whose revision went backwards reads as older than the file it
    // replaced, on every install.
    expect(written(http)).toEqual({ maxRetained: 5, revision: 24 });
  });

  it('preserves a field it does not know about', async () => {
    const { http, client } = clientFor({
      files: { 'content/state.json': '{"revision":3,"somethingLater":"keep me"}' },
    });
    const snapshot = await loadContent(client);

    await saveSettings(client, snapshot, { maxRetained: 9 }, 'Keep the newest 9');

    expect(written(http)).toMatchObject({ somethingLater: 'keep me', revision: 3 });
  });

  it('is ONE commit', async () => {
    const { http, client } = clientFor({ files: { 'content/state.json': '{"revision":1}' } });
    const snapshot = await loadContent(client);

    await saveSettings(client, snapshot, { maxRetained: 5 }, 'Keep the newest 5');

    expect(http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(Object.keys(treeOf(http))).toEqual(['content/state.json']);
  });

  it('refuses a limit outside the bounds rather than clamping it', async () => {
    const { client } = clientFor({ files: { 'content/state.json': '{"revision":1}' } });
    const snapshot = await loadContent(client);

    await expect(
      saveSettings(client, snapshot, { maxRetained: 0 }, 'Keep none'),
    ).rejects.toThrow(GitHubError);
  });

  it('reports an unreadable settings file WITHOUT taking the load down', async () => {
    const { client } = clientFor({
      files: {
        'content/announcements/reports-center.json': canonicalJson(record()),
        'content/state.json': '{ not json',
      },
    });

    const snapshot = await loadContent(client);

    // Announcements still load: a settings file is not a reason to stop
    // authoring. Unlike the retired-id ledger, this one does not throw.
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.failures.map((failure) => failure.path)).toEqual(['content/state.json']);
    expect(snapshot.settings.stored).toBeNull();
  });

  it('refuses to WRITE over a settings file it could not read', async () => {
    const { client } = clientFor({ files: { 'content/state.json': '{ not json' } });
    const snapshot = await loadContent(client);

    // Merging onto a guess is how the revision counter gets invented.
    await expect(
      saveSettings(client, snapshot, { maxRetained: 5 }, 'Keep the newest 5'),
    ).rejects.toThrow(GitHubError);
  });
});
