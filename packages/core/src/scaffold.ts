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

export async function scaffoldRepository(root: string): Promise<ScaffoldResult> {
  const paths = repoPaths(root);
  const created: string[] = [];
  const alreadyExisted = existsSync(paths.content);

  for (const dir of [paths.announcements, paths.media, paths.images, join(root, 'schema')]) {
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

  // An empty but VALID manifest, so a client fetching before the first publish
  // gets a well-formed file rather than a 404 it has to treat as an error.
  if (!existsSync(paths.manifest)) {
    await writeFile(
      paths.manifest,
      canonicalJson({
        schemaVersion: 1,
        revision: 0,
        generatedAt: '1970-01-01T00:00:00Z',
        paused: false,
        announcements: [],
      }),
      'utf8',
    );
    created.push(paths.manifest);
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

const GITIGNORE = `node_modules/
.DS_Store
Thumbs.db
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

## Ids are permanent

An id is never reused, including after its record is deleted, because it keys
impression state on every device that ever saw it. \`content/retired-ids.json\`
is the ledger of ids that are gone for good.
`;
