/**
 * Git, which is the publishing mechanism rather than a detail of it.
 *
 * A publish is ONE COMMIT containing the manifest and every image it
 * references. That single choice is what makes the failure modes the design
 * had to answer disappear rather than be handled:
 *
 *   "JSON succeeds but the image upload fails"   unreachable — one ref update
 *   "two publications close together"            a non-fast-forward rejection
 *   "how do I roll back"                         `git revert`
 *   "where is the publication history"           `git log`
 *   "where do I store the token"                 nowhere; git already has one
 *
 * The GitHub Contents API, which writes one file per call, is precisely the
 * design that creates the partial-publish problem. If publishing ever has to
 * happen without a working copy, the equivalent is the Git Data API — blobs,
 * tree, commit, then a ref update guarded by the expected SHA.
 */

import { CheckRepoActions, simpleGit, type SimpleGit } from 'simple-git';

export interface RepoStatus {
  branch: string;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  hasRemote: boolean;
}

export interface PushOutcome {
  pushed: boolean;
  /** Set when the commit is local but the push did not happen. */
  reason?: 'no-remote' | 'rejected' | 'network' | 'not-attempted';
  detail?: string;
}

export class AnnouncementRepo {
  private readonly git: SimpleGit;

  constructor(readonly root: string) {
    this.git = simpleGit(root);
  }

  /**
   * Whether this directory is a repository ROOT — not merely inside one.
   *
   * The distinction is load-bearing and getting it wrong is silent. Plain
   * `checkIsRepo()` asks "am I inside a work tree", which is true for any
   * subdirectory of any repository. Scaffolding an announcements repository
   * beneath an existing checkout therefore skipped `git init`, and every
   * subsequent publish committed into the ENCLOSING repository instead — the
   * announcements went nowhere and the enclosing project grew commits nobody
   * asked for.
   */
  async isRepository(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
    } catch {
      return false;
    }
  }

  /** True when this directory sits inside some other repository's work tree. */
  async isInsideAnotherRepository(): Promise<boolean> {
    if (await this.isRepository()) return false;
    try {
      return await this.git.checkIsRepo(CheckRepoActions.IN_TREE);
    } catch {
      return false;
    }
  }

  async init(branch = 'main'): Promise<void> {
    await this.git.init(['-b', branch]);
  }

  async status(): Promise<RepoStatus> {
    const status = await this.git.status();
    const remotes = await this.git.getRemotes(false);

    return {
      branch: status.current ?? 'HEAD',
      clean: status.isClean(),
      staged: status.staged,
      modified: status.modified,
      untracked: status.not_added,
      ahead: status.ahead,
      behind: status.behind,
      hasRemote: remotes.length > 0,
    };
  }

  /**
   * Stages the given paths and commits them as one change.
   *
   * Paths are explicit rather than `add -A` so a publish can never sweep up an
   * unrelated edit sitting in the working tree.
   */
  async commitPaths(paths: readonly string[], message: string): Promise<string> {
    await this.git.add([...paths]);

    const staged = await this.git.status();
    if (staged.staged.length === 0 && staged.created.length === 0 && staged.deleted.length === 0) {
      throw new Error('Nothing to commit — the build produced no change.');
    }

    const result = await this.git.commit(message);
    return result.commit;
  }

  /**
   * Pushes, rebasing once if the remote moved.
   *
   * Never force. A rejection means someone — another machine, or a workflow —
   * published in between; the correct response is to take their commit and put
   * yours on top, which is exactly what a rebase does. Discarding their publish
   * is never the right default and is not offered.
   */
  async push(): Promise<PushOutcome> {
    const remotes = await this.git.getRemotes(false);
    if (remotes.length === 0) {
      return {
        pushed: false,
        reason: 'no-remote',
        detail: 'No git remote is configured. The commit is local and can be pushed later.',
      };
    }

    const branch = (await this.git.status()).current ?? 'main';

    try {
      await this.git.push('origin', branch);
      return { pushed: true };
    } catch (error) {
      const message = (error as Error).message;

      if (!/non-fast-forward|fetch first|rejected/i.test(message)) {
        return { pushed: false, reason: 'network', detail: message };
      }

      try {
        await this.git.fetch('origin', branch);
        await this.git.rebase([`origin/${branch}`]);
        await this.git.push('origin', branch);
        return { pushed: true };
      } catch (rebaseError) {
        // Leave the repository as it is. A half-finished rebase is something a
        // person should look at, not something a publish should paper over.
        return {
          pushed: false,
          reason: 'rejected',
          detail:
            `The remote moved and the rebase did not apply cleanly: ${(rebaseError as Error).message}. ` +
            'Your commit is intact locally; resolve the conflict and push.',
        };
      }
    }
  }

  /** Reverts a publish commit, producing a new commit rather than rewriting history. */
  async revert(commit: string): Promise<string> {
    await this.git.raw(['revert', '--no-edit', commit]);
    return (await this.git.revparse(['HEAD'])).trim();
  }

  async log(limit = 20): Promise<{ hash: string; date: string; message: string }[]> {
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 8),
      date: entry.date,
      message: entry.message,
    }));
  }

  async setIdentity(name: string, email: string): Promise<void> {
    await this.git.addConfig('user.name', name);
    await this.git.addConfig('user.email', email);
  }
}
