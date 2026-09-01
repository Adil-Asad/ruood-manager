/**
 * Phase 0's structural guarantees, pinned as tests.
 *
 * Two promises were made when this package was created, and neither is visible
 * in any single file — which is exactly why they need a sweep:
 *
 *  1. the package is ZERO-DEPENDENCY and platform-neutral, so the same code can
 *     run under this node-only jest config and inside RUOOD Lab's Hermes
 *     bundle. This is the same discipline as `modules/reports/engine` and
 *     `constants/material-list-metrics.ts` in RUOOD Lab: a module that must be
 *     unit-testable cannot be allowed to acquire a runtime import;
 *
 *  2. this project is SEPARATE from RUOOD Lab. Nothing here reaches into
 *     `d:\app`, and no path escapes the package.
 *
 * If either regresses, the real tests quietly stop being possible — so the
 * sweep runs alongside them rather than being left to review.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const PACKAGE_ROOT = resolve(SRC, '..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;

  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

const allFiles = sourceFiles(SRC);
const productionFiles = allFiles.filter((file) => !file.includes('__tests__'));

describe('the package has no runtime dependencies', () => {
  it('declares none in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({});
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it('imports only its own modules', () => {
    const offenders: string[] = [];

    for (const file of productionFiles) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) continue;
        offenders.push(`${file.slice(SRC.length + 1)} imports "${specifier}"`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the package is platform-neutral', () => {
  it.each([
    'react',
    'react-native',
    'expo',
    '@react-native-async-storage/async-storage',
    'node:fs',
    'node:path',
    'fs',
    'path',
    // Signing is the standing temptation: `signing.ts` defines WHAT is signed
    // and delegates the Ed25519 itself to the consumer, precisely so that this
    // package keeps running inside a Hermes bundle that has no node:crypto.
    'node:crypto',
    'crypto',
  ])('never imports %s in production code', (banned) => {
    const offenders = productionFiles.filter((file) =>
      importsOf(file).some(
        (specifier) => specifier === banned || specifier.startsWith(`${banned}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it.each(['Buffer', 'process', '__dirname', 'require(', 'window', 'document', 'localStorage'])(
    'never reaches for the host global %s',
    (global) => {
      const offenders = productionFiles.filter((file) =>
        readFileSync(file, 'utf8')
          // Comments legitimately name these while explaining why they are absent.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .includes(global),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('reads the clock nowhere — every rule takes an injected `now`', () => {
    // A scheduling rule that reads the clock itself cannot be pinned to a fixed
    // instant, and so cannot be tested. `now` is a parameter everywhere.
    const offenders = productionFiles.filter((file) => {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return /Date\.now\(\)|new Date\(\s*\)/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the project is separate from RUOOD Lab', () => {
  it('no source file reaches outside the package', () => {
    const offenders: string[] = [];

    for (const file of allFiles) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolve(join(file, '..'), specifier);
        if (!resolved.startsWith(PACKAGE_ROOT)) {
          offenders.push(`${file.slice(SRC.length + 1)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no source file mentions the RUOOD Lab working directory or its alias', () => {
    const offenders: string[] = [];

    // The needle is assembled rather than written out, and this file is skipped,
    // because a literal would otherwise match the scanner itself.
    const labPath = new RegExp(`d:[\\\\/]${'app'}\\b`, 'i');
    const labAlias = /from\s+['"]@\//;

    for (const file of allFiles) {
      if (file === __filename) continue;

      const source = readFileSync(file, 'utf8');
      if (labPath.test(source)) offenders.push(`${file}: absolute path to RUOOD Lab`);
      if (labAlias.test(source)) offenders.push(`${file}: RUOOD Lab's @/ path alias`);
    }

    expect(offenders).toEqual([]);
  });
});

describe('the barrel exports the whole contract', () => {
  it('re-exports every production module', () => {
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');

    for (const file of productionFiles) {
      const name = file.slice(SRC.length + 1).replace(/\.ts$/, '').replace(/\\/g, '/');
      if (name === 'index') continue;
      expect(barrel).toContain(`'./${name}'`);
    }
  });

  it('exposes the entry points the Manager and the app will each need', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('../index') as Record<string, unknown>;

    for (const name of [
      'validateAnnouncementRecord',
      'validateManifest',
      'parseManifest',
      'parseManifestText',
      'verifyPublishable',
      'deriveLifecycleStatus',
      'satisfiesVersionRange',
      'compareVersions',
      'checkIdFormat',
      'checkIdAvailable',
      'parseInstant',
      'isWithinWindow',
      'ROUTE_TARGETS',
      'SUPPORTED_SCHEMA_VERSION',
    ]) {
      expect(api[name]).toBeDefined();
    }
  });
});
