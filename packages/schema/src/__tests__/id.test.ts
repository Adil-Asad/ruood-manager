import {
  checkIdAvailable,
  checkIdFormat,
  isValidId,
  nextAvailableId,
  suggestId,
} from '../id';

describe('checkIdFormat', () => {
  it.each(['abc', 'reports-center', 'reports-center-launch', 'v25', '2026-09-notice'])(
    'accepts %s',
    (id) => {
      expect(checkIdFormat(id)).toEqual({ ok: true });
      expect(isValidId(id)).toBe(true);
    },
  );

  it.each([
    ['Reports-Center', 'uppercase'],
    ['reports_center', 'an underscore'],
    ['reports center', 'a space'],
    ['-reports', 'a leading hyphen'],
    ['reports-', 'a trailing hyphen'],
    ['reports--center', 'a doubled hyphen'],
    ['reports.center', 'a dot'],
    ['reports/center', 'a slash'],
  ])('rejects %s (%s)', (id) => {
    expect(checkIdFormat(id)).toEqual({ ok: false, problem: 'format' });
  });

  it('reports length problems distinctly from format problems', () => {
    expect(checkIdFormat('ab')).toEqual({ ok: false, problem: 'too-short' });
    expect(checkIdFormat('a'.repeat(65))).toEqual({ ok: false, problem: 'too-long' });
    expect(checkIdFormat('a'.repeat(64))).toEqual({ ok: true });
  });

  it.each([null, undefined, 42, {}, ['abc']])('rejects the non-string %p', (value) => {
    expect(checkIdFormat(value)).toEqual({ ok: false, problem: 'format' });
  });
});

describe('checkIdAvailable', () => {
  const registry = {
    active: ['reports-center-launch', 'backup-reminder'],
    retired: ['old-notice'],
  };

  it('accepts an unused id', () => {
    expect(checkIdAvailable('new-thing', registry)).toEqual({ available: true });
  });

  it('rejects an id already in content, including a draft or an archived record', () => {
    expect(checkIdAvailable('reports-center-launch', registry)).toEqual({
      available: false,
      reason: 'duplicate',
    });
  });

  it('rejects a retired id for ever', () => {
    // The rule that matters: a deleted announcement's id still keys impression
    // state on every device that ever saw it.
    expect(checkIdAvailable('old-notice', registry)).toEqual({
      available: false,
      reason: 'retired',
    });
  });

  it('distinguishes duplicate from retired, because the fix differs', () => {
    const duplicate = checkIdAvailable('backup-reminder', registry);
    const retired = checkIdAvailable('old-notice', registry);
    expect(duplicate).not.toEqual(retired);
  });
});

describe('suggestId', () => {
  it('slugifies a title', () => {
    expect(suggestId('Reports Center')).toBe('reports-center');
    expect(suggestId('Reports Center is here!')).toBe('reports-center-is-here');
  });

  it('collapses punctuation runs rather than doubling hyphens', () => {
    expect(suggestId('Backup  --  now')).toBe('backup-now');
  });

  it('never returns an id that would fail validation', () => {
    for (const title of ['Reports Center', '  Spaced  Out  ', 'v2.5 is out']) {
      const id = suggestId(title);
      expect(id).not.toBeNull();
      expect(isValidId(id as string)).toBe(true);
    }
  });

  it('returns null rather than inventing something unrecognisable', () => {
    expect(suggestId('!!!')).toBeNull();
    expect(suggestId('')).toBeNull();
    expect(suggestId('ab')).toBeNull();
  });

  it('truncates a long title without leaving a trailing hyphen', () => {
    const id = suggestId(`${'word '.repeat(40)}end`);
    expect(id).not.toBeNull();
    expect(isValidId(id as string)).toBe(true);
    expect(id!.length).toBeLessThanOrEqual(64);
  });
});

describe('nextAvailableId', () => {
  const registry = { active: ['reports-center'], retired: ['reports-center-2'] };

  it('returns the base when it is free', () => {
    expect(nextAvailableId('brand-new', registry)).toBe('brand-new');
  });

  it('skips both taken and retired candidates', () => {
    expect(nextAvailableId('reports-center', registry)).toBe('reports-center-3');
  });

  it('rejects an invalid base rather than repairing it', () => {
    expect(nextAvailableId('Reports Center', registry)).toBeNull();
  });
});
