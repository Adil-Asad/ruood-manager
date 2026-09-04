/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  moduleNameMapper: {
    '^@ruood/announcement-schema$': '<rootDir>/../schema/src/index.ts',
    '^@ruood/announcement-client$': '<rootDir>/../client/src/index.ts',
  },
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
