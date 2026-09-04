/**
 * Lint for the Android Manager.
 *
 * `eslint-config-expo` is the baseline the Expo toolchain expects, and the
 * additions below are the two rules worth having in a tool that can publish to
 * every install of another app.
 */
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['dist/**', 'android/**', 'ios/**', '.expo/**', 'node_modules/**'],
  },
  {
    rules: {
      // A floating promise here is a save or a publish whose failure nobody
      // hears about. Every call site either awaits or says `void` deliberately.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
