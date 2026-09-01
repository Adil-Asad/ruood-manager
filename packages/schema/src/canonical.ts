/**
 * Canonical JSON.
 *
 * One serialisation, produced identically by the Manager and re-derivable by
 * the client. It is part of the contract rather than a build detail, for two
 * reasons:
 *
 *  - **signing** (Phase 3) is over these exact bytes, and the client has to
 *    reproduce them to verify. A signature over "whatever JSON.stringify felt
 *    like" is not verifiable anywhere else;
 *  - **diffs**. Keys in a fixed order mean a publish that changes one field
 *    shows one changed line, not a reshuffled file.
 *
 * The rules are deliberately narrow — this serialises the announcement
 * contract, not arbitrary JSON:
 *
 *  - object keys sorted by code unit;
 *  - `undefined` members omitted (as `JSON.stringify` does);
 *  - two-space indentation and a trailing newline, so the file reads and diffs
 *    like source rather than one long line;
 *  - non-finite numbers and `undefined` at the top level are refused rather
 *    than silently becoming `null`.
 *
 * Sorting is by code unit (the default comparison), NOT `localeCompare` --
 * locale-aware ordering differs between platforms, which is the one thing a
 * canonical form cannot tolerate.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || '<root>'}`);
    this.name = 'CanonicalJsonError';
  }
}

/** Pretty, stable, two-space indented, with a trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${write(value, '', 0)}\n`;
}

/**
 * The same ordering with no whitespace at all.
 *
 * This is the form a signature covers: indentation is presentation, and a
 * signature must not break because a file was reformatted.
 */
export function canonicalCompactJson(value: unknown): string {
  return write(value, '', -1);
}

function write(value: unknown, path: string, depth: number): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`Non-finite number ${String(value)}`, path);
      }
      // JSON has no -0; JSON.stringify writes it as 0, and so do we.
      return JSON.stringify(value === 0 ? 0 : value);

    case 'string':
      return JSON.stringify(value);

    case 'object':
      return Array.isArray(value)
        ? writeArray(value, path, depth)
        : writeObject(value as Record<string, unknown>, path, depth);

    default:
      throw new CanonicalJsonError(`Cannot serialise ${typeof value}`, path);
  }
}

function writeArray(value: readonly unknown[], path: string, depth: number): string {
  if (value.length === 0) return '[]';

  const members = value.map((entry, index) =>
    // An `undefined` hole would become `null` in JSON; be explicit about it.
    entry === undefined ? 'null' : write(entry, `${path}[${index}]`, next(depth)),
  );

  return wrap('[', members, ']', depth);
}

function writeObject(value: Record<string, unknown>, path: string, depth: number): string {
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  if (keys.length === 0) return '{}';

  const members = keys.map((key) => {
    const child = write(value[key], path ? `${path}.${key}` : key, next(depth));
    return `${JSON.stringify(key)}:${depth < 0 ? '' : ' '}${child}`;
  });

  return wrap('{', members, '}', depth);
}

function next(depth: number): number {
  return depth < 0 ? -1 : depth + 1;
}

function wrap(open: string, members: readonly string[], close: string, depth: number): string {
  if (depth < 0) return `${open}${members.join(',')}${close}`;

  const inner = '  '.repeat(depth + 1);
  const outer = '  '.repeat(depth);
  return `${open}\n${inner}${members.join(`,\n${inner}`)}\n${outer}${close}`;
}
