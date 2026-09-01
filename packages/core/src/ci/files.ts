/**
 * What CI runs in the announcements repository.
 *
 * Scaffolded into the repository rather than run from here, because the thing
 * CI has to catch is a commit the Manager did not produce: a hand edit, a
 * force-push, a well-meaning fix applied straight on GitHub. A check that only
 * ever ran on the publishing machine would miss all of it.
 *
 * ## Why it verifies rather than re-validates
 *
 * Every field rule was already enforced at publish time by
 * `verifyPublishable`, which runs the client's own parser over the exact bytes.
 * Repeating that in CI would need a copy of the validator, and a copy is a
 * thing that drifts. So CI asks the one question publish time cannot answer:
 *
 *     is this file still the file the Manager signed?
 *
 * The signature answers it completely. It covers the whole envelope, so a
 * changed record, a flipped kill switch, a rolled-back revision and an added
 * field all fail it. Images are checked against the hashes inside that signed
 * manifest, which extends the same guarantee to the bytes beside it.
 *
 * ## The one duplicated piece, and why it is safe
 *
 * The script carries its own `canonicalCompactJson`. It has to: its whole
 * value is being independent of this toolchain — no npm install, no access to
 * this repository, nothing but the Node that GitHub Actions already has.
 *
 * If that copy ever drifts from `@ruood/announcement-schema`'s, CI fails on
 * every correctly signed manifest, immediately and loudly. That is the safe
 * direction for a duplicate to fail in: it cannot quietly start passing files
 * it should refuse.
 */

export const CI_WORKFLOW_FILE = '.github/workflows/verify.yml';
export const CI_SCRIPT_FILE = 'scripts/verify-manifest.mjs';

export const CI_WORKFLOW = `# Verifies that dist/ is still what the Announcement Manager signed.
#
# Runs on every push and pull request. It needs no dependencies and no secrets:
# the public key it checks against is committed, because a public key is public.
name: Verify announcements

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # No \`npm install\`. The script is deliberately dependency-free so that a
      # supply-chain problem cannot sit between a push and this check.
      - name: Verify the published manifest
        run: node scripts/verify-manifest.mjs

      - name: Verify the staging manifest
        run: node scripts/verify-manifest.mjs --channel staging
`;

export const CI_SCRIPT = `#!/usr/bin/env node
/**
 * Verifies that a published manifest is still the file the Manager signed.
 *
 * Usage:  node scripts/verify-manifest.mjs [--channel production|staging]
 *
 * Exits 0 on success, 1 on a verification failure, and 0 with a notice when
 * there is nothing to check yet (no manifest, or no key). "Not signed yet" is a
 * legitimate state for a repository whose operator has not run \`announce
 * keygen\`; "signed with the wrong key" is not.
 *
 * Zero dependencies, deliberately. It has to work with nothing but the Node
 * that CI already has, or it cannot be the thing that checks the toolchain.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const channelArg = process.argv.indexOf('--channel');
const channel = channelArg === -1 ? 'production' : process.argv[channelArg + 1];

if (channel !== 'production' && channel !== 'staging') {
  fail(\`--channel must be production or staging, not "\${channel}".\`);
}

const distDir = channel === 'staging' ? join(ROOT, 'dist', 'staging') : join(ROOT, 'dist');
const manifestFile = join(distDir, 'announcements.json');
const imagesDir = join(distDir, 'images');
const keyFile = join(ROOT, 'keys', 'announcement-signing.pub');

// ---------------------------------------------------------------------------

if (!existsSync(manifestFile)) {
  skip(\`No \${rel(manifestFile)} — nothing published on this channel yet.\`);
}

const raw = readFileSync(manifestFile, 'utf8');

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  fail(\`\${rel(manifestFile)} is not valid JSON: \${error.message}\`);
}

if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  fail(\`\${rel(manifestFile)} is not a JSON object.\`);
}

// Revision 0 is the placeholder the scaffold writes so a client fetching before
// the first publish reads a well-formed file rather than a 404. It predates the
// key, so it is unsigned; a build always increments, so nothing else can be 0.
if (manifest.revision === 0) {
  skip(\`\${rel(manifestFile)} is the placeholder — nothing published on this channel yet.\`);
}

// --- the signature ---------------------------------------------------------

const isSigned = manifest.signature !== undefined && manifest.signature !== null;

if (!existsSync(keyFile)) {
  // A signed manifest with no committed public key cannot be checked by
  // anyone. Skipping would make deleting the key file a way to pass.
  if (isSigned) {
    fail(
      \`\${rel(manifestFile)} is signed, but \${rel(keyFile)} is missing — so nothing here \` +
        'can check it. Commit the public key record.',
    );
  }

  skip(
    \`No \${rel(keyFile)} — this repository is not signed yet. \` +
      'Run: announce keygen --repo <path>',
  );
}

const key = JSON.parse(readFileSync(keyFile, 'utf8'));

if (typeof key.keyId !== 'string' || typeof key.publicKey !== 'string') {
  fail(\`\${rel(keyFile)} does not hold a usable public key.\`);
}

if (!isSigned) {
  fail(
    \`\${rel(manifestFile)} carries no signature, but this repository has a signing key. \` +
      'A published file that nobody signed is a published file nobody can trust.',
  );
}

if (manifest.keyId !== key.keyId) {
  fail(
    \`\${rel(manifestFile)} is signed by key "\${manifest.keyId}", but this repository \` +
      \`expects "\${key.keyId}". Every install would reject it.\`,
  );
}

// The covered bytes: the canonical compact form of the envelope, signature
// removed. keyId stays in, so it cannot be swapped after signing.
const covered = { ...manifest };
delete covered.signature;

const verified = verify(
  null,
  Buffer.from(canonicalCompactJson(covered), 'utf8'),
  publicKeyFromRaw(key.publicKey),
  Buffer.from(manifest.signature, 'base64'),
);

if (!verified) {
  fail(
    \`The signature on \${rel(manifestFile)} does not verify.\\n\\n\` +
      '  The file has been changed since it was signed. If that was a hand edit,\\n' +
      '  revert it and republish through the Manager — dist/ is generated, and\\n' +
      '  editing it directly is how a file that no install will accept gets shipped.',
  );
}

// --- the images beside it --------------------------------------------------
//
// Their hashes live inside the manifest, which is now known to be authentic,
// so checking them extends the signature's guarantee to the bytes it names.

const referenced = new Map();

for (const record of Array.isArray(manifest.announcements) ? manifest.announcements : []) {
  if (record && record.image && typeof record.image.path === 'string') {
    referenced.set(record.image.path, record.image);
  }
}

for (const [path, image] of referenced) {
  const file = join(distDir, path.replace(/^images\\//, 'images/'));

  if (!existsSync(file)) {
    fail(\`\${rel(manifestFile)} references \${path}, which does not exist.\`);
  }

  const bytes = readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');

  if (digest !== image.sha256) {
    fail(\`\${path} does not match the sha256 in the signed manifest. It has been replaced.\`);
  }
  if (bytes.length !== image.bytes) {
    fail(\`\${path} is \${bytes.length} bytes; the signed manifest says \${image.bytes}.\`);
  }
}

// An orphan is not a security problem, but it is bytes nothing will request and
// it means dist/ was not written by a build.
if (existsSync(imagesDir)) {
  const names = new Set([...referenced.keys()].map((path) => path.split('/').pop()));
  const orphans = readdirSync(imagesDir).filter((entry) => !names.has(entry));
  if (orphans.length > 0) {
    fail(\`dist/\${channel === 'staging' ? 'staging/' : ''}images/ holds files nothing references: \${orphans.join(', ')}\`);
  }
}

console.log(
  \`OK  \${channel}: \${referenced.size} image(s), \` +
    \`\${Array.isArray(manifest.announcements) ? manifest.announcements.length : 0} record(s), \` +
    \`revision \${manifest.revision}, signed by \${manifest.keyId}\`,
);

// ---------------------------------------------------------------------------

/**
 * Canonical JSON with no whitespace: keys sorted by code unit, undefined
 * members omitted.
 *
 * A deliberate second copy of \`canonicalCompactJson\` from
 * @ruood/announcement-schema. It cannot be imported — the point of this script
 * is that it depends on nothing. If the two ever disagree, every correctly
 * signed manifest fails here, loudly, which is the safe way for a duplicate to
 * break.
 */
function canonicalCompactJson(value) {
  if (value === null) return 'null';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in the manifest.');
    return JSON.stringify(value === 0 ? 0 : value);
  }

  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return \`[\${value.map((entry) => (entry === undefined ? 'null' : canonicalCompactJson(entry))).join(',')}]\`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return \`{\${keys.map((key) => \`\${JSON.stringify(key)}:\${canonicalCompactJson(value[key])}\`).join(',')}}\`;
  }

  throw new Error(\`Cannot serialise \${typeof value}\`);
}

/** An Ed25519 public key object rebuilt from the raw 32 bytes. */
function publicKeyFromRaw(base64) {
  const rawKey = Buffer.from(base64, 'base64');
  if (rawKey.length !== 32) fail(\`The public key is \${rawKey.length} bytes; Ed25519 needs 32.\`);

  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
    format: 'der',
    type: 'spki',
  });
}

function rel(file) {
  return file.slice(ROOT.length + 1).replace(/\\\\/g, '/');
}

function fail(message) {
  console.error(\`FAIL  \${message}\`);
  process.exit(1);
}

function skip(message) {
  console.log(\`SKIP  \${message}\`);
  process.exit(0);
}
`;
