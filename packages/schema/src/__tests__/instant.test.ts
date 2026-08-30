import {
  instantToEpoch,
  isInstant,
  isWithinWindow,
  parseInstant,
  toCanonicalInstant,
} from '../instant';
import { DAY, NOW, iso } from './fixtures';

describe('parseInstant', () => {
  it('accepts a UTC instant', () => {
    const parsed = parseInstant('2026-09-01T06:00:00Z');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.epochMs).toBe(Date.parse('2026-09-01T06:00:00Z'));
  });

  it('accepts an explicit non-UTC offset and normalises it', () => {
    const parsed = parseInstant('2026-09-01T09:00:00+03:00');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.canonical).toBe('2026-09-01T06:00:00Z');
  });

  it('accepts millisecond precision and minute precision', () => {
    expect(parseInstant('2026-09-01T06:00:00.250Z').ok).toBe(true);
    expect(parseInstant('2026-09-01T06:00Z').ok).toBe(true);
  });

  it('rejects a naive local date, and says why', () => {
    // The bug this module exists to prevent: a wall-clock reading is a
    // different moment on every device.
    for (const value of ['2026-09-01', '2026-09-01T09:00', '2026-09-01T09:00:00']) {
      const parsed = parseInstant(value);
      expect(parsed).toEqual({ ok: false, problem: 'no-offset' });
    }
  });

  it('rejects a syntactically impossible date rather than rolling it over', () => {
    // Date.parse resolves this to March 2nd without complaint.
    expect(parseInstant('2026-02-30T00:00:00Z').ok).toBe(false);
    expect(Number.isFinite(Date.parse('2026-02-30T00:00:00Z'))).toBe(true);
  });

  it('accepts a real leap day and rejects a fictional one', () => {
    expect(parseInstant('2028-02-29T00:00:00Z').ok).toBe(true);
    expect(parseInstant('2026-02-29T00:00:00Z').ok).toBe(false);
  });

  it.each([
    '2026/09/01',
    'September 1, 2026',
    '20260901T060000Z',
    '',
    'now',
  ])('rejects %p as invalid', (value) => {
    expect(parseInstant(value)).toEqual({ ok: false, problem: 'invalid' });
  });

  it.each([null, undefined, 0, 1756704000000, {}, []])(
    'rejects the non-string %p',
    (value) => {
      expect(parseInstant(value).ok).toBe(false);
      expect(isInstant(value)).toBe(false);
    },
  );
});

describe('toCanonicalInstant', () => {
  it('produces second-precision UTC with a trailing Z', () => {
    expect(toCanonicalInstant(Date.parse('2026-09-01T06:00:00.750Z'))).toBe(
      '2026-09-01T06:00:00Z',
    );
  });

  it('round-trips', () => {
    const canonical = toCanonicalInstant(NOW);
    expect(instantToEpoch(canonical)).toBe(NOW);
  });
});

describe('isWithinWindow', () => {
  const start = iso(NOW - DAY);
  const end = iso(NOW + DAY);

  it('is true inside the window', () => {
    expect(isWithinWindow(start, end, NOW)).toBe(true);
  });

  it('includes the start instant and excludes the end instant', () => {
    // Half-open, so a record ending at T and one starting at T are never both live.
    expect(isWithinWindow(start, end, Date.parse(start))).toBe(true);
    expect(isWithinWindow(start, end, Date.parse(end))).toBe(false);
  });

  it('is false before the start', () => {
    expect(isWithinWindow(start, end, NOW - 2 * DAY)).toBe(false);
  });

  it('treats a null end as never expiring', () => {
    expect(isWithinWindow(start, null, NOW + 3650 * DAY)).toBe(true);
  });

  it('fails closed on an unreadable date', () => {
    expect(isWithinWindow('2026-09-01', end, NOW)).toBe(false);
    expect(isWithinWindow(start, 'whenever', NOW)).toBe(false);
    expect(isWithinWindow(undefined, end, NOW)).toBe(false);
  });
});
