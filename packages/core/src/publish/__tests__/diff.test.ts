import type { AnnouncementManifest, PublishedAnnouncement } from '@ruood/announcement-schema';

import { diffPublish, formatDiff } from '../diff';
import { toPublished } from '../../build/project';
import { NOW, authored, iso, DAY } from '../../__tests__/fixtures';

function published(overrides = {}): PublishedAnnouncement {
  return toPublished(authored(overrides));
}

function manifest(
  records: PublishedAnnouncement[],
  overrides: Partial<AnnouncementManifest> = {},
): AnnouncementManifest {
  return {
    schemaVersion: 1,
    revision: 1,
    generatedAt: iso(NOW),
    paused: false,
    announcements: records,
    ...overrides,
  };
}

function diff(
  before: AnnouncementManifest | null,
  after: AnnouncementManifest,
  imagesBefore = {},
  imagesAfter = {},
) {
  return diffPublish({
    before,
    after,
    imagesBefore,
    imagesAfter,
    manifestBytesBefore: 100,
    manifestBytesAfter: 120,
  });
}

describe('records', () => {
  it('reports a first publish as all additions', () => {
    const result = diff(null, manifest([published()]));
    expect(result.added.map((r) => r.id)).toEqual(['reports-center']);
    expect(result.removed).toEqual([]);
    expect(result.empty).toBe(false);
  });

  it('reports an unchanged record as unchanged', () => {
    const result = diff(manifest([published()]), manifest([published()]));
    expect(result.unchanged).toEqual(['reports-center']);
    expect(result.modified).toEqual([]);
  });

  it('is empty when nothing at all changed', () => {
    const result = diff(manifest([published()]), manifest([published()]));
    expect(result.empty).toBe(true);
    expect(formatDiff(result)).toMatch(/No changes/);
  });

  it('names the fields that differ', () => {
    const result = diff(
      manifest([published()]),
      manifest([published({ title: 'Reports', priority: 90 })]),
    );
    expect(result.modified).toEqual([
      { id: 'reports-center', fields: ['priority', 'title'], resetsImpressions: false },
    ]);
  });

  it('reports a removal', () => {
    const result = diff(manifest([published(), published({ id: 'other' })]), manifest([published()]));
    expect(result.removed.map((r) => r.id)).toEqual(['other']);
  });

  it('ignores key order, because canonical JSON is the comparison', () => {
    const a = published();
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
    ) as PublishedAnnouncement;
    expect(diff(manifest([a]), manifest([reordered])).modified).toEqual([]);
  });
});

describe('the rev bump is called out on its own', () => {
  it('flags a revision change as resetting impressions', () => {
    const result = diff(manifest([published()]), manifest([published({ rev: 2 })]));
    expect(result.modified[0]).toMatchObject({ fields: ['rev'], resetsImpressions: true });
  });

  it('says so in words, because it is the most consequential thing a publish does', () => {
    const result = diff(manifest([published()]), manifest([published({ rev: 2 })]));
    expect(formatDiff(result)).toContain('RE-SHOWS');
  });

  it('does not flag an ordinary edit', () => {
    const result = diff(manifest([published()]), manifest([published({ body: 'Changed.' })]));
    expect(result.modified[0]!.resetsImpressions).toBe(false);
    expect(formatDiff(result)).not.toContain('RE-SHOWS');
  });
});

describe('images', () => {
  it('reports additions and removals by path', () => {
    const result = diff(
      manifest([published()]),
      manifest([published()]),
      { 'images/old-11111111.webp': 900 },
      { 'images/new-22222222.webp': 1200 },
    );
    expect(result.imagesAdded).toEqual([{ path: 'images/new-22222222.webp', bytes: 1200 }]);
    expect(result.imagesRemoved).toEqual([{ path: 'images/old-11111111.webp', bytes: 900 }]);
    expect(result.empty).toBe(false);
  });

  it('treats an unchanged image as no change', () => {
    const images = { 'images/x-aaaaaaaa.webp': 900 };
    const result = diff(manifest([published()]), manifest([published()]), images, images);
    expect(result.imagesAdded).toEqual([]);
    expect(result.imagesRemoved).toEqual([]);
    expect(result.empty).toBe(true);
  });
});

describe('the kill switch', () => {
  it('is reported as its own change, loudly', () => {
    const result = diff(
      manifest([published()]),
      manifest([published()], { paused: true }),
    );
    expect(result.pausedChanged).toEqual({ from: false, to: true });
    expect(formatDiff(result)).toContain('KILL SWITCH ON');
  });

  it('reports being turned off', () => {
    const result = diff(
      manifest([published()], { paused: true }),
      manifest([published()]),
    );
    expect(result.pausedChanged).toEqual({ from: true, to: false });
    expect(result.empty).toBe(false);
  });

  it('is not reported on a first publish, where there is nothing to compare', () => {
    expect(diff(null, manifest([published()])).pausedChanged).toBeNull();
  });
});

describe('the summary', () => {
  it('lists additions, modifications and removals with their markers', () => {
    const result = diff(
      manifest([published({ id: 'gone' }), published()]),
      manifest([published({ title: 'New title' }), published({ id: 'fresh' })]),
    );
    const text = formatDiff(result);
    expect(text).toContain('+ fresh');
    expect(text).toContain('~ reports-center');
    expect(text).toContain('- gone');
  });

  it('states the byte and revision movement', () => {
    const result = diffPublish({
      before: manifest([published()], { revision: 4 }),
      after: manifest([published({ title: 'X' })], { revision: 5 }),
      imagesBefore: {},
      imagesAfter: {},
      manifestBytesBefore: 1000,
      manifestBytesAfter: 1200,
    });
    expect(formatDiff(result)).toContain('revision 4 -> 5');
    expect(formatDiff(result)).toContain('+200 bytes');
  });

  it('sorts every list, so the same change always reads the same way', () => {
    const result = diff(
      null,
      manifest([published({ id: 'ccc' }), published({ id: 'aaa' }), published({ id: 'bbb' })]),
    );
    expect(result.added.map((r) => r.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});

describe('a scheduled record', () => {
  it('appears as an addition before it is live', () => {
    const future = published({ id: 'later', startAt: iso(NOW + 5 * DAY) });
    expect(diff(null, manifest([future])).added.map((r) => r.id)).toEqual(['later']);
  });
});
