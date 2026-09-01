/**
 * Signing a manifest, and verifying one from the Manager's side.
 *
 * The schema package says WHAT is covered (`manifestSigningInput`) and this
 * says how the bytes are signed. Keeping the split means the Manager and
 * RUOOD Lab cannot disagree about the covered bytes even though they use
 * completely different Ed25519 implementations — which is the failure that
 * would be hardest to notice, because it looks like "the signature is wrong"
 * on every file rather than like a bug.
 */

import { sign, verify, type KeyObject } from 'node:crypto';

import {
  manifestSigningInput,
  verifyManifestSignature,
  type AnnouncementManifest,
  type SignatureVerifier,
  type SignatureVerdict,
  type TrustedKey,
} from '@ruood/announcement-schema';

import { publicKeyFromRaw, type SigningKey } from './keys';

/**
 * The Ed25519 verifier, over `node:crypto`.
 *
 * This is the shape RUOOD Lab will supply its own version of in Phase 4. It
 * never throws: a malformed signature is an answer, not an exception.
 */
export const nodeSignatureVerifier: SignatureVerifier = (input, signature, publicKey) => {
  try {
    return verify(
      null,
      Buffer.from(input, 'utf8'),
      publicKeyFromRaw(publicKey),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
};

/**
 * Returns the manifest with `keyId` and `signature` attached.
 *
 * `keyId` is set BEFORE the signing input is computed, because it is inside
 * the covered bytes — signing first and labelling afterwards would produce a
 * file whose own key id was not authenticated.
 */
export function signManifest(
  manifest: AnnouncementManifest,
  key: SigningKey,
): AnnouncementManifest {
  const withKeyId: AnnouncementManifest = { ...manifest, keyId: key.keyId };

  const signature = sign(
    null,
    Buffer.from(manifestSigningInput(withKeyId), 'utf8'),
    key.privateKey as KeyObject,
  ).toString('base64');

  return { ...withKeyId, signature };
}

/**
 * Checks a manifest against the key a repository says it trusts.
 *
 * Used by the build's own verification step and by `announce verify`. It is the
 * client's check, run by the publisher — the same discipline as
 * `verifyPublishable`: do not merely believe the file is right, run the reader
 * over it.
 */
export function verifySignedManifest(
  envelope: unknown,
  trusted: readonly TrustedKey[],
): SignatureVerdict {
  return verifyManifestSignature(envelope, trusted, nodeSignatureVerifier);
}

/** The trusted-key list for a single key, which is all there ever is today. */
export function trustedKeysFor(key: { keyId: string; publicKey: string }): TrustedKey[] {
  return [{ keyId: key.keyId, publicKey: key.publicKey }];
}
