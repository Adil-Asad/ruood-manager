/**
 * The record routes: create, read, edit, transition, bump, delete.
 *
 * Every one of them is the CLI command of the same name with a different
 * surface. `new` is `createRecord`, `edit` is `applyEdits`, `activate` is
 * `applyTransition`, `bump` is `bumpRevision`, `delete` is `deleteRecord` — the
 * Manager adds no lifecycle rules of its own, because a second implementation
 * of "what archive means" is a second thing to keep in step.
 */

import type { FastifyInstance } from 'fastify';

import {
  applyEdits,
  applyTransition,
  bumpRevision,
  createRecord,
  deleteRecord,
  EditError,
  idRegistryFrom,
  loadRetiredIds,
  saveRecord,
  TransitionError,
  type RecordEdits,
} from '@ruood/announcement-core';
import {
  checkIdAvailable,
  checkIdFormat,
  nextAvailableId,
  suggestId,
  type Category,
  type Surface,
} from '@ruood/announcement-schema';

import type { ServerContext } from '../context';
import type {
  DeleteRecordRequest,
  DeleteRecordResponse,
  EditRecordRequest,
  IdCheckResponse,
  NewRecordRequest,
  RecordDetail,
  TransitionRequest,
} from '../../shared/api';
import { RequestError, detailOf, findRecord, notFound, snapshotOf, validateOne } from './helpers';

export function registerRecordRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * Whether an id can be used, and what to use instead if not.
   *
   * The "new announcement" form asks as you type, because the two ways an id
   * can be unavailable have different fixes: a duplicate can be renamed, and a
   * retired one can never be had at all.
   */
  app.get<{ Querystring: { id?: string } }>(
    '/api/id-check',
    async (request): Promise<IdCheckResponse> => {
      const id = (request.query.id ?? '').trim();
      const format = checkIdFormat(id);

      if (!format.ok) {
        return { id, available: false, reason: 'format', suggestion: suggestId(id) };
      }

      const registry = idRegistryFrom(await snapshotOf(ctx));
      const availability = checkIdAvailable(id, registry);

      return availability.available
        ? { id, available: true, suggestion: null }
        : {
            id,
            available: false,
            reason: availability.reason,
            suggestion: nextAvailableId(id, registry),
          };
    },
  );

  app.get<{ Params: { id: string } }>('/api/records/:id', async (request): Promise<RecordDetail> => {
    const snapshot = await snapshotOf(ctx);
    const record = findRecord(snapshot, request.params.id);
    if (!record) throw notFound(request.params.id);

    return detailOf(record, snapshot, ctx.now());
  });

  app.post<{ Body: NewRecordRequest }>('/api/records', async (request, reply) => {
    const now = ctx.now();
    const body = request.body ?? ({} as NewRecordRequest);

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';

    if (!title || !text) {
      throw new RequestError(400, 'A new announcement needs a title and a body.');
    }

    const id = (typeof body.id === 'string' && body.id.trim()) || suggestId(title);
    if (!id) {
      throw new RequestError(
        400,
        'No id was given and none could be derived from the title. Type one.',
      );
    }

    const format = checkIdFormat(id);
    if (!format.ok) {
      throw new RequestError(
        400,
        `"${id}" is not a usable id (${format.problem}). Lowercase words joined by single ` +
          'hyphens, 3-64 characters.',
      );
    }

    const snapshot = await snapshotOf(ctx);
    const availability = checkIdAvailable(id, idRegistryFrom(snapshot));

    if (!availability.available) {
      throw new RequestError(
        409,
        availability.reason === 'duplicate'
          ? `"${id}" is already in use.`
          : `"${id}" belonged to a deleted announcement and can never be reused — devices that ` +
            'saw the original still hold its impression count under that id.',
      );
    }

    const record = createRecord({
      id,
      title,
      body: text,
      now,
      ...(body.startAt ? { startAt: body.startAt } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
    });

    if (body.surface) record.display = { ...record.display, surface: body.surface as Surface };
    if (body.category) record.category = body.category as Category;
    if (typeof body.priority === 'number') record.priority = body.priority;

    // Validated before writing, so a malformed record never lands in content/
    // and blocks every subsequent build.
    const result = validateOne(record, snapshot, now);
    if (!result.ok) {
      throw new RequestError(422, 'The record would not be valid.', result.errors);
    }

    await saveRecord(ctx.paths, record);

    reply.code(201);
    return detailOf(record, await snapshotOf(ctx), now);
  });

  app.patch<{ Params: { id: string }; Body: EditRecordRequest }>(
    '/api/records/:id',
    async (request): Promise<RecordDetail> => {
      const now = ctx.now();
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      const edits = request.body?.edits;
      if (!edits || typeof edits !== 'object' || Array.isArray(edits)) {
        throw new RequestError(400, 'An edit needs an "edits" object.');
      }

      let next;
      try {
        next = applyEdits(record, edits as RecordEdits, now);
      } catch (error) {
        // `applyEdits` refuses id, status and rev. Reaching here means the
        // browser asked for something only another operation may do.
        throw new RequestError(400, (error as EditError).message);
      }

      const result = validateOne(next, snapshot, now);
      if (!result.ok) {
        throw new RequestError(
          422,
          'The edit would leave the record invalid, so nothing was written.',
          result.errors,
        );
      }

      await saveRecord(ctx.paths, next);
      return detailOf(next, await snapshotOf(ctx), now);
    },
  );

  app.post<{ Params: { id: string }; Body: TransitionRequest }>(
    '/api/records/:id/transition',
    async (request): Promise<RecordDetail> => {
      const now = ctx.now();
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      let next;
      try {
        next = applyTransition(record, request.body?.transition, now);
      } catch (error) {
        throw new RequestError(409, (error as TransitionError).message);
      }

      // Activating is the moment a record becomes everyone's problem, so it is
      // validated again here rather than only at build time.
      const result = validateOne(next, snapshot, now);
      if (!result.ok && request.body.transition === 'publish') {
        throw new RequestError(
          422,
          'Refused — this record is not valid to publish.',
          result.errors,
        );
      }

      await saveRecord(ctx.paths, next);
      return detailOf(next, await snapshotOf(ctx), now);
    },
  );

  /**
   * The re-show switch, on its own route.
   *
   * It is not an edit and it is not reachable from the editor form, because
   * bumping `rev` resets impression counters on every device that has seen the
   * announcement. Correcting a typo and deciding a million installs should look
   * again are different intentions.
   */
  app.post<{ Params: { id: string } }>(
    '/api/records/:id/bump',
    async (request): Promise<RecordDetail> => {
      const now = ctx.now();
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      const next = bumpRevision(record, now);
      await saveRecord(ctx.paths, next);

      return detailOf(next, await snapshotOf(ctx), now);
    },
  );

  app.delete<{ Params: { id: string }; Body: DeleteRecordRequest }>(
    '/api/records/:id',
    async (request): Promise<DeleteRecordResponse> => {
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      if (request.body?.acknowledgeIdRetired !== true) {
        throw new RequestError(
          400,
          'Deleting retires this id for ever. Confirm with acknowledgeIdRetired: true, or ' +
            'archive the record instead — an archived record keeps its id and can come back.',
        );
      }

      await deleteRecord(ctx.paths, request.params.id);

      return {
        deleted: request.params.id,
        retiredIds: await loadRetiredIds(ctx.paths),
      };
    },
  );
}
