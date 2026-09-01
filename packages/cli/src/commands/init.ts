import { scaffoldRepository } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';

export async function runInit(ctx: CommandContext): Promise<CommandResult> {
  const result = await scaffoldRepository(ctx.repoRoot);

  if (result.created.length === 0) {
    ctx.out(`Nothing to do — ${ctx.repoRoot} is already an announcements repository.`);
    return 0;
  }

  ctx.out(`Created the announcements repository at ${ctx.repoRoot}`);
  for (const file of result.created) {
    ctx.out(`  + ${file.slice(ctx.repoRoot.length + 1) || file}`);
  }

  if (result.nestedInsideRepository) {
    ctx.out('');
    ctx.out(
      'Note: this sits inside another git repository. It is its own repository and publishes ' +
        'independently, but add it to the enclosing project\'s .gitignore so nobody commits it there.',
    );
  }

  ctx.out('');
  ctx.out('Next:');
  ctx.out('  1. git remote add origin <the announcements repo URL>');
  ctx.out('  2. enable GitHub Pages on the default branch, serving from /');
  ctx.out('  3. announce new <id> --title ... --body ...');
  ctx.out('');
  ctx.out(
    'dist/announcements.json already holds a valid empty manifest, so a client fetching ' +
      'before your first publish reads a well-formed file rather than a 404.',
  );

  return 0;
}
