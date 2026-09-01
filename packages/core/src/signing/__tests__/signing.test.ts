/**
 * Keys, signing, channels and the scaffolded CI check — against a real
 * repository, a real key and a real `node` process running the vendored script.
 *
 * The last one matters more than it looks. The CI script is a deliberate second
 * implementation of the canonical form, written to depend on nothing; the only
 * way to know it agrees with the real one is to sign a manifest here and run
 * the script over it exactly as GitHub Actions would.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalJson,
  manifestSigningInput,
  parseManifestText,
  type AnnouncementManifest,
} from '@ruood/announcement-schema';

import { scaffoldRepository } from '../../scaffold';
import { repoPaths, channelPaths } from '../../paths';
import { saveRecord } from '../../content/store';
import { buildManifest, writeBuild, readPublished } from '../../build/build';
import { publish } from '../../publish/publish';
import { AnnouncementRepo } from '../../git/repository';
import { CI_SCRIPT_FILE } from '../../ci/files';
import {
  assertOutsideRepository,
  defaultKeyPath,
  generateSigningKey,
  keyIdFor,
  loadPublicKeyRecord,
  loadSigningKey,
  publicKeyPath,
  savePublicKeyRecord,
  saveSigningKey,
  SigningKeyError,
} from '../keys';
import { nodeSignatureVerifier, signManifest, trustedKeysFor, verifySignedManifest } from '../sign';
import { NOW, authored, withTempDir } from '../../__tests__/fixtures';

jest.setTimeout(60000);

/** Generates a key, keeps it outside the repo, and records the public half. */
async function keyedRepo(dir: string): Promise<{ root: string; keyPath: string; keyId: string }> {
  const root = join(dir, 'repo');
  await mkdir(root, { recursive: true });
  await scaffoldRepository(root);

  const generated = generateSigningKey(NOW);
  const keyPath = join(dir, 'signing.key');

  await saveSigningKey(keyPath, generated.privateKeyPem, { repoRoot: root });
  await savePublicKeyRecord(root, {
    algorithm: 'ed25519',
    createdAt: generated.createdAt,
    keyId: generated.keyId,
    publicKey: generated.publicKey,
  });

  return { root, keyPath, keyId: generated.keyId };
}

// ---------------------------------------------------------------------------

describe('keys', () => {
  it('derives the key id from the key rather than assigning one', () => {
    const generated = generateSigningKey(NOW);
    expect(generated.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(keyIdFor(generated.publicKey)).toBe(generated.keyId);
  });

  it('round-trips through the file and keeps the same id', async () => {
    await withTempDir(async (dir) => {
      const generated = generateSigningKey(NOW);
      const keyPath = join(dir, 'signing.key');
      await saveSigningKey(keyPath, generated.privateKeyPem);

      const loaded = await loadSigningKey(keyPath);
      expect(loaded.keyId).toBe(generated.keyId);
      expect(loaded.publicKey).toBe(generated.publicKey);
    });
  });

  it('refuses to write the private key inside a repository', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const generated = generateSigningKey(NOW);

      await expect(
        saveSigningKey(join(root, 'keys', 'signing.key'), generated.privateKeyPem, {
          repoRoot: root,
        }),
      ).rejects.toThrow(SigningKeyError);

      expect(existsSync(join(root, 'keys', 'signing.key'))).toBe(false);
    });
  });

  it('checks containment by path, not by trusting a .gitignore', () => {
    expect(() => assertOutsideRepository('/repo/keys/x.key', '/repo')).toThrow();
    expect(() => assertOutsideRepository('/elsewhere/x.key', '/repo')).not.toThrow();
    // A sibling directory whose name merely starts the same is not inside.
    expect(() => assertOutsideRepository('/repo-other/x.key', '/repo')).not.toThrow();
  });

  it('refuses to overwrite an existing key', async () => {
    await withTempDir(async (dir) => {
      const keyPath = join(dir, 'signing.key');
      await saveSigningKey(keyPath, generateSigningKey(NOW).privateKeyPem);

      await expect(
        saveSigningKey(keyPath, generateSigningKey(NOW).privateKeyPem),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('writes the private key 0600 where the platform has modes', async () => {
    if (process.platform === 'win32') return;

    await withTempDir(async (dir) => {
      const keyPath = join(dir, 'signing.key');
      await saveSigningKey(keyPath, generateSigningKey(NOW).privateKeyPem);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  });

  it('defaults to a path outside every repository', () => {
    expect(defaultKeyPath()).toContain('.ruood');
  });

  it('refuses a corrupt public key file rather than reading it as "unsigned"', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      await writeFile(publicKeyPath(root), '{ not json', 'utf8');

      await expect(loadPublicKeyRecord(root)).rejects.toThrow(SigningKeyError);
    });
  });
});

// ---------------------------------------------------------------------------

describe('signing a build', () => {
  it('signs the manifest and verifies it with the client-shaped check', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath, keyId } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      const result = await buildManifest(paths, { now: NOW, signingKey: key });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.signedBy).toBe(keyId);
      expect(result.manifest.keyId).toBe(keyId);

      expect(verifySignedManifest(result.manifest, trustedKeysFor(key))).toMatchObject({
        ok: true,
      });
    });
  });

  it('signs the bytes that are actually written', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      const result = await buildManifest(paths, { now: NOW, signingKey: key });
      await writeBuild(paths, result);

      // Re-read from disk. The build verifying its own object proves the signer
      // works; this proves the file does.
      const written = JSON.parse(await readFile(paths.manifest, 'utf8')) as unknown;
      expect(verifySignedManifest(written, trustedKeysFor(key))).toMatchObject({ ok: true });
    });
  });

  it('refuses when the key does not match what the repository expects', async () => {
    await withTempDir(async (dir) => {
      const { root } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      // A different key entirely — the classic "signed with the wrong one and
      // every install rejects it, silently" mistake.
      const other = generateSigningKey(NOW);
      const otherPath = join(dir, 'other.key');
      await saveSigningKey(otherPath, other.privateKeyPem);

      const result = await buildManifest(paths, {
        now: NOW,
        signingKey: await loadSigningKey(otherPath),
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toContain('this repository expects');
    });
  });

  it('still builds without a key, so signing is something you turn on', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const result = await buildManifest(paths, { now: NOW });

      expect(result.ok).toBe(true);
      expect(result.signedBy).toBeNull();
      expect(result.manifest.signature).toBeUndefined();
    });
  });

  it('produces a file the client parser accepts with the key pinned', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath, keyId } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      const result = await buildManifest(paths, { now: NOW, signingKey: key });

      const parsed = parseManifestText(result.serialised, {
        now: NOW,
        trustedKeys: trustedKeysFor(key),
        verifySignature: nodeSignatureVerifier,
        requireSignature: true,
      });

      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.manifest.keyId).toBe(keyId);
    });
  });

  it('a hand edit to the written file stops verifying', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));

      const onDisk = JSON.parse(await readFile(paths.manifest, 'utf8')) as AnnouncementManifest;
      // The exact edit the whole mechanism exists to catch.
      await writeFile(paths.manifest, canonicalJson({ ...onDisk, paused: true }), 'utf8');

      const tampered = JSON.parse(await readFile(paths.manifest, 'utf8')) as unknown;
      expect(verifySignedManifest(tampered, trustedKeysFor(key))).toMatchObject({
        ok: false,
        reason: 'bad-signature',
      });
    });
  });

  it('signs keyId itself, so it cannot be relabelled', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      const key = await loadSigningKey(keyPath);

      const signed = signManifest(
        (await buildManifest(paths, { now: NOW })).manifest,
        key,
      );

      expect(manifestSigningInput(signed)).toContain(`"keyId":"${key.keyId}"`);
    });
  });
});

// ---------------------------------------------------------------------------

describe('the staging channel', () => {
  it('publishes drafts, which production never does', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const paths = repoPaths(root);

      await saveRecord(paths, authored({ id: 'live', status: 'published' }));
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      const production = await buildManifest(paths, { now: NOW });
      const staging = await buildManifest(paths, { now: NOW, channel: 'staging' });

      expect(production.manifest.announcements.map((r) => r.id)).toEqual(['live']);
      expect(staging.manifest.announcements.map((r) => r.id).sort()).toEqual(['a-draft', 'live']);
    });
  });

  it('still excludes archived and expired records from staging', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const paths = repoPaths(root);

      await saveRecord(paths, authored({ id: 'archived-one', status: 'archived' }));
      await saveRecord(
        paths,
        authored({ id: 'expired-one', status: 'published', endAt: '2020-01-01T00:00:00Z' }),
      );

      const staging = await buildManifest(paths, { now: NOW, channel: 'staging' });
      expect(staging.manifest.announcements).toEqual([]);
      expect(staging.excluded.map((e) => e.reason).sort()).toEqual(['archived', 'expired']);
    });
  });

  it('writes to its own directory and leaves production alone', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const paths = repoPaths(root);
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      await writeBuild(paths, await buildManifest(paths, { now: NOW, channel: 'staging' }));

      const staging = channelPaths(paths, 'staging');
      expect(JSON.parse(await readFile(staging.manifest, 'utf8')).announcements).toHaveLength(1);
      // Production is still the empty manifest the scaffold wrote.
      expect(JSON.parse(await readFile(paths.manifest, 'utf8')).announcements).toHaveLength(0);
    });
  });

  it('reads each channel back independently', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const paths = repoPaths(root);
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      await writeBuild(paths, await buildManifest(paths, { now: NOW, channel: 'staging' }));

      expect((await readPublished(paths, 'staging')).manifest?.announcements).toHaveLength(1);
      expect((await readPublished(paths, 'production')).manifest?.announcements).toHaveLength(0);
    });
  });

  it('a staging publish does not commit production output', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const git = new AnnouncementRepo(root);
      await git.setIdentity('Test', 'test@example.com');
      await git.commitPaths(['.'], 'Initial');

      const paths = repoPaths(root);
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      // Leave an unrelated production edit in the working tree.
      await writeFile(paths.manifest, `${await readFile(paths.manifest, 'utf8')}\n`, 'utf8');

      const result = await publish(paths, {
        now: NOW,
        channel: 'staging',
        noPush: true,
        acceptWarnings: true,
      });

      expect(result.status).toBe('committed');

      // The stray production edit is still uncommitted: a staging publish
      // stages dist/staging, never the whole of dist/.
      const status = await git.status();
      expect([...status.modified, ...status.staged]).toContain('dist/announcements.json');
    });
  });

  it('names the channel in the commit subject', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);
      const git = new AnnouncementRepo(root);
      await git.setIdentity('Test', 'test@example.com');
      await git.commitPaths(['.'], 'Initial');

      const paths = repoPaths(root);
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      await publish(paths, { now: NOW, channel: 'staging', noPush: true, acceptWarnings: true });

      const log = await git.log(1);
      expect(log[0]!.message).toContain('[staging]');
    });
  });
});

// ---------------------------------------------------------------------------

describe('the scaffolded CI check', () => {
  function runScript(root: string, args: string[] = []): { code: number; output: string } {
    try {
      const output = execFileSync('node', [join(root, CI_SCRIPT_FILE), ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      return { code: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  }

  it('is scaffolded along with the workflow that runs it', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);

      expect(existsSync(join(root, CI_SCRIPT_FILE))).toBe(true);
      expect(existsSync(join(root, '.github', 'workflows', 'verify.yml'))).toBe(true);
    });
  });

  it('skips cleanly on a repository with no key yet', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'repo');
      await scaffoldRepository(root);

      const result = runScript(root);
      expect(result.code).toBe(0);
      expect(result.output).toContain('SKIP');
    });
  });

  it('accepts a manifest the Manager signed — the two canonical forms agree', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath, keyId } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));

      const result = runScript(root);
      expect(result.output).toContain('OK');
      expect(result.output).toContain(keyId);
      expect(result.code).toBe(0);
    });
  });

  it('fails on a hand edit to the published file', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));

      const onDisk = JSON.parse(await readFile(paths.manifest, 'utf8')) as AnnouncementManifest;
      await writeFile(paths.manifest, canonicalJson({ ...onDisk, paused: true }), 'utf8');

      const result = runScript(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain('does not verify');
    });
  });

  it('fails when a signed repository publishes an unsigned manifest', async () => {
    await withTempDir(async (dir) => {
      const { root } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      await writeBuild(paths, await buildManifest(paths, { now: NOW }));

      const result = runScript(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain('carries no signature');
    });
  });

  it('fails when a referenced image has been replaced', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);

      const key = await loadSigningKey(keyPath);
      const { attachImage } = await import('../../images/attach');
      const sharp = (await import('sharp')).default;
      const png = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .png()
        .toBuffer();

      const attached = await attachImage(paths, {
        id: 'reports-center',
        alt: 'A picture',
        source: png,
        filename: 'shot.png',
      });
      await saveRecord(paths, authored({ image: attached.image }));

      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));
      expect(runScript(root).code).toBe(0);

      // Swap the bytes, leaving the signed manifest untouched.
      const imageFile = join(paths.images, attached.image.path.replace('images/', ''));
      await writeFile(imageFile, Buffer.from('not the image that was signed'));

      const result = runScript(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain('has been replaced');
    });
  });

  it('checks the staging channel too', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored({ id: 'a-draft', status: 'draft' }));

      const key = await loadSigningKey(keyPath);
      await writeBuild(
        paths,
        await buildManifest(paths, { now: NOW, channel: 'staging', signingKey: key }),
      );

      const result = runScript(root, ['--channel', 'staging']);
      expect(result.code).toBe(0);
      expect(result.output).toContain('OK  staging');
    });
  });

  it('fails on an orphaned image, which means dist/ was not written by a build', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));
      await writeFile(join(paths.images, 'stray-deadbeef.webp'), Buffer.from([1, 2, 3]));

      const result = runScript(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain('nothing references');
    });
  });

  it('removes nothing and reports cleanly when there is no manifest at all', async () => {
    await withTempDir(async (dir) => {
      const { root } = await keyedRepo(dir);
      await rm(join(root, 'dist', 'announcements.json'));

      const result = runScript(root);
      expect(result.code).toBe(0);
      expect(result.output).toContain('nothing published');
    });
  });
});

describe('the public key travels with the publish', () => {
  it('is committed by the first signed publish, not left for someone to remember', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const git = new AnnouncementRepo(root);
      await git.setIdentity('Test', 'test@example.com');
      // The initial commit happens BEFORE keygen, exactly as it does in life.
      await git.commitPaths(['content', 'dist'], 'Initial');

      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      await publish(paths, {
        now: NOW,
        noPush: true,
        acceptWarnings: true,
        signingKey: await loadSigningKey(keyPath),
      });

      const tracked = await git.log(1);
      expect(tracked).toHaveLength(1);

      // The public key record is in the tree, so CI has something to check
      // the signature against.
      const status = await git.status();
      expect(status.untracked).not.toContain('keys/announcement-signing.pub');
    });
  });

  it('CI fails rather than skipping when a signed manifest has lost its key file', async () => {
    await withTempDir(async (dir) => {
      const { root, keyPath } = await keyedRepo(dir);
      const paths = repoPaths(root);
      await saveRecord(paths, authored());

      const key = await loadSigningKey(keyPath);
      await writeBuild(paths, await buildManifest(paths, { now: NOW, signingKey: key }));

      // Deleting the public key must not be a way to make the check pass.
      await rm(publicKeyPath(root));

      let code = 0;
      let output = '';
      try {
        output = execFileSync('node', [join(root, CI_SCRIPT_FILE)], { cwd: root, encoding: 'utf8' });
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        code = failure.status ?? 1;
        output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      }

      expect(code).toBe(1);
      expect(output).toContain('nothing here');
    });
  });
});
