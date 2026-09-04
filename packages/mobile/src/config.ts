/**
 * What this build knows before anybody signs in.
 *
 * ## What replaced MANAGER_URL
 *
 * A previous version of this app was compiled with the address of a Manager
 * server running on the operator's PC. That made the product depend on one
 * machine being awake, and made a network change a rebuild.
 *
 * What is compiled in now is a **GitHub client id** and the **coordinates of
 * the announcements repository**. Neither is a secret and neither is a
 * capability:
 *
 *   - a device-flow client id is public by design. It is not a client secret;
 *     the device flow exists precisely because a public client cannot keep one.
 *   - `owner/repo` is where a public repository lives. Knowing it grants
 *     nothing — GitHub decides what a token may do with it.
 *
 * `__tests__/config.test.ts` still sweeps the built config for anything that
 * looks like a real secret, and the announcement signing key is not here,
 * anywhere, ever: it is a secret of the publishing workflow, and neither this
 * app nor the person using it needs to see it.
 *
 * ## The two repositories, named separately
 *
 * The Manager repository builds this app. The announcements repository holds
 * the announcements. This app is a client of the second, addressed at runtime —
 * so pointing a build at a different announcements repository is an
 * environment variable, not a code change, and neither repository contains the
 * other.
 */

import Constants from 'expo-constants';

import type { AppEnvironment } from '@ruood/announcement-client';
import type { RepositoryRef } from '@ruood/announcement-github';

interface Extra {
  appVariant?: string;
  githubClientId?: string;
  announcementsOwner?: string;
  announcementsRepo?: string;
  announcementsBranch?: string;
}

function extra(): Extra {
  return (Constants.expoConfig?.extra ?? {}) as Extra;
}

/**
 * The GitHub App (or OAuth App) client id this build signs in with.
 *
 * Public. A device-flow client has no secret — that is the whole reason it is
 * usable from an APK, where anything compiled in is readable by anyone who
 * unzips the file.
 */
export function compiledClientId(): string {
  return (extra().githubClientId ?? '').trim();
}

/**
 * The announcements repository this build manages.
 *
 * `branch` defaults to `main` because that is what the publish workflow
 * triggers on; a build pointed at a different branch would write content
 * nothing publishes.
 */
export function announcementsRepository(): RepositoryRef {
  const values = extra();

  return {
    owner: (values.announcementsOwner ?? '').trim(),
    repo: (values.announcementsRepo ?? '').trim(),
    branch: (values.announcementsBranch ?? 'main').trim() || 'main',
  };
}

/** Whether this build knows which repository it manages. Not overridable. */
export function hasRepository(): boolean {
  const repository = announcementsRepository();
  return repository.owner.length > 0 && repository.repo.length > 0;
}

/**
 * Whether this build has been told everything it needs.
 *
 * Checked before the sign-in screen is shown, so a misconfigured build says so
 * plainly instead of offering a sign-in that could never succeed.
 */
export function isConfigured(): boolean {
  return compiledClientId().length > 0 && hasRepository();
}

/** Which build this is: `development`, `preview` or `production`. */
export function appVariant(): AppEnvironment {
  const value = extra().appVariant;
  return value === 'development' || value === 'preview' ? value : 'production';
}

/**
 * Whether this build shows developer tools at all.
 *
 * A production build hides the diagnostics screen completely — the technical
 * detail exists, and an ordinary administrator never encounters it.
 */
export function developerToolsAvailable(): boolean {
  return appVariant() !== 'production' || __DEV__;
}

/**
 * Re-exported so a screen has one import for "things about this build".
 *
 * DEFINED in `brand.ts`, which depends on nothing: this module imports
 * `expo-constants`, and anything importing it is out of reach of the node-only
 * jest config. `language.ts` decides every word an administrator reads and must
 * stay testable.
 */
export { PRODUCT_NAME } from './brand';
