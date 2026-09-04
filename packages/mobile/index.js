/**
 * The app entry point.
 *
 * This file exists, rather than `package.json` pointing `main` straight at
 * `expo-router/entry`, because of how the release bundle is produced in a
 * monorepo — and the failure it prevents appears only in a release build, which
 * is the worst place to find it.
 *
 * Gradle's `createBundleReleaseJsAndAssets` runs `expo export:embed`. Expo
 * resolves the entry path relative to the **server root**, which in a workspace
 * is the repository root, not this package. npm nests `expo-router` under
 * `packages/mobile/node_modules` (it cannot hoist it: the repository root holds
 * React 18 for the desktop Manager's browser client, and expo-router needs
 * React 19), so `expo-router/entry` resolved from the repository root points at
 * a path that does not exist:
 *
 *     Unable to resolve module ./node_modules/expo-router/entry.js
 *     from D:\RUOOD-Announcement-Manager\.
 *
 * A debug build never hits it, because it loads JavaScript from Metro instead
 * of bundling — so this is invisible until the first release or EAS build.
 *
 * Pointing `main` at this file makes the entry a real path inside this package.
 * It resolves the same way from either root, and it no longer depends on where
 * npm happened to put `expo-router`.
 */

import 'expo-router/entry';
