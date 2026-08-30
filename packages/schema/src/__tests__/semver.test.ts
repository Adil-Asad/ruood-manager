import {
  compareVersions,
  isRangeSatisfiable,
  isVersion,
  parseVersion,
  satisfiesVersionRange,
} from '../semver';

describe('parseVersion', () => {
  it('parses a plain release', () => {
    expect(parseVersion('2.5.0')).toEqual({
      major: 2,
      minor: 5,
      patch: 0,
      prerelease: [],
      build: null,
    });
  });

  it('parses prerelease and build metadata', () => {
    expect(parseVersion('2.5.0-beta.1+build.7')).toEqual({
      major: 2,
      minor: 5,
      patch: 0,
      prerelease: ['beta', '1'],
      build: 'build.7',
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion('  2.5.0  ')).not.toBeNull();
  });

  it.each([
    ['2.5', 'two components'],
    ['2.5.0.1', 'four components'],
    ['v2.5.0', 'a leading v'],
    ['2.5.x', 'a wildcard'],
    ['02.5.0', 'a leading zero'],
    ['2.5.0-', 'an empty prerelease'],
    ['', 'an empty string'],
    ['not-a-version', 'prose'],
  ])('rejects %s (%s)', (value) => {
    expect(parseVersion(value)).toBeNull();
    expect(isVersion(value)).toBe(false);
  });

  it.each([null, undefined, 250, {}, ['2.5.0']])('rejects the non-string %p', (value) => {
    expect(parseVersion(value)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.1.0', '2.0.9')).toBe(1);
    expect(compareVersions('2.0.1', '2.0.2')).toBe(-1);
    expect(compareVersions('2.5.0', '2.5.0')).toBe(0);
  });

  it('ignores build metadata entirely', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareVersions('1.0.0+build.999', '1.0.0')).toBe(0);
  });

  it('sorts a prerelease before its release', () => {
    expect(compareVersions('2.5.0-beta.1', '2.5.0')).toBe(-1);
    expect(compareVersions('2.5.0', '2.5.0-rc.1')).toBe(1);
  });

  it('compares numeric prerelease identifiers numerically, not as strings', () => {
    // The rule a naive string sort gets backwards.
    expect(compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10')).toBe(-1);
    expect('alpha.9' < 'alpha.10').toBe(false);
  });

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('ranks a shorter identifier set lower, all else equal', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  it('reproduces the precedence chain from the semver specification', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];

    const shuffled = [...ordered].reverse();
    shuffled.sort(compareVersions);
    expect(shuffled).toEqual(ordered);
  });

  it('throws rather than guessing on an unparseable input', () => {
    expect(() => compareVersions('2.5', '2.5.0')).toThrow(TypeError);
  });
});

describe('satisfiesVersionRange', () => {
  it('treats minVersion as inclusive and maxVersion as exclusive', () => {
    const range = { minVersion: '2.4.0', maxVersion: '2.6.0' };

    expect(satisfiesVersionRange('2.4.0', range)).toBe(true);
    expect(satisfiesVersionRange('2.5.9', range)).toBe(true);
    expect(satisfiesVersionRange('2.3.9', range)).toBe(false);
    expect(satisfiesVersionRange('2.6.0', range)).toBe(false);
  });

  it('expresses "every 2.5.x" as min 2.5.0 / max 2.6.0', () => {
    const range = { minVersion: '2.5.0', maxVersion: '2.6.0' };

    expect(satisfiesVersionRange('2.5.0', range)).toBe(true);
    expect(satisfiesVersionRange('2.5.99', range)).toBe(true);
    expect(satisfiesVersionRange('2.6.0', range)).toBe(false);
    expect(satisfiesVersionRange('2.4.9', range)).toBe(false);
  });

  it('treats a null bound as unbounded on that side', () => {
    expect(satisfiesVersionRange('9.9.9', { minVersion: '2.4.0', maxVersion: null })).toBe(true);
    expect(satisfiesVersionRange('0.0.1', { minVersion: null, maxVersion: '2.6.0' })).toBe(true);
    expect(satisfiesVersionRange('1.0.0', { minVersion: null, maxVersion: null })).toBe(true);
  });

  it('admits a prerelease by plain precedence', () => {
    // The deliberate divergence from npm range semantics, documented in semver.ts.
    const range = { minVersion: '2.4.0', maxVersion: '2.6.0' };
    expect(satisfiesVersionRange('2.5.0-beta.1', range)).toBe(true);
  });

  it('excludes a prerelease of the lower bound itself', () => {
    expect(
      satisfiesVersionRange('2.5.0-beta.1', { minVersion: '2.5.0', maxVersion: null }),
    ).toBe(false);
  });

  it('fails closed on an unreadable app version', () => {
    for (const version of ['', 'unknown', null, undefined, 250]) {
      expect(satisfiesVersionRange(version, { minVersion: null, maxVersion: null })).toBe(false);
    }
  });

  it('fails closed on an unreadable bound rather than ignoring it', () => {
    expect(satisfiesVersionRange('2.5.0', { minVersion: '2.5', maxVersion: null })).toBe(false);
    expect(satisfiesVersionRange('2.5.0', { minVersion: null, maxVersion: 'later' })).toBe(false);
  });
});

describe('isRangeSatisfiable', () => {
  it('accepts an ordinary range', () => {
    expect(isRangeSatisfiable({ minVersion: '2.4.0', maxVersion: '2.6.0' })).toBe(true);
  });

  it('accepts a half-open range', () => {
    expect(isRangeSatisfiable({ minVersion: '2.4.0', maxVersion: null })).toBe(true);
    expect(isRangeSatisfiable({ minVersion: null, maxVersion: '2.6.0' })).toBe(true);
  });

  it('rejects transposed bounds', () => {
    expect(isRangeSatisfiable({ minVersion: '2.5.0', maxVersion: '2.4.0' })).toBe(false);
  });

  it('rejects equal bounds, which exclude their own lower bound', () => {
    expect(isRangeSatisfiable({ minVersion: '2.5.0', maxVersion: '2.5.0' })).toBe(false);
  });
});
