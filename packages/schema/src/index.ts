/**
 * @ruood/announcement-schema
 *
 * The announcement data contract, shared by the Announcement Manager (Node)
 * and by RUOOD Lab (React Native).
 *
 * Zero runtime dependencies, and no import of `react`, `react-native`, `fs` or
 * anything else platform-bound -- that is a contract, not an accident, and
 * `__tests__/isolation.test.ts` fails if it is ever broken. It is what lets the
 * same validator run under a node-only jest config and inside a Hermes bundle.
 */

export * from './constants';
export * from './types';
export * from './routes';
export * from './issues';
export * from './instant';
export * from './semver';
export * from './id';
export * from './validate-record';
export * from './validate-manifest';
export * from './parse-manifest';
