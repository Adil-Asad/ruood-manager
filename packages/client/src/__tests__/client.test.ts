/**
 * The platform-neutral plumbing that survived the move to GitHub.
 *
 * The pairing codec, the Manager-server API client and the session model are
 * all gone with the server itself. What is left is the part that was never
 * about the server: encoding bytes, and the `Http` port every front end injects
 * a transport into.
 *
 * The base64 half is worth more than it looks. `@ruood/announcement-github`
 * sends file content to the Git Data API with it, so an off-by-one in the
 * padding is a corrupt image in a published announcement — and it would look
 * like a successful commit.
 */

import { decodeBase64, decodeBase64Url, encodeBase64, encodeBase64Url, toBase64Url, toStandardBase64 } from '../base64url';
import { ApiFailure, ConnectionFailure } from '../http';

describe('base64url', () => {
  it('round-trips plain text', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'hello world', '{"v":1}']) {
      expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
    }
  });

  it('round-trips text a repository path can actually contain', () => {
    // A path with an accent or an emoji in it must survive, or pairing fails
    // for a reason that looks like the token being wrong.
    for (const text of ['d:\\RUŌOD\\announcements', 'café → naïve', '📣 announcements']) {
      expect(decodeBase64Url(encodeBase64Url(text))).toBe(text);
    }
  });

  it('emits nothing that needs escaping in a URL or a QR', () => {
    const encoded = encodeBase64Url('a'.repeat(100));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a character that is not in the alphabet', () => {
    expect(() => decodeBase64Url('abc!def')).toThrow();
  });
});


describe('standard base64', () => {
  it('round-trips text, including things outside ASCII', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'RUOOD', 'Réservé aux membres', '🎉 emoji 🎉']) {
      expect(decodeBase64(encodeBase64(text))).toBe(text);
    }
  });

  it('pads, because GitHub refuses an unpadded blob', () => {
    // The url-safe encoder never emits padding, so this conversion is the
    // actual difference between the two — not a defensive extra.
    expect(encodeBase64('a')).toMatch(/=$/);
    expect(encodeBase64('ab')).toMatch(/=$/);
    expect(encodeBase64('abc')).not.toMatch(/=$/);
  });

  it('uses + and / where base64url uses - and _', () => {
    // Bytes chosen to produce both characters. Getting this backwards corrupts
    // roughly one blob in forty, which is the worst possible rate: often enough
    // to happen and rare enough to look like something else.
    const tricky = String.fromCharCode(0xfb, 0xff, 0xbf);

    expect(encodeBase64Url(tricky)).toMatch(/[-_]/);
    expect(encodeBase64(tricky)).toMatch(/[+/]/);
    expect(decodeBase64(encodeBase64(tricky))).toBe(tricky);
  });

  it('converts between the two alphabets without losing anything', () => {
    const text = 'RUOOD announcements, with padding';
    expect(toStandardBase64(encodeBase64Url(text))).toBe(encodeBase64(text));
    expect(toBase64Url(encodeBase64(text))).toBe(encodeBase64Url(text));
  });

  it('tolerates the newlines GitHub wraps its blobs with', () => {
    // GitHub wraps at 60 characters. Refusing whitespace would fail on every
    // file the API returns.
    const encoded = encodeBase64('a reasonably long piece of announcement body text');
    const wrapped = encoded.replace(/(.{10})/g, `$1${'\n'}`);

    expect(decodeBase64(wrapped)).toBe('a reasonably long piece of announcement body text');
  });

  it('refuses something that is not base64 at all', () => {
    expect(() => decodeBase64('not base64 !!')).toThrow();
  });
});

describe('failures', () => {
  it('names an auth failure, whatever the status text says', () => {
    expect(new ApiFailure(401, 'Unauthorized').isAuthFailure).toBe(true);
    expect(new ApiFailure(500, 'Server error').isAuthFailure).toBe(false);
  });

  it('carries what could not be reached, for a message that names it', () => {
    const failure = new ConnectionFailure('https://api.github.com', new Error('offline'));
    expect(failure.message).toContain('api.github.com');
  });
});
