/**
 * Validate, build, publish — and the git operations around them.
 *
 * `publish` is `core`'s `publish`, with one thing the CLI does not have to
 * arrange: the browser asks twice. A dry run computes the diff and writes
 * nothing; the operator reads it; a second request with `dryRun: false` does
 * the work. That is the CLI's confirmation prompt, moved to where a person can
 * actually read the list of records about to disappear.
 *
 * Nothing here decides anything on its own. `publish` refuses on errors,
 * refuses on unaccepted warnings, and writes nothing until both have passed —
 * this route only carries the answer back.
 */

import type { FastifyInstance } from 'fastify';

import {
  AnnouncementRepo,
  buildManifest,
  publish,
  saveState,
  writeBuild,
  type BuildResult,
} from '@ruood/announcement-core';

import type { ServerContext } from '../context';
import type {
  BuildSummary,
  GitLogEntry,
  PublishRequest,
  PublishResponse,
  PushOutcome,
  RevertRequest,
} from '../../shared/api';
import { RequestError } from './helpers';

export function registerPublishRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * The whole pipeline, writing nothing — including the revision counter.
   *
   * `keepRevision` is why: running validate twice must not advance the number
   * that will appear in a published manifest.
   */
  app.post('/api/validate', async (): Promise<BuildSummary> => {
    const result = await buildManifest(ctx.paths, { now: ctx.now(), keepRevision: true });
    return summarise(result);
  });

  /** Writes `dist/` without committing. */
  app.post('/api/build', async (): Promise<BuildSummary> => {
    const result = await buildManifest(ctx.paths, { now: ctx.now() });

    if (!result.ok) {
      // Same refusal the CLI makes, and for the same reason: a build that
      // cannot be published is a build that should not reach the working tree.
      return summarise(result);
    }

    await writeBuild(ctx.paths, result);
    await saveState(ctx.paths, { revision: result.manifest.revision });

    return summarise(result);
  });

  app.post<{ Body: PublishRequest }>('/api/publish', async (request): Promise<PublishResponse> => {
    const body = request.body ?? ({ dryRun: true } as PublishRequest);

    // Defaulting to a dry run is deliberate. A malformed request should never
    // be the one that commits and pushes.
    const dryRun = body.dryRun !== false;

    const result = await publish(ctx.paths, {
      now: ctx.now(),
      dryRun,
      ...(body.acceptWarnings ? { acceptWarnings: true } : {}),
      ...(body.noPush ? { noPush: true } : {}),
      // Omitted means "leave it as it is": the kill switch is sticky, and an
      // ordinary publish must never quietly turn it off.
      ...(typeof body.paused === 'boolean' ? { paused: body.paused } : {}),
      ...(body.message ? { message: body.message } : {}),
    });

    return {
      status: result.status,
      ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
      ...(result.commit ? { commit: result.commit } : {}),
      ...(result.push ? { push: result.push } : {}),
      build: summarise(result.build),
      diff: result.diff,
    };
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/git/log',
    async (request): Promise<GitLogEntry[]> => {
      const limit = Number(request.query.limit ?? 20);
      const repo = await usableRepo(ctx);
      return repo.log(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20);
    },
  );

  /**
   * Pushes commits that are already made.
   *
   * `publish` pushes for you; this is only for what it leaves behind when the
   * network was down — committed locally, not pushed. Running publish again
   * would not retry it, because a second run finds nothing to publish.
   */
  app.post('/api/git/push', async (): Promise<PushOutcome> => {
    return (await usableRepo(ctx)).push();
  });

  /**
   * Undoes a publish by adding a commit, never by rewriting history.
   *
   * This is the rollback the architecture promises, and it works precisely
   * because a publish is one commit: reverting it takes the manifest and every
   * image back together.
   */
  app.post<{ Body: RevertRequest }>('/api/git/revert', async (request) => {
    const commit = (request.body?.commit ?? '').trim();
    if (!commit) throw new RequestError(400, 'A commit to revert is required.');

    const repo = await usableRepo(ctx);

    try {
      const created = await repo.revert(commit);
      return { reverted: commit, commit: created };
    } catch (error) {
      throw new RequestError(
        409,
        `The revert did not apply: ${(error as Error).message}. The repository has been left ` +
          'as it is — a half-finished revert is something to look at, not to paper over.',
      );
    }
  });
}

async function usableRepo(ctx: ServerContext): Promise<AnnouncementRepo> {
  const repo = new AnnouncementRepo(ctx.root);
  if (!(await repo.isRepository())) {
    throw new RequestError(409, `${ctx.root} is not a git repository. Publishing needs one.`);
  }
  return repo;
}

/**
 * `BuildResult` minus the bytes.
 *
 * It carries `imageFiles`, a `Map<string, Buffer>` of every encoded image —
 * megabytes of payload and none of the answer to "would this publish".
 */
function summarise(result: BuildResult): BuildSummary {
  return {
    ok: result.ok,
    revision: result.manifest.revision,
    bytes: result.bytes,
    records: result.manifest.announcements.length,
    images: result.imageFiles.size,
    excluded: result.excluded,
    errors: result.errors,
    warnings: result.warnings,
    problems: result.problems,
  };
}
