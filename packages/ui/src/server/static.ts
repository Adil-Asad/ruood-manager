/**
 * Serving the built client.
 *
 * Hand-rolled rather than `@fastify/static`, for the same reason the CLI's
 * argument parser is hand-rolled: this is a local tool serving a handful of
 * files from one directory it built itself, and the whole job is a path
 * resolution, a MIME lookup and a fallback to `index.html`.
 *
 * The path check is not ceremony. Anything reachable from a browser that joins
 * a URL onto a filesystem path can be walked out of with `..`, and this process
 * runs with the operator's own permissions in a directory next to their
 * repository.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import type { FastifyInstance } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function registerClient(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);

  app.get('/*', async (request, reply) => {
    // The API is registered first, so anything arriving here that looks like a
    // route into it is a call to something that does not exist — answering with
    // index.html would hand the caller HTML where it expected JSON.
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: `No such endpoint: ${request.url}` });
    }

    const file = resolveWithin(root, request.url.split('?')[0] ?? '/');

    if (file && existsSync(file) && statSync(file).isFile()) {
      return reply
        .header('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
        // Hashed asset names make Vite's output safe to cache; index.html is
        // the one file that must always be re-fetched or a rebuilt client is
        // never picked up.
        .header(
          'cache-control',
          file.endsWith('index.html') ? 'no-cache' : 'private, max-age=31536000, immutable',
        )
        .send(createReadStream(file));
    }

    const index = join(root, 'index.html');
    if (!existsSync(index)) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send(
          'The Manager client has not been built.\n\n' +
            'Run: npm run build\n' +
            'or, for the dev server with reloading: npm run ui:dev\n',
        );
    }

    return reply
      .header('content-type', MIME['.html']!)
      .header('cache-control', 'no-cache')
      .send(createReadStream(index));
  });
}

/**
 * A URL path resolved inside `root`, or `null` if it escapes.
 *
 * The containment check compares resolved absolute paths and requires a
 * separator after the root, so `/rootless` cannot pass as a child of `/root`.
 */
export function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const candidate = resolve(root, `.${normalize(decoded)}`);

  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}
