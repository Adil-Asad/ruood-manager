import {
  applyEdits,
  EditError,
  idRegistryFrom,
  type RecordEdits,
} from '@ruood/announcement-core';
import {
  validateAnnouncementRecord,
  type Category,
  type DismissBehaviour,
  type Platform,
  type RouteTarget,
  type Surface,
  type Trigger,
} from '@ruood/announcement-schema';

import { flagBool, flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { mediaIds, reportIssues, requireRecord, snapshot, writeRecord } from './shared';

/**
 * Edits a record's content fields.
 *
 * The counterpart of the Manager's editor form, and deliberately the same
 * operation: both call `applyEdits`, which is where the closed set of editable
 * fields lives. `rev`, `status` and `id` are not editable here for the reasons
 * that module spells out — each has its own command precisely so that editing
 * a typo and re-showing a message to a million devices cannot be confused.
 *
 * Nothing is written unless the result validates. A malformed record in
 * `content/` blocks every subsequent build, so refusing at the edit is what
 * stops one bad field from taking publishing down until it is found.
 */
export async function runEdit(ctx: CommandContext): Promise<CommandResult> {
  const id = ctx.args.positionals[0];
  if (!id) {
    ctx.err('edit requires an announcement id.');
    return 2;
  }

  const found = await requireRecord(ctx, id);
  if (!found) return 1;

  let edits: RecordEdits;
  try {
    edits = collectEdits(ctx, found.record);
  } catch (error) {
    ctx.err((error as Error).message);
    return 2;
  }

  if (Object.keys(edits).length === 0) {
    ctx.err('Nothing to change. Pass at least one field — see: announce help');
    return 2;
  }

  let next;
  try {
    next = applyEdits(found.record, edits, ctx.now);
  } catch (error) {
    ctx.err((error as EditError).message);
    return 2;
  }

  const content = await snapshot(ctx);
  const result = validateAnnouncementRecord(next, {
    now: ctx.now,
    mode: 'authored',
    idRegistry: idRegistryFrom(content),
    editingId: id,
    // Clearing the title of an announcement whose picture is the whole message
    // is a legitimate edit. The original says there is one; the `image` object
    // may not exist yet.
    pendingImage: (await mediaIds(ctx)).has(id),
  });

  if (!result.ok) {
    ctx.err(`Refused — the edit would leave "${id}" invalid, and nothing was written:`);
    reportIssues(ctx, result.errors, []);
    return 1;
  }

  await writeRecord(ctx, next);

  ctx.out(`Edited "${id}": ${Object.keys(edits).sort().join(', ')}.`);
  reportIssues(ctx, [], result.warnings);

  ctx.out('');
  if (found.record.status === 'published' || found.record.status === 'paused') {
    ctx.out(
      `"${id}" is ${found.record.status}, so this changes what installs receive on the next ` +
        'publish. It does NOT re-show it to anyone who has already seen it — for that: ' +
        `announce bump ${id}`,
    );
    ctx.out('');
  }
  ctx.out('Run: announce publish');

  return 0;
}

/**
 * Turns flags into an edit set.
 *
 * Only the flags actually passed appear, so an unmentioned field is an
 * unchanged field — the same contract `applyEdits` keeps.
 */
function collectEdits(ctx: CommandContext, record: Parameters<typeof applyEdits>[0]): RecordEdits {
  const edits: RecordEdits = {};
  const { args } = ctx;

  const title = flagString(args, 'title');
  if (title !== null) edits.title = title;

  const body = flagString(args, 'body');
  if (body !== null) edits.body = body;

  const category = flagString(args, 'category');
  if (category !== null) edits.category = category as Category;

  const priority = flagString(args, 'priority');
  if (priority !== null) {
    const value = Number(priority);
    if (!Number.isFinite(value)) throw new Error('--priority must be a number from 0 to 100.');
    edits.priority = value;
  }

  const start = flagString(args, 'start');
  if (start !== null) edits.startAt = start;

  // `--no-end` and `--end` are opposites: one clears the end date, the other
  // sets it. Silently preferring either would be a way to publish a window
  // nobody asked for.
  const end = flagString(args, 'end');
  const noEnd = flagBool(args, 'no-end');
  if (end !== null && noEnd) throw new Error('--end and --no-end are opposites; pass one.');
  if (end !== null) edits.endAt = end;
  if (noEnd) edits.endAt = null;

  const display = { ...record.display };
  let displayChanged = false;

  const surface = flagString(args, 'surface');
  if (surface !== null) {
    display.surface = surface as Surface;
    displayChanged = true;
  }

  const trigger = flagString(args, 'trigger');
  if (trigger !== null) {
    display.trigger = trigger as Trigger;
    displayChanged = true;
  }

  const dismiss = flagString(args, 'dismiss');
  if (dismiss !== null) {
    display.dismiss = dismiss as DismissBehaviour;
    displayChanged = true;
  }

  const maxImpressions = flagString(args, 'max-impressions');
  if (maxImpressions !== null) {
    // "unlimited" spelled out, because `--max-impressions 0` reads as "never
    // show it" and would be a very quiet way to publish nothing.
    display.maxImpressions =
      maxImpressions === 'unlimited' || maxImpressions === 'none' ? null : Number(maxImpressions);
    displayChanged = true;
  }

  const minInterval = flagString(args, 'min-interval');
  if (minInterval !== null) {
    display.minIntervalHours = Number(minInterval);
    displayChanged = true;
  }

  if (displayChanged) edits.display = display;

  const targeting = { ...record.targeting };
  let targetingChanged = false;

  const platforms = flagString(args, 'platforms');
  if (platforms !== null) {
    targeting.platforms = platforms
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) as Platform[];
    targetingChanged = true;
  }

  const minVersion = flagString(args, 'min-version');
  if (minVersion !== null) {
    targeting.minVersion = minVersion === 'none' ? null : minVersion;
    targetingChanged = true;
  }

  const maxVersion = flagString(args, 'max-version');
  if (maxVersion !== null) {
    targeting.maxVersion = maxVersion === 'none' ? null : maxVersion;
    targetingChanged = true;
  }

  if (targetingChanged) edits.targeting = targeting;

  const routeTarget = flagString(args, 'action-route');
  const externalUrl = flagString(args, 'action-external');
  const actionLabel = flagString(args, 'action-label');
  const noAction = flagBool(args, 'no-action');

  if (noAction && (routeTarget !== null || externalUrl !== null)) {
    throw new Error('--no-action cannot be combined with --action-route or --action-external.');
  }
  if (routeTarget !== null && externalUrl !== null) {
    throw new Error('An action is either a route or an external link, not both.');
  }

  if (noAction) {
    edits.action = null;
  } else if (routeTarget !== null || externalUrl !== null) {
    const label = actionLabel ?? record.action?.label;
    if (!label) {
      throw new Error('--action-label <text> is required when setting an action.');
    }
    edits.action =
      routeTarget !== null
        ? { type: 'route', label, target: routeTarget as RouteTarget }
        : { type: 'external', label, target: externalUrl! };
  } else if (actionLabel !== null) {
    if (!record.action) {
      throw new Error('There is no action to relabel. Pass --action-route or --action-external.');
    }
    edits.action = { ...record.action, label: actionLabel };
  }

  const note = flagString(args, 'note');
  if (note !== null) edits.internalNote = note;
  if (flagBool(args, 'no-note')) edits.internalNote = null;

  // Detaching only. Attaching means encoding bytes and hashing them, which is
  // `announce image`.
  if (flagBool(args, 'remove-image')) edits.image = null;

  return edits;
}
