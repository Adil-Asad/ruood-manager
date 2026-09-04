/**
 * Picking an image, and getting it small enough to send.
 *
 * ## The rule this file exists for
 *
 * **An animated GIF must not be touched here.**
 *
 * `expo-image-manipulator` decodes a bitmap, resizes it and re-encodes it. Hand
 * it an animation and it returns frame one — a perfectly valid, perfectly still
 * picture, with no error and no warning. The upload would succeed, the publish
 * would succeed, and the announcement would go out as a motionless image that
 * looked exactly like what the administrator chose. That is the worst possible
 * shape for a bug, and it is the default behaviour of every image library on
 * this platform.
 *
 * So an animation skips client-side optimisation entirely and the original
 * bytes go up untouched. The server has `sharp`, which decodes every frame, and
 * it does the resizing and re-encoding there — see `packages/core/src/images/
 * encode.ts`, which asserts the frame count of its own output for the same
 * reason.
 *
 * ## Which is authoritative
 *
 * Neither half trusts the other, and they are not doing the same job (§27):
 *
 *   here    a nicety. A 12-megapixel camera photo is 8 MB, and sending 8 MB
 *           over a phone connection to a server that will squeeze it to 150 KB
 *           anyway is a slow progress bar for nothing.
 *   server  the authority. It decodes the bytes with `sharp` and validates
 *           format, dimensions, frame count and size from what it actually
 *           finds — never from the filename, never from a declared MIME type,
 *           and never from anything this file claims (§26).
 *
 * A client that skipped optimisation entirely would still be correct. A server
 * that trusted this file would not be.
 */

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { readAsStringAsync, EncodingType, getInfoAsync } from 'expo-file-system/legacy';

import type { CropRect, Size } from './crop';

/**
 * The largest original this app will send.
 *
 * Not a quality judgement — a transport one. Beyond this the base64 body is
 * tens of megabytes over a phone connection, and the server would refuse it
 * anyway (`MAX_UPLOAD_BYTES` there is 32 MB, and base64 costs a third more).
 * Refusing here means the administrator finds out before the upload rather than
 * after it.
 */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

/**
 * How large an animation may be, before anything is sent.
 *
 * Lower than a still's ceiling, and deliberately: an animation is not
 * optimisable on this side at all, so whatever is picked is what gets uploaded.
 * A 40 MB GIF is a 40 MB upload, and the server would then refuse it for having
 * too many frames — after the wait.
 */
export const MAX_ANIMATION_BYTES = 12 * 1024 * 1024;

/**
 * The long edge this app resizes down to before sending.
 *
 * Matches the schema's `IMAGE_MAX_DIMENSION`, so the server's own resize has
 * nothing left to do on an image that came through here — and an image that
 * came from anywhere else is still resized there.
 */
export const CLIENT_MAX_DIMENSION = 1080;

/** Below this there is nothing worth compressing, so nothing is. */
const OPTIMISE_ABOVE_BYTES = 400 * 1024;

/**
 * A crop the administrator confirmed.
 *
 * Applied here rather than on the server because the administrator has already
 * SEEN it: the frame they dragged is the rectangle, and sending the original
 * plus a rectangle would mean the published image was produced by code that
 * never showed anybody the result.
 */
export interface AppliedCrop {
  rect: CropRect;
  /** What to encode at. Never larger than the rectangle itself. */
  output: Size;
}

export interface PickedImage {
  /** Base64 of the bytes to upload. */
  dataBase64: string;
  /** Carries the extension, which decides how the original is kept in `content/media/`. */
  filename: string;
  /** What the administrator picked, in bytes. */
  originalBytes: number;
  /** What will actually be sent. Equal to `originalBytes` when nothing was done. */
  optimisedBytes: number;
  /** Whether this moves — and therefore whether it was deliberately left alone. */
  animated: boolean;
  /** A local uri for showing a preview before it is sent. */
  previewUri: string;
  /** The shape it was cropped to, when it was. Display only. */
  ratio?: string;
  /** What the encoder actually produced. Diagnostics only; absent when nothing was re-encoded. */
  output?: Size;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

/**
 * Opens the system picker.
 *
 * `allowsEditing` is deliberately OFF. The Android crop UI rasterises whatever
 * it is given, so turning it on would silently destroy every animation before
 * this module ever saw one — the same failure as the manipulator, arriving one
 * step earlier.
 *
 * Returns `null` when the administrator backed out, which is not an error and
 * must not be reported as one.
 */
export async function pickImage(): Promise<ImagePicker.ImagePickerAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    allowsEditing: false,
    // Full quality out of the picker. Compressing here would be a second,
    // invisible quality step before the one below that reports what it did.
    quality: 1,
    exif: false,
  });

  if (result.canceled || result.assets.length === 0) return null;
  return result.assets[0]!;
}

/**
 * The source's size, in the coordinate system the CROP will be applied in.
 *
 * This exists because the obvious answer is wrong, and wrong invisibly.
 *
 * `Image.getSize` was used here first. It returns a size, the cropper lays the
 * image out at that size, and everything on screen is self-consistent — the
 * frame, the drag, the preview, all of it looks perfect. But the rectangle the
 * cropper computes is then handed to `expo-image-manipulator`, which measures
 * in the file's TRUE pixels. When the two sizes disagree, the manipulator cuts
 * a different rectangle out of a different part of the picture, and the only
 * way to notice is to compare the preview with the result side by side.
 *
 * That was a real bug: at 4:5 on a 3000x2000 test card, the editor framed the
 * centre and the committed image was the top-left corner.
 *
 * So the size is asked of the manipulator itself, by running it with no
 * actions. It is the same library, reading the same file, reporting the
 * coordinate system it is about to crop in — the two cannot disagree, because
 * there is only one of them. The cost is one decode per image, once, when the
 * editor opens.
 *
 * Never call this for an animation: every path through the manipulator returns
 * frame one. Nothing here needs to — the cropper is not offered for one.
 */
export async function sourceSize(uri: string): Promise<Size | null> {
  try {
    const probe = await manipulateAsync(uri, []);
    if (probe.width > 0 && probe.height > 0) {
      return { width: probe.width, height: probe.height };
    }
  } catch {
    // An image the manipulator cannot read is one it cannot crop either. The
    // caller sends it uncropped rather than failing.
  }

  return null;
}

/**
 * Prepares a picked asset for upload.
 *
 * Reports what it did rather than doing it quietly, so the screen can show
 * "1.8 MB → 420 KB" (§8) — and so an animation can say, truthfully, that it was
 * left alone.
 */
export async function prepareForUpload(
  asset: ImagePicker.ImagePickerAsset,
  crop?: AppliedCrop,
): Promise<PickedImage> {
  const originalBytes = asset.fileSize ?? (await sizeOf(asset.uri));
  const animated = await isAnimatedAsset(asset);

  if (animated) {
    if (originalBytes > MAX_ANIMATION_BYTES) {
      throw new MediaError(
        'This animation is too large. Please choose a shorter one, or one at a smaller size.',
      );
    }

    // Untouched, and the crop is deliberately IGNORED even if one was passed.
    // Every path through the manipulator returns frame one, so cropping here
    // would publish a still image that looked exactly like a success. The form
    // does not offer the cropper for an animation; this is the second lock on
    // that door, because the cost of it being wrong is invisible.
    const dataBase64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });

    return {
      dataBase64,
      filename: 'announcement.gif',
      originalBytes,
      optimisedBytes: originalBytes,
      animated: true,
      previewUri: asset.uri,
    };
  }

  if (originalBytes > MAX_ORIGINAL_BYTES) {
    throw new MediaError('This image is too large. Please choose a smaller image.');
  }

  const format = saveFormatFor(asset);

  // A confirmed crop is applied first and settles the size question entirely:
  // the rectangle is cut out and the result encoded at `output`, which the
  // crop maths has already capped at the rectangle's own size so nothing is
  // ever upscaled.
  if (crop) {
    const result = await manipulateAsync(
      asset.uri,
      [{ crop: crop.rect }, { resize: { width: crop.output.width } }],
      { format, compress: 0.85, base64: true },
    );

    if (!result.base64) {
      throw new MediaError('That image could not be prepared. Please try another one.');
    }

    return {
      dataBase64: result.base64,
      filename: `announcement${extensionFor(format)}`,
      originalBytes,
      optimisedBytes: Math.floor((result.base64.length * 3) / 4),
      animated: false,
      previewUri: result.uri,
      output: { width: result.width, height: result.height },
    };
  }

  const needsResize = Math.max(asset.width ?? 0, asset.height ?? 0) > CLIENT_MAX_DIMENSION;
  const needsCompression = originalBytes > OPTIMISE_ABOVE_BYTES;

  if (!needsResize && !needsCompression) {
    // Small already. Re-encoding it would cost quality and save nothing.
    const dataBase64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });

    return {
      dataBase64,
      filename: `announcement${extensionFor(format)}`,
      originalBytes,
      optimisedBytes: originalBytes,
      animated: false,
      previewUri: asset.uri,
    };
  }

  // Resize on the longer edge, preserving the aspect ratio — passing only one
  // dimension is what makes the manipulator keep it.
  const landscape = (asset.width ?? 0) >= (asset.height ?? 0);
  const actions = needsResize
    ? [landscape
        ? { resize: { width: CLIENT_MAX_DIMENSION } }
        : { resize: { height: CLIENT_MAX_DIMENSION } }]
    : [];

  const result = await manipulateAsync(asset.uri, actions, {
    format,
    // Ignored for PNG, which is lossless. Kept high because the server does the
    // real squeeze against a byte budget and a soft input cannot be un-softened.
    compress: 0.85,
    base64: true,
  });

  if (!result.base64) {
    throw new MediaError('That image could not be prepared. Please try another one.');
  }

  return {
    dataBase64: result.base64,
    filename: `announcement${extensionFor(format)}`,
    originalBytes,
    // base64 is 4 bytes per 3, so the decoded length is what will be stored.
    optimisedBytes: Math.floor((result.base64.length * 3) / 4),
    animated: false,
    previewUri: result.uri,
  };
}

/**
 * Whether these bytes are an animation.
 *
 * The file header is read rather than the MIME type or the extension, because
 * both are supplied by whatever produced the file and neither is evidence
 * (§26). A GIF is `GIF87a` or `GIF89a` in its first six bytes, and an animated
 * one carries more than one Graphic Control Extension block — but the second
 * question does not need answering here: a still GIF sent untouched is simply a
 * still GIF, and the server sees it for what it is and treats it as one.
 *
 * So the test is "is this a GIF", and the consequence is "do not manipulate
 * it". That is the safe side of the only mistake that matters.
 */
async function isAnimatedAsset(asset: ImagePicker.ImagePickerAsset): Promise<boolean> {
  // The cheap checks first, so a photograph never costs a file read.
  if (asset.mimeType === 'image/gif') return true;
  if (/\.gif$/i.test(asset.fileName ?? asset.uri)) return true;

  try {
    // 8 bytes of base64 is 12 characters; reading the whole file to look at six
    // of them would mean holding a 20 MB photo in memory to answer "no".
    const head = await readAsStringAsync(asset.uri, {
      encoding: EncodingType.Base64,
      length: 8,
      position: 0,
    });

    return globalThis.atob(head).startsWith('GIF8');
  } catch {
    // Unreadable header. Treated as NOT animated, which routes it through the
    // manipulator — and the manipulator will fail loudly on something it cannot
    // decode, where the alternative is uploading unknown bytes as an animation.
    return false;
  }
}

function saveFormatFor(asset: ImagePicker.ImagePickerAsset): SaveFormat {
  const name = (asset.fileName ?? asset.uri).toLowerCase();

  // The source format is preserved rather than normalised to JPEG. A PNG with
  // transparency re-encoded as JPEG is composited onto a background this module
  // does not choose — and the one the server picks (white) would then be
  // applied twice, to whatever the phone happened to use first.
  if (asset.mimeType === 'image/png' || name.endsWith('.png')) return SaveFormat.PNG;
  if (asset.mimeType === 'image/webp' || name.endsWith('.webp')) return SaveFormat.WEBP;
  return SaveFormat.JPEG;
}

function extensionFor(format: SaveFormat): string {
  switch (format) {
    case SaveFormat.PNG:
      return '.png';
    case SaveFormat.WEBP:
      return '.webp';
    default:
      return '.jpg';
  }
}

async function sizeOf(uri: string): Promise<number> {
  try {
    const info = await getInfoAsync(uri);
    return info.exists && 'size' in info ? (info.size ?? 0) : 0;
  } catch {
    return 0;
  }
}
