/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/server'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  testTimeout: 60000,
  moduleNameMapper: {
    '^@ruood/announcement-schema$': '<rootDir>/../schema/src/index.ts',
    '^@ruood/announcement-core$': '<rootDir>/../core/src/index.ts',
  },
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
