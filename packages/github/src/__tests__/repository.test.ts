/**
 * Writing the announcements repository over the Git Data API.
 *
 * The assertions that matter are about SHAPE, not about JSON: that a write is
 * one commit, that it carries `base_tree` so it is a change rather than a
 * replacement, and that the ref update is non-forcing so a concurrent push is
 * detected instead of clobbered.
 *
 * Each of those, got wrong, produces a repository that looks fine until the
 * moment it does not — an emptied tree, or somebody's announcement silently
 * overwritten by somebody else's phone.
 */

import type { Http, HttpRequestInit } from '@ruood/announcement-client';

import {
  ConcurrentUpdate,
  GitHubError,
  createGitHubClient,
  type FileWrite,
} from '../repository';

const REPOSITORY = { owner: 'adil-asad', repo: 'ruood-announcements', branch: 'main' };
const TOKEN = 'gho_a_user_token';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A GitHub that answers by URL pattern and records every call.
 *
 * Matched in order, so a test can override one endpoint and let the rest fall
 * through to sensible defaults.
 */
function fakeGitHub(
  routes: { match: RegExp; method?: string; status?: number; body: unknown }[],
): Http & { calls: Recorded[] } {
  const calls: Recorded[] = [];

  return {
    calls,
    async fetch(url: string, init?: HttpRequestInit) {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body) : undefined,
        headers: init?.headers ?? {},
      });

      const route = routes.find(
        (candidate) =>
          candidate.match.test(url) && (candidate.method === undefined || candidate.method === method),
      );

      if (!route) {
        return { status: 404, ok: false, text: async () => JSON.stringify({ message: `no route for ${method} ${url}` }) };
      }

      const status = route.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => JSON.stringify(route.body),
      };
    },
  };
}

/** The four calls a commit always makes, answered plausibly. */
function commitRoutes(overrides: Parameters<typeof fakeGitHub>[0] = []) {
  return [
    ...overrides,
    { match: /\/git\/commits\/parent-sha$/, body: { tree: { sha: 'base-tree-sha' } } },
    { match: /\/git\/blobs$/, method: 'POST', body: { sha: 'new-blob-sha' } },
    { match: /\/git\/trees$/, method: 'POST', body: { sha: 'new-tree-sha' } },
    { match: /\/git\/commits$/, method: 'POST', body: { sha: 'new-commit-sha' } },
    { match: /\/git\/refs\/heads\/main$/, method: 'PATCH', body: {} },
  ];
}

const RECORD: FileWrite = {
  path: 'content/announcements/notice.json',
  kind: 'text',
  content: '{"id":"notice"}',
};

describe('authentication and headers', () => {
  it('sends the token and the pinned API version on every call', async () => {
    const http = fakeGitHub([{ match: /\/git\/ref\/heads\/main$/, body: { object: { sha: 'head' } } }]);
    await createGitHubClient({ http, token: TOKEN, repository: REPOSITORY }).head();

    const [call] = http.calls;
    expect(call!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Unpinned, GitHub warns and may change shape underneath the app.
    expect(call!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('names a 401 as an auth failure, so the app knows to sign in again', async () => {
    const http = fakeGitHub([
      { match: /\/git\/ref/, status: 401, body: { message: 'Bad credentials' } },
    ]);

    const failure = await createGitHubClient({ http, token: TOKEN, repository: REPOSITORY })
      .head()
      .catch((error: GitHubError) => error);

    expect(failure).toBeInstanceOf(GitHubError);
    expect((failure as GitHubError).isAuthFailure).toBe(true);
  });

  it('treats 403 and 404 as a permission problem, not a missing repository', async () => {
    // A repository somebody cannot see answers 404 rather than 403, so the two
    // are the same answer to the app: you are signed in and not allowed.
    for (const status of [403, 404]) {
      const http = fakeGitHub([{ match: /\/git\/ref/, status, body: { message: 'nope' } }]);
      const failure = await createGitHubClient({ http, token: TOKEN, repository: REPOSITORY })
        .head()
        .catch((error: GitHubError) => error);

      expect((failure as GitHubError).isPermissionFailure).toBe(true);
    }
  });

  it('reports write access from the repository permissions', async () => {
    const yes = fakeGitHub([{ match: /\/repos\/[^/]+\/[^/]+$/, body: { permissions: { push: true } } }]);
    const no = fakeGitHub([{ match: /\/repos\/[^/]+\/[^/]+$/, body: { permissions: { push: false } } }]);

    // Asked once at sign-in, so "you have read access but not write" is said on
    // the login screen rather than after a whole announcement is written.
    await expect(
      createGitHubClient({ http: yes, token: TOKEN, repository: REPOSITORY }).canWrite(),
    ).resolves.toBe(true);
    await expect(
      createGitHubClient({ http: no, token: TOKEN, repository: REPOSITORY }).canWrite(),
    ).resolves.toBe(false);
  });
});

describe('committing', () => {
  it('writes blobs, a tree and a commit, then moves the ref ONCE', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    const result = await client.commit({
      message: 'Add an announcement',
      files: [RECORD],
      parent: 'parent-sha',
    });

    expect(result).toEqual({ sha: 'new-commit-sha', parent: 'parent-sha' });

    // One ref update means one commit means the manifest and its images land
    // together or not at all — the rule this project has kept since Phase 1.
    const refUpdates = http.calls.filter((call) => call.method === 'PATCH');
    expect(refUpdates).toHaveLength(1);
  });

  it('sends base_tree, so a commit is a CHANGE and not a replacement', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await client.commit({ message: 'Edit', files: [RECORD], parent: 'parent-sha' });

    const tree = http.calls.find((call) => call.url.endsWith('/git/trees'))!;
    // Without base_tree the commit contains ONLY the listed files, which would
    // delete the entire rest of the repository in a single, successful-looking
    // operation.
    expect((tree.body as { base_tree: string }).base_tree).toBe('base-tree-sha');
  });

  it('refuses to force, and reports a concurrent push as such', async () => {
    const http = fakeGitHub(
      commitRoutes([
        {
          match: /\/git\/refs\/heads\/main$/,
          method: 'PATCH',
          status: 422,
          body: { message: 'Update is not a fast forward' },
        },
      ]),
    );

    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await expect(
      client.commit({ message: 'Edit', files: [RECORD], parent: 'parent-sha' }),
    ).rejects.toBeInstanceOf(ConcurrentUpdate);

    const patch = http.calls.find((call) => call.method === 'PATCH')!;
    // Two administrators with two phones is now possible, where one Manager
    // against one checkout made it impossible. Last-writer-wins would silently
    // lose somebody's work.
    expect((patch.body as { force: boolean }).force).toBe(false);
  });

  it('builds on the parent it was given, not on whatever HEAD is now', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await client.commit({ message: 'Edit', files: [RECORD], parent: 'parent-sha' });

    const commit = http.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/git/commits'),
    )!;
    expect((commit.body as { parents: string[] }).parents).toEqual(['parent-sha']);
  });

  it('encodes a deletion as a null sha rather than an empty blob', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await client.commit({
      message: 'Delete',
      files: [{ path: 'content/announcements/gone.json', kind: 'delete' }],
      parent: 'parent-sha',
    });

    const tree = http.calls.find((call) => call.url.endsWith('/git/trees'))!;
    const entries = (tree.body as { tree: { path: string; sha: string | null }[] }).tree;

    expect(entries).toEqual([
      { path: 'content/announcements/gone.json', mode: '100644', type: 'blob', sha: null },
    ]);

    // A deletion writes no blob at all.
    expect(http.calls.filter((call) => call.url.endsWith('/git/blobs'))).toHaveLength(0);
  });

  it('sends binary content as base64 and text as utf-8', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await client.commit({
      message: 'Attach',
      files: [RECORD, { path: 'content/media/notice.gif', kind: 'base64', content: 'R0lGODlh' }],
      parent: 'parent-sha',
    });

    const blobs = http.calls
      .filter((call) => call.url.endsWith('/git/blobs'))
      .map((call) => call.body as { encoding: string });

    expect(blobs.map((blob) => blob.encoding).sort()).toEqual(['base64', 'utf-8']);
  });

  it('refuses a commit with no files', async () => {
    const http = fakeGitHub(commitRoutes());
    const client = createGitHubClient({ http, token: TOKEN, repository: REPOSITORY });

    await expect(
      client.commit({ message: 'Nothing', files: [], parent: 'parent-sha' }),
    ).rejects.toThrow(/at least one file/);
  });
});

describe('reading', () => {
  it('lists only blobs under the prefix', async () => {
    const http = fakeGitHub([
      { match: /\/git\/commits\/head-sha$/, body: { tree: { sha: 'tree-sha' } } },
      {
        match: /\/git\/trees\/tree-sha/,
        body: {
          truncated: false,
          tree: [
            { path: 'content/announcements/a.json', type: 'blob', sha: 'sha-a', size: 10 },
            { path: 'content/announcements', type: 'tree', sha: 'sha-dir' },
            { path: 'dist/announcements.json', type: 'blob', sha: 'sha-dist', size: 20 },
          ],
        },
      },
    ]);

    const files = await createGitHubClient({ http, token: TOKEN, repository: REPOSITORY }).listFiles(
      'head-sha',
      'content/',
    );

    expect(files).toEqual([{ path: 'content/announcements/a.json', sha: 'sha-a', size: 10 }]);
  });

  it('REFUSES a truncated listing rather than returning a short one', async () => {
    const http = fakeGitHub([
      { match: /\/git\/commits\/head-sha$/, body: { tree: { sha: 'tree-sha' } } },
      { match: /\/git\/trees\/tree-sha/, body: { truncated: true, tree: [] } },
    ]);

    // A silently short listing reads as "those announcements were deleted",
    // and the app would then offer to publish a manifest missing them.
    await expect(
      createGitHubClient({ http, token: TOKEN, repository: REPOSITORY }).listFiles('head-sha', 'content/'),
    ).rejects.toThrow(/incomplete/i);
  });

  it('decodes a blob, including the newlines GitHub wraps it with', async () => {
    // GitHub wraps base64 at 60 characters. Refusing whitespace would fail on
    // every file the API returns.
    const wrapped = 'eyJpZCI6Im5vdGlj\nZSJ9';
    const http = fakeGitHub([{ match: /\/git\/blobs\/sha-a$/, body: { content: wrapped, encoding: 'base64' } }]);

    const text = await createGitHubClient({ http, token: TOKEN, repository: REPOSITORY }).readBlob('sha-a');
    expect(JSON.parse(text)).toEqual({ id: 'notice' });
  });

  it('refuses a blob that is not base64', async () => {
    const http = fakeGitHub([{ match: /\/git\/blobs\//, body: { content: 'x', encoding: 'none' } }]);

    await expect(
      createGitHubClient({ http, token: TOKEN, repository: REPOSITORY }).readBlob('sha-a'),
    ).rejects.toThrow(/not base64/);
  });
});
