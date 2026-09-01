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
import { channelPaths, imageName, type Channel, type ChannelPaths, type RepoPaths } from '../paths';
import { signManifest, trustedKeysFor, verifySignedManifest } from '../signing/sign';
import { loadPublicKeyRecord, PUBLIC_KEY_FILE, type SigningKey } from '../signing/keys';
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

  /** Which manifest is being produced. Staging additionally includes drafts. */
  channel?: Channel;

  /**
   * Signs the manifest when supplied.
   *
   * Optional, so a repository that has not generated a key yet still builds.
   * Signing is something you turn on, and turning it on in the app before the
   * publisher signs would reject every good file.
   */
  signingKey?: SigningKey;
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

  channel: Channel;
  /** The key id the manifest was signed with, or `null` if it was not signed. */
  signedBy: string | null;
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
  const channel = options.channel ?? 'production';
  const output = channelPaths(paths, channel);

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
    options.paused === undefined
      ? (await readPublished(paths, channel)).manifest?.paused ?? false
      : options.paused;

  const projected = projectManifest(snapshot.records.map((entry) => entry.record), {
    now: options.now,
    revision,
    paused,
    // Staging exists to preview a draft on a real device before deciding it is
    // ready; production never publishes one.
    includeDrafts: channel === 'staging',
  });

  const excluded = projected.excluded;

  const { images, imageFiles, imageProblems } = await resolveImages(
    paths,
    output,
    projected.manifest,
  );
  problems.push(...imageProblems);

  // Signing happens LAST, over the finished manifest, and what gets serialised
  // is the signed object — so `verifyPublishable` below reads exactly the bytes
  // that will be written, signature included.
  let manifest = projected.manifest;
  let signedBy: string | null = null;

  if (options.signingKey) {
    problems.push(...(await checkKeyMatchesRepository(paths, options.signingKey)));

    manifest = signManifest(manifest, options.signingKey);
    signedBy = options.signingKey.keyId;

    // Verify what was just produced, with the client's own check. A signature
    // the publisher cannot verify is one no install can verify either.
    const verdict = verifySignedManifest(manifest, trustedKeysFor(options.signingKey));
    if (!verdict.ok) {
      problems.push(`The manifest was signed but the signature does not verify: ${verdict.detail}`);
    }
  }

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
    channel,
    signedBy,
  };
}

/**
 * The key doing the signing must be the key the repository says it expects.
 *
 * Signing with a key the app was not built to trust produces a file every
 * install refuses — and refuses silently, because there is no feedback channel
 * to report it. Build time is the only place this can be caught at all.
 */
async function checkKeyMatchesRepository(
  paths: RepoPaths,
  key: SigningKey,
): Promise<string[]> {
  const expected = await loadPublicKeyRecord(paths.root);

  if (!expected) {
    return [
      `This repository has no ${PUBLIC_KEY_FILE.replace(/\\/g, '/')}, so nothing records which ` +
        'key it is signed by. Run: announce keygen --repo <path>',
    ];
  }

  if (expected.keyId !== key.keyId) {
    return [
      `Signing with key "${key.keyId}" but this repository expects "${expected.keyId}". ` +
        'Publishing would produce a file every install rejects. Check --key.',
    ];
  }

  return [];
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
  output: ChannelPaths,
  manifest: AnnouncementManifest,
): Promise<{ images: ImageInventory; imageFiles: Map<string, Buffer>; imageProblems: string[] }> {
  const images: ImageInventory = {};
  const imageFiles = new Map<string, Buffer>();
  const imageProblems: string[] = [];

  for (const record of manifest.announcements) {
    if (!record.image) continue;

    const name = imageName(record.id, record.image.sha256);
    const distFile = join(output.images, name);

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
  const output = channelPaths(paths, result.channel);
  await mkdir(output.images, { recursive: true });

  const written: string[] = [];

  await writeFile(output.manifest, result.serialised, 'utf8');
  written.push(output.manifest);

  for (const [name, data] of result.imageFiles) {
    const file = join(output.images, name);
    await writeFile(file, data);
    written.push(file);
  }

  // Prune. The channel's `images/` must hold exactly the referenced set — an
  // orphan is bytes in the repository that nothing will ever request.
  for (const entry of await readdir(output.images)) {
    if (result.imageFiles.has(entry)) continue;
    await rm(join(output.images, entry));
    written.push(join(output.images, entry));
  }

  return written;
}

/** Reads what is currently published, for the diff. `null` before a first build. */
export async function readPublished(
  paths: RepoPaths,
  channel: Channel = 'production',
): Promise<{ manifest: AnnouncementManifest | null; images: ImageInventory; bytes: number }> {
  const output = channelPaths(paths, channel);
  if (!existsSync(output.manifest)) return { manifest: null, images: {}, bytes: 0 };

  const raw = await readFile(output.manifest, 'utf8');
  let manifest: AnnouncementManifest | null = null;
  try {
    manifest = JSON.parse(raw) as AnnouncementManifest;
  } catch {
    manifest = null;
  }

  const images: ImageInventory = {};
  if (existsSync(output.images)) {
    for (const entry of await readdir(output.images)) {
      const data = await readFile(join(output.images, entry));
      images[`images/${entry}`] = data.length;
    }
  }

  return { manifest, images, bytes: utf8ByteLength(raw) };
}

function prefix(issues: readonly ValidationIssue[], id: string): ValidationIssue[] {
  return issues.map((issue) => ({ ...issue, path: `${id}${issue.path ? `.${issue.path}` : ''}` }));
}

export { formatIssues };
