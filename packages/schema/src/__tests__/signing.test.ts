/**
 * Signing, tested with real Ed25519.
 *
 * `node:crypto` appears here and nowhere in the package's production code —
 * which is the arrangement being tested as much as the rules are. The schema
 * defines what is covered and what a verdict means; the crypto is injected.
 * A test that stubbed the verifier would prove the plumbing and miss the one
 * thing that matters, which is that the bytes the signer signs are the bytes
 * the verifier checks.
 */

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { canonicalCompactJson, canonicalJson } from '../canonical';
import {
  BASE64_PATTERN,
  KEY_ID_PATTERN,
  manifestSigningInput,
  SIGNATURE_BASE64_LENGTH,
  verifyManifestSignature,
  type SignatureVerifier,
  type TrustedKey,
} from '../signing';
import { parseManifest, parseManifestText } from '../parse-manifest';
import type { AnnouncementManifest } from '../types';
import { NOW, publishedRecord } from './fixtures';

// --- a real Ed25519 pair, and the verifier a consumer would inject ----------

const pair = generateKeyPairSync('ed25519');

/** Raw 32-byte public key as base64 — the form the manifest and app carry. */
const publicKeyBase64 = pair.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64');

const KEY_ID = 'a1b2c3d4';

const trusted: TrustedKey[] = [{ keyId: KEY_ID, publicKey: publicKeyBase64 }];

function signWithTestKey(input: string): string {
  return sign(null, Buffer.from(input, 'utf8'), pair.privateKey).toString('base64');
}

const verifier: SignatureVerifier = (input, signature, publicKey) =>
  verify(
    null,
    Buffer.from(input, 'utf8'),
    createPublicKey({
      // Rebuild SPKI around the raw 32 bytes, which is how a client that was
      // shipped a raw key gets back to something node:crypto will accept.
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(signature, 'base64'),
  );

function manifest(overrides: Partial<AnnouncementManifest> = {}): AnnouncementManifest {
  return {
    schemaVersion: 1,
    revision: 4,
    generatedAt: '2026-09-15T12:00:00Z',
    paused: false,
    announcements: [publishedRecord()],
    ...overrides,
  };
}

/** Signs like the Manager does: keyId in place first, then sign, then attach. */
function signed(base: AnnouncementManifest = manifest()): AnnouncementManifest {
  const withKey = { ...base, keyId: KEY_ID };
  return { ...withKey, signature: signWithTestKey(manifestSigningInput(withKey)) };
}

// ---------------------------------------------------------------------------

describe('what the signature covers', () => {
  it('excludes the signature itself and nothing else', () => {
    const input = manifestSigningInput({ ...manifest(), keyId: KEY_ID, signature: 'xxx' });
    expect(input).toBe(canonicalCompactJson({ ...manifest(), keyId: KEY_ID }));
  });

  it('covers keyId, so it cannot be swapped to point at another key', () => {
    const a = manifestSigningInput({ ...manifest(), keyId: 'a1b2c3d4' });
    const b = manifestSigningInput({ ...manifest(), keyId: 'ffffffff' });
    expect(a).not.toBe(b);
  });

  it('is unaffected by formatting, because it re-derives the canonical form', () => {
    const value = signed();

    // The file on disk is pretty-printed so it diffs like source. A signature
    // that broke on reformatting would be a signature nobody could verify.
    const fromPretty = JSON.parse(canonicalJson(value)) as unknown;
    const fromCompact = JSON.parse(canonicalCompactJson(value)) as unknown;

    expect(manifestSigningInput(fromPretty)).toBe(manifestSigningInput(fromCompact));
  });

  it('covers unknown fields, so one cannot be added after signing', () => {
    const value = signed();
    const tampered = { ...value, injected: 'anything' };

    expect(manifestSigningInput(tampered)).not.toBe(manifestSigningInput(value));
    expect(verifyManifestSignature(tampered, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('verifyManifestSignature', () => {
  it('accepts a manifest signed by a trusted key', () => {
    expect(verifyManifestSignature(signed(), trusted, verifier)).toEqual({
      ok: true,
      keyId: KEY_ID,
    });
  });

  it('produces a signature of the expected shape', () => {
    const value = signed();
    expect(value.signature).toHaveLength(SIGNATURE_BASE64_LENGTH);
    expect(BASE64_PATTERN.test(value.signature!)).toBe(true);
    expect(KEY_ID_PATTERN.test(value.keyId!)).toBe(true);
  });

  // The three tampering targets a per-record signature would have left open.
  it('refuses a flipped kill switch', () => {
    const tampered = { ...signed(), paused: true };
    expect(verifyManifestSignature(tampered, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a rolled-back revision', () => {
    const tampered = { ...signed(), revision: 1 };
    expect(verifyManifestSignature(tampered, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a removed record', () => {
    const tampered = { ...signed(), announcements: [] };
    expect(verifyManifestSignature(tampered, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses an edited record', () => {
    const value = signed();
    const tampered = {
      ...value,
      announcements: [{ ...value.announcements[0]!, title: 'Something else' }],
    };
    expect(verifyManifestSignature(tampered, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a key it was not shipped with, rather than trying the others', () => {
    const other = generateKeyPairSync('ed25519');
    const value = { ...manifest(), keyId: 'deadbeef' };
    const forged = {
      ...value,
      signature: sign(null, Buffer.from(manifestSigningInput(value), 'utf8'), other.privateKey)
        .toString('base64'),
    };

    expect(verifyManifestSignature(forged, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'unknown-key',
    });
  });

  it('refuses a valid signature from the wrong key under a trusted keyId', () => {
    const other = generateKeyPairSync('ed25519');
    const value = { ...manifest(), keyId: KEY_ID };
    const forged = {
      ...value,
      signature: sign(null, Buffer.from(manifestSigningInput(value), 'utf8'), other.privateKey)
        .toString('base64'),
    };

    expect(verifyManifestSignature(forged, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it.each([
    ['no signature at all', {}],
    ['a null signature', { keyId: KEY_ID, signature: null }],
  ])('reports %s as missing rather than as a bad signature', (_label, extra) => {
    expect(verifyManifestSignature({ ...manifest(), ...extra }, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'missing',
    });
  });

  it.each([
    ['a truncated signature', { keyId: KEY_ID, signature: 'abc' }],
    ['a signature that is not a string', { keyId: KEY_ID, signature: 42 }],
    ['a keyId of the wrong shape', { keyId: 'NOT-HEX!', signature: 'a'.repeat(88) }],
  ])('reports %s as malformed', (_label, extra) => {
    expect(verifyManifestSignature({ ...manifest(), ...extra }, trusted, verifier)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('treats a verifier that throws as a failure, never as a crash', () => {
    const throwing: SignatureVerifier = () => {
      throw new Error('the crypto backend is unavailable');
    };

    expect(() => verifyManifestSignature(signed(), trusted, throwing)).not.toThrow();
    expect(verifyManifestSignature(signed(), trusted, throwing)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('the parser refuses a manifest it cannot trust', () => {
  const options = { now: NOW, trustedKeys: trusted, verifySignature: verifier };

  it('accepts a correctly signed manifest and carries the signature through', () => {
    const result = parseManifest(signed(), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.keyId).toBe(KEY_ID);
    expect(result.manifest.announcements).toHaveLength(1);
  });

  it('refuses the WHOLE file when the signature is wrong — no salvaging records', () => {
    const result = parseManifest({ ...signed(), paused: true }, options);

    expect(result).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  it('survives a round trip through the serialised file', () => {
    const result = parseManifestText(canonicalJson(signed()), options);
    expect(result.ok).toBe(true);
  });

  it('ignores signatures entirely when the build has no keys', () => {
    // A build shipped before signing existed must behave exactly as it did.
    const result = parseManifest({ ...signed(), paused: true }, { now: NOW });
    expect(result.ok).toBe(true);
  });

  it('accepts an unsigned manifest unless one is required', () => {
    expect(parseManifest(manifest(), options).ok).toBe(true);

    expect(parseManifest(manifest(), { ...options, requireSignature: true })).toMatchObject({
      ok: false,
      reason: 'signature-required',
    });
  });

  it('fails closed when a signature is required but no key was shipped', () => {
    // Requiring what you cannot check is a misconfiguration, and the only safe
    // reading of it is refusal.
    expect(parseManifest(signed(), { now: NOW, requireSignature: true })).toMatchObject({
      ok: false,
      reason: 'signature-required',
    });
  });

  it('checks the signature before reading any record', () => {
    // A file that does not verify is not a file to take records from, however
    // well-formed they look.
    const tampered = {
      ...signed(),
      announcements: [{ ...publishedRecord(), title: 'Injected' }],
    };

    expect(parseManifest(tampered, options)).toMatchObject({
      ok: false,
      reason: 'signature-invalid',
    });
  });
});
