/**
 * Creating the announcements repository.
 *
 * A separate git repository from both this project and RUOOD Lab. It holds
 * `content/` (the source of truth, including drafts) and `dist/` (what clients
 * read), and nothing else — no build step between a push and a device, which is
 * why `dist/` is committed rather than produced by CI.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from '@ruood/announcement-schema';

import { AnnouncementRepo } from './git/repository';
import { repoPaths, type RepoPaths } from './paths';
import { CI_SCRIPT, CI_SCRIPT_FILE, CI_WORKFLOW, CI_WORKFLOW_FILE } from './ci/files';
import { PUBLISH_WORKFLOW_FILE, publishWorkflow } from './ci/publish-workflow';

export interface ScaffoldResult {
  paths: RepoPaths;
  created: string[];
  alreadyExisted: boolean;
  /**
   * Set when the new repository sits inside another checkout.
   *
   * Not an error — a nested repository works — but it is worth saying out loud,
   * because the enclosing project will see the whole thing as one untracked
   * directory and someone will eventually commit it there by accident.
   */
  nestedInsideRepository: boolean;
}

/**
 * Where the publishing toolchain is checked out from.
 *
 * Defaults rather than requirements, so `announce init` still takes one
 * argument. Both are overridable because a fork, or a pinned upgrade, is a
 * normal thing to want — and the ref especially: leaving it on a branch would
 * mean a change in the Manager repository silently changing what every publish
 * signs.
 */
export const DEFAULT_MANAGER_REPOSITORY = 'Adil-Asad/ruood-manager';

/**
 * A TAG, and never a branch.
 *
 * This defaulted to `main`, directly underneath the paragraph explaining why a
 * branch is wrong — so `announce init` scaffolded exactly the arrangement the
 * rest of this file exists to prevent, and nothing failed: every generated
 * workflow would have tracked whatever the Manager's default branch happened to
 * contain at the moment of each publish, silently changing what gets signed.
 *
 * The tests did not catch it because they all pass `managerRef` explicitly.
 * They now assert the default itself.
 *
 * A tag that does not exist yet fails loudly, in CI, naming the missing ref.
 * That is strictly better than a branch that always resolves and is always a
 * moving target.
 *
 * `v1.0.1` rather than `v1.0.0` because v1.0.0 cannot publish on a Linux
 * runner: its `package-lock.json` was generated on Windows and carried only
 * `@img/sharp-win32-x64`, so `npm ci` gave the runner sharp's JavaScript and
 * none of its native libvips. A repository scaffolded against it would be born
 * unable to publish, and the failure arrives late — `npm ci` and the build both
 * succeed, and only the image step says so.
 *
 * `v1.0.2` rather than `v1.0.1` because v1.0.1's validator still REQUIRED a
 * title and a body, and the app that writes `content/` no longer does — an
 * announcement may be a picture and nothing else. The phone accepted one, the
 * pinned build refused it, and the publish step exited non-zero. That is worse
 * than it sounds: the build validates every published record, so ONE record the
 * pinned toolchain cannot read freezes `dist/` for every announcement after it.
 * Nothing on a device says so; the manifest simply stops changing, and every
 * install goes on showing the last file that published.
 *
 * The lesson is the pin's, not the validator's: a schema the app can author and
 * the pinned toolchain cannot read is a broken publisher, so the two are
 * upgraded together — and this constant is half of that.
 */
export const DEFAULT_MANAGER_REF = 'v1.0.2';

export interface ScaffoldOptions {
  /** `owner/repo` of the Manager repository. */
  managerRepository?: string;
  /** The ref to pin the toolchain at. A tag or a sha; never a moving branch. */
  managerRef?: string;
}

export async function scaffoldRepository(
  root: string,
  options?: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const paths = repoPaths(root);
  const created: string[] = [];
  const alreadyExisted = existsSync(paths.content);

  for (const dir of [
    paths.announcements,
    paths.media,
    paths.images,
    join(root, 'schema'),
    // The staging channel's output. Created up front so the layout is visible
    // before the first staging publish rather than appearing later.
    join(paths.dist, 'staging', 'images'),
    join(root, 'keys'),
  ]) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      created.push(dir);
    }
  }

  await writeOnce(paths.retiredIds, canonicalJson([]), created);
  await writeOnce(paths.state, canonicalJson({ revision: 0 }), created);
  await writeOnce(join(root, '.gitignore'), GITIGNORE, created);
  await writeOnce(join(root, 'README.md'), README, created);
  await writeOnce(join(paths.media, '.gitkeep'), '', created);
  await writeOnce(join(root, 'keys', '.gitkeep'), '', created);

  // CI verifies that dist/ is still what the Manager signed. Scaffolded into
  // the repository rather than run from the Manager, because what it has to
  // catch is a commit the Manager did not produce.
  await writeOnce(join(root, CI_WORKFLOW_FILE), CI_WORKFLOW, created);
  await writeOnce(join(root, CI_SCRIPT_FILE), CI_SCRIPT, created);

  // And the workflow that PUBLISHES: the Manager app writes `content/` over the
  // GitHub API, and this is what turns that into a signed `dist/`. It checks
  // the Manager repository out as a build tool at a pinned ref — a dependency
  // in one direction, so neither repository ends up inside the other.
  await writeOnce(
    join(root, PUBLISH_WORKFLOW_FILE),
    publishWorkflow({
      managerRepository: options?.managerRepository ?? DEFAULT_MANAGER_REPOSITORY,
      managerRef: options?.managerRef ?? DEFAULT_MANAGER_REF,
    }),
    created,
  );

  // An empty but VALID manifest, so a client fetching before the first publish
  // gets a well-formed file rather than a 404 it has to treat as an error.
  if (!existsSync(paths.manifest)) {
    await writeFile(paths.manifest, EMPTY_MANIFEST, 'utf8');
    created.push(paths.manifest);
  }

  const stagingManifest = join(paths.dist, 'staging', 'announcements.json');
  if (!existsSync(stagingManifest)) {
    await writeFile(stagingManifest, EMPTY_MANIFEST, 'utf8');
    created.push(stagingManifest);
  }

  const repo = new AnnouncementRepo(root);
  const nestedInsideRepository = await repo.isInsideAnotherRepository();

  // `isRepository` asks whether this directory is a repository ROOT. Asking
  // only "am I inside a work tree" would be true for any subdirectory of any
  // checkout, so `init` would be skipped and every later publish would commit
  // into the enclosing repository instead.
  if (!(await repo.isRepository())) {
    await repo.init();
    created.push(join(root, '.git'));
  }

  return { paths, created, alreadyExisted, nestedInsideRepository };
}

async function writeOnce(file: string, contents: string, created: string[]): Promise<void> {
  if (existsSync(file)) return;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, contents, 'utf8');
  created.push(file);
}

/**
 * A valid but empty manifest, so a client fetching before the first publish
 * reads a well-formed file rather than a 404 it has to treat as an error.
 *
 * Unsigned, and correctly so: there is no key yet, and a client that requires
 * signatures is a client that should refuse this rather than be handed a
 * plausible-looking forgery target.
 */
const EMPTY_MANIFEST = canonicalJson({
  schemaVersion: 1,
  revision: 0,
  generatedAt: '1970-01-01T00:00:00Z',
  paused: false,
  announcements: [],
});

const GITIGNORE = `node_modules/
.DS_Store
Thumbs.db

# The PRIVATE signing key must never be committed. \`announce keygen\` refuses to
# write one inside a repository at all, so this is the second line of defence
# rather than the first — but a key in git history stays in git history.
*.key
*.pem
keys/*.key
keys/*.pem
`;

const README = `# RUOOD Lab Announcements

Remote announcement data for RUOOD Lab. **Published by the Announcement
Manager — do not edit \`dist/\` by hand.**

\`\`\`
content/                    source of truth, including drafts and archives
  announcements/<id>.json   one file per record
  media/<id>.<ext>          image originals, full resolution
  retired-ids.json          ids that can never be reused
  state.json                the revision counter
dist/                       BUILT — the only thing the app reads
  announcements.json
  images/<id>-<hash8>.webp  content-addressed, cacheable for ever
\`\`\`

## For anyone who finds this repository

The app reads \`dist/announcements.json\` and nothing else. If it is missing,
malformed, or unreachable, **RUOOD Lab carries on working normally** — an
announcement is never a dependency for the app starting.

\`paused: true\` at the root of that file is a kill switch: every install shows
nothing until it goes back to \`false\`.

## Signing

\`dist/announcements.json\` is signed with Ed25519 over the canonical form of the
whole file — including \`paused\`, \`revision\` and which records are present. The
public key is in \`keys/announcement-signing.pub\` and is committed on purpose; a
public key is public. The private key lives outside every repository.

CI re-checks the signature on every push (\`.github/workflows/verify.yml\`). If it
fails, \`dist/\` was edited by something other than the Manager.

## Channels

\`dist/announcements.json\` is production. \`dist/staging/announcements.json\` is
the staging channel, which dev builds read and which additionally carries
**drafts** — that is what it is for. Each is published by its own commit.

## Ids are permanent

An id is never reused, including after its record is deleted, because it keys
impression state on every device that ever saw it. \`content/retired-ids.json\`
is the ledger of ids that are gone for good.
`;
