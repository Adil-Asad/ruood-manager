/**
 * The two repositories are separate, and stay separate.
 *
 * This is a structural rule rather than a code one, which is exactly why it is
 * worth a test: nothing else fails when it is broken. Someone runs
 * `git add .` in a Manager checkout that happens to contain a cloned
 * announcements repository, and the announcements are absorbed into the
 * Manager's history — where they are no longer independently versioned, no
 * longer independently published, and no longer removable without a rewrite.
 *
 * The rule:
 *
 *   D:\RUOOD-Announcement-Manager                    the Manager. Builds the
 *                                                    app and the CLI.
 *   D:\RUOOD-Announcement-Manager\workspace\...      cloned announcement
 *                                                    repositories, each with
 *                                                    its own .git and remote.
 *
 * `workspace/` is gitignored, so a clone can live inside the Manager's
 * directory for convenience without ever being part of its repository. That is
 * the whole mechanism, and this asserts it rather than trusting it.
 *
 * The publishing workflow depends on the same boundary from the other side: it
 * checks the Manager out as a build tool at a pinned ref, which only makes
 * sense while the two are genuinely independent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Manager repository root, from this file's location. */
const ROOT = join(__dirname, '..', '..', '..', '..');

describe('the Manager and the announcements repository are separate', () => {
  it('ignores workspace/, so a clone inside it is never tracked', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

    // `git add .` in the Manager must not sweep up an announcements checkout.
    // Matched loosely because the trailing slash is optional and both forms
    // work; what matters is that the entry is there at all.
    expect(ignore).toMatch(/^workspace\/?$/m);
  });

  it('is not a submodule arrangement', () => {
    // A submodule would couple the two histories: a Manager commit would pin an
    // announcements commit, and updating announcements would mean a commit in
    // the Manager. The app writes announcements through the GitHub API
    // precisely so that never has to happen.
    expect(existsSync(join(ROOT, '.gitmodules'))).toBe(false);
  });

  it('holds no announcement content of its own', () => {
    // `content/` at the Manager root would mean somebody had started treating
    // this repository as an announcements repository too, and the ambiguity
    // about which is the source of truth is the whole failure.
    expect(existsSync(join(ROOT, 'content', 'announcements'))).toBe(false);
    expect(existsSync(join(ROOT, 'dist', 'announcements.json'))).toBe(false);
  });

  it('addresses the announcements repository at RUNTIME, never by a hard path', () => {
    // The GitHub client takes {owner, repo, branch}. A hard-coded default in
    // the package would make "which repository" a property of the toolchain
    // rather than of the deployment, and pointing a build at a different one
    // would become a code change.
    const client = readFileSync(
      join(ROOT, 'packages', 'github', 'src', 'repository.ts'),
      'utf8',
    );

    expect(client).not.toMatch(/ruood-announcements/);
    expect(client).toMatch(/owner: string/);
  });

  it('never reaches for the announcements repository from a package', () => {
    // A package that read `workspace/announcements` would only work on the one
    // machine where that clone exists — and would quietly bind the toolchain to
    // one deployment.
    for (const file of [
      join(ROOT, 'packages', 'github', 'src', 'content.ts'),
      join(ROOT, 'packages', 'core', 'src', 'paths.ts'),
      join(ROOT, 'packages', 'authoring', 'src', 'repo-paths.ts'),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/workspace[/\\]announcements/);
    }
  });
});
