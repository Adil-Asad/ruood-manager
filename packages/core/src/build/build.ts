/**
 * The build: `content/` -> `dist/`.
 *
 * Deterministic. The same `content/` and the same injected `now` produce the
 * same bytes, which is what makes the dry-run diff trustworthy and what a
 * future signature requires.
 *
 * Order matters, and each step exists to stop a specific way of shipping a file
 * the client cannot use:
 *
 *   1. project        decide what is published at all
 *   2. sync images    ensure every referenced file exists; prune orphans
 *   3. serialise      canonical JSON, so a one-field edit is a one-line diff
 *   4. VERIFY         run the CLIENT's own parser over the exact bytes
 *
 * Step 4 is the one that matters most. Validating the input would prove the
 * Manager is happy; running `verifyPublishable` proves the app can read what is
 * about to be written, which is a different and stricter question.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalJson,
  formatIssues,
  utf8ByteLength,
  validateAnnouncementRecord,
  validateManifest,
  verifyPublishable,
  type AnnouncementManifest,
  type ValidationIssue,
} from '@ruood/announcement-schema';

import { idRegistryFrom, loadContent } from '../content/store';
import { imageName, type RepoPaths } from '../paths';
import { encodeAnnouncementImage, sha256Of } from '../images/encode';
import { findOriginalFor } from '../images/attach';
import { projectManifest, type ExcludedRecord } from './project';
import type { ImageInventory } from '../publish/diff';

export interface BuildOptions {
  now: number;
  /**
   * Sets the kill switch. Omit it and the CURRENTLY PUBLISHED value is carried
   * forward.
   *
   * Carrying it forward is the important half. Defaulting to `false` meant an
   * ordinary publish silently turned the switch off — so flipping it during an
   * incident and then publishing the fix would put every install straight back
   * to showing announcements. Clearing it is something you now have to ask for.
   */
  paused?: boolean;
  /** Skip the revision bump — used by `validate`, which writes nothing. */
  keepRevision?: boolean;
  externalHostAllowlist?: readonly string[];
}

export interface BuildResult {
  ok: boolean;
  manifest: AnnouncementManifest;
  serialised: string;
  bytes: number;
  excluded: ExcludedRecord[];
  images: ImageInventory;
  /** Files that must exist in `dist/images/` after the write. */
  imageFiles: Map<string, Buffer>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Non-validation problems: unreadable files, missing originals. */
  problems: string[];
}

/**
 * Produces the manifest and every byte that goes with it, WITHOUT writing.
 *
 * Separating "compute" from "write" is what lets `validate` and the dry-run
 * diff run the whole pipeline without touching the working tree.
 */
export async function buildManifest(
  paths: RepoPaths,
  options: BuildOptions,
): Promise<BuildResult> {
  const snapshot = await loadContent(paths);
  const problems = snapshot.failures.map((failure) => `${failure.file}: ${failure.error}`);

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Validate each authored record first. A record that fails here is a record
  // the operator must fix; publishing it would put the burden on every install.
  const registry = idRegistryFrom(snapshot);
  for (const entry of snapshot.records) {
    const result = validateAnnouncementRecord(entry.record, {
      now: options.now,
      mode: 'authored',
      idRegistry: registry,
      editingId: entry.id,
      ...(options.externalHostAllowlist
        ? { externalHostAllowlist: options.externalHostAllowlist }
        : {}),
    });

    errors.push(...prefix(result.errors, entry.id));
    warnings.push(...prefix(result.warnings, entry.id));
  }

  const revision = options.keepRevision ? snapshot.revision : snapshot.revision + 1;

  // The kill switch is STICKY. When the caller does not say, whatever is
  // currently published stays in force — because the alternative, defaulting to
  // `false`, meant flipping the switch during an incident and then publishing
  // the fix silently turned it back off, on every install at once.
  const paused =
    options.paused === undefined ? (await readPublished(paths)).manifest?.paused ?? false : options.paused;

  const { manifest, excluded } = projectManifest(
    snapshot.records.map((entry) => entry.record),
    { now: options.now, revision, paused },
  );

  const { images, imageFiles, imageProblems } = await resolveImages(paths, manifest);
  problems.push(...imageProblems);

  const serialised = canonicalJson(manifest);
  const bytes = utf8ByteLength(serialised);

  const manifestResult = validateManifest(manifest, {
    now: options.now,
    serialisedBytes: bytes,
    ...(options.externalHostAllowlist
      ? { externalHostAllowlist: options.externalHostAllowlist }
      : {}),
  });
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);

  // The client's own reader, over the exact bytes.
  const verdict = verifyPublishable(serialised, {
    now: options.now,
    ...(options.externalHostAllowlist
      ? { externalHostAllowlist: options.externalHostAllowlist }
      : {}),
  });
  if (!verdict.ok) problems.push(verdict.detail);

  return {
    ok: errors.length === 0 && problems.length === 0,
    manifest,
    serialised,
    bytes,
    excluded,
    images,
    imageFiles,
    errors,
    warnings,
    problems,
  };
}

/**
 * Makes sure every referenced image exists as bytes, re-encoding from the
 * original when `dist/` is missing it.
 *
 * Re-encoding rather than failing is what makes `dist/` genuinely disposable:
 * delete the whole directory and a build reconstructs it from `content/`.
 */
async function resolveImages(
  paths: RepoPaths,
  manifest: AnnouncementManifest,
): Promise<{ images: ImageInventory; imageFiles: Map<string, Buffer>; imageProblems: string[] }> {
  const images: ImageInventory = {};
  const imageFiles = new Map<string, Buffer>();
  const imageProblems: string[] = [];

  for (const record of manifest.announcements) {
    if (!record.image) continue;

    const name = imageName(record.id, record.image.sha256);
    const distFile = join(paths.images, name);

    if (existsSync(distFile)) {
      const data = await readFile(distFile);
      // The hash in the record is the contract; a file that no longer matches
      // it would fail on the device, silently, after being downloaded.
      if (sha256Of(data) !== record.image.sha256) {
        imageProblems.push(
          `${name} does not match the sha256 recorded for "${record.id}". ` +
            'Re-attach the image rather than editing the record by hand.',
        );
        continue;
      }
      images[record.image.path] = data.length;
      imageFiles.set(name, data);
      continue;
    }

    const original = await findOriginalFor(paths, record.id);
    if (!original) {
      imageProblems.push(
        `"${record.id}" references ${record.image.path}, but neither the built file nor an ` +
          `original in content/media/ exists.`,
      );
      continue;
    }

    try {
      const encoded = await encodeAnnouncementImage(original, {
        id: record.id,
        alt: record.image.alt,
      });

      if (encoded.image.sha256 !== record.image.sha256) {
        imageProblems.push(
          `Re-encoding the original for "${record.id}" produced different bytes than the record ` +
            'expects. Re-attach the image so the record and the file agree.',
        );
        continue;
      }

      images[record.image.path] = encoded.data.length;
      imageFiles.set(name, encoded.data);
    } catch (error) {
      imageProblems.push(`"${record.id}": ${(error as Error).message}`);
    }
  }

  return { images, imageFiles, imageProblems };
}

/** Writes the build to `dist/`, pruning any image nothing references. */
export async function writeBuild(paths: RepoPaths, result: BuildResult): Promise<string[]> {
  await mkdir(paths.images, { recursive: true });

  const written: string[] = [];

  await writeFile(paths.manifest, result.serialised, 'utf8');
  written.push(paths.manifest);

  for (const [name, data] of result.imageFiles) {
    const file = join(paths.images, name);
    await writeFile(file, data);
    written.push(file);
  }

  // Prune. `dist/images/` must hold exactly the referenced set — an orphan is
  // bytes in the repository that nothing will ever request.
  for (const entry of await readdir(paths.images)) {
    if (result.imageFiles.has(entry)) continue;
    await rm(join(paths.images, entry));
    written.push(join(paths.images, entry));
  }

  return written;
}

/** Reads what is currently published, for the diff. `null` before a first build. */
export async function readPublished(
  paths: RepoPaths,
): Promise<{ manifest: AnnouncementManifest | null; images: ImageInventory; bytes: number }> {
  if (!existsSync(paths.manifest)) return { manifest: null, images: {}, bytes: 0 };

  const raw = await readFile(paths.manifest, 'utf8');
  let manifest: AnnouncementManifest | null = null;
  try {
    manifest = JSON.parse(raw) as AnnouncementManifest;
  } catch {
    manifest = null;
  }

  const images: ImageInventory = {};
  if (existsSync(paths.images)) {
    for (const entry of await readdir(paths.images)) {
      const data = await readFile(join(paths.images, entry));
      images[`images/${entry}`] = data.length;
    }
  }

  return { manifest, images, bytes: utf8ByteLength(raw) };
}

function prefix(issues: readonly ValidationIssue[], id: string): ValidationIssue[] {
  return issues.map((issue) => ({ ...issue, path: `${id}${issue.path ? `.${issue.path}` : ''}` }));
}

export { formatIssues };
