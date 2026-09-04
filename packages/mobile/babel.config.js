/**
 * Babel for the Android Manager.
 *
 * `babel-preset-expo` and nothing else, which is the same thing RUOOD Lab runs.
 * Every additional plugin here is a way for the bundle to differ from what the
 * preset guarantees, and nothing in this app needs one: there is no Reanimated
 * worklet, no decorator, and no module-resolver alias (Metro does the aliasing,
 * where the reasoning for it can live beside the resolution).
 *
 * ## Why the preset is resolved rather than named
 *
 * This app is a workspace member, so npm hoists what it can to the repository
 * root and nests the rest. That put `@babel/core` at the root and
 * `babel-preset-expo` under this package — and Babel resolves a preset NAME
 * relative to wherever `@babel/core` is installed, so the bare string
 * `'babel-preset-expo'` fails with "Cannot find module", from a stack that
 * names eight files and not the real cause.
 *
 * `require.resolve` runs here, in this package, where the preset genuinely is.
 * Babel then gets an absolute path and has nothing to resolve. It is one line
 * against a class of hoisting failure that is otherwise diagnosed by hand every
 * time npm rearranges the tree.
 */
/**
 * The expo-router Babel plugin, added by hand.
 *
 * ## The failure it fixes
 *
 * `expo-router/_ctx.android.js` is one line: a `require.context` over
 * `process.env.EXPO_ROUTER_APP_ROOT`. The router's Babel plugin replaces that
 * expression with a real path. If the plugin never runs, Metro reaches a
 * `require.context` whose argument it cannot evaluate statically and the whole
 * bundle fails with:
 *
 *   SyntaxError: node_modules/expo-router/_ctx.android.js:
 *   Invalid call at line 2: process.env.EXPO_ROUTER_APP_ROOT
 *
 * which names the router's own file and says nothing whatsoever about this
 * project or about why.
 *
 * ## Why it stops running: the same hoisting problem, one layer along
 *
 * `babel-preset-expo` adds the plugin only when `hasModule('expo-router')`
 * succeeds, and that is a bare `require.resolve('expo-router')` evaluated from
 * inside the PRESET's own directory. So it works when the preset and the
 * router are installed next to each other, and fails silently when they are
 * not.
 *
 * npm put the preset at the repository root and left `expo-router` nested under
 * this package, so resolution walked `node_modules/babel-preset-expo/...` up to
 * the root, found no `expo-router` there, and quietly dropped the plugin.
 * Nothing warned. The preset simply produced a bundle missing one transform.
 *
 * This is the third time hoisting has broken this app in the same shape, and
 * the second time in this file — the `require.resolve` on the preset below
 * exists because `@babel/core` hoisted and the preset did not. The rule that
 * keeps emerging: **never let a bare module name decide whether a build step
 * happens.**
 *
 * ## Why adding the plugin is the right fix
 *
 * The plugin does not need `expo-router` to be resolvable from anywhere. It
 * takes the app root from `api.caller(...)`, which Metro supplies, and it is
 * idempotent — a second pass finds string literals where the environment reads
 * used to be and does nothing. So if a future npm layout lets the preset find
 * the router again and adds the plugin as well, having it twice is harmless.
 *
 * The alternative was hoisting `expo-router` to the root by declaring it there,
 * which npm refuses outright: it conflicts with the peer graph around
 * `react-native` and `expo`, and forcing it would put a second copy of the
 * router in the tree. That is precisely the shape of the React 18/19 crash this
 * repository already carries an `overrides` block to prevent.
 *
 * The build path is reached for deliberately: `babel-preset-expo` publishes no
 * other entry point for it. `bundle.test.ts` sweeps the SHIPPING bundle, so if
 * a future version moves this file the release build fails loudly at the same
 * step rather than shipping a bundle with a transform missing.
 *
 * Resolved the same way the preset below is — from THIS file, which is in the
 * package that depends on it, so Node walks `packages/mobile/node_modules` and
 * then the root and finds it wherever npm put it.
 */
const { expoRouterBabelPlugin } = require('babel-preset-expo/build/expo-router-plugin');

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [require.resolve('babel-preset-expo')],
    plugins: [expoRouterBabelPlugin],
  };
};
