import { CanonicalJsonError, canonicalCompactJson, canonicalJson } from '../canonical';
import { manifest, publishedRecord } from './fixtures';

describe('key ordering', () => {
  it('sorts object keys', () => {
    expect(canonicalCompactJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('produces the same bytes whatever the insertion order', () => {
    const one = canonicalCompactJson({ z: 1, a: { d: 4, c: 3 }, m: [1, 2] });
    const two = canonicalCompactJson({ m: [1, 2], a: { c: 3, d: 4 }, z: 1 });
    expect(one).toBe(two);
  });

  it('sorts by code unit, not by locale', () => {
    // localeCompare would order these differently on some platforms, which is
    // the one thing a canonical form cannot tolerate.
    expect(canonicalCompactJson({ b: 1, B: 2, a: 3, A: 4 })).toBe('{"A":4,"B":2,"a":3,"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalCompactJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('values', () => {
  it('omits undefined members, as JSON.stringify does', () => {
    expect(canonicalCompactJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('writes an undefined array hole as null', () => {
    expect(canonicalCompactJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('keeps null, which is a real value in this schema', () => {
    expect(canonicalCompactJson({ endAt: null })).toBe('{"endAt":null}');
  });

  it('normalises negative zero', () => {
    expect(canonicalCompactJson({ n: -0 })).toBe('{"n":0}');
  });

  it('escapes strings exactly as JSON does', () => {
    expect(canonicalCompactJson({ s: 'a"b\\c\nd' })).toBe(JSON.stringify({ s: 'a"b\\c\nd' }));
  });

  it('renders empty containers compactly', () => {
    expect(canonicalJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}\n');
  });

  it('refuses a non-finite number rather than writing null', () => {
    expect(() => canonicalCompactJson({ n: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalCompactJson({ n: Infinity })).toThrow(CanonicalJsonError);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalCompactJson({ a: { b: [1, NaN] } })).toThrow(/a\.b\[1\]/);
  });

  it('refuses a function or a symbol', () => {
    expect(() => canonicalCompactJson({ f: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalCompactJson(undefined)).toThrow(CanonicalJsonError);
  });
});

describe('the pretty form', () => {
  it('indents by two spaces and ends with a newline', () => {
    expect(canonicalJson({ b: 1, a: { c: 2 } })).toBe(
      '{\n  "a": {\n    "c": 2\n  },\n  "b": 1\n}\n',
    );
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = manifest([publishedRecord()]);
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('is stable across repeated serialisation', () => {
    const value = manifest([publishedRecord()]);
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });
});

describe('the compact form', () => {
  it('carries the same data as the pretty form', () => {
    const value = manifest([publishedRecord()]);
    expect(JSON.parse(canonicalCompactJson(value))).toEqual(JSON.parse(canonicalJson(value)));
  });

  it('contains no insignificant whitespace, so reformatting cannot break a signature', () => {
    const compact = canonicalCompactJson(manifest([publishedRecord()]));
    expect(compact).not.toMatch(/\n/);
    expect(compact).not.toMatch(/: /);
  });

  it('is shorter than the pretty form', () => {
    const value = manifest([publishedRecord()]);
    expect(canonicalCompactJson(value).length).toBeLessThan(canonicalJson(value).length);
  });
});
