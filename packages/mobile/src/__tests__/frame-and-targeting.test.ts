/**
 * What the frame decides, and who an announcement is for.
 *
 * Both are pure, and both are things that were being decided by nobody:
 *
 *   the frame     was chosen, cropped to, and then previewed at a fixed 16:9 in
 *                 this app and drawn at a fixed 16:9 in RUOOD Lab. Every shape
 *                 but a landscape one arrived cut to a band, in both places.
 *   the targeting the schema has always carried `platforms`, `minVersion` and
 *                 `maxVersion`, and a phone could not set any of them.
 *
 * There is no new field behind either. The frame is read back from the
 * published dimensions, and the audience is `targeting.platforms`.
 */

import {
  BODY_LIMITS,
  bodyLimitFor,
  DEFAULT_RATIO,
  frameForSize,
  RATIOS,
} from '../crop';
import { audienceFor, platformsFor } from '../language';

/** What the pipeline publishes for each frame, after the 1080 long-edge cap. */
const PUBLISHED = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 864, height: 1080 },
  '2:3': { width: 720, height: 1080 },
  '9:16': { width: 608, height: 1080 },
} as const;

describe('the frame is the published dimensions', () => {
  it('reads every frame back from what the pipeline produced', () => {
    for (const ratio of RATIOS) {
      expect(frameForSize(PUBLISHED[ratio.id])).toBe(ratio.id);
    }
  });

  it('reads a crop the encoder did not have to shrink', () => {
    // A small selection is encoded at its own size rather than upscaled, so the
    // numbers are not the canonical ones — only the shape is.
    expect(frameForSize({ width: 720, height: 900 })).toBe('4:5');
    expect(frameForSize({ width: 400, height: 400 })).toBe('1:1');
  });

  it('answers for a picture from before frames existed, rather than refusing', () => {
    // 16:9 was what everything used to be drawn at. Nearest wins; nothing
    // throws, because an old announcement still has to open.
    expect(RATIOS.map((ratio) => ratio.id)).toContain(frameForSize({ width: 1600, height: 900 }));
    expect(RATIOS.map((ratio) => ratio.id)).toContain(frameForSize({ width: 10, height: 0 }));
  });
});

describe('how much there is room to say', () => {
  it('is the full limit when there is no picture', () => {
    expect(bodyLimitFor(null, false, 500)).toBe(500);
    expect(bodyLimitFor('9:16', false, 500)).toBe(500);
  });

  it('shrinks as the picture grows taller', () => {
    const limits = RATIOS.map((ratio) => bodyLimitFor(ratio.id, true, 500));

    // RATIOS is ordered squarest first, so each frame leaves less room than the
    // one before it.
    for (let index = 1; index < limits.length; index += 1) {
      expect(limits[index]!).toBeLessThan(limits[index - 1]!);
    }
    expect(Math.max(...limits)).toBeLessThan(500);
  });

  it('treats a picture of unknown shape as the default frame', () => {
    // An animation is never cropped, so nobody chose a frame for it. It is
    // still a picture, and 500 characters under one is not an announcement.
    expect(bodyLimitFor(null, true, 500)).toBe(BODY_LIMITS[DEFAULT_RATIO]);
  });
});

describe('who sees it', () => {
  it('maps each answer onto the platforms the schema already has', () => {
    expect(platformsFor('both')).toEqual(['android', 'ios']);
    expect(platformsFor('android')).toEqual(['android']);
    expect(platformsFor('ios')).toEqual(['ios']);
  });

  it('reads a stored record back into the answer that produced it', () => {
    for (const audience of ['both', 'android', 'ios'] as const) {
      expect(audienceFor(platformsFor(audience))).toBe(audience);
    }
  });

  it('reads a record the CLI wrote, including one naming web', () => {
    // `web` is not offered on the phone and is a legitimate CLI target. It must
    // not read as "iPhone only" and lose Android on the next save.
    expect(audienceFor(['android', 'ios', 'web'])).toBe('both');
    expect(audienceFor(['android', 'web'])).toBe('android');
    expect(audienceFor([])).toBe('both');
  });
});
