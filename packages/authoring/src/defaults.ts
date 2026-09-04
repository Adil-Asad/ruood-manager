/**
 * What a new announcement starts as.
 *
 * The defaults are opinions, and they are the cautious ones — a new record is a
 * draft that interrupts nobody, targets nothing it should not, and expires
 * because someone set an end date rather than because it was forgotten.
 */

import type { AuthoredAnnouncement, StoredStatus } from '@ruood/announcement-schema';

export type { AuthoredAnnouncement, StoredStatus };

/**
 * Everything but the fields `createRecord` fills in.
 *
 * `trigger: 'next-launch'` and `surface: 'modal'` are the two that matter.
 * Next-launch never interrupts work in progress, which is the default the
 * architecture argues for; modal is the surface an operator expects when they
 * write an announcement at all, and downgrading to a banner is a deliberate
 * choice rather than something to discover.
 */
export const DEFAULT_NEW_RECORD = {
  rev: 1,
  minSchema: 1,
  category: 'notice',
  priority: 50,
  display: {
    surface: 'modal',
    trigger: 'next-launch',
    maxImpressions: 1,
    minIntervalHours: 24,
    dismiss: 'permanent',
  },
  targeting: {
    // Web is omitted by default: it has no persistent image cache and no
    // native version to compare, so it is opted into deliberately.
    platforms: ['android', 'ios'],
    minVersion: null,
    maxVersion: null,
  },
} as const satisfies Partial<AuthoredAnnouncement>;
