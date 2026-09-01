#!/usr/bin/env node
/**
 * Copies `@ruood/announcement-schema` into a consuming app.
 *
 * Usage:
 *   node scripts/sync-schema.mjs --to <dir>            copy
 *   node scripts/sync-schema.mjs --to <dir> --check    fail if it has drifted
 *
 * ## Why copy rather than depend
 *
 * RUOOD Lab is a separate repository that builds on EAS, where this workspace
 * does not exist. A `file:` dependency on a sibling folder resolves on the
 * operator's machine and nowhere else, npm is not an option for an unpublished
 * private package, and a submodule is a lot of machinery for thirteen files
 * with no dependencies.
 *
 * So the source of truth stays here and the app carries a copy. "One validator,
 * two consumers" survives because the copy is byte-identical and `--check`
 * says so — run it in this repository whenever the schema changes, before
 * shipping an app version.
 *
 * The copied files carry a generated header naming this script, because the one
 * way this arrangement fails is somebody editing the copy.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', 'packages', 'schema', 'src');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Copied from @ruood/announcement-schema in the RUOOD Announcement Manager
 * workspace by \`scripts/sync-schema.mjs\`. Edit it there; run the script again
 * to bring the change across.
 *
 * The Manager and this app validate through the SAME code, which is what stops
 * a manifest the Manager will publish from being one this app cannot read.
 */
`;

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

async function sourceFiles() {
  const entries = await readdir(SOURCE, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
}

const args = parseArgs(process.argv.slice(2));
const target = args.get('to');
const check = args.has('check');

if (typeof target !== 'string') {
  process.stderr.write('--to <dir> is required.\n');
  process.exit(2);
}

const targetDir = resolve(target);
const names = await sourceFiles();

let drifted = 0;
let written = 0;

if (!check) await mkdir(targetDir, { recursive: true });

for (const name of names) {
  const body = await readFile(join(SOURCE, name), 'utf8');
  const contents = `${HEADER}\n${body}`;
  const destination = join(targetDir, name);

  if (check) {
    if (!existsSync(destination)) {
      process.stderr.write(`MISSING  ${name}\n`);
      drifted += 1;
      continue;
    }
    if ((await readFile(destination, 'utf8')).replace(/\r\n/g, '\n') !== contents.replace(/\r\n/g, '\n')) {
      process.stderr.write(`DRIFTED  ${name}\n`);
      drifted += 1;
    }
    continue;
  }

  await writeFile(destination, contents, 'utf8');
  written += 1;
}

if (check) {
  if (drifted > 0) {
    process.stderr.write(
      `\n${drifted} file(s) differ from packages/schema/src.\n` +
        'The app is validating with different code than the Manager publishes with.\n' +
        `Fix: node scripts/sync-schema.mjs --to ${target}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`OK  ${names.length} file(s) match packages/schema/src.\n`);
  process.exit(0);
}

process.stdout.write(`Copied ${written} file(s) to ${targetDir}\n`);
