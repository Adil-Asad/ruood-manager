import { AnnouncementRepo } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';

/**
 * Undoes a publish by adding a commit, never by rewriting history.
 *
 * This is the rollback path the architecture promises, and it is why publishing
 * is one commit: reverting one commit takes the manifest and every image back
 * together, atomically. It is also why nothing here force-pushes.
 */
export async function runRevert(ctx: CommandContext): Promise<CommandResult> {
  const commit = ctx.args.positionals[0];
  if (!commit) {
    ctx.err('revert requires a commit to undo. Recent publishes:');
    const recent = await new AnnouncementRepo(ctx.repoRoot).log(10);
    for (const entry of recent) {
      ctx.err(`  ${entry.hash}  ${entry.message.split('\n')[0]}`);
    }
    return 2;
  }

  const repo = new AnnouncementRepo(ctx.repoRoot);
  const created = await repo.revert(commit);

  ctx.out(`Reverted ${commit} in ${created.slice(0, 8)}.`);
  ctx.out('');
  ctx.out(
    'dist/ and content/ are both back to their previous state. Push to make it real: the ' +
      'revert is only local until then.',
  );
  ctx.out(
    'Note that content/state.json went back too, so the next publish reuses that revision ' +
      'number. That is intended — revision tracks what is published, not how many times you ' +
      'have published.',
  );

  return 0;
}
