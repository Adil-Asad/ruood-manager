/**
 * The workflow that publishes, scaffolded into the announcements repository.
 *
 * ## What this replaced
 *
 * Publishing used to happen in a server process on the operator's machine: it
 * held the git checkout, ran `sharp`, and read the Ed25519 key out of
 * `~/.ruood/`. That made the operator's PC a single point of failure for the
 * whole product, which is what this workflow exists to remove.
 *
 * Now the Manager app writes `content/` over the GitHub API, and this runs
 * afterwards to do everything that needs a real machine: encode the images,
 * build the manifest, verify it with the client's own parser, sign it, and
 * commit `dist/`.
 *
 * ## The two repositories stay separate
 *
 * This workflow lives in the ANNOUNCEMENTS repository and checks the MANAGER
 * repository out as a build tool, at a pinned ref. That is a dependency in one
 * direction only:
 *
 *   - the announcements repository never becomes part of the Manager;
 *   - the Manager never contains announcement content;
 *   - either can be replaced without touching the other's history.
 *
 * A submodule would have coupled their histories. Publishing the CLI to npm
 * would have worked too, and would mean a release step between fixing a bug and
 * being able to publish with the fix.
 *
 * **The ref is pinned deliberately.** With `@main` a change in the Manager
 * repository would silently change what every publish produces, including what
 * gets signed. Pinning means upgrading the toolchain is a commit in this
 * repository, visible in its history, next to the manifests it produced.
 *
 * ## Why the signing key can be a plain secret here
 *
 * The token the Manager app holds can write `content/` and cannot write
 * `.github/workflows/` — those are separate permissions in GitHub's
 * fine-grained model. So an administrator, or a stolen phone, can change what
 * is published but cannot change what the publishing step DOES, and therefore
 * cannot make it print the key.
 *
 * What this does mean, stated plainly: anyone who can push to `main` can cause
 * a signed publish. The signature proves "this came through the pipeline"
 * rather than "a human with an offline key approved it". That is unavoidable in
 * any design where a phone publishes without a particular machine being awake,
 * and it was the deliberate trade.
 *
 * When a stronger property is wanted, it is a repository SETTING and not a code
 * change: move `ANNOUNCEMENT_SIGNING_KEY` to an Environment secret and add a
 * required reviewer. The job below already names an environment for exactly
 * that reason — `github.event.repository.name` is not used, `announcements` is
 * a literal, so protection rules can be attached without editing this file.
 */

export const PUBLISH_WORKFLOW_FILE = '.github/workflows/publish.yml';

export interface PublishWorkflowOptions {
  /** `owner/repo` of the Manager repository, checked out as a build tool. */
  managerRepository: string;
  /** The ref to pin it at. A tag or a commit sha; never a moving branch. */
  managerRef: string;
}

export function publishWorkflow(options: PublishWorkflowOptions): string {
  return `# Builds, signs and publishes dist/ whenever content/ changes.
#
# The RUOOD Manager app writes content/ through the GitHub API. This is what
# turns that into a published, signed manifest: it encodes the images, builds
# the manifest, verifies it with the client's own parser, signs it, and commits
# dist/ in one commit.
#
# It needs one secret: ANNOUNCEMENT_SIGNING_KEY, the Ed25519 private key in PEM
# form. The app that writes content/ cannot edit this file — "Contents" and
# "Workflows" are separate permissions in GitHub's fine-grained model — so a
# stolen phone can change what is published and cannot change what publishing
# does.
name: Publish announcements

on:
  push:
    branches: [main]
    # dist/ is what this workflow WRITES. Without this filter its own commit
    # would look like a reason to run again — GITHUB_TOKEN pushes do not
    # trigger workflows, so it would not actually loop, but the intent should
    # not rest on that.
    paths:
      - 'content/**'
      - '.github/workflows/publish.yml'
  workflow_dispatch:

# One publish at a time. Two overlapping runs would both build from their own
# checkout and the second would fail to push, which is safe but looks like a
# broken publish to whoever is watching.
concurrency:
  group: publish-announcements
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest

    # Named so a required-reviewer protection rule can be attached later
    # WITHOUT editing this workflow. Move the signing key to an environment
    # secret and add reviewers, and every publish then waits for approval.
    environment: announcements

    permissions:
      # Enough to commit dist/ back. Deliberately not \`workflows: write\`.
      contents: write

    steps:
      - name: Check out the announcements
        uses: actions/checkout@v4

      # The Manager is a separate repository and a build tool here. Pinned, so
      # a change there cannot silently change what this signs.
      - name: Check out the Manager toolchain
        uses: actions/checkout@v4
        with:
          repository: ${options.managerRepository}
          ref: ${options.managerRef}
          path: .manager

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build the toolchain
        working-directory: .manager
        run: |
          npm ci
          npm run build

      # The key arrives in the environment and is never written to disk. The
      # runner is ephemeral either way, but a file would be readable by every
      # later step in the job.
      # The publish makes the commit itself, because "publishing is one git
      # commit" is a guarantee of the tool rather than of this file: the
      # manifest and every image land together or not at all. So git has to know
      # who it is BEFORE that step, not after.
      - name: Identify the committer
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      # The key arrives in the environment and is never written to disk. The
      # runner is ephemeral either way, but a file would be readable by every
      # later step in the job.
      - name: Build, sign and commit
        env:
          ANNOUNCEMENT_SIGNING_KEY: \${{ secrets.ANNOUNCEMENT_SIGNING_KEY }}
        run: |
          if [ -z "$ANNOUNCEMENT_SIGNING_KEY" ]; then
            echo "::error::ANNOUNCEMENT_SIGNING_KEY is not set. Publishing unsigned would ship"
            echo "::error::a file that every install rejects, so this refuses instead."
            exit 1
          fi

          # --accept-warnings, not --dry-run. Warnings here are advisory (a long
          # body, a start date far out) and there is nobody to read them.
          # ERRORS still refuse the publish, which is the check that matters.
          node .manager/packages/cli/dist/bin.js publish \\
            --repo "$GITHUB_WORKSPACE" \\
            --sign \\
            --accept-warnings \\
            --no-push

      # Pushed separately, so the credential used is GITHUB_TOKEN's — which
      # actions/checkout has already configured on the remote.
      - name: Push
        run: |
          if git diff --quiet HEAD "origin/$GITHUB_REF_NAME"; then
            echo "Nothing to push - content/ produced an identical build."
            exit 0
          fi
          git push origin "HEAD:$GITHUB_REF_NAME"

      # The same check CI runs on every push, run here against what was just
      # produced. A GITHUB_TOKEN push does NOT trigger other workflows, so
      # verify.yml will not see this commit - which would leave the one commit
      # that matters unverified if this step did not exist.
      - name: Verify what was just published
        run: |
          node scripts/verify-manifest.mjs
          node scripts/verify-manifest.mjs --channel staging
`;
}
