/**
 * Active or passive delivery — read off the schema, never stored separately.
 *
 * The contract already answers this question with `surface`, and its own
 * definition of `inbox` is "appears only in Settings › Announcements. Never
 * presented." So there is no `passive` flag and there must not be one: a second
 * field saying the same thing as an existing one is a field that can disagree
 * with it, and the client would then have to decide which to believe.
 *
 *     modal   ACTIVE   a blocking dialog, at most one per session
 *     banner  ACTIVE   an inline notice on a list screen, never blocks
 *     inbox   PASSIVE  the inbox only — never interrupts anyone
 *
 * RUOOD Lab enforces exactly this: `isEligible` refuses any record whose
 * surface is not `modal` or `banner`, so a passive announcement can never
 * reach the presenter however eligible it otherwise is.
 *
 * This module exists so the Manager can *say* that to an author in those words,
 * which is the whole of the UI's job here.
 */

import type { Surface } from '@ruood/announcement-schema';

export type Delivery = 'active' | 'passive';

export interface DeliveryDescription {
  kind: Delivery;
  /** The word for it, for a badge. */
  label: string;
  /** What actually happens to a user, in one sentence. */
  detail: string;
}

const DELIVERY: Record<Surface, DeliveryDescription> = {
  modal: {
    kind: 'active',
    label: 'Active',
    detail:
      'Interrupts with a dialog the next time the app opens, at most once per session, and ' +
      'also appears in Settings › Announcements.',
  },
  banner: {
    kind: 'active',
    label: 'Active',
    detail:
      'Appears as an inline notice on a list screen — it never blocks — and also appears in ' +
      'Settings › Announcements.',
  },
  inbox: {
    kind: 'passive',
    label: 'Passive',
    detail:
      'Never interrupts and never opens anything. It waits in Settings › Announcements, and ' +
      'the Settings tab shows an unread dot until it is read.',
  },
};

export function deliveryFor(surface: Surface): DeliveryDescription {
  return DELIVERY[surface];
}

export function isPassive(surface: Surface): boolean {
  return DELIVERY[surface].kind === 'passive';
}
