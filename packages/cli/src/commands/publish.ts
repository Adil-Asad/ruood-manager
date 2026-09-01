import { formatDiff, publish } from '@ruood/announcement-core';

import { flagBool, flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { channelOf, paths, reportIssues, signingKeyFor } from './shared';

export async function runPublish(ctx: CommandContext): Promise<CommandResult> {
  const wantPause = flagBool(ctx.args, 'pause');
  const wantUnpause = flagBool(ctx.args, 'unpause');

  if (wantPause && wantUnpause) {
    ctx.err('--pause and --unpause are opposites; pass one.');
    return 2;
  }

  const channel = channelOf(ctx);
  if (!channel) return 2;

  const signingKey = await signingKeyFor(ctx);
  if (signingKey === null) return 1;

  const result = await publish(paths(ctx), {
    now: ctx.now,
    channel,
    ...(signingKey ? { signingKey } : {}),
    dryRun: flagBool(ctx.args, 'dry-run'),
    noPush: flagBool(ctx.args, 'no-push'),
    acceptWarnings: flagBool(ctx.args, 'accept-warnings'),
    ...(wantPause ? { paused: true } : {}),
    ...(wantUnpause ? { paused: false } : {}),
    ...(flagString(ctx.args, 'message') ? { message: flagString(ctx.args, 'message')! } : {}),
  });

  reportIssues(ctx, result.build.errors, result.build.warnings, result.build.problems);

  if (result.build.excluded.length > 0) {
    ctx.out('');
    ctx.out('Not published:');
    for (const excluded of result.build.excluded) {
      ctx.out(`  - ${excluded.id} (${excluded.reason})`);
    }
  }

  ctx.out('');
  ctx.out(formatDiff(result.diff));

  switch (result.status) {
    case 'blocked':
      ctx.err('');
      ctx.err(result.blockedBy ?? 'Publishing refused.');
      return 1;

    case 'dry-run':
      ctx.out('');
      ctx.out('Dry run — nothing was written, committed or pushed.');
      return 0;

    case 'no-changes':
      ctx.out('');
      ctx.out('Nothing to publish.');
      return 0;

    case 'committed':
      ctx.out('');
      ctx.out(`Committed ${result.commit?.slice(0, 8)}.`);
      if (result.push && !result.push.pushed) {
        ctx.err(`NOT pushed: ${result.push.detail ?? result.push.reason}`);
        ctx.err('');
        ctx.err(
          'The commit is intact locally — nothing is half-published. Fix the cause and push, ' +
            'or run publish again.',
        );
        // A commit that did not reach anyone is not a success.
        return 1;
      }
      ctx.out('Not pushed (--no-push).');
      return 0;

    case 'published':
      ctx.out('');
      ctx.out(
        `Published ${result.commit?.slice(0, 8)} to ${result.build.channel} at revision ` +
          `${result.diff.revisionTo}` +
          `${result.build.signedBy ? `, signed by ${result.build.signedBy}` : ''}.`,
      );
      ctx.out(
        'Clients pick it up on their next check — at most one fetch every 6 hours per install.',
      );
      return 0;
  }
}
