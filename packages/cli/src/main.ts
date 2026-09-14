/**
 * The announcement CLI.
 *
 * CLI-first is a deliberate ordering, not a stopgap. Every operation the Phase
 * 2 UI will perform is a `core` function this tool already calls, which means
 * the risky half of the system — building, validating and committing — is
 * exercised and testable before any of it is behind a browser. It also means
 * you can always publish when the UI is broken.
 *
 * Every command takes `--repo <path>`; there is no ambient "current
 * repository". Publishing to the wrong repository is not a mistake worth
 * leaving available.
 *
 * Exit codes: 0 success, 1 refused (validation, a conflict), 2 misuse.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { parseArgs, type ParsedArgs } from './args';
import { runInit } from './commands/init';
import { runNew } from './commands/new';
import { runList } from './commands/list';
import { runValidate } from './commands/validate';
import { runBuild } from './commands/build';
import { runPublish } from './commands/publish';
import { runTransition } from './commands/transition';
import { runImage } from './commands/image';
import { runStatus } from './commands/status';
import { runRevert } from './commands/revert';
import { runDelete } from './commands/delete';
import { runEdit } from './commands/edit';
import { runPush } from './commands/push';
import { runKeygen } from './commands/keygen';
import { runVerify } from './commands/verify';
import { runRetention } from './commands/retention';

export interface CommandContext {
  args: ParsedArgs;
  repoRoot: string;
  now: number;
  out: (line: string) => void;
  err: (line: string) => void;
}

export type CommandResult = 0 | 1 | 2;

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  init: runInit,
  new: runNew,
  edit: runEdit,
  list: runList,
  validate: runValidate,
  build: runBuild,
  publish: runPublish,
  push: runPush,
  keygen: runKeygen,
  verify: runVerify,
  retention: runRetention,
  status: runStatus,
  revert: runRevert,
  delete: runDelete,
  image: runImage,
  // Lifecycle transitions share one implementation.
  activate: runTransition,
  pause: runTransition,
  resume: runTransition,
  archive: runTransition,
  restore: runTransition,
  bump: runTransition,
};

export async function main(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
): Promise<CommandResult> {
  const args = parseArgs(argv);

  if (args.command === null || args.command === 'help' || args.flags.has('help')) {
    io.out(usage());
    return args.command === null ? 2 : 0;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    io.err(`Unknown command "${args.command}".\n`);
    io.err(usage());
    return 2;
  }

  const repoFlag = args.flags.get('repo');
  if (typeof repoFlag !== 'string') {
    io.err('--repo <path> is required. There is no default repository, deliberately.');
    return 2;
  }

  const repoRoot = resolve(repoFlag);
  if (args.command !== 'init' && !existsSync(repoRoot)) {
    io.err(`No such directory: ${repoRoot}`);
    return 2;
  }

  const nowFlag = args.flags.get('now');
  const now = typeof nowFlag === 'string' ? Date.parse(nowFlag) : Date.now();
  if (!Number.isFinite(now)) {
    io.err(`--now must be an ISO instant, e.g. 2026-09-01T06:00:00Z`);
    return 2;
  }

  try {
    return await handler({ args, repoRoot, now, out: io.out, err: io.err });
  } catch (error) {
    io.err(`${(error as Error).message}`);
    return 1;
  }
}

function usage(): string {
  return `announce — RUOOD Lab announcement authoring and publishing

  All commands take --repo <path> to the announcements repository.

SETUP
  init                          create the repository skeleton and git-init it
  keygen                        create the Ed25519 signing key (once, per repo)
      [--key <path>]            default ~/.ruood/announcement-signing.key
      [--force]                 rotate — this is an app release, read the warning

AUTHORING
  new <id>                      create a draft
      [--title <text>] [--body <text>]  (at least one)
      [--start <instant>] [--end <instant>]
      [--surface modal|banner|inbox] [--category feature|fix|notice|tip]
  edit <id>                     change content fields (never id, status or rev)
      [--title <text>] [--body <text>] [--category <category>]
      [--priority <0-100>] [--start <instant>] [--end <instant> | --no-end]
      [--surface modal|banner|inbox] [--trigger next-launch|immediate]
      [--dismiss permanent|session|snooze-24h|none]
      [--max-impressions <n>|unlimited] [--min-interval <hours>]
      [--platforms android,ios,web] [--min-version <v>|none] [--max-version <v>|none]
      [--action-route <target> | --action-external <url> | --no-action]
      [--action-label <text>] [--note <text> | --no-note] [--remove-image]
  list [--status <status>]      list records with their derived lifecycle state
  image <id> <file>             encode and attach an image
      [--alt <text>]
  activate <id>                 draft  -> published
  pause <id>                    published -> paused (stays in the manifest)
  resume <id>                   paused -> published
  archive <id>                  -> archived (kept, not published)
  restore <id>                  archived -> draft
  bump <id>                     bump rev — RE-SHOWS to everyone who saw it
  delete <id>                   remove the record and retire its id for ever

SETTINGS
  retention [--max <n>]         how many announcements stay published. Older ones
                                stay in content/ and are simply not sent

PUBLISHING
  validate                      validate content/ and what it would produce
  build                         write dist/ without committing
  publish [--dry-run]           build, verify, commit and push
          [--accept-warnings] [--no-push] [--message <text>]
          [--pause | --unpause]    the global kill switch
  push                          push commits publish made but could not send
  status                        repository and publication state
  verify [--channel <c>]        check dist/ still matches the repository's key
  revert <commit>               revert a publish

OPTIONS
  --channel production|staging  which manifest. Default production; staging
                                additionally publishes DRAFTS, which is its point
  --sign                        sign the manifest with the key
  --key <path>                  the signing key. Implies --sign
  --now <instant>               fix the clock, for reproducible builds and tests
`;
}
