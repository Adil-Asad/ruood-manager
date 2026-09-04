/**
 * Where things live inside an announcements repository, as relative paths.
 *
 * ## Why these are here and not in `core`
 *
 * `core/src/paths.ts` builds ABSOLUTE paths with `node:path`, for a working
 * copy on a disk. The Manager app has no working copy — it addresses the same
 * files over the GitHub API, where a path is a forward-slashed string and
 * `join` would be actively wrong on Windows.
 *
 * So the *names* live here, platform-neutral, and `core` composes absolute
 * paths from them. One definition of "a record is `content/announcements/<id>.json`",
 * used by the phone that writes it and by the build that reads it.
 *
 * Getting this wrong is not a crash. It is a commit that lands somewhere the
 * build does not look, which reads as an announcement that saved successfully
 * and then vanished.
 *
 * ## Forward slashes, always
 *
 * Git stores paths with forward slashes on every platform, and so does the
 * GitHub API. There is no separator to choose here and nothing to normalise.
 */

/** The authored half. Never read by a client. */
export const CONTENT_DIR = 'content';

/** One JSON file per announcement, named by its id. */
export const ANNOUNCEMENTS_DIR = `${CONTENT_DIR}/announcements`;

/** Image originals at full resolution, one per id. */
export const MEDIA_DIR = `${CONTENT_DIR}/media`;

/** The ledger of ids that must never be reused. */
export const RETIRED_IDS_FILE = `${CONTENT_DIR}/retired-ids.json`;

/** The revision counter and the sticky kill switch. */
export const STATE_FILE = `${CONTENT_DIR}/state.json`;

/** The built half. The only thing a client reads. */
export const DIST_DIR = 'dist';

/** `content/announcements/<id>.json` */
export function recordFile(id: string): string {
  return `${ANNOUNCEMENTS_DIR}/${id}.json`;
}

/** `content/media/<id><extension>`, where the extension carries its dot. */
export function mediaFile(id: string, extension: string): string {
  return `${MEDIA_DIR}/${id}${extension.startsWith('.') ? extension : `.${extension}`}`;
}

/**
 * The id a record path names, or `null`.
 *
 * The inverse of `recordFile`, used when turning a tree listing back into
 * records. It refuses anything nested deeper than the announcements directory,
 * so a stray file under `content/announcements/drafts/` is skipped rather than
 * read as an announcement called `drafts/thing`.
 */
export function idFromRecordFile(path: string): string | null {
  if (!path.startsWith(`${ANNOUNCEMENTS_DIR}/`) || !path.endsWith('.json')) return null;

  const name = path.slice(ANNOUNCEMENTS_DIR.length + 1, -'.json'.length);
  return name.length > 0 && !name.includes('/') ? name : null;
}

/**
 * The id a media path names, and the extension it was stored with.
 *
 * `content/media/` holds exactly ONE original per id — the build finds it by
 * matching the filename stem — so the stem is the id and everything after the
 * final dot is the extension.
 */
export function mediaOf(path: string): { id: string; extension: string } | null {
  if (!path.startsWith(`${MEDIA_DIR}/`)) return null;

  const name = path.slice(MEDIA_DIR.length + 1);
  if (name.length === 0 || name.includes('/')) return null;

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;

  return { id: name.slice(0, dot), extension: name.slice(dot) };
}
