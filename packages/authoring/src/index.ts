/**
 * @ruood/announcement-authoring
 *
 * The pure record operations: what it means to create an announcement, edit
 * one, and move one between states.
 *
 * ## Why it is its own package
 *
 * These three files used to live in `@ruood/announcement-core`, and they were
 * already pure — they import nothing but the schema. What made them
 * unreachable was their neighbours: `core` also holds `node:fs`, `simple-git`
 * and `sharp`, so importing `applyEdits` from a phone meant importing libvips.
 *
 * Now that the Manager app talks to GitHub directly, the phone has to perform
 * these operations itself, and it has to perform them **identically** to the
 * build that later reads what it wrote. Copying them onto the phone would have
 * been two implementations of "what an edit means"; extracting them is one.
 *
 * It is the same reasoning that put the validator in `@ruood/announcement-schema`
 * rather than in each consumer, and the same reasoning that moved the wire
 * contract into `@ruood/announcement-client`: **the code that decides something
 * lives once, and everybody imports it.**
 *
 * `core` re-exports all of it, so every existing import path still resolves.
 *
 * ## The contract this package keeps
 *
 * Zero platform dependencies. No `fs`, no `Buffer`, no `process`, no
 * `Date.now()` — every function takes `now`. `__tests__/isolation.test.ts`
 * sweeps for all of it and fails if any appears, exactly as the schema
 * package's own sweep does.
 */

export * from './repo-paths';
export * from './defaults';
export * from './authoring';
export * from './edit';
