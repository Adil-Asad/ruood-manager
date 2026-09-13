/**
 * The Expo configuration for the Android Announcement Manager.
 *
 * ## What is deliberately absent
 *
 * **Every secret.** `extra` and `android.config` are compiled into the binary
 * and readable by anyone who unzips the APK, so nothing that must stay private
 * may appear here. In particular:
 *
 *   - the RUOOD announcement signing key (Ed25519 private key) — it lives at
 *     `~/.ruood/announcement-signing.key` on the operator's machine and is
 *     never, under any circumstance, put into an app;
 *   - the Manager bearer token — it is entered once on the Connect screen and
 *     stored in the Android keystore through `expo-secure-store`;
 *   - any GitHub credential — the app never talks to GitHub. The Manager server
 *     does the commit and the push with whatever git is already configured
 *     with on that machine.
 *
 * `packages/mobile/src/__tests__/config.test.ts` asserts that, because a secret
 * added here would be invisible in review and permanent in a published build.
 *
 * **Unnecessary permissions.** The app makes HTTP requests and reads an image
 * the user picks. `INTERNET` is added by the Android build itself; the media
 * picker on Android 13+ uses the photo picker and needs no storage permission.
 * The `permissions: []` below is a positive statement rather than an omission —
 * an empty list is what makes an added one show up in a diff.
 *
 * ## The two signings, which are not the same thing
 *
 *   Android app signing        Google Play or EAS holds the upload/app signing
 *                              key. It authenticates the APK to Android.
 *   RUOOD announcement signing Key id 2bc1e956, on the operator's machine only.
 *                              It authenticates a manifest to RUOOD Lab.
 *
 * They share nothing — not a key, not a store, not a process. Rotating one has
 * no bearing on the other.
 */

import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Which build this is.
 *
 * Set by the EAS profile (see `eas.json`). It changes the app name, the
 * application id and the icon badge so that a preview build and a production
 * build can be installed side by side and told apart at a glance — which is
 * what stops "I tested it on the wrong one".
 *
 * It is NOT the announcement channel. A development build can publish to
 * production and a production build can publish to staging; the app makes the
 * operator choose that per publish, and says which they chose in capitals.
 */
type AppVariant = 'development' | 'preview' | 'production';

const VARIANT = (process.env.APP_VARIANT ?? 'production') as AppVariant;

const IDENTITY: Record<AppVariant, { name: string; packageId: string }> = {
  development: {
    name: 'Announcements (dev)',
    packageId: 'com.ruood.announcementmanager.dev',
  },
  preview: {
    name: 'Announcements (preview)',
    packageId: 'com.ruood.announcementmanager.preview',
  },
  production: {
    name: 'RUOOD Announcements',
    packageId: 'com.ruood.announcementmanager',
  },
};

/**
 * The version users see, and the integer Play orders builds by.
 *
 * `versionCode` is managed remotely by EAS (`autoIncrement` in `eas.json`), so
 * it is deliberately not written here: two builds sharing a version code is a
 * Play upload rejection, and the way that happens is a human editing a number.
 */
const VERSION = '1.0.0';

/**
 * The EAS project builds are uploaded to: `@adill/ruood-announcement-manager`,
 * whose slug is the `slug` below. Overridden by `EAS_PROJECT_ID` — see the
 * `extra.eas` comment for why it is written down rather than left to `eas init`.
 */
const EAS_PROJECT_ID = '2fd32418-6810-4dc9-a2dc-07e38d247469';

export default ({ config }: ConfigContext): ExpoConfig => {
  const identity = IDENTITY[VARIANT];

  return {
    ...config,
    name: identity.name,
    slug: 'ruood-announcement-manager',
    scheme: 'ruood-manager',
    version: VERSION,
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,

    /**
     * Android only, and stated rather than left to the default.
     *
     * Expo's default is `['ios', 'android', 'web']`, and leaving it there is not
     * harmless: pressing `w` in `expo start` — or Expo falling back to web when
     * no device is attached — tries to bundle for a platform this app has no
     * dependencies for, and fails with a wall of "Unable to resolve
     * react-native-web/..." that says nothing about the real problem.
     *
     * The fix is not to install `react-native-web`. This app is a native client
     * whose whole security model rests on `expo-secure-store` putting the
     * bearer token in the Android keystore; on web that degrades to
     * `localStorage`, which is readable by any script on the page. A web build
     * would be a worse-secured version of the same tool, and the desktop
     * Manager already exists for the browser — served by the very process this
     * app talks to.
     *
     * So the platform list is closed. `w` now says the platform is unsupported,
     * which is true and is one line instead of forty.
     */
    platforms: ['android'],

    icon: './assets/icon.png',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#12100E',
    },

    assetBundlePatterns: ['**/*'],

    android: {
      package: identity.packageId,
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#12100E',
      },
      // Positive and empty. An added permission then shows up in a diff rather
      // than arriving with a library nobody audited.
      permissions: [],
      /**
       * And this is what the libraries add anyway.
       *
       * `permissions: []` above does not prevent any of it: a config plugin
       * merges INTO the manifest rather than being filtered by that list. The
       * only way to see the truth is to run `expo prebuild` and read the
       * generated `AndroidManifest.xml`, which is what found these — and what
       * `src/__tests__/manifest.test.ts` now does automatically.
       *
       *   RECORD_AUDIO         expo-image-picker, because the same module can
       *                        also record video. This app picks a still image
       *                        and nothing else, so "wants your microphone" on
       *                        the Play listing would be untrue and alarming.
       *   WRITE_EXTERNAL_STORAGE
       *                        expo-image-picker again. The app only ever
       *                        READS one chosen image; it writes nothing to
       *                        shared storage, ever.
       *   CAMERA               expo-image-picker a third time, because it can
       *                        also LAUNCH the camera. This app only ever calls
       *                        `launchImageLibraryAsync`. Found by dumping the
       *                        permissions of the installed APK — it survives
       *                        into a release build, so it is not merely a
       *                        development-build artefact.
       *   SYSTEM_ALERT_WINDOW  React Native's dev-menu overlay. "Display over
       *                        other apps" is one of the permissions users are
       *                        most suspicious of, and a release build has no
       *                        use for it. The dev menu falls back to a dialog.
       *
       * READ_EXTERNAL_STORAGE is deliberately NOT blocked. On Android 13+ the
       * system photo picker needs no permission at all, but this app supports
       * older releases too, and there the picker cannot read the chosen image
       * without it. Blocking it would break attaching an image on those devices
       * — a real capability traded for a line on a listing.
       *
       * VIBRATE and ACCESS_NETWORK_STATE are left as well. VIBRATE comes from
       * React Native core; ACCESS_NETWORK_STATE arrived with `expo-image` in
       * Phase 7, which is what draws the image preview — and specifically what
       * makes an ANIMATED preview move, since React Native's own Image draws
       * frame one and stops. Both are `normal` permissions, granted at install
       * with no prompt, and neither is shown prominently on a listing.
       *
       * USE_BIOMETRIC and USE_FINGERPRINT are ALSO left, deliberately. They
       * arrive with `expo-secure-store`, which is where the Manager bearer
       * token lives. Stripping a permission that the credential store may rely
       * on to protect that token — to tidy a listing — is the wrong side of
       * that trade. They are `normal`-tier and prompt for nothing.
       */
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.CAMERA',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ],
      edgeToEdgeEnabled: true,
    },

    plugins: [
      'expo-router',
      [
        // Cleartext is OFF. It was enabled while the app talked to a Manager
        // server over plain HTTP on a LAN; it now talks to api.github.com and
        // github.com over TLS and nothing else, so allowing cleartext would
        // grant a capability the app has no use for and that a hostile network
        // could use to downgrade a request.
        'expo-build-properties',
        {
          android: {
            usesCleartextTraffic: false,
          },
        },
      ],
      [
        'expo-splash-screen',
        {
          image: './assets/splash.png',
          resizeMode: 'contain',
          backgroundColor: '#12100E',
        },
      ],
      [
        'expo-image-picker',
        {
          // Android 13+ uses the system photo picker, which grants access to
          // the one chosen image and needs no storage permission at all.
          photosPermission:
            'The Manager attaches an image you choose to an announcement. It is read once, ' +
            'encoded, and sent to your own Manager server.',
        },
      ],
    ],

    experiments: {
      typedRoutes: true,
    },

    extra: {
      // The build variant, so a screen can say which app this is. It is not a
      // secret and it is not a capability — nothing is unlocked by changing it.
      appVariant: VARIANT,
      /**
       * The GitHub client id this build signs in with, and the announcements
       * repository it manages.
       *
       * None of it is a secret:
       *
       *   githubClientId       a DEVICE-FLOW client id. The device flow exists
       *                        because a public client cannot keep a secret, so
       *                        there is no client secret to compile in and none
       *                        to extract from the APK.
       *   announcements*       where a public repository lives. GitHub decides
       *                        what a token may do with it; knowing the name
       *                        grants nothing.
       *
       * The announcement SIGNING key is not here and must never be. It is a
       * secret of the publishing workflow in the announcements repository, and
       * neither this app nor the person using it ever needs to see it.
       *
       *   GITHUB_CLIENT_ID=Iv1.xxxx \
       *   ANNOUNCEMENTS_OWNER=Adil-Asad \
       *   ANNOUNCEMENTS_REPO=ruood-announcements \
       *     npx eas build --profile preview --platform android
       *
       * Omitted rather than empty when unset, for the same reason `eas` is: an
       * absent key reads as "not configured", where an empty string reads as
       * something configured to nothing.
       */
      ...(process.env.GITHUB_CLIENT_ID ? { githubClientId: process.env.GITHUB_CLIENT_ID } : {}),
      ...(process.env.ANNOUNCEMENTS_OWNER
        ? { announcementsOwner: process.env.ANNOUNCEMENTS_OWNER }
        : {}),
      ...(process.env.ANNOUNCEMENTS_REPO
        ? { announcementsRepo: process.env.ANNOUNCEMENTS_REPO }
        : {}),
      ...(process.env.ANNOUNCEMENTS_BRANCH
        ? { announcementsBranch: process.env.ANNOUNCEMENTS_BRANCH }
        : {}),
      router: {},
      /**
       * Which EAS project this app builds into.
       *
       * It used to be omitted unless `EAS_PROJECT_ID` was set, on the reasoning
       * that `eas init` is an account-scoped action and therefore the
       * operator's. That was right about whose decision it is and wrong about
       * where the answer lands: `eas init` cannot write into a `.ts` config, so
       * run anywhere near this repository it writes an `app.json` beside
       * whatever directory it was in — and at the WORKSPACE ROOT that produces
       * a second Expo project whose `package.json` has no `main`. The bundler
       * then falls back to `expo/AppEntry.js` and dies on `../../App`, which is
       * exactly how the preview build failed.
       *
       * So the id is recorded here, where the rest of this app's identity
       * lives. It is not a credential — it names a project, and the account
       * that owns it is what authorises anything. `EAS_PROJECT_ID` still wins,
       * so building into a different project stays one variable away.
       */
      eas: { projectId: process.env.EAS_PROJECT_ID ?? EAS_PROJECT_ID },
    },
  };
};
