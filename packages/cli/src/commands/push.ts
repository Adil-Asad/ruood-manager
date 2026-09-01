import { AnnouncementRepo } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';

/**
 * Pushes commits that are already made.
 *
 * `publish` pushes for you, so this is only for the state it leaves behind when
 * the network was down: committed locally, not pushed. That state is not a
 * failure — the unit of publication is the commit — but it means no install has
 * the change yet, and `publish` will not retry the push on its own because a
 * second run finds nothing to publish.
 *
 * It rebases once on rejection and never forces, because it is the same
 * `AnnouncementRepo.push` the publish path uses.
 */
export async function runPush(ctx: CommandContext): Promise<CommandResult> {
  const repo = new AnnouncementRepo(ctx.repoRoot);

  if (!(await repo.isRepository())) {
    ctx.err(`${ctx.repoRoot} is not a git repository. Run: announce init`);
    return 1;
  }

  const before = await repo.status();
  if (before.hasRemote && before.ahead === 0) {
    ctx.out('Nothing to push — the remote already has every local commit.');
    return 0;
  }

  const outcome = await repo.push();

  if (!outcome.pushed) {
    ctx.err(`NOT pushed: ${outcome.detail ?? outcome.reason}`);
    ctx.err('');
    ctx.err('Your commits are intact locally. Nothing is half-published.');
    return 1;
  }

  ctx.out(`Pushed ${before.ahead || 'the outstanding'} commit(s) to origin/${before.branch}.`);
  ctx.out('Clients pick it up on their next check — at most one fetch every 6 hours per install.');

  return 0;
}
