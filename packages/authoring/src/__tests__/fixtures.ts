/**
 * A valid authored record, and the fixed clock every test here uses.
 *
 * A local copy rather than an import from `core`: this package is
 * platform-neutral and `core` is not, so reaching into its tests would drag
 * `node:fs` into a suite whose whole point is that it needs none.
 *
 * The fixture builds a VALID record deliberately, so a test asserting
 * "exactly one error" has a clean baseline to work from.
 */

import type { AuthoredAnnouncement } from '@ruood/announcement-schema';

/** 2026-09-15T12:00:00Z — the fixed clock for every test in this package. */
export const NOW = Date.parse('2026-09-15T12:00:00Z');
export const DAY = 24 * 60 * 60 * 1000;

export function iso(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

export function authored(overrides: Partial<AuthoredAnnouncement> = {}): AuthoredAnnouncement {
  return {
    id: 'reports-center',
    rev: 1,
    minSchema: 1,
    title: 'Reports Center',
    body: 'Eight new library reports are available under Tools.',
    category: 'feature',
    priority: 50,
    startAt: iso(NOW - DAY),
    endAt: iso(NOW + 7 * DAY),
    display: {
      surface: 'modal',
      trigger: 'next-launch',
      maxImpressions: 3,
      minIntervalHours: 24,
      dismiss: 'permanent',
    },
    targeting: { platforms: ['android', 'ios'], minVersion: '2.4.0', maxVersion: null },
    status: 'published',
    createdAt: iso(NOW - 30 * DAY),
    updatedAt: iso(NOW - DAY),
    publishedAt: iso(NOW - DAY),
    ...overrides,
  };
}
