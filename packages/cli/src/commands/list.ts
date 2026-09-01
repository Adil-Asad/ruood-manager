import { flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { lifecycleOf, snapshot, table } from './shared';

export async function runList(ctx: CommandContext): Promise<CommandResult> {
  const content = await snapshot(ctx);
  const filter = flagString(ctx.args, 'status');

  if (content.failures.length > 0) {
    ctx.err(`${content.failures.length} file(s) in content/ could not be read:`);
    for (const failure of content.failures) ctx.err(`  ${failure.file}: ${failure.error}`);
    ctx.err('');
  }

  const rows = content.records
    .map((entry) => ({ entry, state: lifecycleOf(entry.record, ctx.now) }))
    .filter(({ state }) => !filter || state === filter)
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || compare(a.entry.id, b.entry.id));

  if (rows.length === 0) {
    ctx.out(filter ? `No announcements are "${filter}".` : 'No announcements yet.');
    return 0;
  }

  ctx.out(
    table([
      ['STATE', 'ID', 'REV', 'SURFACE', 'PRIORITY', 'WINDOW', 'TITLE'],
      ...rows.map(({ entry, state }) => [
        state,
        entry.id,
        `r${entry.record.rev}`,
        entry.record.display.surface,
        String(entry.record.priority),
        window(entry.record.startAt, entry.record.endAt),
        entry.record.title,
      ]),
    ]),
  );

  const counts = new Map<string, number>();
  for (const { state } of rows) counts.set(state, (counts.get(state) ?? 0) + 1);

  ctx.out('');
  ctx.out(
    [...counts.entries()]
      .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
      .map(([state, count]) => `${state} ${count}`)
      .join('   '),
  );

  if (content.retiredIds.length > 0) {
    ctx.out(`retired ids (never reusable): ${content.retiredIds.length}`);
  }

  return 0;
}

/** Most actionable first: what is live, then what is coming, then the rest. */
const ORDER = ['active', 'scheduled', 'paused', 'draft', 'expired', 'archived'];

function window(startAt: string, endAt: string | null | undefined): string {
  const start = startAt.slice(0, 10);
  return endAt ? `${start} .. ${endAt.slice(0, 10)}` : `${start} .. never`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
