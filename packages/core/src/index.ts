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

export * from './content/defaults';
export * from './content/authoring';
export * from './content/edit';
export * from './content/store';

export * from './build/project';
export * from './build/build';

export * from './images/encode';
export * from './images/attach';
export * from './ci/files';

export * from './signing/keys';
export * from './signing/sign';

export * from './publish/diff';
export * from './publish/publish';

export { AnnouncementRepo } from './git/repository';
export type { RepoStatus, PushOutcome } from './git/repository';
