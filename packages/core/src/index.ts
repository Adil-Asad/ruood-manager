/**
 * @ruood/announcement-core
 *
 * Everything the Manager does to the announcements repository: read and write
 * `content/`, build `dist/`, encode images, diff a publish, and commit it.
 *
 * The pure parts (`build/project`, `publish/diff`, `content/authoring`) are
 * separated from the impure ones deliberately — they are the parts that decide
 * what every install sees, and they are unit-tested rather than exercised
 * through the filesystem.
 */

export * from './paths';
export * from './scaffold';

/**
 * The pure record operations now live in `@ruood/announcement-authoring`, so
 * the phone can run the SAME code the build does. They are re-exported here
 * unchanged: every existing import of `applyEdits`, `createRecord` or
 * `applyTransition` from `core` still resolves, and there is still exactly one
 * definition of each.
 */
export * from '@ruood/announcement-authoring';

export * from './content/store';

export * from './build/project';
export * from './build/build';

export * from './images/encode';
export * from './images/attach';
export * from './ci/files';
export * from './ci/publish-workflow';

export * from './signing/keys';
export * from './signing/sign';

export * from './publish/diff';
export * from './publish/publish';

export { AnnouncementRepo } from './git/repository';
export type { RepoStatus, PushOutcome } from './git/repository';
