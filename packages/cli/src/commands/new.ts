import { createRecord, idRegistryFrom } from '@ruood/announcement-core';
import {
  checkIdAvailable,
  checkIdFormat,
  suggestId,
  validateAnnouncementRecord,
  type AuthoredAnnouncement,
  type Category,
  type Surface,
} from '@ruood/announcement-schema';

import { flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { reportIssues, snapshot, writeRecord } from './shared';

export async function runNew(ctx: CommandContext): Promise<CommandResult> {
  const title = flagString(ctx.args, 'title');
  const body = flagString(ctx.args, 'body');

  if (!title || !body) {
    ctx.err('new requires --title and --body.');
    return 2;
  }

  const id = ctx.args.positionals[0] ?? suggestId(title);
  if (!id) {
    ctx.err('No id given, and none could be derived from the title. Pass one explicitly.');
    return 2;
  }

  const format = checkIdFormat(id);
  if (!format.ok) {
    ctx.err(
      `"${id}" is not a usable id (${format.problem}). Use lowercase words joined by single ` +
        'hyphens, 3-64 characters.',
    );
    return 2;
  }

  const content = await snapshot(ctx);
  const availability = checkIdAvailable(id, idRegistryFrom(content));

  if (!availability.available) {
    ctx.err(
      availability.reason === 'duplicate'
        ? `"${id}" is already in use.`
        : `"${id}" belonged to a deleted announcement and can never be reused — devices that saw ` +
            'the original still hold its impression count under that id.',
    );
    return 1;
  }

  const record: AuthoredAnnouncement = createRecord({
    id,
    title,
    body,
    now: ctx.now,
    ...(flagString(ctx.args, 'start') ? { startAt: flagString(ctx.args, 'start')! } : {}),
    ...(flagString(ctx.args, 'end') ? { endAt: flagString(ctx.args, 'end')! } : {}),
  });

  const surface = flagString(ctx.args, 'surface');
  if (surface) record.display = { ...record.display, surface: surface as Surface };

  const category = flagString(ctx.args, 'category');
  if (category) record.category = category as Category;

  const priority = flagString(ctx.args, 'priority');
  if (priority) record.priority = Number(priority);

  // Validate before writing, so a malformed record never reaches content/ and
  // then blocks every subsequent build.
  const result = validateAnnouncementRecord(record, {
    now: ctx.now,
    mode: 'authored',
    idRegistry: idRegistryFrom(content),
    editingId: id,
  });

  if (!result.ok) {
    ctx.err(`Refused — the record would not be valid:`);
    reportIssues(ctx, result.errors, []);
    return 1;
  }

  await writeRecord(ctx, record);

  ctx.out(`Created draft "${id}".`);
  ctx.out(`  content/announcements/${id}.json`);
  reportIssues(ctx, [], result.warnings);
  ctx.out('');
  ctx.out(`It is a DRAFT and will not be published. When it is ready: announce activate ${id}`);

  return 0;
}
