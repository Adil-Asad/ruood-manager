/**
 * The server, driven through `inject` against a real temporary repository.
 *
 * No mocks. Every test scaffolds a repository, calls the routes a browser would
 * call, and asserts on what ended up in `content/` — because the questions
 * worth asking here are exactly the ones a mocked `core` would answer wrongly:
 * whether a refused edit really wrote nothing, and whether a dry run really
 * left the working tree alone.
 */

import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import sharp from 'sharp';

import { AnnouncementRepo, scaffoldRepository } from '@ruood/announcement-core';
import type { AuthoredAnnouncement } from '@ruood/announcement-schema';

import { createApp } from '../app';
import { checkRequest, hostnameOf } from '../guards';
import { resolveWithin } from '../static';

jest.setTimeout(60000);

const NOW = Date.parse('2026-09-15T12:00:00Z');

type App = ReturnType<typeof createApp>;

async function withServer(fn: (app: App, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ruood-ui-'));
  await scaffoldRepository(root);

  const git = new AnnouncementRepo(root);
  await git.setIdentity('Test', 'test@example.com');
  await git.commitPaths(['.'], 'Initial');

  const app = createApp({ root, now: () => NOW });

  try {
    await fn(app, root);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function createRecord(app: App, id: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/records',
    payload: { id, title: 'A title', body: 'A body.', ...overrides },
  });
}

async function storedRecord(root: string, id: string): Promise<AuthoredAnnouncement> {
  return JSON.parse(
    await readFile(join(root, 'content', 'announcements', `${id}.json`), 'utf8'),
  ) as AuthoredAnnouncement;
}

async function samplePng(width = 800, height = 450): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 170, b: 90 } },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------

describe('the request guard', () => {
  it('reads a hostname out of every Host header form', () => {
    expect(hostnameOf('127.0.0.1:4874')).toBe('127.0.0.1');
    expect(hostnameOf('localhost')).toBe('localhost');
    expect(hostnameOf('[::1]:4874')).toBe('[::1]');
    expect(hostnameOf(undefined)).toBeNull();
  });

  it('refuses a Host that is not loopback, which is what rebinding looks like', () => {
    const verdict = checkRequest(
      { method: 'GET', host: 'manager.evil.example', origin: undefined, contentType: undefined },
      [],
    );

    expect(verdict).toMatchObject({ ok: false, status: 403 });
    expect(verdict.ok === false && verdict.reason).toContain('rebinding');
  });

  it('refuses a cross-site origin', () => {
    expect(
      checkRequest(
        {
          method: 'GET',
          host: '127.0.0.1:4874',
          origin: 'https://evil.example',
          contentType: undefined,
        },
        ['http://127.0.0.1:4874'],
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('allows a request with no Origin at all — that is an address bar', () => {
    expect(
      checkRequest(
        { method: 'GET', host: '127.0.0.1:4874', origin: undefined, contentType: undefined },
        [],
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
    undefined,
  ])('refuses a mutation sent as %s, which is what a form can produce', (contentType) => {
    expect(
      checkRequest(
        { method: 'POST', host: '127.0.0.1:4874', origin: undefined, contentType },
        [],
      ),
    ).toMatchObject({ ok: false, status: 415 });
  });

  it('accepts the two types a form cannot produce', () => {
    for (const contentType of ['application/json', 'application/octet-stream']) {
      expect(
        checkRequest(
          { method: 'POST', host: '127.0.0.1:4874', origin: undefined, contentType },
          [],
        ),
      ).toEqual({ ok: true });
    }
  });

  it('enforces all of it on the live server', async () => {
    await withServer(async (app) => {
      const rebinding = await app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { host: 'manager.evil.example' },
      });
      expect(rebinding.statusCode).toBe(403);

      const crossSite = await app.inject({
        method: 'GET',
        url: '/api/state',
        headers: { origin: 'https://evil.example' },
      });
      expect(crossSite.statusCode).toBe(403);
    });
  });
});

describe('serving the client', () => {
  const root = join(tmpdir(), 'web');

  it('never resolves a request outside the web root', () => {
    // `normalize` collapses a leading `..` rather than walking above the root,
    // so these land harmlessly inside it. The property worth asserting is the
    // outcome — contained, or refused — not which of the two mechanisms did it.
    for (const attempt of [
      '/../../secrets',
      '/%2e%2e/%2e%2e/secrets',
      '/../webother/x',
      '/assets/../../../../etc/passwd',
    ]) {
      const resolved = resolveWithin(root, attempt);
      if (resolved !== null) {
        expect(resolved.startsWith(root + sep)).toBe(true);
      }
    }
  });

  it('resolves an ordinary asset path', () => {
    expect(resolveWithin(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveWithin(root, '/')).toBe(root);
  });

  it('refuses input that cannot be decoded, or that smuggles a NUL', () => {
    expect(resolveWithin(root, '/%ZZ')).toBeNull();
    expect(resolveWithin(root, '/a\0b')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  it('answers for an empty repository without failing', async () => {
    await withServer(async (app, root) => {
      const response = await app.inject({ method: 'GET', url: '/api/state' });
      expect(response.statusCode).toBe(200);

      const state = response.json();
      expect(state.repo.root).toBe(root);
      expect(state.records).toEqual([]);
      expect(state.now).toBe('2026-09-15T12:00:00Z');
      expect(state.git.ok).toBe(true);
      // Scaffolding writes a valid empty manifest so a client fetching before
      // the first publish reads a well-formed file rather than a 404.
      expect(state.published.revision).toBe(0);
    });
  });

  it('counts by derived lifecycle state, not by stored status', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'live-now');
      await createRecord(app, 'starts-later', { startAt: '2026-12-01T00:00:00Z' });

      for (const id of ['live-now', 'starts-later']) {
        await app.inject({
          method: 'POST',
          url: `/api/records/${id}/transition`,
          payload: { transition: 'publish' },
        });
      }

      const state = (await app.inject({ method: 'GET', url: '/api/state' })).json();

      // Both are stored as "published"; only the dates tell them apart.
      expect(state.counts).toEqual({ active: 1, scheduled: 1 });
    });
  });

  it('surfaces a file that will not parse rather than swallowing it', async () => {
    await withServer(async (app, root) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(root, 'content', 'announcements', 'broken.json'), '{ not json', 'utf8');

      const state = (await app.inject({ method: 'GET', url: '/api/state' })).json();
      expect(state.failures).toHaveLength(1);
      expect(state.failures[0].file).toContain('broken.json');
    });
  });
});

describe('id availability', () => {
  it('separates a duplicate from a retired id, because the fixes differ', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'taken');

      const duplicate = (
        await app.inject({ method: 'GET', url: '/api/id-check?id=taken' })
      ).json();
      expect(duplicate).toMatchObject({ available: false, reason: 'duplicate' });
      // A duplicate has an answer: use another id.
      expect(duplicate.suggestion).toBe('taken-2');

      await app.inject({
        method: 'DELETE',
        url: '/api/records/taken',
        payload: { acknowledgeIdRetired: true },
      });

      const retired = (await app.inject({ method: 'GET', url: '/api/id-check?id=taken' })).json();
      expect(retired).toMatchObject({ available: false, reason: 'retired' });
    });
  });

  it('rejects a malformed id and suggests a usable form', async () => {
    await withServer(async (app) => {
      const result = (
        await app.inject({ method: 'GET', url: '/api/id-check?id=Reports%20Center' })
      ).json();

      expect(result).toMatchObject({ available: false, reason: 'format' });
      expect(result.suggestion).toBe('reports-center');
    });
  });
});

describe('creating a record', () => {
  it('creates a draft with the cautious defaults', async () => {
    await withServer(async (app, root) => {
      const response = await createRecord(app, 'reports-center');
      expect(response.statusCode).toBe(201);

      const detail = response.json();
      expect(detail.record.status).toBe('draft');
      expect(detail.lifecycle).toBe('draft');
      expect(detail.record.rev).toBe(1);
      expect(detail.record.display.trigger).toBe('next-launch');
      expect(detail.record.targeting.platforms).toEqual(['android', 'ios']);
      expect(detail.transitions).toEqual(['publish', 'archive']);

      expect((await storedRecord(root, 'reports-center')).title).toBe('A title');
    });
  });

  it('refuses a retired id and explains why it can never come back', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'gone');
      await app.inject({
        method: 'DELETE',
        url: '/api/records/gone',
        payload: { acknowledgeIdRetired: true },
      });

      const response = await createRecord(app, 'gone');
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('impression count');
    });
  });

  it('derives an id from the title when none is given', async () => {
    await withServer(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/records',
        payload: { title: 'Reports Center', body: 'Eight new reports.' },
      });

      expect(response.json().record.id).toBe('reports-center');
    });
  });

  it('writes nothing when the record would not be valid', async () => {
    await withServer(async (app, root) => {
      const response = await createRecord(app, 'too-long', { title: 'x'.repeat(200) });

      expect(response.statusCode).toBe(422);
      expect(response.json().issues[0].code).toBe('text-too-long');
      expect(existsSync(join(root, 'content', 'announcements', 'too-long.json'))).toBe(false);
    });
  });
});

describe('editing a record', () => {
  it('writes the fields it is given and leaves the rest alone', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: { edits: { title: 'A better title', priority: 80 } },
      });

      expect(response.statusCode).toBe(200);

      const record = await storedRecord(root, 'thing');
      expect(record.title).toBe('A better title');
      expect(record.priority).toBe(80);
      expect(record.body).toBe('A body.');
    });
  });

  it.each(['rev', 'status', 'id'])('refuses to edit %s through the editor', async (field) => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: { edits: { [field]: field === 'rev' ? 9 : 'published' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain(field);

      const record = await storedRecord(root, 'thing');
      expect(record.rev).toBe(1);
      expect(record.status).toBe('draft');
      expect(record.id).toBe('thing');
    });
  });

  it('refuses an edit that would leave the record invalid, and writes nothing', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: { edits: { body: 'Contains <script> brackets.' } },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().issues[0].code).toBe('text-unsafe-characters');
      expect((await storedRecord(root, 'thing')).body).toBe('A body.');
    });
  });

  it('clears an action when it is set to null', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');
      await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: {
          edits: { action: { type: 'route', label: 'Open Tools', target: 'app.tools' } },
        },
      });

      await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: { edits: { action: null } },
      });

      expect((await storedRecord(root, 'thing')).action).toBeUndefined();
    });
  });

  it('refuses an action target that is not on the closed list', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: {
          edits: {
            action: { type: 'route', label: 'Reset', target: 'settings.factory-reset' },
          },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().issues[0].code).toBe('action-target-not-allowed');
    });
  });
});

describe('lifecycle', () => {
  it('offers only the legal transitions and refuses the rest', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'thing');

      const refused = await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'resume' },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain('Available: publish, archive');

      const published = await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'publish' },
      });
      expect(published.json().record.status).toBe('published');
      expect(published.json().transitions).toEqual(['pause', 'archive']);
    });
  });

  it('stamps publishedAt once, on first publication', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      for (const transition of ['publish', 'pause', 'resume']) {
        await app.inject({
          method: 'POST',
          url: '/api/records/thing/transition',
          payload: { transition },
        });
      }

      expect((await storedRecord(root, 'thing')).publishedAt).toBe('2026-09-15T12:00:00Z');
    });
  });

  it('restores an archived record as a draft, never straight to published', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'thing');
      await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'archive' },
      });

      const restored = await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'restore' },
      });

      expect(restored.json().record.status).toBe('draft');
    });
  });

  it('bumps rev only through its own route', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({ method: 'POST', url: '/api/records/thing/bump', payload: {} });
      expect(response.json().record.rev).toBe(2);
      expect((await storedRecord(root, 'thing')).rev).toBe(2);
    });
  });
});

describe('deleting', () => {
  it('will not delete without the acknowledgement, and suggests archiving', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/records/thing',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('archive the record instead');
      expect(existsSync(join(root, 'content', 'announcements', 'thing.json'))).toBe(true);
    });
  });

  it('retires the id in the same step as removing the file', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/records/thing',
        payload: { acknowledgeIdRetired: true },
      });

      expect(response.json().retiredIds).toEqual(['thing']);
      expect(existsSync(join(root, 'content', 'announcements', 'thing.json'))).toBe(false);
    });
  });
});

describe('images', () => {
  it('attaches, serves and detaches', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const attached = await app.inject({
        method: 'POST',
        url: '/api/records/thing/image?filename=shot.png&alt=The%20Reports%20screen',
        payload: await samplePng(),
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(attached.statusCode).toBe(200);
      const detail = attached.json();
      expect(detail.record.image.path).toMatch(/^images\/thing-[0-9a-f]{8}\.webp$/);
      expect(detail.encoded.bytes).toBeLessThanOrEqual(150 * 1024);
      expect(detail.imageUrl).toContain(detail.record.image.sha256.slice(0, 8));

      const shown = await app.inject({ method: 'GET', url: detail.imageUrl });
      expect(shown.statusCode).toBe(200);
      expect(shown.headers['content-type']).toBe('image/webp');
      expect((await sharp(shown.rawPayload).metadata()).format).toBe('webp');

      const detached = await app.inject({
        method: 'DELETE',
        url: '/api/records/thing/image',
        payload: {},
      });

      expect(detached.json().record.image).toBeUndefined();
      expect((await readdir(join(root, 'content', 'media'))).filter((f) => f.startsWith('thing'))).toEqual([]);
      expect((await storedRecord(root, 'thing')).image).toBeUndefined();
    });
  });

  it('requires alt text the first time, then inherits it', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'thing');

      const refused = await app.inject({
        method: 'POST',
        url: '/api/records/thing/image?filename=shot.png',
        payload: await samplePng(),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toContain('Alt text is required');

      await app.inject({
        method: 'POST',
        url: '/api/records/thing/image?filename=shot.png&alt=A%20screenshot',
        payload: await samplePng(),
        headers: { 'content-type': 'application/octet-stream' },
      });

      const replaced = await app.inject({
        method: 'POST',
        url: '/api/records/thing/image?filename=other.png',
        payload: await samplePng(640, 400),
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(replaced.statusCode).toBe(200);
      expect(replaced.json().record.image.alt).toBe('A screenshot');
    });
  });

  it('refuses something that is not an image, and keeps no original', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');

      const response = await app.inject({
        method: 'POST',
        url: '/api/records/thing/image?filename=shot.png&alt=x',
        payload: Buffer.from('this is not an image'),
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(response.statusCode).toBe(422);
      expect(existsSync(join(root, 'content', 'media', 'thing.png'))).toBe(false);
    });
  });
});

describe('validate and build', () => {
  it('validate writes nothing, including the revision counter', async () => {
    await withServer(async (app, root) => {
      await createRecord(app, 'thing');
      await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'publish' },
      });

      const first = (await app.inject({ method: 'POST', url: '/api/validate', payload: {} })).json();
      const second = (await app.inject({ method: 'POST', url: '/api/validate', payload: {} })).json();

      expect(first.revision).toBe(second.revision);
      expect(first.records).toBe(1);

      const state = JSON.parse(await readFile(join(root, 'content', 'state.json'), 'utf8'));
      expect(state.revision).toBe(0);
    });
  });

  it('reports what would be excluded and why', async () => {
    await withServer(async (app) => {
      await createRecord(app, 'still-a-draft');

      const summary = (await app.inject({ method: 'POST', url: '/api/validate', payload: {} })).json();
      expect(summary.excluded).toEqual([{ id: 'still-a-draft', reason: 'draft' }]);
    });
  });
});

describe('publishing', () => {
  async function publishable(app: App, id = 'thing'): Promise<void> {
    await createRecord(app, id, { endAt: '2026-12-01T00:00:00Z' });
    await app.inject({
      method: 'POST',
      url: `/api/records/${id}/transition`,
      payload: { transition: 'publish' },
    });
  }

  it('a dry run computes the diff and writes nothing', async () => {
    await withServer(async (app, root) => {
      await publishable(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: true },
      });

      const result = response.json();
      expect(result.status).toBe('dry-run');
      expect(result.diff.added.map((r: { id: string }) => r.id)).toEqual(['thing']);
      expect(result.diff.revisionTo).toBe(1);

      const manifest = JSON.parse(
        await readFile(join(root, 'dist', 'announcements.json'), 'utf8'),
      );
      expect(manifest.announcements).toEqual([]);
      expect(manifest.revision).toBe(0);
    });
  });

  it('defaults to a dry run when the request does not say', async () => {
    await withServer(async (app) => {
      await publishable(app);

      const response = await app.inject({ method: 'POST', url: '/api/publish', payload: {} });
      expect(response.json().status).toBe('dry-run');
    });
  });

  it('commits one commit carrying the manifest and the content together', async () => {
    await withServer(async (app, root) => {
      await publishable(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, noPush: true, acceptWarnings: true },
      });

      const result = response.json();
      expect(result.status).toBe('committed');
      expect(result.commit).toBeTruthy();

      const manifest = JSON.parse(
        await readFile(join(root, 'dist', 'announcements.json'), 'utf8'),
      );
      expect(manifest.announcements).toHaveLength(1);

      const log = (await app.inject({ method: 'GET', url: '/api/git/log' })).json();
      expect(log[0].message).toContain('Publish r1');
    });
  });

  it('blocks on warnings until they are accepted', async () => {
    await withServer(async (app) => {
      // No end date is a warning: an announcement that runs for ever is
      // usually a forgotten one rather than an intended one.
      await createRecord(app, 'thing');
      await app.inject({
        method: 'POST',
        url: '/api/records/thing/transition',
        payload: { transition: 'publish' },
      });

      const blocked = await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, noPush: true },
      });

      expect(blocked.json().status).toBe('blocked');
      expect(blocked.json().blockedBy).toContain('--accept-warnings');
      expect(blocked.json().build.warnings.length).toBeGreaterThan(0);
    });
  });

  it('carries the kill switch forward rather than clearing it', async () => {
    await withServer(async (app) => {
      await publishable(app);

      await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, noPush: true, acceptWarnings: true, paused: true },
      });

      // An ordinary publish that says nothing about the switch must leave it on.
      await app.inject({
        method: 'PATCH',
        url: '/api/records/thing',
        payload: { edits: { title: 'Edited' } },
      });
      await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, noPush: true, acceptWarnings: true },
      });

      const state = (await app.inject({ method: 'GET', url: '/api/state' })).json();
      expect(state.published.paused).toBe(true);
    });
  });

  it('says the commit is local when there is no remote to push to', async () => {
    await withServer(async (app) => {
      await publishable(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, acceptWarnings: true },
      });

      const result = response.json();
      expect(result.status).toBe('committed');
      expect(result.push).toMatchObject({ pushed: false, reason: 'no-remote' });

      const pushed = await app.inject({ method: 'POST', url: '/api/git/push', payload: {} });
      expect(pushed.json()).toMatchObject({ pushed: false, reason: 'no-remote' });
    });
  });

  it('reverts a publish with a new commit', async () => {
    await withServer(async (app, root) => {
      await publishable(app);
      const published = await app.inject({
        method: 'POST',
        url: '/api/publish',
        payload: { dryRun: false, noPush: true, acceptWarnings: true },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/git/revert',
        payload: { commit: published.json().commit },
      });

      expect(response.statusCode).toBe(200);

      const manifest = JSON.parse(
        await readFile(join(root, 'dist', 'announcements.json'), 'utf8'),
      );
      expect(manifest.announcements).toEqual([]);
    });
  });
});

describe('unknown endpoints', () => {
  it('answers an unknown API path with JSON, not with the client', async () => {
    await withServer(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(response.statusCode).toBe(404);
    });
  });

  it('reports a missing record by id', async () => {
    await withServer(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/api/records/nope' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toContain('nope');
    });
  });
});
