/**
 * The client's reader.
 *
 * This is what RUOOD Lab will call in Phase 4, and its contract is different in
 * kind from the Manager's validator even though it shares every rule: the
 * Manager REPORTS problems to a person who can fix them; the client SURVIVES
 * them, silently, and shows whatever is left.
 *
 * Three consequences, and all three are the difference between a bad manifest
 * being a non-event and a bad manifest being a support ticket:
 *
 *  - it never throws. Malformed JSON, a null, an array where an object belongs,
 *    a number where the whole file should be -- all return an empty result.
 *  - one bad record does not poison the file. Records are validated
 *    individually and the bad ones dropped, so a typo in announcement 3 does
 *    not hide announcements 1, 2 and 4.
 *  - it FAILS CLOSED on anything it does not understand. An unknown `surface`,
 *    an unrecognised `action.type`, a `minSchema` from the future: skip the
 *    record. Never guess a default -- an old build guessing at a new record
 *    type is how the wrong thing gets shown to exactly the users who cannot be
 *    reached with a correction.
 *
 * Warnings are ignored here entirely. "Unrecognised field" is a typo worth
 * flagging to an author and is precisely what forward compatibility requires a
 * client to tolerate.
 */

import { MANIFEST_MAX_BYTES, SUPPORTED_SCHEMA_VERSION } from './constants';
import type { AnnouncementManifest, PublishedAnnouncement } from './types';
import { validateManifest } from './validate-manifest';
import { isPlainObject, validateAnnouncementRecord } from './validate-record';

export type ManifestRejection =
  | 'not-json'
  | 'too-large'
  | 'not-an-object'
  | 'schema-too-new'
  | 'schema-too-old'
  | 'malformed-envelope';

export interface ParsedManifest {
  ok: true;
  manifest: AnnouncementManifest;
  /** Records dropped because this build could not render them safely. */
  skipped: { index: number; id: string | null; reason: string }[];
}

export interface RejectedManifest {
  ok: false;
  reason: ManifestRejection;
  detail: string;
}

export type ParseManifestResult = ParsedManifest | RejectedManifest;

/**
 * UTF-8 byte length, computed rather than taken from `Buffer` or `TextEncoder`.
 *
 * `Buffer` does not exist in a React Native bundle and `TextEncoder` is not
 * guaranteed on every Hermes build, and this package is contractually
 * platform-neutral. Surrogate pairs are counted once, as the 4 bytes they
 * encode to, rather than twice as 3.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

export interface ParseOptions {
  now: number;
  externalHostAllowlist?: readonly string[];
  schemaVersion?: number;
  /**
   * Byte length of the payload as received. The client passes this so an
   * oversized file is rejected before it is parsed into memory.
   */
  receivedBytes?: number;
}

/** Parses raw response text. Never throws. */
export function parseManifestText(text: string, options: ParseOptions): ParseManifestResult {
  if (options.receivedBytes !== undefined && options.receivedBytes > MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `Manifest is ${options.receivedBytes} bytes; the limit is ${MANIFEST_MAX_BYTES}.`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json', detail: 'Response was not valid JSON.' };
  }

  return parseManifest(value, options);
}

/** Parses an already-decoded value. Never throws. */
export function parseManifest(value: unknown, options: ParseOptions): ParseManifestResult {
  const supported = options.schemaVersion ?? SUPPORTED_SCHEMA_VERSION;

  if (!isPlainObject(value)) {
    return { ok: false, reason: 'not-an-object', detail: 'Manifest is not an object.' };
  }

  const envelope = value as Record<string, unknown>;

  const schemaVersion = envelope.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return {
      ok: false,
      reason: 'malformed-envelope',
      detail: 'schemaVersion is missing or not an integer.',
    };
  }
  if (schemaVersion > supported) {
    return {
      ok: false,
      reason: 'schema-too-new',
      detail: `Manifest declares schema ${schemaVersion}; this build supports ${supported}.`,
    };
  }
  if (schemaVersion < 1) {
    return {
      ok: false,
      reason: 'schema-too-old',
      detail: `Manifest declares schema ${schemaVersion}.`,
    };
  }

  if (typeof envelope.generatedAt !== 'string' || typeof envelope.revision !== 'number') {
    return {
      ok: false,
      reason: 'malformed-envelope',
      detail: 'revision or generatedAt is missing or of the wrong type.',
    };
  }
  if (!Array.isArray(envelope.announcements)) {
    return {
      ok: false,
      reason: 'malformed-envelope',
      detail: 'announcements is missing or not an array.',
    };
  }

  // A missing `paused` reads as false rather than rejecting the file: a kill
  // switch that fails to the "everything is suppressed" side would be worse.
  const paused = envelope.paused === true;

  const accepted: PublishedAnnouncement[] = [];
  const skipped: { index: number; id: string | null; reason: string }[] = [];

  envelope.announcements.forEach((record, index) => {
    const id =
      isPlainObject(record) && typeof (record as Record<string, unknown>).id === 'string'
        ? ((record as Record<string, unknown>).id as string)
        : null;

    const result = validateAnnouncementRecord(record, {
      now: options.now,
      mode: 'published',
      schemaVersion: supported,
      ...(options.externalHostAllowlist
        ? { externalHostAllowlist: options.externalHostAllowlist }
        : {}),
    });

    if (result.ok) {
      accepted.push(record as PublishedAnnouncement);
      return;
    }

    skipped.push({
      index,
      id,
      reason: result.errors.map((issue) => `${issue.path || 'record'}: ${issue.code}`).join('; '),
    });
  });

  return {
    ok: true,
    manifest: {
      schemaVersion,
      revision: envelope.revision,
      generatedAt: envelope.generatedAt,
      paused,
      announcements: accepted,
    },
    skipped,
  };
}

/**
 * The Manager's pre-publish gate: the full validator, plus a parse with the
 * client's own reader, so publishing cannot succeed on a file the client would
 * silently drop records from.
 *
 * This is the "one validator, two consumers" rule made operational -- the
 * Manager does not merely run the same rules, it runs the client's code path
 * over the exact bytes it is about to write.
 */
export function verifyPublishable(
  serialised: string,
  options: ParseOptions,
): { ok: boolean; detail: string } {
  const bytes = utf8ByteLength(serialised);

  const parsed = parseManifestText(serialised, { ...options, receivedBytes: bytes });
  if (!parsed.ok) {
    return { ok: false, detail: `The client would reject this manifest: ${parsed.detail}` };
  }
  if (parsed.skipped.length > 0) {
    const names = parsed.skipped.map((entry) => entry.id ?? `index ${entry.index}`).join(', ');
    return { ok: false, detail: `The client would silently skip: ${names}` };
  }

  const validation = validateManifest(JSON.parse(serialised), {
    now: options.now,
    serialisedBytes: bytes,
    ...(options.externalHostAllowlist
      ? { externalHostAllowlist: options.externalHostAllowlist }
      : {}),
  });
  if (!validation.ok) {
    return { ok: false, detail: `Manifest validation failed with ${validation.errors.length} error(s).` };
  }

  return { ok: true, detail: `Manifest is publishable (${bytes} bytes).` };
}
