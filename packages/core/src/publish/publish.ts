/**
 * Publishing: build, verify, show, commit, push.
 *
 * The whole point of the sequence is that nothing irreversible happens until
 * everything reversible has already succeeded. In order:
 *
 *   build + verify   pure and in memory. A failure here writes nothing at all.
 *   diff             shown to a person, who confirms. Still nothing written.
 *   write dist/      the working tree changes, but git can undo it.
 *   commit           one commit, manifest and images together.
 *   push             and if this fails, the commit is still intact locally.
 *
 * The last line is why a network failure is not a crisis: `publish` reports
 * "committed, not pushed", and `push` retries later. Nothing is lost and
 * nothing is half-done, because the unit of publication is the commit rather
 * than the upload.
 */

import { buildManifest, readPublished, writeBuild, type BuildOptions, type BuildResult } from '../build/build';
import { diffPublish, formatDiff, type PublishDiff } from './diff';
import { saveState } from '../content/store';
import { AnnouncementRepo, type PushOutcome } from '../git/repository';
import { channelPaths, type RepoPaths } from '../paths';

/**
 * One publish is one channel.
 *
 * Publishing production and staging is two commits, and that is deliberate
 * rather than a limitation: each commit is still atomic — its manifest and its
 * images land together or not at all — and each channel gets its own line in
 * `git log` and its own thing to revert. A single commit touching both would
 * make "roll back staging" mean rolling back production too.
 */
export interface PublishOptions extends BuildOptions {
  /** Compute and show, write nothing. */
  dryRun?: boolean;
  /** Skip the push; commit only. */
  noPush?: boolean;
  /** Publish even with warnings outstanding. Errors are never overridable. */
  acceptWarnings?: boolean;
  message?: string;
}

export type PublishStatus =
  | 'dry-run'
  | 'no-changes'
  | 'blocked'
  | 'committed'
  | 'published';

export interface PublishResult {
  status: PublishStatus;
  build: BuildResult;
  diff: PublishDiff;
  commit?: string;
  push?: PushOutcome;
  /** Why a `blocked` result was blocked, ready to print. */
  blockedBy?: string;
}

export async function publish(
  paths: RepoPaths,
  options: PublishOptions,
): Promise<PublishResult> {
  const channel = options.channel ?? 'production';
  const output = channelPaths(paths, channel);

  const build = await buildManifest(paths, options);
  const previous = await readPublished(paths, channel);

  const diff = diffPublish({
    before: previous.manifest,
    after: build.manifest,
    imagesBefore: previous.images,
    imagesAfter: build.images,
    manifestBytesBefore: previous.bytes,
    manifestBytesAfter: build.bytes,
  });

  if (!build.ok) {
    return {
      status: 'blocked',
      build,
      diff,
      blockedBy: blockedSummary(build),
    };
  }

  if (build.warnings.length > 0 && !options.acceptWarnings && !options.dryRun) {
    return {
      status: 'blocked',
      build,
      diff,
      blockedBy:
        `${build.warnings.length} warning(s) outstanding. Review them, then publish with ` +
        '--accept-warnings if they are what you meant.',
    };
  }

  if (options.dryRun) {
    return { status: 'dry-run', build, diff };
  }

  if (diff.empty) {
    return { status: 'no-changes', build, diff };
  }

  // From here the working tree changes.
  await writeBuild(paths, build);
  await saveState(paths, { revision: build.manifest.revision });

  const repo = new AnnouncementRepo(paths.root);
  const commit = await repo.commitPaths(
    // Per-channel, so a production publish cannot sweep up whatever staging
    // last wrote, and the reverse.
    output.commitPaths,
    options.message ?? defaultMessage(diff, build.manifest.revision, build),
  );

  if (options.noPush) {
    return { status: 'committed', build, diff, commit };
  }

  const push = await repo.push();
  return {
    status: push.pushed ? 'published' : 'committed',
    build,
    diff,
    commit,
    push,
  };
}

function blockedSummary(build: BuildResult): string {
  const parts: string[] = [];
  if (build.errors.length > 0) parts.push(`${build.errors.length} validation error(s)`);
  if (build.problems.length > 0) parts.push(`${build.problems.length} problem(s)`);
  return `Publishing refused: ${parts.join(' and ')}. Nothing was written.`;
}

/**
 * The commit subject names what changed, so `git log` is the publication
 * history rather than a wall of "publish".
 */
function defaultMessage(diff: PublishDiff, revision: number, build: BuildResult): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length}`);
  if (diff.modified.length > 0) parts.push(`~${diff.modified.length}`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length}`);

  const summary = parts.length > 0 ? parts.join(' ') : 'no record changes';
  // The channel is in the subject because `git log` is the publication history,
  // and "which of the two files did this change" is the first thing you ask of
  // it once there are two.
  const where = build.channel === 'production' ? '' : ` [${build.channel}]`;
  const subject = `Publish r${revision}${where} (${summary})`;

  const signed = build.signedBy ? `\nSigned by key ${build.signedBy}.\n` : '';
  const body = formatDiff(diff);
  return `${subject}\n\n${body}\n${signed}`;
}

export { formatDiff };
