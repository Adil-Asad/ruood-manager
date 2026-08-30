/**
 * Node-only, like RUOOD Lab's own jest config -- there is no renderer here and
 * there never should be.
 *
 * `tsconfig.test.json` is used deliberately rather than an inline override: an
 * inline `{ module, target }` replaces the project's compiler options wholesale,
 * which quietly turned `strict` off and let type errors sit in the test files
 * while `jest` stayed green.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
