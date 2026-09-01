/**
 * What a signature covers, and how a signed manifest is judged.
 *
 * The channel controls what RUOOD Lab displays and where it navigates, so the
 * practical threat is one bad file: a compromised repository, a hijacked Pages
 * domain, a proxy on a hostile network. A signature answers it without a
 * backend — the app carries a public key it was built with, and refuses
 * anything not signed by the matching private one.
 *
 * ## The signature is over the whole manifest
 *
 * The record shape reserved a per-record `signature` field in v1, and it is
 * still reserved. It is not what secures the file, because a per-record
 * signature leaves the three highest-impact tampering targets untouched:
 *
 *   `paused`      the kill switch. Flipping it off resumes every announcement
 *                 on every install, or flipping it on silences all of them.
 *   `revision`    replay. An old manifest, re-served, is a valid old manifest.
 *   record set    removal. Deleting a signed record needs no forgery at all.
 *
 * A signature over the envelope covers all three, plus every record inside it.
 *
 * ## The covered bytes are the CANONICAL COMPACT form
 *
 * Not the file as written. `dist/announcements.json` is pretty-printed so it
 * diffs like source; a signature that broke when a file was reformatted would
 * be a signature nobody could verify twice. So both sides re-derive the covered
 * bytes with `canonicalCompactJson`, and both sides do it with THIS function.
 *
 * `signature` is removed before signing, for the obvious reason. `keyId` is
 * NOT — it is signed along with everything else, so it cannot be swapped to
 * point at some other key after the fact.
 *
 * Unknown fields are covered too, and deliberately: canonicalising the envelope
 * as received means an attacker who *adds* a field changes the covered bytes
 * and the signature stops verifying. Tolerating unknown fields is a rule about
 * what a client may still read, never a licence to leave them unauthenticated.
 *
 * ## No crypto lives here
 *
 * This package is zero-dependency and platform-neutral: no `crypto`, no
 * `Buffer`, nothing a Hermes bundle does not have. So it defines what is
 * signed and what the answer means, and the actual Ed25519 verification is
 * injected by the consumer — `node:crypto` in the Manager, a Hermes-compatible
 * implementation in RUOOD Lab. There is still only one definition of the
 * covered bytes, which is the part that could silently disagree.
 */

import { canonicalCompactJson } from './canonical';
import { isPlainObject } from './validate-record';

/** The one algorithm. One algorithm means one thing to reason about. */
export const SIGNING_ALGORITHM = 'ed25519';

/**
 * A key id: the first 8 hex characters of the sha256 of the raw public key.
 *
 * Short because it is only a *hint* — it tells the client which of its pinned
 * keys to try, and tells an operator which key signed a file they are looking
 * at. It is never itself a credential, and a client that does not recognise one
 * refuses the manifest rather than trying its keys in turn.
 */
export const KEY_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Base64, which is what an Ed25519 signature and a raw public key are carried as. */
export const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** An Ed25519 signature is 64 bytes, which is 88 base64 characters with padding. */
export const SIGNATURE_BASE64_LENGTH = 88;

/** An Ed25519 public key is 32 bytes: 44 base64 characters with padding. */
export const PUBLIC_KEY_BASE64_LENGTH = 44;

/**
 * The exact string a signature is computed over.
 *
 * Takes the envelope **as received**, not a reconstructed one — a manifest
 * rebuilt from the fields a client understands would omit anything it does not,
 * and would therefore canonicalise to different bytes than the signer signed.
 */
export function manifestSigningInput(envelope: unknown): string {
  if (!isPlainObject(envelope)) return canonicalCompactJson(null);

  const covered: Record<string, unknown> = { ...envelope };
  delete covered.signature;

  return canonicalCompactJson(covered);
}

/**
 * Verifies one signature. Supplied by the consumer, never implemented here.
 *
 * Returns a plain boolean and must not throw — a verifier that throws on a
 * malformed signature would turn "this file is not trustworthy", which is a
 * handled outcome, into a crash on the startup path.
 */
export type SignatureVerifier = (
  /** The exact string returned by `manifestSigningInput`. */
  input: string,
  /** The base64 signature from the manifest. */
  signature: string,
  /** The base64 raw public key to check it against. */
  publicKey: string,
) => boolean;

/** A public key the client is willing to trust, keyed by its id. */
export interface TrustedKey {
  keyId: string;
  /** Base64, raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export type SignatureVerdict =
  | { ok: true; keyId: string }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'unknown-key' | 'bad-signature';
      detail: string;
    };

/**
 * Whether a manifest is signed by a key the caller trusts.
 *
 * Every failure is a refusal, never a downgrade. There is no "signed but by an
 * unknown key, so show it anyway" — that would make the pinning pointless, and
 * an unverifiable manifest is precisely the case the mechanism exists for.
 */
export function verifyManifestSignature(
  envelope: unknown,
  trusted: readonly TrustedKey[],
  verify: SignatureVerifier,
): SignatureVerdict {
  if (!isPlainObject(envelope)) {
    return { ok: false, reason: 'malformed', detail: 'Manifest is not an object.' };
  }

  const signature = envelope.signature;
  const keyId = envelope.keyId;

  if (signature === undefined || signature === null || keyId === undefined) {
    return { ok: false, reason: 'missing', detail: 'Manifest carries no signature.' };
  }

  if (
    typeof signature !== 'string' ||
    typeof keyId !== 'string' ||
    !KEY_ID_PATTERN.test(keyId) ||
    signature.length !== SIGNATURE_BASE64_LENGTH ||
    !BASE64_PATTERN.test(signature)
  ) {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'signature or keyId is not of the expected form.',
    };
  }

  const key = trusted.find((candidate) => candidate.keyId === keyId);
  if (!key) {
    return {
      ok: false,
      reason: 'unknown-key',
      detail: `Manifest is signed by key "${keyId}", which this build does not trust.`,
    };
  }

  // A verifier that throws would turn a handled outcome into a crash on the
  // startup path, so a throw is read as "did not verify".
  let verified = false;
  try {
    verified = verify(manifestSigningInput(envelope), signature, key.publicKey);
  } catch {
    verified = false;
  }

  return verified
    ? { ok: true, keyId }
    : {
        ok: false,
        reason: 'bad-signature',
        detail: `Signature does not match key "${keyId}". The file has been altered.`,
      };
}
