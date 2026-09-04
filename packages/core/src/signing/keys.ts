/**
 * The signing key: making one, keeping it, and keeping it out of the repository.
 *
 * There is exactly one private key and it authenticates every announcement
 * every install will ever act on. Two rules follow, and both are enforced here
 * rather than left to discipline:
 *
 *   1. **It never goes in a repository.** The announcements repository is
 *      served publicly by GitHub Pages; this project's repository is where the
 *      tooling lives. A key committed to either is a key that has to be rotated
 *      and an app version that has to ship to do it. `saveSigningKey` refuses a
 *      path inside a repository rather than trusting a `.gitignore` line.
 *   2. **The public half goes in, and is meant to.** `keys/announcement-signing.pub`
 *      is committed so CI can verify a pushed manifest and so an operator can
 *      see which key a repository expects. A public key is public.
 *
 * The private key is PKCS#8 PEM at `0600`. Not because a mode bit stops a
 * determined local attacker, but because the failure it does prevent — a key
 * world-readable in a home directory, or swept into a backup — is the likely
 * one.
 */

import { createHash, generateKeyPairSync, type KeyObject, createPrivateKey, createPublicKey } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

import { canonicalJson, KEY_ID_PATTERN, SIGNING_ALGORITHM } from '@ruood/announcement-schema';

/**
 * Where the private key lives unless told otherwise.
 *
 * Outside every repository, in the operator's own home directory, so the
 * default is the safe one and putting it somewhere dangerous takes a flag.
 */
export function defaultKeyPath(): string {
  return join(homedir(), '.ruood', 'announcement-signing.key');
}

/** The public half, committed to the announcements repository. */
export const PUBLIC_KEY_FILE = join('keys', 'announcement-signing.pub');

export function publicKeyPath(repoRoot: string): string {
  return join(repoRoot, PUBLIC_KEY_FILE);
}

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

export interface SigningKey {
  keyId: string;
  /** Base64, raw 32 bytes — the form the manifest and the app carry. */
  publicKey: string;
  privateKey: KeyObject;
}

/** What `keys/announcement-signing.pub` holds. Public, committed, canonical. */
export interface PublicKeyRecord {
  algorithm: string;
  createdAt: string;
  keyId: string;
  publicKey: string;
}

/**
 * The key id: the first 8 hex of the sha256 of the raw public key.
 *
 * Derived rather than assigned, so the id of a key is a fact about the key
 * instead of a label someone has to keep in step with it.
 */
export function keyIdFor(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 8);
}

/** The raw 32 public key bytes, base64, out of any Ed25519 key object. */
export function rawPublicKey(key: KeyObject): string {
  // `createPublicKey` derives a public key from a private one and REJECTS one
  // that is already public, so it can only be applied to the private case.
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // An Ed25519 SPKI is a 12-byte prefix and then the key. Taking the tail is
  // what makes the stored form the same 32 bytes the app will be built with.
  return spki.subarray(-32).toString('base64');
}

/**
 * An Ed25519 public key object rebuilt from the raw 32 bytes.
 *
 * The client is shipped a bare key, not a certificate; this is how those bytes
 * become something `node:crypto` will verify against.
 */
export function publicKeyFromRaw(publicKeyBase64: string): KeyObject {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new SigningKeyError(
      `An Ed25519 public key is 32 bytes; this one is ${raw.length}. The key file is not usable.`,
    );
  }

  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
}

export interface GeneratedKey {
  keyId: string;
  publicKey: string;
  privateKeyPem: string;
}

export function generateSigningKey(now: number): GeneratedKey & { createdAt: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = rawPublicKey(pair.publicKey);

  return {
    keyId: keyIdFor(publicKey),
    publicKey,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    createdAt: `${new Date(now).toISOString().slice(0, 19)}Z`,
  };
}

/**
 * Writes the private key, refusing to overwrite one and refusing a repository.
 *
 * Overwriting is refused because there is no undo: the previous key is what
 * every already-published manifest was signed with, and losing it means every
 * install with the old public key pinned rejects everything until a new app
 * version ships.
 */
export async function saveSigningKey(
  keyPath: string,
  privateKeyPem: string,
  options: { repoRoot?: string } = {},
): Promise<void> {
  const target = resolve(keyPath);

  if (options.repoRoot) assertOutsideRepository(target, options.repoRoot);

  if (existsSync(target)) {
    throw new SigningKeyError(
      `${target} already exists, and overwriting a signing key is not something to do by ` +
        'accident — every manifest already published was signed with it. Move it aside first ' +
        'if you really are rotating.',
    );
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, privateKeyPem, { encoding: 'utf8', mode: 0o600 });

  // Explicit, because `mode` on `writeFile` is subject to the process umask and
  // is a no-op on Windows. Best effort: a failure here is not worth refusing a
  // key that is otherwise correctly placed.
  try {
    await chmod(target, 0o600);
  } catch {
    /* not supported on this platform */
  }
}

/**
 * A repository is not a place for a private key.
 *
 * Checked by path containment rather than by looking for `.gitignore`, because
 * the failure being prevented is precisely the one where the ignore rule is
 * missing, wrong, or added after the first commit.
 */
export function assertOutsideRepository(keyPath: string, repoRoot: string): void {
  const key = resolve(keyPath);
  const root = resolve(repoRoot);
  const inside = relative(root, key);

  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
    throw new SigningKeyError(
      `${key} is inside ${root}. The private signing key must never live in a repository — ` +
        'the announcements repository is served publicly, and a key in git history stays in ' +
        `git history. Put it somewhere like ${defaultKeyPath()}.`,
    );
  }
}

export async function loadSigningKey(keyPath: string): Promise<SigningKey> {
  const target = resolve(keyPath);

  if (!existsSync(target)) {
    throw new SigningKeyError(
      `No signing key at ${target}. Create one with: announce keygen --repo <path>`,
    );
  }

  return signingKeyFromPem(await readFile(target, 'utf8'), target);
}

/**
 * The environment variable a CI run supplies the key through.
 *
 * Publishing moved into a GitHub Actions workflow, and a workflow's secret
 * arrives in the environment. Writing it to a file first would work — a runner
 * is an ephemeral VM — but it would leave the key on a disk for the length of
 * the job, and in a temporary file that a later step, or a compromised action,
 * could read. Taking it from the environment keeps it in one process.
 */
export const SIGNING_KEY_ENV = 'ANNOUNCEMENT_SIGNING_KEY';

/**
 * The key from the environment, or `null` when it is not set.
 *
 * `null` rather than a throw: not having it set is the ordinary case for every
 * local run, and only the caller knows whether that is a problem.
 */
export function signingKeyFromEnvironment(
  environment: Record<string, string | undefined>,
): SigningKey | null {
  const pem = environment[SIGNING_KEY_ENV];
  if (!pem || pem.trim().length === 0) return null;

  return signingKeyFromPem(pem, `$${SIGNING_KEY_ENV}`);
}

/**
 * A PEM private key, checked and turned into a `SigningKey`.
 *
 * `source` names where it came from, so the message says "$ANNOUNCEMENT_SIGNING_KEY
 * is not a readable private key" rather than naming a path that does not exist.
 */
export function signingKeyFromPem(pem: string, source: string): SigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new SigningKeyError(`${source} is not a readable private key: ${(error as Error).message}`);
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new SigningKeyError(
      `${source} is a ${privateKey.asymmetricKeyType ?? 'unknown'} key; announcements are ` +
        `signed with ${SIGNING_ALGORITHM}.`,
    );
  }

  const publicKey = rawPublicKey(createPublicKey(privateKey));
  return { keyId: keyIdFor(publicKey), publicKey, privateKey };
}

export async function savePublicKeyRecord(
  repoRoot: string,
  record: PublicKeyRecord,
): Promise<string> {
  const target = publicKeyPath(repoRoot);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(record), 'utf8');
  return target;
}

/** The public key a repository expects its manifests to be signed with. */
export async function loadPublicKeyRecord(repoRoot: string): Promise<PublicKeyRecord | null> {
  const target = publicKeyPath(repoRoot);
  if (!existsSync(target)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    throw new SigningKeyError(`${target} is not readable JSON: ${(error as Error).message}`);
  }

  const record = parsed as Partial<PublicKeyRecord>;
  if (
    typeof record.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(record.keyId) ||
    typeof record.publicKey !== 'string'
  ) {
    // A corrupt public key file must never read as "no key is expected" — that
    // would silently turn signature checking off for the whole repository.
    throw new SigningKeyError(
      `${target} does not hold a usable public key. It is what says which key this ` +
        'repository trusts, so publishing is refused until it is repaired.',
    );
  }

  return {
    algorithm: record.algorithm ?? SIGNING_ALGORITHM,
    createdAt: record.createdAt ?? '',
    keyId: record.keyId,
    publicKey: record.publicKey,
  };
}
