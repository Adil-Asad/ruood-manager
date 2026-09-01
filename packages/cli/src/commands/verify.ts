import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  channelPaths,
  isChannel,
  loadPublicKeyRecord,
  repoPaths,
  trustedKeysFor,
  verifySignedManifest,
  type Channel,
} from '@ruood/announcement-core';

import { flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';

/**
 * Checks a published manifest against the key the repository expects.
 *
 * The same question CI asks, asked locally: is this file still the file the
 * Manager signed? Useful after a merge, after a revert, and any time
 * `dist/` looks like it has been touched by hand.
 *
 * It reads the file on disk rather than the build's own output on purpose. The
 * build verifying its own bytes proves the signer works; this proves what is
 * actually committed still verifies.
 */
export async function runVerify(ctx: CommandContext): Promise<CommandResult> {
  const requested = flagString(ctx.args, 'channel') ?? 'production';
  if (!isChannel(requested)) {
    ctx.err(`--channel must be production or staging, not "${requested}".`);
    return 2;
  }

  const paths = repoPaths(ctx.repoRoot);
  const expected = await loadPublicKeyRecord(ctx.repoRoot);

  if (!expected) {
    ctx.err('This repository has no keys/announcement-signing.pub, so nothing says which key');
    ctx.err('it should be signed by. Create one: announce keygen --repo <path>');
    return 1;
  }

  const channels: Channel[] = requested === 'production' && !flagString(ctx.args, 'channel')
    ? ['production', 'staging']
    : [requested];

  ctx.out(`Repository expects key ${expected.keyId} (${expected.algorithm}).`);
  ctx.out('');

  let failed = false;
  let checked = 0;

  for (const channel of channels) {
    const output = channelPaths(paths, channel);

    if (!existsSync(output.manifest)) {
      // Nothing published on this channel yet is an ordinary state, not a
      // failure — especially for staging.
      ctx.out(`${channel.padEnd(11)} nothing published yet.`);
      continue;
    }

    checked += 1;

    let envelope: unknown;
    try {
      envelope = JSON.parse(await readFile(output.manifest, 'utf8'));
    } catch (error) {
      ctx.err(`${channel.padEnd(11)} NOT VALID JSON: ${(error as Error).message}`);
      failed = true;
      continue;
    }

    // Revision 0 is the placeholder the scaffold writes so a client fetching
    // before the first publish reads a well-formed file rather than a 404. It
    // is unsigned, and correctly so — there was no key when it was written.
    // A build always increments, so revision 0 can only ever be that file.
    if ((envelope as { revision?: number }).revision === 0) {
      ctx.out(`${channel.padEnd(11)} nothing published yet (placeholder manifest).`);
      checked -= 1;
      continue;
    }

    const verdict = verifySignedManifest(envelope, trustedKeysFor(expected));

    if (verdict.ok) {
      ctx.out(`${channel.padEnd(11)} OK — signed by ${verdict.keyId}.`);
      continue;
    }

    failed = true;

    if (verdict.reason === 'missing') {
      ctx.err(`${channel.padEnd(11)} NOT SIGNED.`);
      ctx.err('            Republish with --sign. An unsigned file is one no install can trust.');
      continue;
    }

    ctx.err(`${channel.padEnd(11)} FAILED — ${verdict.detail}`);

    if (verdict.reason === 'bad-signature') {
      ctx.err('');
      ctx.err('            dist/ has been changed since it was signed. It is generated output —');
      ctx.err('            revert the edit and republish through the Manager rather than fixing');
      ctx.err('            the file, or you will ship something no install will accept.');
    }
  }

  if (failed) return 1;

  ctx.out('');
  ctx.out(
    checked === 0
      ? 'Nothing to verify yet.'
      : `${checked} manifest(s) verify against the repository's key.`,
  );

  return 0;
}
