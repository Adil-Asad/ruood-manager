/**
 * base64url, in plain JavaScript.
 *
 * It exists because the pairing blob is produced by the Manager's server, which
 * has `Buffer`, and consumed by the Android Manager, which has neither `Buffer`
 * nor a guaranteed `atob` — and two implementations of a codec that must agree
 * byte for byte is precisely the failure this project keeps refusing to build.
 * One implementation, both consumers, the same discipline as the validator.
 *
 * base64url rather than base64 so the blob survives a URL and a QR without
 * escaping: no `+`, no `/`, no `=`.
 *
 * Only UTF-8 text goes through it, so the encoder does its own UTF-8 conversion
 * rather than depending on `TextEncoder` being present.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Code point -> UTF-8 bytes, without `TextEncoder`. */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);

    // A surrogate pair is one code point in two units; combining them here is
    // what keeps a repository path with an emoji in it from becoming mojibake.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return bytes;
}

function fromUtf8Bytes(bytes: number[]): string {
  let out = '';

  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    let code: number;
    let width: number;

    if (byte < 0x80) {
      code = byte;
      width = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      code = byte & 0x1f;
      width = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      code = byte & 0x0f;
      width = 3;
    } else if ((byte & 0xf8) === 0xf0) {
      code = byte & 0x07;
      width = 4;
    } else {
      throw new Error('Not valid UTF-8.');
    }

    if (i + width > bytes.length) throw new Error('Truncated UTF-8.');

    for (let k = 1; k < width; k += 1) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) throw new Error('Not valid UTF-8.');
      code = (code << 6) | (next & 0x3f);
    }

    i += width;

    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }

  return out;
}

export function encodeBase64Url(text: string): string {
  const bytes = utf8Bytes(text);
  let out = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f]!;
  }

  return out;
}

/** Throws on anything that is not base64url of valid UTF-8. Callers catch. */
export function decodeBase64Url(encoded: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of encoded) {
    // Padding is not produced by the encoder, but a blob that has been through
    // something that added it should still read rather than fail obscurely.
    if (character === '=') continue;

    const value = ALPHABET.indexOf(character);
    if (value === -1) throw new Error(`"${character}" is not a base64url character.`);

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return fromUtf8Bytes(bytes);
}

// ---------------------------------------------------------------------------
// Standard base64
//
// GitHub's Git Data API speaks standard base64 with `+`, `/` and padding —
// not the url-safe alphabet above. The two differ in exactly three characters,
// so they share the machinery and differ only in a translation at the edges.
//
// Two codecs rather than one with a flag, because the call sites are about
// different things and should not be able to pass the wrong one: base64url
// carries a token through a URL, and base64 carries file bytes to GitHub.
// ---------------------------------------------------------------------------

/** The standard alphabet. Identical to `ALPHABET` but for the last two entries. */
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64url to standard base64, padded. What GitHub wants for a blob. */
export function toStandardBase64(base64url: string): string {
  const swapped = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = swapped.length % 4;

  // GitHub rejects an unpadded blob body, and the url-safe encoder above never
  // emits padding — so this is not defensive, it is the actual conversion.
  return remainder === 0 ? swapped : swapped + '='.repeat(4 - remainder);
}

/** Standard base64 to base64url, unpadded. */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 text as standard base64. */
export function encodeBase64(text: string): string {
  return toStandardBase64(encodeBase64Url(text));
}

/**
 * Standard base64 back to UTF-8 text. Throws on anything that is not.
 *
 * GitHub wraps the base64 it returns at 60 characters, so whitespace is
 * stripped rather than refused — a newline inside a blob body is formatting,
 * not corruption, and refusing it would fail on every file the API returns.
 */
export function decodeBase64(encoded: string): string {
  return decodeBase64Url(toBase64Url(encoded.replace(/\s+/g, '')));
}

/** The alphabet is exported so a test can assert the two differ as described. */
export const STANDARD_ALPHABET = STANDARD;
