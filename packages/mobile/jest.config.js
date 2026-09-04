/**
 * Tests for the parts of the Android Manager that are not a React tree.
 *
 * A node environment and `ts-jest`, deliberately, rather than `jest-expo` and a
 * renderer. What is worth testing here is the configuration and the security
 * properties — whether a secret could reach a build, whether the two storage
 * halves stay separate, whether the application ids are distinct. None of that
 * needs a rendered component, and a native-module mock layer would add a lot of
 * machinery for assertions about `<View>`.
 *
 * The logic the screens sit on is already covered where it lives: 41 tests in
 * `@ruood/announcement-github` for the GitHub client and the device flow, and
 * 313 in `@ruood/announcement-schema` for the validator the editor runs.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  moduleNameMapper: {
    '^@ruood/announcement-schema$': '<rootDir>/../schema/src/index.ts',
    '^@ruood/announcement-client$': '<rootDir>/../client/src/index.ts',
    '^@ruood/announcement-authoring$': '<rootDir>/../authoring/src/index.ts',
    '^@ruood/announcement-github$': '<rootDir>/../github/src/index.ts',
  },
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
