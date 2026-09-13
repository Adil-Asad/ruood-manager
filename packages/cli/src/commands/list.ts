import { flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { lifecycleOf, mediaIds, snapshot, table } from './shared';

export async function runList(ctx: CommandContext): Promise<CommandResult> {
  const content = await snapshot(ctx);
  const filter = flagString(ctx.args, 'status');

  // Which ids have a picture, including one the build has not encoded yet — a
  // record authored on a phone carries no `image` object until it does. Without
  // this an image-only announcement lists as though it had nothing in it.
  const withMedia = await mediaIds(ctx);

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
        titleCell(entry.record, withMedia.has(entry.id)),
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

/**
 * What the TITLE column says.
 *
 * An announcement may be a picture and nothing else, so there is not always a
 * title. The message stands in for it, and a picture with neither says so —
 * rather than leaving a column blank, which reads as data that failed to load.
 */
function titleCell(
  record: { title?: string; body?: string; image?: unknown },
  hasOriginal: boolean,
): string {
  const title = (record.title ?? '').trim();
  if (title) return title;

  const body = (record.body ?? '').replace(/\s+/g, ' ').trim();
  if (body) return body.length > 48 ? `${body.slice(0, 47)}…` : body;

  return record.image || hasOriginal ? '(image only)' : '(no content)';
}
