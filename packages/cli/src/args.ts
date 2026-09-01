/**
 * A small argument parser.
 *
 * Hand-rolled rather than pulled from npm, for the same reason the schema
 * package is zero-dependency: this is the tool you reach for when something
 * else is broken, and it should have as little standing between it and Node as
 * possible. It handles what these commands actually use — `--flag`,
 * `--key value`, `--key=value`, `-x`, `--` and positionals — and nothing else.
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      onlyPositionals = true;
      continue;
    }

    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const name = token.replace(/^--?/, '');

    if (name.includes('=')) {
      const at = name.indexOf('=');
      flags.set(name.slice(0, at), name.slice(at + 1));
      continue;
    }

    // A following token is this flag's value unless it is itself a flag. That
    // makes `--title "Reports Center"` work without quoting rules of its own.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }

  return {
    command: positionals.length > 0 ? positionals[0]! : null,
    positionals: positionals.slice(1),
    flags,
  };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function flagNumber(args: ParsedArgs, name: string): number | null {
  const value = flagString(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
