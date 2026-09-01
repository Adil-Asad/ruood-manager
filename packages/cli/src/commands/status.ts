import { AnnouncementRepo, readPublished } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';
import { lifecycleOf, paths, snapshot, table } from './shared';

/** Where things stand: what is in content/, what is published, what git thinks. */
export async function runStatus(ctx: CommandContext): Promise<CommandResult> {
  const repo = paths(ctx);
  const content = await snapshot(ctx);
  const published = await readPublished(repo);

  const counts = new Map<string, number>();
  for (const entry of content.records) {
    const state = lifecycleOf(entry.record, ctx.now);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  ctx.out(`Repository   ${repo.root}`);
  ctx.out('');
  ctx.out(
    table([
      ['CONTENT', `${content.records.length} record(s)`],
      ...[...counts.entries()].sort().map(([state, n]) => ['', `${state}: ${n}`]),
      ['RETIRED IDS', String(content.retiredIds.length)],
    ]),
  );

  ctx.out('');
  if (!published.manifest) {
    ctx.out('PUBLISHED    nothing yet — dist/announcements.json does not exist.');
  } else {
    ctx.out(
      table([
        ['PUBLISHED', `revision ${published.manifest.revision}, ${published.bytes} bytes`],
        ['', `${published.manifest.announcements.length} record(s), ${Object.keys(published.images).length} image(s)`],
        ['', `generated ${published.manifest.generatedAt}`],
        ...(published.manifest.paused
          ? [['', 'KILL SWITCH IS ON — every install is showing nothing']]
          : []),
      ]),
    );
  }

  if (content.revision !== (published.manifest?.revision ?? 0)) {
    ctx.out('');
    ctx.out(
      `content/state.json says revision ${content.revision} but dist/ says ` +
        `${published.manifest?.revision ?? 0} — dist/ is stale. Run: announce build`,
    );
  }

  const git = new AnnouncementRepo(repo.root);
  ctx.out('');

  if (!(await git.isRepository())) {
    ctx.err('GIT          not a git repository. Publishing needs one — run: announce init');
    return 1;
  }

  const gitStatus = await git.status();
  ctx.out(
    table([
      ['GIT', `branch ${gitStatus.branch}${gitStatus.clean ? ', clean' : ', UNCOMMITTED CHANGES'}`],
      ['', gitStatus.hasRemote ? `ahead ${gitStatus.ahead}, behind ${gitStatus.behind}` : 'no remote configured'],
    ]),
  );

  if (!gitStatus.clean) {
    ctx.out('');
    for (const file of [...gitStatus.staged, ...gitStatus.modified, ...gitStatus.untracked].slice(0, 20)) {
      ctx.out(`  ${file}`);
    }
  }

  if (gitStatus.hasRemote && gitStatus.ahead > 0) {
    ctx.out('');
    ctx.out(`${gitStatus.ahead} commit(s) are committed but not pushed — no install has them yet.`);
  }

  return 0;
}
