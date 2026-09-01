#!/usr/bin/env node
/**
 * Starting the Manager.
 *
 *   npm run ui -- --repo <path to the announcements repository>
 *
 * `--repo` is required and there is no default, exactly as in the CLI: an
 * ambient "current repository" is how you publish to the wrong one.
 *
 * It binds to the loopback interface and nothing else. The Manager can write
 * `content/`, commit, and push to the repository every install reads, so there
 * is no version of "briefly expose it on the network" that is a good idea. If
 * you need it from another machine, that is what an SSH tunnel is for.
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { createApp } from './app';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4874;

/** Vite's default. Added to the origin allowlist only when `--dev` is passed. */
const DEV_ORIGIN = 'http://localhost:5173';

async function run(argv: readonly string[]): Promise<number> {
  const args = parse(argv);

  if (args.has('help')) {
    process.stdout.write(usage());
    return 0;
  }

  const repo = args.get('repo');
  if (typeof repo !== 'string') {
    process.stderr.write('--repo <path> is required. There is no default, deliberately.\n');
    return 2;
  }

  const root = resolve(repo);
  if (!existsSync(root)) {
    process.stderr.write(`No such directory: ${root}\n`);
    return 2;
  }

  const portFlag = args.get('port');
  const port = typeof portFlag === 'string' ? Number(portFlag) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`--port must be a port number, not "${String(portFlag)}".\n`);
    return 2;
  }

  const dev = args.has('dev');
  const webRoot = join(__dirname, '..', 'web');

  const app = createApp({
    root,
    ...(dev ? { allowedOrigins: [DEV_ORIGIN] } : {}),
    // In dev the client is served by Vite, which proxies here; serving a stale
    // build alongside it would be a way to look at yesterday's UI by accident.
    ...(dev ? {} : { webRoot }),
  });

  try {
    await app.listen({ host: HOST, port });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  process.stdout.write(`\nRUOOD Announcement Manager\n`);
  process.stdout.write(`  repository  ${root}\n`);
  process.stdout.write(
    dev
      ? `  api         http://${HOST}:${port}  (client: run "npm run ui:dev", then ${DEV_ORIGIN})\n`
      : `  open        http://${HOST}:${port}\n`,
  );
  if (!dev && !existsSync(join(webRoot, 'index.html'))) {
    process.stdout.write(`\n  The client is not built yet. Run: npm run build\n`);
  }
  process.stdout.write(`\n  Loopback only. Ctrl-C to stop.\n\n`);

  const stop = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return 0;
}

/** The same shape of flags the CLI takes, and only the four this needs. */
function parse(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-')) continue;

    const name = token.replace(/^--?/, '');
    if (name.includes('=')) {
      const at = name.indexOf('=');
      flags.set(name.slice(0, at), name.slice(at + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }

  return flags;
}

function usage(): string {
  return `announce-ui — the RUOOD Lab Announcement Manager

  --repo <path>   the announcements repository (required)
  --port <n>      default ${DEFAULT_PORT}
  --dev           serve the API only, and trust ${DEV_ORIGIN} as an origin
  --help

Binds to ${HOST} only. It can commit and push to the repository every install
reads, so it is never exposed on a network interface.
`;
}

void run(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exit(code);
});
