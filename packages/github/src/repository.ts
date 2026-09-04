/**
 * Reading and writing the announcements repository through GitHub's API.
 *
 * ## The two repositories stay separate
 *
 * This package lives in the **Manager** repository and never contains
 * announcement content. The announcements repository is addressed entirely by
 * `{owner, repo, branch}` at runtime — there is no submodule, no vendored
 * checkout, and nothing here that would break if the announcements repository
 * were replaced with a different one tomorrow. The Manager is a client of it,
 * in the same sense that it was a client of the Manager server before.
 *
 * ## Why the Git Data API and not the Contents API
 *
 * The Contents API writes one file per commit. Publishing an announcement with
 * a picture is two files — the record and the original image — and two commits
 * would mean a repository that can be observed in a state where the record
 * exists and its image does not. `buildManifest` running against that state
 * would refuse, correctly, and the administrator would see a failure caused
 * entirely by the shape of the write.
 *
 * The Git Data API builds a tree and commits it in one move: blobs, then a
 * tree, then a commit, then one ref update. That is the same "publishing is one
 * git commit" rule this project has kept since Phase 1, expressed over HTTP
 * rather than over a working copy.
 *
 * ## Concurrency is detected, never papered over
 *
 * The ref update is sent with `force: false` and the parent commit this write
 * was built on. If anyone else has pushed in between, GitHub refuses it and
 * this throws `ConcurrentUpdate` rather than overwriting. Two administrators
 * with two phones is now a real possibility — it was not when there was one
 * Manager against one checkout — so the failure has to be a value the screen
 * can act on, not a silent last-writer-wins.
 *
 * ## Blob shas are content hashes, and that is the whole caching strategy
 *
 * A tree listing gives every path with the sha of its content. A record whose
 * sha has not changed has not changed, so it never needs fetching twice. That
 * is the same content-addressing the image pipeline uses, arriving for free
 * from git itself.
 */

import { decodeBase64, toStandardBase64, type Http } from '@ruood/announcement-client';

/** The API host. Not `github.com`, which is where the device flow lives. */
export const API_ROOT = 'https://api.github.com';

/** Sent on every request. GitHub asks for it and warns when it is absent. */
const API_VERSION = '2022-11-28';

/** A regular, non-executable file. The only mode this app ever writes. */
const FILE_MODE = '100644';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }

  /** The token is gone, expired, or was revoked. The app must sign in again. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /**
   * Signed in, but not allowed to do this.
   *
   * Overwhelmingly means the account has read access and not write, or the
   * GitHub App is not installed on this repository — both of which are a
   * person-to-fix problem rather than a bug.
   */
  get isPermissionFailure(): boolean {
    return this.status === 403 || this.status === 404;
  }
}

/** Somebody else pushed while this write was being prepared. */
export class ConcurrentUpdate extends Error {
  constructor() {
    super('The announcements were changed somewhere else while you were working.');
    this.name = 'ConcurrentUpdate';
  }
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  /** Usually `main`. Held explicitly so a fork or a test can differ. */
  branch: string;
}

export interface GitHubClientOptions {
  http: Http;
  /** The user token from the device flow. */
  token: string;
  repository: RepositoryRef;
}

/** One file to write, or to delete. */
export type FileWrite =
  | { path: string; kind: 'text'; content: string }
  | { path: string; kind: 'base64'; content: string }
  | { path: string; kind: 'delete' };

export interface TreeEntry {
  path: string;
  /** The blob sha. Content-addressed, so unchanged content keeps its sha. */
  sha: string;
  size: number;
}

export interface CommitResult {
  sha: string;
  /** What the ref pointed at before. Useful for a diff, and for a revert. */
  parent: string;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export function createGitHubClient(options: GitHubClientOptions) {
  const { http, token, repository } = options;
  const base = `${API_ROOT}/repos/${repository.owner}/${repository.repo}`;

  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await http.fetch(path.startsWith('http') ? path : `${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();

    if (!response.ok) {
      let message = `GitHub answered ${response.status}.`;
      try {
        const failure = JSON.parse(text) as { message?: string };
        if (failure?.message) message = failure.message;
      } catch {
        /* a non-JSON body from GitHub means something else answered */
      }

      throw new GitHubError(response.status, message);
    }

    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    /** Who this token belongs to. The only call that is not repository-scoped. */
    async viewer(): Promise<GitHubUser> {
      const user = await call<{ login: string; name: string | null; avatar_url: string | null }>(
        `${API_ROOT}/user`,
      );

      return { login: user.login, name: user.name, avatarUrl: user.avatar_url };
    },

    /**
     * Whether this token can actually write here.
     *
     * Asked once, after signing in, so the app can say "you have read access
     * but not write" on the login screen — rather than letting somebody write
     * a whole announcement and fail at the last step.
     */
    async canWrite(): Promise<boolean> {
      try {
        const info = await call<{ permissions?: { push?: boolean } }>('');
        return info.permissions?.push === true;
      } catch (failure) {
        if (failure instanceof GitHubError && failure.isPermissionFailure) return false;
        throw failure;
      }
    },

    /** The commit the branch currently points at. */
    async head(): Promise<string> {
      const ref = await call<{ object: { sha: string } }>(
        `/git/ref/heads/${encodeURIComponent(repository.branch)}`,
      );
      return ref.object.sha;
    },

    /**
     * Every file under `prefix`, at a given commit.
     *
     * One request for the whole tree rather than a walk: `recursive=1` returns
     * the entire repository, and filtering here is cheaper than a request per
     * directory. The announcements repository is small enough that GitHub's
     * truncation limit is not in play, and `truncated` is checked rather than
     * assumed — a silently short listing would read as "those records were
     * deleted".
     */
    async listFiles(commitSha: string, prefix: string): Promise<TreeEntry[]> {
      const commit = await call<{ tree: { sha: string } }>(`/git/commits/${commitSha}`);
      const tree = await call<{
        truncated: boolean;
        tree: { path: string; type: string; sha: string; size?: number }[];
      }>(`/git/trees/${commit.tree.sha}?recursive=1`);

      if (tree.truncated) {
        throw new GitHubError(
          200,
          'The repository listing came back incomplete, so this would not be a full picture.',
        );
      }

      return tree.tree
        .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
    },

    /**
     * A blob's content as text, by its sha.
     *
     * By sha rather than by path, because a sha is immutable: the result can be
     * cached for ever, and a caller that already has this sha need not ask at
     * all. GitHub wraps its base64 at 60 characters, which `decodeBase64`
     * handles.
     */
    async readBlob(sha: string): Promise<string> {
      const blob = await call<{ content: string; encoding: string }>(`/git/blobs/${sha}`);

      if (blob.encoding !== 'base64') {
        throw new GitHubError(200, `A blob came back as "${blob.encoding}", which is not base64.`);
      }

      return decodeBase64(blob.content);
    },

    /** A blob's raw bytes as standard base64, for an image. */
    async readBlobBase64(sha: string): Promise<string> {
      const blob = await call<{ content: string; encoding: string }>(`/git/blobs/${sha}`);
      return blob.content.replace(/\s+/g, '');
    },

    /**
     * Writes files as ONE commit.
     *
     * `parent` is the commit this change was built on. Passing it is what makes
     * the write safe: the ref update is refused if the branch has moved, and
     * the caller gets `ConcurrentUpdate` instead of quietly clobbering somebody.
     */
    async commit(input: {
      message: string;
      files: readonly FileWrite[];
      parent: string;
    }): Promise<CommitResult> {
      if (input.files.length === 0) {
        throw new GitHubError(400, 'A commit needs at least one file.');
      }

      const commit = await call<{ tree: { sha: string } }>(`/git/commits/${input.parent}`);

      // Blobs first. Each is independent, so a failure here has written nothing
      // that anybody can see — a dangling blob is invisible until a tree
      // references it, and git garbage-collects it.
      const entries = await Promise.all(
        input.files.map(async (file) => {
          if (file.kind === 'delete') {
            // A null sha in a tree entry is how the Git Data API says "remove
            // this path". It is not a deletion of the blob, it is an absence
            // in the new tree.
            return { path: file.path, mode: FILE_MODE, type: 'blob' as const, sha: null };
          }

          const blob = await call<{ sha: string }>('/git/blobs', {
            method: 'POST',
            body:
              file.kind === 'text'
                ? { content: file.content, encoding: 'utf-8' }
                : { content: toStandardBase64(file.content), encoding: 'base64' },
          });

          return { path: file.path, mode: FILE_MODE, type: 'blob' as const, sha: blob.sha };
        }),
      );

      const tree = await call<{ sha: string }>('/git/trees', {
        method: 'POST',
        // `base_tree` is what makes this a change rather than a replacement:
        // without it the commit would contain ONLY these files and delete the
        // entire rest of the repository.
        body: { base_tree: commit.tree.sha, tree: entries },
      });

      const created = await call<{ sha: string }>('/git/commits', {
        method: 'POST',
        body: { message: input.message, tree: tree.sha, parents: [input.parent] },
      });

      try {
        await call(`/git/refs/heads/${encodeURIComponent(repository.branch)}`, {
          method: 'PATCH',
          body: { sha: created.sha, force: false },
        });
      } catch (failure) {
        // 422 from a non-fast-forward ref update is the concurrency answer.
        // Everything else is a real failure and is rethrown as itself.
        if (failure instanceof GitHubError && failure.status === 422) {
          throw new ConcurrentUpdate();
        }
        throw failure;
      }

      return { sha: created.sha, parent: input.parent };
    },

    /** The repository this client is pointed at. For display, and for tests. */
    repository,
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
