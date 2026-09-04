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
