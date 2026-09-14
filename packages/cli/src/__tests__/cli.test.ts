/**
 * The CLI, driven through `main` exactly as the binary drives it.
 *
 * Output is captured rather than printed, and every command runs against a real
 * temporary repository — so these tests exercise the same path an operator
 * does, including the exit codes, which are the half a UI would never surface.
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import sharp from 'sharp';

import { main, type CommandResult } from '../main';
import { parseArgs, flagBool, flagNumber, flagString } from '../args';

jest.setTimeout(60000);

const NOW = '2026-09-15T12:00:00Z';

interface Run {
  code: CommandResult;
  out: string;
  err: string;
}

async function withRepo<T>(fn: (repo: string, run: (...argv: string[]) => Promise<Run>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ruood-cli-'));

  const run = async (...argv: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv, '--repo', dir, '--now', NOW], {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  try {
    return await fn(dir, run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function initialised(repo: string, run: (...argv: string[]) => Promise<Run>): Promise<void> {
  await run('init');
  // git needs an identity to commit at all, and CI machines have none.
  const { AnnouncementRepo } = await import('@ruood/announcement-core');
  const git = new AnnouncementRepo(repo);
  await git.setIdentity('Test', 'test@example.com');
  await git.commitPaths(['.'], 'Initial');
}

describe('argument parsing', () => {
  it('reads flags in every form the commands use', () => {
    const args = parseArgs(['new', 'my-id', '--title', 'A title', '--dry-run', '--priority=90']);
    expect(args.command).toBe('new');
    expect(args.positionals).toEqual(['my-id']);
    expect(flagString(args, 'title')).toBe('A title');
    expect(flagBool(args, 'dry-run')).toBe(true);
    expect(flagNumber(args, 'priority')).toBe(90);
  });

  it('treats a flag followed by another flag as a boolean', () => {
    const args = parseArgs(['publish', '--dry-run', '--no-push']);
    expect(flagBool(args, 'dry-run')).toBe(true);
    expect(flagBool(args, 'no-push')).toBe(true);
  });

  it('stops interpreting flags after --', () => {
    const args = parseArgs(['new', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });
});

describe('misuse', () => {
  it('requires --repo', async () => {
    const out: string[] = [];
    const code = await main(['list'], { out: (l) => out.push(l), err: (l) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('--repo');
  });

  it('rejects an unknown command with usage', async () => {
    const err: string[] = [];
    const code = await main(['frobnicate', '--repo', '.'], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('Unknown command');
  });

  it('prints usage for help', async () => {
    const out: string[] = [];
    expect(await main(['help'], { out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(out.join('\n')).toContain('AUTHORING');
  });
});

describe('the authoring flow', () => {
  it('goes init -> new -> activate -> publish', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const created = await run('new', 'reports-center', '--title', 'Reports Center', '--body', 'Eight new reports.');
      expect(created.code).toBe(0);
      expect(created.out).toContain('DRAFT');

      const listed = await run('list');
      expect(listed.out).toContain('draft');
      expect(listed.out).toContain('reports-center');

      const activated = await run('activate', 'reports-center');
      expect(activated.code).toBe(0);
      expect(activated.out).toContain('draft -> active');

      const published = await run('publish', '--no-push', '--accept-warnings');
      expect(published.code).toBe(0);
      expect(published.out).toContain('Committed');

      const manifest = JSON.parse(await readFile(join(repo, 'dist', 'announcements.json'), 'utf8'));
      expect(manifest.announcements.map((r: { id: string }) => r.id)).toEqual(['reports-center']);
    });
  });

  it('refuses an id that is already taken', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const second = await run('new', 'thing', '--title', 'C', '--body', 'D');
      expect(second.code).toBe(1);
      expect(second.err).toContain('already in use');
    });
  });

  it('refuses a malformed id before writing anything', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const result = await run('new', 'Not An Id', '--title', 'A', '--body', 'B');
      expect(result.code).toBe(2);
      expect(result.err).toContain('not a usable id');
    });
  });

  it('suggests near misses when an id is not found', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'reports-center', '--title', 'A', '--body', 'B');

      const result = await run('activate', 'reports');
      expect(result.code).toBe(1);
      expect(result.err).toContain('Did you mean: reports-center');
    });
  });
});

describe('lifecycle transitions', () => {
  it('refuses an illegal transition and says what is available', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const result = await run('resume', 'thing');
      expect(result.code).toBe(1);
      expect(result.err).toContain('Available: publish, archive');
    });
  });

  it('pauses and resumes', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      const paused = await run('pause', 'thing');
      expect(paused.out).toContain('active -> paused');
      expect(paused.out).toContain('paused:true');

      const resumed = await run('resume', 'thing');
      expect(resumed.out).toContain('paused -> active');
    });
  });

  it('warns in words that a rev bump re-shows the announcement', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const result = await run('bump', 'thing');
      expect(result.out).toContain('rev 1 -> 2');
      expect(result.out).toContain('RE-SHOWS');
    });
  });
});

describe('publishing', () => {
  it('shows the diff and writes nothing on a dry run', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      const before = await readFile(join(repo, 'dist', 'announcements.json'), 'utf8');
      const result = await run('publish', '--dry-run');

      expect(result.code).toBe(0);
      expect(result.out).toContain('+ thing');
      expect(result.out).toContain('Dry run');
      expect(await readFile(join(repo, 'dist', 'announcements.json'), 'utf8')).toBe(before);
    });
  });

  it('blocks on warnings until they are accepted', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      const blocked = await run('publish', '--no-push');
      expect(blocked.code).toBe(1);
      expect(blocked.err).toContain('--accept-warnings');

      const accepted = await run('publish', '--no-push', '--accept-warnings');
      expect(accepted.code).toBe(0);
    });
  });

  it('refuses a corrupt record and reports the file', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await writeFile(join(repo, 'content', 'announcements', 'broken.json'), '{ not json', 'utf8');

      const result = await run('publish', '--no-push', '--accept-warnings');
      expect(result.code).toBe(1);
      expect(result.err).toContain('broken.json');
    });
  });

  it('validate does not advance the revision counter', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      await run('validate');
      await run('validate');

      const published = await run('publish', '--no-push', '--accept-warnings');
      expect(published.out).toContain('revision 0 -> 1');
    });
  });

  it('announces the kill switch in the diff', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');
      await run('publish', '--no-push', '--accept-warnings');

      const paused = await run('publish', '--no-push', '--accept-warnings', '--pause');
      expect(paused.out).toContain('KILL SWITCH ON');
    });
  });

  it('rejects --pause and --unpause together', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const result = await run('publish', '--pause', '--unpause');
      expect(result.code).toBe(2);
    });
  });
});

describe('images', () => {
  it('attaches an encoded image and keeps the original', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const file = join(repo, 'source.png');
      await writeFile(
        file,
        await sharp({ create: { width: 900, height: 500, channels: 3, background: '#c8aa5a' } })
          .png()
          .toBuffer(),
      );

      const result = await run('image', 'thing', file, '--alt', 'A screen');
      expect(result.code).toBe(0);
      expect(result.out).toContain('WebP');

      const record = JSON.parse(
        await readFile(join(repo, 'content', 'announcements', 'thing.json'), 'utf8'),
      );
      expect(record.image.path).toMatch(/^images\/thing-[0-9a-f]{8}\.webp$/);
      expect(await readFile(join(repo, 'content', 'media', 'thing.png'))).toBeTruthy();
    });
  });

  it('requires alt text the first time', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const file = join(repo, 'source.png');
      await writeFile(
        file,
        await sharp({ create: { width: 900, height: 500, channels: 3, background: '#c8aa5a' } })
          .png()
          .toBuffer(),
      );

      const result = await run('image', 'thing', file);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--alt');
    });
  });
});

describe('delete', () => {
  it('asks before retiring an id for ever, and suggests archiving', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const asked = await run('delete', 'thing');
      expect(asked.code).toBe(2);
      expect(asked.err).toContain('NEVER be used again');
      expect(asked.err).toContain('archive');

      const done = await run('delete', 'thing', '--yes');
      expect(done.code).toBe(0);

      const retired = JSON.parse(await readFile(join(repo, 'content', 'retired-ids.json'), 'utf8'));
      expect(retired).toEqual(['thing']);
    });
  });

  it('refuses to recreate a retired id', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('delete', 'thing', '--yes');

      const result = await run('new', 'thing', '--title', 'C', '--body', 'D');
      expect(result.code).toBe(1);
      expect(result.err).toContain('never be reused');
    });
  });
});

describe('status', () => {
  it('reports content, publication and git state', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');
      await run('publish', '--no-push', '--accept-warnings');

      const result = await run('status');
      expect(result.code).toBe(0);
      expect(result.out).toContain('CONTENT');
      expect(result.out).toContain('PUBLISHED');
      expect(result.out).toContain('revision 1');
      expect(result.out).toContain('no remote configured');
    });
  });

  it('says when the kill switch is on', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');
      await run('publish', '--no-push', '--accept-warnings', '--pause');

      const result = await run('status');
      expect(result.out).toContain('KILL SWITCH IS ON');
    });
  });
});

describe('edit', () => {
  it('changes content fields and leaves the rest alone', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const result = await run(
        'edit',
        'thing',
        '--title',
        'A better title',
        '--priority',
        '80',
        '--surface',
        'banner',
      );

      expect(result.code).toBe(0);
      expect(result.out).toContain('display, priority, title');

      const record = JSON.parse(
        await readFile(join(repo, 'content', 'announcements', 'thing.json'), 'utf8'),
      );
      expect(record.title).toBe('A better title');
      expect(record.priority).toBe(80);
      expect(record.display.surface).toBe('banner');
      // Untouched fields survive a partial edit.
      expect(record.body).toBe('B');
      expect(record.display.trigger).toBe('next-launch');
    });
  });

  it('never edits rev — that is a separate command with a separate consequence', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      // There is no --rev flag at all, so the field cannot be reached from here.
      const result = await run('edit', 'thing', '--rev', '5');
      expect(result.code).toBe(2);
      expect(result.err).toContain('Nothing to change');

      const record = JSON.parse(
        await readFile(join(repo, 'content', 'announcements', 'thing.json'), 'utf8'),
      );
      expect(record.rev).toBe(1);
    });
  });

  it('refuses an edit that would leave the record invalid, and writes nothing', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const result = await run('edit', 'thing', '--title', 'x'.repeat(200));

      expect(result.code).toBe(1);
      expect(result.err).toContain('text-too-long');

      const record = JSON.parse(
        await readFile(join(repo, 'content', 'announcements', 'thing.json'), 'utf8'),
      );
      expect(record.title).toBe('A');
    });
  });

  it('says that editing a published record does not re-show it', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      const result = await run('edit', 'thing', '--body', 'A corrected body.');
      expect(result.out).toContain('does NOT re-show');
      expect(result.out).toContain('announce bump thing');
    });
  });

  it('clears an end date with --no-end and refuses both at once', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B', '--end', '2026-12-01T00:00:00Z');

      expect((await run('edit', 'thing', '--end', '2027-01-01T00:00:00Z', '--no-end')).code).toBe(2);

      expect((await run('edit', 'thing', '--no-end')).code).toBe(0);
      const record = JSON.parse(
        await readFile(join(repo, 'content', 'announcements', 'thing.json'), 'utf8'),
      );
      expect(record.endAt).toBeNull();
    });
  });

  it('sets and removes an action', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const file = join(repo, 'content', 'announcements', 'thing.json');

      expect(
        (await run('edit', 'thing', '--action-route', 'tools.reports', '--action-label', 'Open'))
          .code,
      ).toBe(0);
      expect(JSON.parse(await readFile(file, 'utf8')).action).toEqual({
        type: 'route',
        label: 'Open',
        target: 'tools.reports',
      });

      expect((await run('edit', 'thing', '--no-action')).code).toBe(0);
      expect(JSON.parse(await readFile(file, 'utf8')).action).toBeUndefined();
    });
  });

  it('refuses an action target that is not on the closed list', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      const result = await run(
        'edit',
        'thing',
        '--action-route',
        'settings.factory-reset',
        '--action-label',
        'Reset',
      );

      expect(result.code).toBe(1);
      expect(result.err).toContain('action-target-not-allowed');
    });
  });

  it('requires an id and at least one field', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');

      expect((await run('edit')).code).toBe(2);
      expect((await run('edit', 'thing')).code).toBe(2);
    });
  });
});

describe('push', () => {
  it('reports that there is no remote rather than pretending to publish', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');
      await run('publish', '--no-push', '--accept-warnings');

      const result = await run('push');
      expect(result.code).toBe(1);
      expect(result.err).toContain('No git remote');
      expect(result.err).toContain('intact locally');
    });
  });
});

describe('keygen', () => {
  /** A key path outside the repository, which is where one is allowed to live. */
  function keyPathFor(repo: string): string {
    return join(tmpdir(), `ruood-cli-key-${basename(repo)}.key`);
  }

  it('creates a key, keeps the private half out of the repository', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const keyPath = keyPathFor(repo);

      try {
        const result = await run('keygen', '--key', keyPath);

        expect(result.code).toBe(0);
        expect(result.out).toContain('key id');
        expect(result.out).toContain('NOT RECOVERABLE');

        // Private outside, public inside.
        expect(existsSync(keyPath)).toBe(true);
        const record = JSON.parse(
          await readFile(join(repo, 'keys', 'announcement-signing.pub'), 'utf8'),
        );
        expect(record.algorithm).toBe('ed25519');
        expect(record.keyId).toMatch(/^[0-9a-f]{8}$/);
      } finally {
        await rm(keyPath, { force: true });
      }
    });
  });

  it('refuses to put the private key inside the repository', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const result = await run('keygen', '--key', join(repo, 'keys', 'signing.key'));

      expect(result.code).toBe(1);
      expect(result.err).toContain('must never live in a repository');
      expect(existsSync(join(repo, 'keys', 'signing.key'))).toBe(false);
    });
  });

  it('refuses to rotate without --force, because rotating is an app release', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const keyPath = keyPathFor(repo);

      try {
        await run('keygen', '--key', keyPath);
        const again = await run('keygen', '--key', `${keyPath}.2`);

        expect(again.code).toBe(1);
        expect(again.err).toContain('rotation is an app release');
      } finally {
        await rm(keyPath, { force: true });
        await rm(`${keyPath}.2`, { force: true });
      }
    });
  });
});

describe('signing a publish', () => {
  function keyPathFor(repo: string): string {
    return join(tmpdir(), `ruood-cli-sign-${basename(repo)}.key`);
  }

  it('signs, verifies, and refuses once the file is touched', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const keyPath = keyPathFor(repo);

      try {
        await run('keygen', '--key', keyPath);
        await run('new', 'thing', '--title', 'A', '--body', 'B', '--end', '2026-12-01T00:00:00Z');
        await run('activate', 'thing');

        const published = await run('publish', '--no-push', '--accept-warnings', '--key', keyPath);
        expect(published.code).toBe(0);

        const verified = await run('verify');
        expect(verified.code).toBe(0);
        expect(verified.out).toContain('production  OK');

        // The edit the whole mechanism exists to catch.
        const manifestFile = join(repo, 'dist', 'announcements.json');
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
        await writeFile(manifestFile, JSON.stringify({ ...manifest, paused: true }), 'utf8');

        const broken = await run('verify');
        expect(broken.code).toBe(1);
        expect(broken.err).toContain('has been altered');
        expect(broken.err).toContain('republish through the Manager');
      } finally {
        await rm(keyPath, { force: true });
      }
    });
  });

  it('warns when a signed repository is about to publish unsigned', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const keyPath = keyPathFor(repo);

      try {
        await run('keygen', '--key', keyPath);
        await run('new', 'thing', '--title', 'A', '--body', 'B');
        await run('activate', 'thing');

        const result = await run('publish', '--dry-run');
        expect(result.err).toContain('this build is unsigned');
      } finally {
        await rm(keyPath, { force: true });
      }
    });
  });

  it('refuses rather than publishing unsigned when the key is missing', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'thing', '--title', 'A', '--body', 'B');
      await run('activate', 'thing');

      const result = await run(
        'publish',
        '--no-push',
        '--accept-warnings',
        '--key',
        join(tmpdir(), 'ruood-no-such-key.key'),
      );

      expect(result.code).toBe(1);
      expect(result.err).toContain('No signing key at');
    });
  });

  it('verify says so when nothing has been signed yet', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const result = await run('verify');
      expect(result.code).toBe(1);
      expect(result.err).toContain('no keys/announcement-signing.pub');
    });
  });
});

describe('the staging channel', () => {
  it('publishes drafts to staging and nothing to production', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('new', 'preview-me', '--title', 'Preview', '--body', 'Not ready yet.');

      const staged = await run('publish', '--channel', 'staging', '--no-push', '--accept-warnings');
      expect(staged.code).toBe(0);

      const staging = JSON.parse(
        await readFile(join(repo, 'dist', 'staging', 'announcements.json'), 'utf8'),
      );
      expect(staging.announcements.map((r: { id: string }) => r.id)).toEqual(['preview-me']);

      // Production is untouched: the draft is still a draft.
      const production = JSON.parse(
        await readFile(join(repo, 'dist', 'announcements.json'), 'utf8'),
      );
      expect(production.announcements).toEqual([]);
    });
  });

  it('rejects a channel that is not one of the two', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const result = await run('publish', '--channel', 'beta', '--dry-run');
      expect(result.code).toBe(2);
      expect(result.err).toContain('production or staging');
    });
  });
});

/**
 * The retention window, driven the way an operator drives it.
 *
 * The unit tests in `core` cover the selection; this covers the thing that
 * actually has to hold: publish a sixth announcement under a limit of five and
 * the oldest stops being published, while its file stays exactly where it is.
 *
 * Every record here is activated at the same fixed `--now`, so `publishedAt` is
 * identical across all of them and the ordering falls through to `startAt` —
 * which is what the distinct `--start` dates are for.
 */
describe('retention', () => {
  const started = (day: number): string => `2026-09-0${day}T00:00:00Z`;

  async function announce(
    run: (...argv: string[]) => Promise<Run>,
    id: string,
    day: number,
  ): Promise<void> {
    await run('new', id, '--title', id.toUpperCase(), '--body', 'Body', '--start', started(day));
    await run('activate', id);
  }

  async function publishedIds(repo: string): Promise<string[]> {
    const manifest = JSON.parse(
      await readFile(join(repo, 'dist', 'announcements.json'), 'utf8'),
    ) as { announcements: { id: string }[] };

    return manifest.announcements.map((record) => record.id).sort();
  }

  it('shows the default, and the bounds', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const result = await run('retention');
      expect(result.code).toBe(0);
      expect(result.out).toContain('Maximum retained announcements: 20');
      expect(result.out).toContain('the default');
    });
  });

  it('moves the window forward as announcements are published', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      expect((await run('retention', '--max', '5')).code).toBe(0);

      for (const [id, day] of [['note-a', 1], ['note-b', 2], ['note-c', 3], ['note-d', 4], ['note-e', 5]] as const) {
        await announce(run, id, day);
      }
      expect((await run('publish', '--no-push', '--accept-warnings')).code).toBe(0);
      expect(await publishedIds(repo)).toEqual(['note-a', 'note-b', 'note-c', 'note-d', 'note-e']);

      await announce(run, 'note-f', 6);
      await run('publish', '--no-push', '--accept-warnings');
      expect(await publishedIds(repo)).toEqual(['note-b', 'note-c', 'note-d', 'note-e', 'note-f']);

      await announce(run, 'note-g', 7);
      await run('publish', '--no-push', '--accept-warnings');
      expect(await publishedIds(repo)).toEqual(['note-c', 'note-d', 'note-e', 'note-f', 'note-g']);
    });
  });

  it('keeps the excluded records, unchanged, in content/', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('retention', '--max', '2');

      for (const [id, day] of [['note-a', 1], ['note-b', 2], ['note-c', 3]] as const) {
        await announce(run, id, day);
      }
      await run('publish', '--no-push', '--accept-warnings');

      expect(await publishedIds(repo)).toEqual(['note-b', 'note-c']);

      // The distinction the whole feature turns on. "a" is not deleted and not
      // archived — it is simply not sent.
      const file = join(repo, 'content', 'announcements', 'note-a.json');
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('published');

      const listed = await run('list');
      expect(listed.out).toContain('note-a');
    });
  });

  it('names what falls outside it, and says they are still here', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('retention', '--max', '1');
      await announce(run, 'old-one', 1);
      await announce(run, 'new-one', 2);

      const result = await run('retention');
      expect(result.out).toContain('- old-one');
      expect(result.out).toContain('Nothing in content/ is removed.');
    });
  });

  it('follows the setting up and back down again', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('retention', '--max', '5');

      for (const [id, day] of [
        ['note-a', 1],
        ['note-b', 2],
        ['note-c', 3],
        ['note-d', 4],
        ['note-e', 5],
        ['note-f', 6],
        ['note-g', 7],
      ] as const) {
        await announce(run, id, day);
      }

      await run('publish', '--no-push', '--accept-warnings');
      expect(await publishedIds(repo)).toEqual(['note-c', 'note-d', 'note-e', 'note-f', 'note-g']);

      await run('retention', '--max', '10');
      await run('publish', '--no-push', '--accept-warnings');
      expect(await publishedIds(repo)).toEqual(['note-a', 'note-b', 'note-c', 'note-d', 'note-e', 'note-f', 'note-g']);

      await run('retention', '--max', '3');
      await run('publish', '--no-push', '--accept-warnings');
      expect(await publishedIds(repo)).toEqual(['note-e', 'note-f', 'note-g']);
    });
  });

  it('never reactivates a paused announcement, in or out of the window', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('retention', '--max', '2');

      await announce(run, 'old-paused', 1);
      await run('pause', 'old-paused');
      await announce(run, 'new-paused', 2);
      await run('pause', 'new-paused');
      await announce(run, 'newest', 3);

      await run('publish', '--no-push', '--accept-warnings');

      const manifest = JSON.parse(
        await readFile(join(repo, 'dist', 'announcements.json'), 'utf8'),
      ) as { announcements: { id: string; paused?: boolean }[] };

      // The one inside the window is published and still paused; the one
      // outside it is not published — and neither record changed.
      expect(manifest.announcements.find((r) => r.id === 'new-paused')?.paused).toBe(true);
      expect(manifest.announcements.map((r) => r.id).sort()).toEqual(['new-paused', 'newest']);

      for (const id of ['old-paused', 'new-paused']) {
        const record = JSON.parse(
          await readFile(join(repo, 'content', 'announcements', `${id}.json`), 'utf8'),
        );
        expect(record.status).toBe('paused');
      }
    });
  });

  it('keeps the setting when a publish writes the revision counter', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      await run('retention', '--max', '4');
      await announce(run, 'thing', 1);
      await run('publish', '--no-push', '--accept-warnings');

      const state = JSON.parse(await readFile(join(repo, 'content', 'state.json'), 'utf8'));
      expect(state.maxRetained).toBe(4);
      expect(state.revision).toBeGreaterThan(0);

      expect((await run('retention')).out).toContain('Maximum retained announcements: 4');
    });
  });

  it('still signs, and still verifies, with a window applied', async () => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);
      const keyPath = join(tmpdir(), `ruood-cli-retain-${basename(repo)}.key`);

      try {
        await run('keygen', '--key', keyPath);
        await run('retention', '--max', '2');

        for (const [id, day] of [['note-a', 1], ['note-b', 2], ['note-c', 3]] as const) {
          await announce(run, id, day);
        }

        const published = await run('publish', '--no-push', '--accept-warnings', '--key', keyPath);
        expect(published.code).toBe(0);
        expect(await publishedIds(repo)).toEqual(['note-b', 'note-c']);

        // Signing happens over the manifest the window produced, so what is
        // signed and what is published cannot differ.
        const verified = await run('verify');
        expect(verified.code).toBe(0);
        expect(verified.out).toContain('production  OK');
      } finally {
        await rm(keyPath, { force: true });
      }
    });
  });

  it.each(['0', '-1', '999', 'lots'])('refuses --max %s as misuse', async (value) => {
    await withRepo(async (repo, run) => {
      await initialised(repo, run);

      const result = await run('retention', '--max', value);
      expect(result.code).toBe(2);
      expect(result.err).toContain('whole number');

      // And nothing was written: a refused setting is not a setting.
      expect((await run('retention')).out).toContain('Maximum retained announcements: 20');
    });
  });
});
