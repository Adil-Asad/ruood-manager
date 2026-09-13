import {
  applyTransition,
  availableTransitions,
  bumpRevision,
  type Transition,
} from '@ruood/announcement-core';
import { validateAnnouncementRecord } from '@ruood/announcement-schema';

import type { CommandContext, CommandResult } from '../main';
import { lifecycleOf, mediaIds, reportIssues, requireRecord, writeRecord } from './shared';

/** `activate` reads better than `publish` for a record, and `publish` is taken. */
const COMMAND_TO_TRANSITION: Record<string, Transition> = {
  activate: 'publish',
  pause: 'pause',
  resume: 'resume',
  archive: 'archive',
  restore: 'restore',
};

export async function runTransition(ctx: CommandContext): Promise<CommandResult> {
  const command = ctx.args.command!;
  const id = ctx.args.positionals[0];

  if (!id) {
    ctx.err(`${command} requires an announcement id.`);
    return 2;
  }

  const found = await requireRecord(ctx, id);
  if (!found) return 1;

  if (command === 'bump') return bump(ctx, found.record, id);

  const transition = COMMAND_TO_TRANSITION[command]!;
  const before = lifecycleOf(found.record, ctx.now);

  let next;
  try {
    next = applyTransition(found.record, transition, ctx.now);
  } catch (error) {
    ctx.err((error as Error).message);
    ctx.err(`"${id}" is ${found.record.status}; available: ${availableTransitions(found.record).join(', ') || 'none'}.`);
    return 1;
  }

  // Activating is the moment a record becomes everyone's problem, so it is
  // validated again here rather than only at build time.
  const result = validateAnnouncementRecord(next, {
    now: ctx.now,
    mode: 'authored',
    // An image-only announcement is valid, and its picture may still be an
    // unencoded original — see `mediaIds`.
    pendingImage: (await mediaIds(ctx)).has(id),
  });
  if (!result.ok && transition === 'publish') {
    ctx.err(`Refused — "${id}" is not valid to publish:`);
    reportIssues(ctx, result.errors, []);
    return 1;
  }

  await writeRecord(ctx, next);

  ctx.out(`"${id}": ${before} -> ${lifecycleOf(next, ctx.now)}`);
  reportIssues(ctx, [], result.warnings);

  if (transition === 'pause') {
    ctx.out('It stays in the manifest carrying paused:true, so resuming needs no re-download.');
  }
  if (transition === 'restore') {
    ctx.out('Restored as a DRAFT — its dates are probably in the past; check them before activating.');
  }
  ctx.out('');
  ctx.out('Nothing has been published yet. Run: announce publish');

  return 0;
}

async function bump(
  ctx: CommandContext,
  record: Parameters<typeof bumpRevision>[0],
  id: string,
): Promise<CommandResult> {
  const next = bumpRevision(record, ctx.now);
  await writeRecord(ctx, next);

  ctx.out(`"${id}": rev ${record.rev} -> ${next.rev}`);
  ctx.out('');
  ctx.out(
    'This RE-SHOWS the announcement to every device that has already seen it — impression ' +
      'counters for this id reset on publish. To correct a typo quietly, edit the record and ' +
      'do not bump.',
  );

  return 0;
}
