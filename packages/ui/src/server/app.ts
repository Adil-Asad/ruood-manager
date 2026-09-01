/**
 * The Manager's server.
 *
 * A thin local process doing the three things a browser cannot: the
 * filesystem, git, and `sharp`. It holds no state of its own — every route
 * reads `content/` fresh and writes it back through `core` — because the
 * repository is the system of record and a server-side cache would be a second
 * copy to disagree with it.
 *
 * `createApp` builds the instance without listening, so the tests drive it
 * through `inject()` over a real temporary repository. `bin.ts` is the only
 * place that opens a socket.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { EditError, ImageEncodeError, TransitionError } from '@ruood/announcement-core';
import { CanonicalJsonError } from '@ruood/announcement-schema';

import { createContext, type ServerContext } from './context';
import { checkRequest } from './guards';
import { registerStateRoutes } from './routes/state';
import { registerRecordRoutes } from './routes/records';
import { registerImageRoutes } from './routes/image';
import { registerPublishRoutes } from './routes/publish';
import { RequestError } from './routes/helpers';
import { registerClient } from './static';

export interface AppOptions {
  /** The announcements repository. Chosen once, for the life of the process. */
  root: string;
  /** Injected so tests can pin the clock; nothing under `src/` reads it directly. */
  now?: () => number;
  /**
   * Origins a browser may make requests from. The server's own origin is added
   * automatically; the Vite dev server is added by `bin.ts --dev`.
   */
  allowedOrigins?: readonly string[];
  /** Where the built client lives. Omitted means API only. */
  webRoot?: string;
  logger?: boolean;
}

/**
 * An original can be a few megabytes before it is encoded down to 150 KB, and
 * refusing one at the door with a bare 413 would be a worse message than the
 * encoder's own.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export function createApp(options: AppOptions): FastifyInstance & { ctx: ServerContext } {
  const ctx = createContext(options.root, options.now ?? Date.now);

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_UPLOAD_BYTES,
  });

  // Raw image bytes. Fastify has no parser for this type by default, and the
  // alternative — a multipart form — would mean a dependency and a content
  // type that a cross-site form post can also produce.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  const allowedOrigins = [...(options.allowedOrigins ?? [])];

  app.addHook('onRequest', async (request, reply) => {
    const verdict = checkRequest(
      {
        method: request.method,
        host: request.headers.host,
        origin: request.headers.origin,
        contentType: request.headers['content-type'],
      },
      originsFor(request.headers.host, allowedOrigins),
    );

    if (!verdict.ok) {
      await reply.code(verdict.status).send({ error: verdict.reason });
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = statusFor(error);
    return reply.code(mapped.status).send({
      error: mapped.message,
      ...(mapped.issues ? { issues: mapped.issues } : {}),
    });
  });

  registerStateRoutes(app, ctx);
  registerRecordRoutes(app, ctx);
  registerImageRoutes(app, ctx);
  registerPublishRoutes(app, ctx);

  if (options.webRoot) registerClient(app, options.webRoot);

  return Object.assign(app, { ctx });
}

/**
 * The origins this request may have come from.
 *
 * Its own, derived from the `Host` header the guard has already established is
 * loopback — so the port does not have to be known in advance — plus whatever
 * was configured.
 */
function originsFor(host: string | undefined, configured: readonly string[]): string[] {
  return host ? [`http://${host}`, `https://${host}`, ...configured] : [...configured];
}

/**
 * Which failures are the operator's and which are ours.
 *
 * The distinction is worth keeping: a 4xx is something to fix in the form, a
 * 500 is a bug here. `core`'s own error types carry that meaning already, so
 * they are mapped rather than re-tested.
 */
function statusFor(error: unknown): { status: number; message: string; issues?: unknown[] } {
  if (error instanceof RequestError) {
    return {
      status: error.status,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }

  // A field only another operation may write, an illegal lifecycle move, an
  // image that will not encode: all refusals, all the caller's to correct.
  if (error instanceof EditError) return { status: 400, message: error.message };
  if (error instanceof TransitionError) return { status: 409, message: error.message };
  if (error instanceof ImageEncodeError) return { status: 422, message: error.message };
  if (error instanceof CanonicalJsonError) return { status: 422, message: error.message };

  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, message: (error as Error).message };
  }

  return {
    status: 500,
    message: (error as Error).message || 'The Manager failed to handle that.',
  };
}
