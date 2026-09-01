import { deleteRecord } from '@ruood/announcement-core';

import { flagBool } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { lifecycleOf, paths, requireRecord } from './shared';

/**
 * Removes a record and retires its id.
 *
 * The two are one operation. An id whose file is gone but which is not on the
 * ledger can be handed out again, and a reused id inherits the previous
 * announcement's impression counters on every device that ever saw it — so the
 * replacement silently fails to show for exactly the users paying attention.
 *
 * Archiving is almost always what you want instead, which is why this asks.
 */
export async function runDelete(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0];
  if (!id) {
    ctx.err('delete requires an announcement id.');
    return 2;
  }

  const found = await requireRecord(ctx, id);
  if (!found) return 1;

  if (!flagBool(ctx.args, 'yes')) {
    ctx.err(`"${id}" is ${lifecycleOf(found.record, ctx.now)}.`);
    ctx.err('');
    ctx.err('Deleting is permanent in one specific way: the id can NEVER be used again.');
    ctx.err('If you only want it out of the way, archive it instead — it stays reusable:');
    ctx.err(`  announce archive ${id} --repo <path>`);
    ctx.err('');
    ctx.err(`To go ahead: announce delete ${id} --yes --repo <path>`);
    return 2;
  }

  await deleteRecord(paths(ctx), id);

  ctx.out(`Deleted "${id}" and added it to content/retired-ids.json.`);
  ctx.out('The record is gone from the working tree; git history still has it.');
  ctx.out('');
  ctx.out('Run: announce publish');

  return 0;
}
