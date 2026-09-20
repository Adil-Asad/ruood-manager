/**
 * The workflow that publishes, asserted as a parsed document.
 *
 * It is a template string, so the easy mistake is a YAML one — an indent, a
 * stray backtick from the template literal — and a broken workflow does not
 * fail loudly here. It fails on GitHub, after a push, as "workflow file issue",
 * with the repository already in a state where content/ has changed and dist/
 * has not.
 *
 * The other assertions are about the security shape, and they are the reason
 * the signing key can be an ordinary repository secret at all:
 *
 *   - `contents: write` and NOT `workflows: write`, so the job cannot rewrite
 *     itself;
 *   - the toolchain is checked out from a SEPARATE repository at a pinned ref,
 *     so the two repositories stay independent and an upgrade is a visible
 *     commit;
 *   - the key is read from the environment and never written to a file.
 */

import { execFileSync } from 'node:child_process';

import { load } from 'js-yaml';
import { DEFAULT_MANAGER_REF, DEFAULT_MANAGER_REPOSITORY } from '../scaffold';

import { PUBLISH_WORKFLOW_FILE, publishWorkflow } from '../ci/publish-workflow';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  concurrency?: { group: string };
  jobs: {
    publish: {
      environment?: string;
      permissions?: Record<string, string>;
      steps: Step[];
    };
  };
}

function parsed(
  options = { managerRepository: 'Owner/Manager', managerRef: 'v1.2.3' },
): Workflow {
  return load(publishWorkflow(options)) as Workflow;
}

describe('the publish workflow', () => {
  it('is valid YAML', () => {
    // `js-yaml` throws on a malformed document, so reaching the assertion is
    // most of the test. The alternative is finding out on GitHub.
    expect(() => parsed()).not.toThrow();
    expect(parsed().name).toBe('Publish announcements');
  });

  it('lives where GitHub looks for it', () => {
    expect(PUBLISH_WORKFLOW_FILE).toBe('.github/workflows/publish.yml');
  });

  it('runs on a content change, not on its own output', () => {
    const on = parsed().on as { push: { paths: string[]; branches: string[] } };

    // `dist/` is what this workflow writes. Triggering on it would be asking
    // for a loop, and relying on GITHUB_TOKEN not triggering workflows would
    // make the intent invisible.
    expect(on.push.paths).toContain('content/**');
    expect(on.push.paths).not.toContain('dist/**');
    expect(on.push.branches).toEqual(['main']);
  });

  it('can be triggered by hand, for a republish', () => {
    expect(parsed().on).toHaveProperty('workflow_dispatch');
  });

  it('publishes one at a time', () => {
    // Two overlapping runs both build from their own checkout, and the second
    // fails to push — safe, and it looks like a broken publish.
    expect(parsed().concurrency?.group).toBe('publish-announcements');
  });

  it('CANNOT rewrite itself', () => {
    const permissions = parsed().jobs.publish.permissions ?? {};

    // The whole basis on which the signing key can be an ordinary secret: the
    // job may commit dist/, and may not touch .github/workflows/.
    expect(permissions).toEqual({ contents: 'write' });
    expect(permissions).not.toHaveProperty('workflows');
  });

  it('names an environment, so a reviewer gate is a SETTING and not a rewrite', () => {
    // Moving the secret to an environment secret and adding required reviewers
    // then gates every publish on approval, with no change to this file.
    expect(parsed().jobs.publish.environment).toBe('announcements');
  });

  it('checks the toolchain out of a separate repository, at a pinned ref', () => {
    const steps = parsed().jobs.publish.steps;
    const toolchain = steps.find((step) => step.name === 'Check out the Manager toolchain')!;

    expect(toolchain.with).toMatchObject({
      repository: 'Owner/Manager',
      ref: 'v1.2.3',
      path: '.manager',
    });

    // A moving branch would let a change in the Manager repository silently
    // change what every publish signs.
    expect(toolchain.with?.ref).not.toBe('main');
  });

  it('takes the signing key from the environment and never writes it down', () => {
    const steps = parsed().jobs.publish.steps;
    const signing = steps.find((step) => step.name === 'Build, sign and commit')!;

    expect(signing.env).toHaveProperty('ANNOUNCEMENT_SIGNING_KEY');

    // A file would be readable by every later step in the job, and by anything
    // a compromised action ran.
    expect(signing.run).not.toMatch(/>\s*\S*key|tee .*key/i);
  });

  it('refuses to publish unsigned rather than shipping a rejected file', () => {
    const signing = parsed().jobs.publish.steps.find(
      (step) => step.name === 'Build, sign and commit',
    )!;

    expect(signing.run).toContain('exit 1');
    expect(signing.run).toContain('--sign');
  });

  it('accepts warnings but not errors, because nobody is watching', () => {
    const signing = parsed().jobs.publish.steps.find(
      (step) => step.name === 'Build, sign and commit',
    )!;

    // Comments are stripped before matching. The step explains why it is not a
    // dry run, and a naive `not.toContain` would fail on the explanation —
    // which would push somebody to delete the comment rather than keep it.
    const commands = signing
      .run!.split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    // Warnings are advisory — a long body, a distant start date — and there is
    // no operator to read them. Errors still refuse the publish.
    expect(commands).toContain('--accept-warnings');
    expect(commands).not.toContain('--dry-run');
  });

  it('verifies what it just published', () => {
    const steps = parsed().jobs.publish.steps.map((step) => step.name);
    expect(steps).toContain('Verify what was just published');

    const verify = parsed().jobs.publish.steps.find(
      (step) => step.name === 'Verify what was just published',
    )!;

    // A GITHUB_TOKEN push does not trigger verify.yml, so the one commit that
    // matters most would otherwise go unverified.
    expect(verify.run).toContain('verify-manifest.mjs');
  });

  it('carries the repository it was told about, not a hard-coded one', () => {
    const other = load(
      publishWorkflow({ managerRepository: 'Someone/Else', managerRef: 'abc123' }),
    ) as Workflow;

    const toolchain = other.jobs.publish.steps.find(
      (step) => step.name === 'Check out the Manager toolchain',
    )!;

    expect(toolchain.with?.repository).toBe('Someone/Else');
  });
});

/**
 * The scaffolded DEFAULT is pinned too.
 *
 * Every test above passes `managerRef` explicitly, which is exactly why the
 * default went unchecked: `DEFAULT_MANAGER_REF` was `'main'`, sitting directly
 * underneath the paragraph explaining why a branch must never be used. So
 * `announce init` produced the one arrangement this whole file exists to
 * prevent, and nothing failed — a workflow pinned to a branch resolves
 * perfectly well, and silently changes what every publish signs.
 */
describe('the scaffolded defaults', () => {
  it('pins the toolchain by default, and not to a moving branch', () => {
    expect(['main', 'master', 'HEAD', 'develop']).not.toContain(DEFAULT_MANAGER_REF);
  });

  it('names the Manager repository, which is not the announcements one', () => {
    expect(DEFAULT_MANAGER_REPOSITORY).not.toMatch(/announcement/i);
    expect(DEFAULT_MANAGER_REPOSITORY).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it('produces a workflow pinned to that default when nothing is passed', () => {
    const yaml = publishWorkflow({
      managerRepository: DEFAULT_MANAGER_REPOSITORY,
      managerRef: DEFAULT_MANAGER_REF,
    });

    expect(yaml).toContain(`ref: ${DEFAULT_MANAGER_REF}`);
    expect(yaml).not.toMatch(/ref: main$/m);
  });
});

/**
 * The pinned ref has to be a ref that EXISTS.
 *
 * `DEFAULT_MANAGER_REF` and the tag it names are two halves of one release, and
 * only the first of them is code — so moving the constant is the easy half, and
 * it can be done, committed and shipped while the tag it points at has never
 * been cut. Nothing in this repository notices: the constant is a string, the
 * workflow template interpolates it, and every assertion above still passes.
 *
 * What happens instead is that `actions/checkout` fails in the ANNOUNCEMENTS
 * repository, on a publish, with `Reference is not a tree` — and the publish
 * that fails is somebody else's, in a repository this one cannot see.
 *
 * It has already happened once. `DEFAULT_MANAGER_REF` was moved to `v1.0.3` so
 * that new repositories would scaffold against a toolchain that understands the
 * retention limit, and the tag was never created. The live announcements
 * repository was still pinned at `v1.0.2` and went on publishing every record
 * while the Settings screen said three; repointing it — the actual fix — would
 * have failed at checkout.
 *
 * So: the constant may only name a tag this repository actually has. Cutting
 * the release is what makes the test pass, and there is no way to satisfy it by
 * editing a string.
 */
describe('the ref the default names', () => {
  /** This repository, or `null` when the tests are not run from a checkout. */
  function git(args: string[]): string | null {
    try {
      return execFileSync('git', args, {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }

  const insideCheckout = git(['rev-parse', '--is-inside-work-tree']) === 'true';

  it('exists as a tag in this repository', () => {
    if (!insideCheckout) {
      // A packaged copy with no `.git`. There is nothing to check and nothing
      // to be wrong about, so this is a skip rather than a pass by accident.
      console.warn('publish-workflow: not a git checkout, tag existence unchecked');
      return;
    }

    const resolved = git(['rev-parse', '--verify', `refs/tags/${DEFAULT_MANAGER_REF}`]);

    expect(resolved).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is a tag rather than a branch, so what a publish signs cannot move', () => {
    if (!insideCheckout) return;

    // A branch head with the same name would resolve above and still be a
    // moving target, which is the arrangement the whole file exists to prevent.
    expect(git(['rev-parse', '--verify', `refs/heads/${DEFAULT_MANAGER_REF}`])).toBeNull();
  });

  /**
   * A tag that exists ONLY on this machine is not a release.
   *
   * The assertion above passes the moment somebody types `git tag v1.0.3`, and
   * a local tag is invisible to everyone. `actions/checkout` resolves the ref
   * against the REMOTE and nowhere else, so an unpushed tag fails there with
   * `Reference is not a tree` — in the announcements repository, on somebody
   * else's publish, in a run this repository never sees.
   *
   * That is not the hypothetical the paragraph above took it for. It is what
   * actually happened: `v1.0.3` was created here, `DEFAULT_MANAGER_REF` was
   * moved to it, this file's local-tag assertion went green, and the tag was
   * never pushed. The live `publish.yml` therefore stayed on `v1.0.2` — a
   * toolchain with no `applyRetention` at all — and went on publishing every
   * record while the phone's Settings screen said three, with a completely
   * green Actions history. Ten announcements reached RUOOD Lab.
   *
   * So the check is against `origin`, which is the only place the answer lives.
   */
  it('is PUSHED, because a checkout resolves it on the remote and not here', () => {
    if (!insideCheckout) return;

    const remotes = git(['remote']);
    if (!remotes) {
      console.warn('publish-workflow: no git remote, tag publication unchecked');
      return;
    }

    const listed = git(['ls-remote', '--tags', 'origin', `refs/tags/${DEFAULT_MANAGER_REF}`]);

    if (listed === null) {
      // Offline, or the remote refused. Unknowable is not the same as wrong,
      // and a suite that fails on an aeroplane is a suite people stop running.
      console.warn('publish-workflow: remote unreachable, tag publication unchecked');
      return;
    }

    // `ls-remote` answers with an empty string for a ref the remote does not
    // have, which is the exact shape of this failure.
    expect(listed).not.toBe('');
    expect(listed).toContain(`refs/tags/${DEFAULT_MANAGER_REF}`);
  });

  /**
   * And it must be the same commit here and there.
   *
   * `git tag -f` after a push leaves two different objects wearing one name:
   * the toolchain that was tested locally, and the different one every publish
   * actually runs. The workflow pins a tag precisely so that what it signs
   * cannot move, and a tag that means two things has given that up quietly.
   */
  it('names the same commit here and on the remote', () => {
    if (!insideCheckout) return;
    if (!git(['remote'])) return;

    const listed = git(['ls-remote', '--tags', 'origin', `refs/tags/${DEFAULT_MANAGER_REF}`]);
    if (listed === null || listed === '') return; // covered by the test above

    // Asked for one exact ref, `ls-remote` answers with that ref alone and does
    // NOT peel it — so an annotated tag reports the sha of the tag OBJECT,
    // while `rev-parse <tag>^{commit}` reports the commit underneath it. Both
    // are "this tag" and neither is wrong, so both are accepted; what is being
    // refused is the remote naming something this repository does not have.
    const remote = listed.split(/\s+/)[0];

    const local = [
      git([`rev-parse`, DEFAULT_MANAGER_REF]),
      git([`rev-parse`, `${DEFAULT_MANAGER_REF}^{commit}`]),
    ];

    expect(local).toContain(remote);
  });
});
