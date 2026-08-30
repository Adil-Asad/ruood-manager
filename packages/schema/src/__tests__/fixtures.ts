/**
 * Builders for valid records, so a test can state the one thing it is about.
 *
 * Every builder returns something that PASSES validation with no errors and no
 * warnings. That is deliberate and load-bearing: a test asserting "this
 * produces exactly one error" is only meaningful if the baseline is clean, and
 * a fixture that quietly carried a warning would mask a real one.
 */

import type {
  AuthoredAnnouncement,
  AnnouncementManifest,
  PublishedAnnouncement,
} from '../types';

/** 2026-09-15T12:00:00Z -- the fixed "now" for every test in this package. */
export const NOW = Date.parse('2026-09-15T12:00:00Z');

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function iso(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

export function publishedRecord(
  overrides: Partial<PublishedAnnouncement> = {},
): PublishedAnnouncement {
  return {
    id: 'reports-center-launch',
    rev: 1,
    minSchema: 1,
    title: 'Reports Center',
    body: 'Eight new library reports are now available under Tools.',
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
    targeting: {
      platforms: ['android', 'ios'],
      minVersion: '2.4.0',
      maxVersion: null,
    },
    ...overrides,
  };
}

export function authoredRecord(
  overrides: Partial<AuthoredAnnouncement> = {},
): AuthoredAnnouncement {
  return {
    ...publishedRecord(),
    status: 'published',
    createdAt: iso(NOW - 30 * DAY),
    updatedAt: iso(NOW - DAY),
    publishedAt: iso(NOW - DAY),
    ...overrides,
  };
}

export function manifest(
  records: PublishedAnnouncement[] = [publishedRecord()],
  overrides: Partial<AnnouncementManifest> = {},
): AnnouncementManifest {
  return {
    schemaVersion: 1,
    revision: 47,
    generatedAt: iso(NOW),
    paused: false,
    announcements: records,
    ...overrides,
  };
}

/**
 * A weakly-typed shallow copy, for the tests that delete a required field to
 * prove it is required. A copy rather than a cast, so one test cannot mutate a
 * fixture another test then reads.
 */
export function loose(value: object): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

/**
 * Deliberately invalid data, typed as though it were valid.
 *
 * Every use marks a test that feeds the validator something the type system
 * would otherwise forbid -- which is exactly the input a real malformed
 * manifest supplies at runtime.
 */
export function malformed<T>(value: unknown): T {
  return value as T;
}

export const validImage = {
  path: 'images/reports-center-a3f91c22.webp',
  width: 1080,
  height: 608,
  bytes: 41203,
  sha256: 'a'.repeat(64),
  alt: 'The Reports Center screen',
};
