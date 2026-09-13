/**
 * Metro, taught about the workspace this app lives in.
 *
 * Two separate problems are solved here, and they are worth keeping apart.
 *
 * ## 1. The monorepo
 *
 * This app is an npm workspace member, so its dependencies are hoisted to the
 * repository root and its own `node_modules` is nearly empty. Metro looks only
 * inside the project directory by default, so it has to be told:
 *
 *   watchFolders     the workspace root, so files above the app are watched
 *                    and resolvable at all;
 *   nodeModulesPaths both the app's and the root's.
 *
 * `disableHierarchicalLookup` is deliberately NOT set, which is worth saying
 * because most monorepo recipes do set it. Those recipes assume a hoisting
 * scheme (pnpm, or yarn with nohoist) where every dependency is reachable from
 * one of the listed roots. npm does not do that: it hoists what it can and
 * NESTS the rest, so `expo-router` here carries its own `node_modules` holding
 * `@expo/metro-runtime`. Turning hierarchical lookup off makes those nested
 * copies unreachable, and the bundle fails on a module that is plainly present
 * on disk.
 *
 * ## 2. The two shared packages resolve to SOURCE, not to `dist`
 *
 * `@ruood/announcement-schema`, `-client`, `-authoring` and `-github` all publish
 * CommonJS from `dist`, and `export * from './constants'` compiles to an
 * `__exportStar` call a bundler cannot analyse statically. Vite hit this first
 * and aliases the schema to its source for exactly this reason (see
 * `packages/ui/vite.config.ts`); this is the same fix for the same cause.
 *
 * It also removes a build step from the bundle path: `npm run build` no longer
 * has to have been run for the app to bundle correctly, which matters most on
 * EAS, where nothing runs this repository's build script.
 *
 * The result is the property the whole project is built around — the phone runs
 * the SAME validator the Manager publishes with, not a copy of it.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

// Appended, never assigned. Expo's default config already puts entries in
// `watchFolders` for its own reasons, and replacing the array drops them —
// which `expo-doctor` reports as "does not contain all entries from Expo's
// defaults", and which shows up in practice as a file that does not trigger a
// reload. Adding the workspace root to what is already there gets the monorepo
// behaviour without taking anything away.
config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];

/**
 * The app's own `node_modules` FIRST, and the order is load-bearing.
 *
 * This workspace holds two React applications with different Reacts: the
 * desktop Manager's browser client is React 18, and React Native 0.81 requires
 * React 19. npm resolves that by hoisting 18 to the root and nesting 19 here,
 * so both are on disk and the resolution order is what decides which one the
 * app gets. Listing this directory first makes React 19 the answer
 * deterministically rather than by luck.
 *
 * `expo-doctor` reports the pair as a duplicate native module, and it is right
 * that they are duplicated — it cannot see that the order above settles it. The
 * alternative is upgrading a working, tested browser client to React 19 to
 * satisfy a static check, which is a change with real risk and no benefit to
 * either application.
 */
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

/**
 * The four shared packages, and the SOURCE file each one resolves to.
 *
 * `schema` is the contract, `client` the platform-neutral plumbing, `authoring`
 * what makes the phone and the publishing build agree about what an edit means,
 * and `github` how the phone reaches the repository at all. Every one of them
 * must be the source, for the CommonJS re-export reason above.
 */
const SOURCE_ENTRY = {
  '@ruood/announcement-schema': path.resolve(workspaceRoot, 'packages/schema/src/index.ts'),
  '@ruood/announcement-client': path.resolve(workspaceRoot, 'packages/client/src/index.ts'),
  '@ruood/announcement-authoring': path.resolve(workspaceRoot, 'packages/authoring/src/index.ts'),
  '@ruood/announcement-github': path.resolve(workspaceRoot, 'packages/github/src/index.ts'),
};

/**
 * The alias has to run BEFORE node_modules resolution, and `extraNodeModules`
 * does not.
 *
 * This used to be `config.resolver.extraNodeModules`, which reads like an alias
 * and is not one. In `metro-resolver/src/resolve.js` the extra paths are
 * `.concat(extraPaths)` onto the END of the candidate list: they are a FALLBACK
 * for a package that could not be found at all. npm workspaces symlink every
 * one of these into the root `node_modules`, so each is always found — and the
 * alias below it was never once consulted.
 *
 * That was invisible on a development machine, because `npm run build` has been
 * run there and `dist/index.js` exists, so resolution succeeded one step
 * earlier than intended and produced a working bundle from the built output.
 *
 * On EAS it is fatal. `dist/` is gitignored, so it is not in the upload, and
 * nothing in a managed build runs this repository's build script. Metro then
 * finds the package, cannot resolve the `main` it declares, and throws
 * `InvalidPackageError` — it does NOT fall through to the remaining candidates,
 * so the fallback could not have saved it even if it had been reached:
 *
 *     Unable to resolve module @ruood/announcement-authoring ...
 *     But its main module could not be resolved:
 *       node_modules/@ruood/announcement-authoring/dist/index.js
 *
 * `resolveRequest` is the supported hook that runs first, so the mapping is now
 * the answer rather than a guess made after the real answer failed. Nothing
 * about the packages changes: `main` still points at `dist` for node, the CLI
 * and every jest suite. Only this bundle reads the source — which is what the
 * whole arrangement was for, and what makes the build independent of whether
 * anything was compiled first.
 */
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const source = SOURCE_ENTRY[moduleName];
  if (source) {
    return { type: 'sourceFile', filePath: source };
  }

  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

/**
 * The server root is this package, not the workspace root.
 *
 * `@expo/metro-config` detects the monorepo and points `unstable_serverRoot` at
 * the repository root. Expo's embed exporter then computes the entry path
 * relative to `projectRoot` and resolves it with `relativeTo: 'server'` — so
 * the two disagree by `packages/mobile`, and a RELEASE build dies with:
 *
 *     Unable to resolve module ./index.js from D:\RUOOD-Announcement-Manager\.
 *
 * A debug build never sees it, because it loads JavaScript from Metro rather
 * than bundling it — which makes this exactly the kind of failure that first
 * appears on EAS, in the artefact you were about to ship.
 *
 * Making the two agree fixes it. Resolution of the shared packages above this
 * directory is unaffected: that is what `watchFolders` and `nodeModulesPaths`
 * are for, and they are untouched.
 */
config.server = {
  ...config.server,
  unstable_serverRoot: projectRoot,
};

module.exports = config;
