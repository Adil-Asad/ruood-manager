/**
 * @ruood/announcement-client
 *
 * The platform-neutral plumbing every front end needs: an injected HTTP port,
 * a place to keep a credential, base64, and the pure helpers that turn a record
 * into words.
 *
 * It used to hold a typed client for the Manager server and the wire contract
 * that went with it. Both are gone, along with the server: the app talks to
 * GitHub now, through `@ruood/announcement-github`, which builds on the `Http`
 * port defined here.
 *
 * It runs unchanged in a browser, in Hermes on a phone, and in a node test.
 * That is a contract rather than an accident, and `__tests__/isolation.test.ts`
 * fails if it is broken — no `fs`, no `Buffer`, no `document`, no `window`, no
 * `react-native`. The transport is injected (`Http`) and so is storage
 * (`SessionStore`), which is what lets the same code back two front ends
 * instead of being copied into each.
 *
 * It carries no secret of its own and no crypto. The announcement signing key
 * lives on the operator's machine and stays there; see `session.ts` for the
 * distinction between that key and the bearer token a device may hold.
 */

export * from './base64url';
export * from './http';
export * from './session';
export * from './delivery';
export * from './format';
