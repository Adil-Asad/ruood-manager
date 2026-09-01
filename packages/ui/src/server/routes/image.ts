/**
 * Attaching, showing and detaching an announcement image.
 *
 * The upload arrives as raw bytes rather than a multipart form, which keeps the
 * server free of a body-parsing dependency and, more usefully, means the only
 * content types this server will accept on a mutation are two an HTML form
 * cannot produce — see `guards.ts` for why that matters on a loopback port.
 */

import type { FastifyInstance } from 'fastify';

import {
  applyEdits,
  attachImage,
  ImageEncodeError,
  readEncodedImage,
  removeOriginalsFor,
  saveRecord,
  touch,
} from '@ruood/announcement-core';
import { IMAGE_ALT_MAX_LENGTH } from '@ruood/announcement-schema';

import type { ServerContext } from '../context';
import type { ImageAttachResponse, RecordDetail } from '../../shared/api';
import { RequestError, detailOf, findRecord, notFound, snapshotOf } from './helpers';

export function registerImageRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * The encoded bytes, for the preview.
   *
   * The URL carries the content hash, so it is safe to cache for ever: a
   * different image is a different URL. That is the same property the published
   * image name has, and for the same reason.
   */
  app.get<{ Params: { id: string } }>('/api/records/:id/image', async (request, reply) => {
    const snapshot = await snapshotOf(ctx);
    const record = findRecord(snapshot, request.params.id);
    if (!record) throw notFound(request.params.id);

    const bytes = await readEncodedImage(ctx.paths, record);
    if (!bytes) throw new RequestError(404, `"${request.params.id}" has no image to show.`);

    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes);
  });

  app.post<{ Params: { id: string }; Querystring: { filename?: string; alt?: string } }>(
    '/api/records/:id/image',
    async (request): Promise<ImageAttachResponse> => {
      const now = ctx.now();
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      const source = request.body;
      if (!Buffer.isBuffer(source) || source.length === 0) {
        throw new RequestError(400, 'No image data was uploaded.');
      }

      const filename = (request.query.filename ?? '').trim();
      if (!filename) {
        throw new RequestError(
          400,
          'A filename is required — its extension decides how the original is kept.',
        );
      }

      // Alt text is required the first time and inherited afterwards, exactly
      // as `announce image` does it. It is what a screen reader announces, and
      // the only description a user gets if the image fails to load.
      const alt = (request.query.alt ?? '').trim() || record.image?.alt;
      if (!alt) {
        throw new RequestError(
          400,
          'Alt text is required the first time an image is attached.',
        );
      }
      if (alt.length > IMAGE_ALT_MAX_LENGTH) {
        throw new RequestError(400, `Alt text is limited to ${IMAGE_ALT_MAX_LENGTH} characters.`);
      }

      let attached;
      try {
        attached = await attachImage(ctx.paths, { id: record.id, alt, source, filename });
      } catch (error) {
        // An image that will not decode, is too small, is animated, or cannot
        // be squeezed under the byte budget. All of them are the operator's to
        // fix, and the message says which.
        throw new RequestError(422, (error as ImageEncodeError).message);
      }

      const next = touch(record, { image: attached.image }, now);
      await saveRecord(ctx.paths, next);

      return {
        ...detailOf(next, await snapshotOf(ctx), now),
        encoded: {
          width: attached.image.width,
          height: attached.image.height,
          bytes: attached.image.bytes,
          originalBytes: attached.encoded.originalBytes,
          quality: attached.encoded.quality,
        },
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/records/:id/image',
    async (request): Promise<RecordDetail> => {
      const now = ctx.now();
      const snapshot = await snapshotOf(ctx);
      const record = findRecord(snapshot, request.params.id);
      if (!record) throw notFound(request.params.id);

      if (!record.image) {
        throw new RequestError(409, `"${record.id}" has no image attached.`);
      }

      const next = applyEdits(record, { image: null }, now);
      await saveRecord(ctx.paths, next);
      await removeOriginalsFor(ctx.paths, record.id);

      return detailOf(next, await snapshotOf(ctx), now);
    },
  );
}
