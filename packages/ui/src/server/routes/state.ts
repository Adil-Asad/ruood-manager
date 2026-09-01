/**
 * `GET /api/state` — everything the shell shows, in one request.
 *
 * The CLI answers this question with `status` and `list` and expects you to run
 * both. A screen cannot ask twice and render once, and two requests would let
 * the counts and the git state disagree by however long the second took. So
 * this is deliberately one call over one `loadContent`.
 */

import type { FastifyInstance } from 'fastify';

import { AnnouncementRepo, readPublished } from '@ruood/announcement-core';
import { toCanonicalInstant, type LifecycleStatus } from '@ruood/announcement-schema';

import type { ServerContext } from '../context';
import type { GitState, ManagerState } from '../../shared/api';
import { snapshotOf, summarise } from './helpers';

export function registerStateRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/health', async () => ({ ok: true, root: ctx.root }));

  app.get('/api/state', async (): Promise<ManagerState> => {
    const now = ctx.now();
    const snapshot = await snapshotOf(ctx);
    const published = await readPublished(ctx.paths);
    const records = summarise(snapshot, now);

    const counts: Partial<Record<LifecycleStatus, number>> = {};
    for (const record of records) {
      counts[record.lifecycle] = (counts[record.lifecycle] ?? 0) + 1;
    }

    return {
      repo: { root: ctx.root, name: ctx.name },
      now: toCanonicalInstant(now),
      records,
      counts,
      failures: snapshot.failures,
      retiredIds: snapshot.retiredIds,
      contentRevision: snapshot.revision,
      published: published.manifest
        ? {
            revision: published.manifest.revision,
            bytes: published.bytes,
            records: published.manifest.announcements.length,
            images: Object.keys(published.images).length,
            generatedAt: published.manifest.generatedAt,
            paused: published.manifest.paused,
          }
        : null,
      git: await gitState(ctx),
      // The same check `announce status` makes: the counter content/ believes
      // in has moved past the one dist/ was built at, so dist/ is behind.
      distStale: snapshot.revision !== (published.manifest?.revision ?? 0),
    };
  });
}

/**
 * Git state, or the reason there is none.
 *
 * A directory that was never `init`ed is an ordinary state for a new operator
 * to be in, and the dashboard should say so and offer the fix — not fail.
 */
async function gitState(ctx: ServerContext): Promise<GitState> {
  const repo = new AnnouncementRepo(ctx.root);

  try {
    if (!(await repo.isRepository())) {
      return {
        ok: false,
        reason:
          (await repo.isInsideAnotherRepository())
            ? 'This directory sits inside another git repository but is not one itself. ' +
              'Publishing here would commit into the enclosing project.'
            : 'Not a git repository. Publishing needs one.',
      };
    }

    return { ok: true, status: await repo.status() };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
