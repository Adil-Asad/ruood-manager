import { relative } from 'node:path';

import {
  defaultKeyPath,
  generateSigningKey,
  loadPublicKeyRecord,
  publicKeyPath,
  savePublicKeyRecord,
  saveSigningKey,
  SigningKeyError,
} from '@ruood/announcement-core';
import { SIGNING_ALGORITHM } from '@ruood/announcement-schema';

import { flagBool, flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';

/**
 * Creates the signing key pair.
 *
 * Run once per repository, and then essentially never again — the public half
 * is compiled into RUOOD Lab, so rotating means shipping an app version, and
 * every install still on the old build rejects everything signed by the new key
 * until it updates. That is why this refuses to overwrite an existing key
 * rather than asking.
 *
 * The private half goes outside every repository; the public half is committed,
 * because that is what lets CI verify a push and what tells an operator which
 * key a repository expects.
 */
export async function runKeygen(ctx: CommandContext): Promise<CommandResult> {
  const keyPath = flagString(ctx.args, 'key') ?? defaultKeyPath();

  const existing = await loadPublicKeyRecord(ctx.repoRoot);
  if (existing && !flagBool(ctx.args, 'force')) {
    ctx.err(`${ctx.repoRoot} already expects key "${existing.keyId}".`);
    ctx.err('');
    ctx.err(
      'Generating another one is a key rotation, and a rotation is an app release: the public ' +
        'key is compiled into RUOOD Lab, so every install on the old build would reject ' +
        'everything signed by the new key until it updates.',
    );
    ctx.err('');
    ctx.err('If that is genuinely what you want: announce keygen --force --repo <path>');
    return 1;
  }

  const generated = generateSigningKey(ctx.now);

  try {
    await saveSigningKey(keyPath, generated.privateKeyPem, { repoRoot: ctx.repoRoot });
  } catch (error) {
    ctx.err((error as SigningKeyError).message);
    return 1;
  }

  await savePublicKeyRecord(ctx.repoRoot, {
    algorithm: SIGNING_ALGORITHM,
    createdAt: generated.createdAt,
    keyId: generated.keyId,
    publicKey: generated.publicKey,
  });

  ctx.out(`Created an ${SIGNING_ALGORITHM} signing key.`);
  ctx.out('');
  ctx.out(`  key id       ${generated.keyId}`);
  ctx.out(`  private      ${keyPath}`);
  ctx.out(
    `  public       ${relative(ctx.repoRoot, publicKeyPath(ctx.repoRoot)).replace(/\\/g, '/')} ` +
      '(committed — a public key is public)',
  );
  ctx.out('');
  ctx.out('  public key, for the app build:');
  ctx.out(`  ${generated.publicKey}`);
  ctx.out('');
  ctx.out('THE PRIVATE KEY IS NOT RECOVERABLE. Back it up somewhere you would back up a');
  ctx.out('password. Losing it means every install rejects everything you publish afterwards,');
  ctx.out('until a new app version ships with a new public key.');
  ctx.out('');
  ctx.out('Next:');
  ctx.out('  1. commit keys/announcement-signing.pub');
  ctx.out('  2. sign a publish:  announce publish --sign');
  ctx.out('  3. Phase 4: compile the public key above into RUOOD Lab');

  return 0;
}
