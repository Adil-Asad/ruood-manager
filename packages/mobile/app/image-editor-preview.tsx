/**
 * The image editor, exercised on its own. Developer builds only.
 *
 * ## Why this exists
 *
 * The cropper is reached, in the product, by signing in and starting an
 * announcement. That is the right place for it and a slow place to iterate on:
 * changing one number in `crop.ts` should not mean a sign-in and a repository
 * round trip to see the result.
 *
 * It is also the only way to exercise the picker, the four formats, the
 * gestures and the optimiser on a REAL DEVICE without touching anybody's
 * announcements — which matters, because a crop bug is invisible in a unit test
 * of the arithmetic (that passes) and obvious the moment a finger drags.
 *
 * It writes nothing, commits nothing and needs no credential. It is reachable
 * only from Advanced, which `developerToolsAvailable()` hides in a production
 * build, so an administrator can never arrive here.
 *
 * ## What it proves
 *
 * The numbers under the result are the point: the output dimensions must match
 * the chosen format exactly, and an animation must come back with
 * `animated: true` and its bytes untouched. Both are things you can be wrong
 * about while the picture on screen looks perfectly fine.
 */

import { useState } from 'react';
import { Modal, View } from 'react-native';
import { getInfoAsync } from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Image } from 'expo-image';

import { MediaError, pickImage, prepareForUpload, type PickedImage } from '../src/media';
import { ratioById, type RatioId, type Size } from '../src/crop';
import { fileSize } from '../src/language';
import { ImageCropper, useImageSize, type CropResult } from '../src/components/image-cropper';
import { Body, Button, Callout, Card, Hint, Screen } from '../src/components/ui';
import { RADIUS, SPACE } from '../src/theme';

export default function ImageEditorPreviewScreen(): React.JSX.Element {
  const [asset, setAsset] = useState<Awaited<ReturnType<typeof pickImage>>>(null);
  const [cropping, setCropping] = useState(false);
  const [result, setResult] = useState<PickedImage | null>(null);
  const [chosen, setChosen] = useState<RatioId | null>(null);
  const [applied, setApplied] = useState<CropResult | null>(null);
  // Captured when the crop is confirmed. `size` is read only while the editor
  // is open, so by the time the result is on screen it has already gone.
  const [appliedSource, setAppliedSource] = useState<Size | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const size = useImageSize(cropping ? (asset?.uri ?? null) : null);

  const choose = async (): Promise<void> => {
    setError(null);
    setResult(null);
    setChosen(null);
    setApplied(null);
    setAppliedSource(null);

    const picked = await pickImage();
    if (!picked) return;

    setAsset(picked);

    // An animation is never cropped — the same check the real form makes. Here
    // it also demonstrates the behaviour, which is what this screen is for.
    const looksAnimated =
      picked.mimeType === 'image/gif' || /\.gif$/i.test(picked.fileName ?? picked.uri);

    if (looksAnimated) {
      await run(picked);
      return;
    }

    setCropping(true);
  };

  /**
   * Loads a file placed on the device by the test harness.
   *
   * Developer builds only, and only ever reads — it exists so the crop path can
   * be run against an image whose geometry is known, which is what makes
   * "nothing was stretched" checkable rather than a matter of opinion.
   */
  const loadFixture = async (name: string): Promise<void> => {
    setError(null);
    setResult(null);
    setChosen(null);
    setApplied(null);
    setAppliedSource(null);

    // The app's own EXTERNAL files directory. Two properties matter and only
    // this location has both: the app can read it with no runtime permission
    // (reading /sdcard would need READ_EXTERNAL_STORAGE, which this app
    // deliberately never requests because the system photo picker does not need
    // it), and `adb push` can write to it on a release build (internal storage
    // it cannot).
    const packageId = Constants.expoConfig?.android?.package ?? '';
    const uri = `file:///sdcard/Android/data/${packageId}/files/${name}`;

    try {
      const info = await getInfoAsync(uri);
      if (!info.exists) {
        setError(`${name} is not here yet. Push it to the app's files directory first.`);
        return;
      }

      const asset = {
        uri,
        width: 0,
        height: 0,
        fileName: name,
        fileSize: 'size' in info ? info.size : undefined,
        mimeType: name.endsWith('.gif') ? 'image/gif' : 'image/jpeg',
      } as NonNullable<Awaited<ReturnType<typeof pickImage>>>;

      setAsset(asset);

      if (name.endsWith('.gif')) {
        await run(asset);
        return;
      }

      setCropping(true);
    } catch (failure) {
      setError(String(failure));
    }
  };

  const run = async (
    picked: NonNullable<Awaited<ReturnType<typeof pickImage>>>,
    crop?: CropResult,
  ): Promise<void> => {
    setBusy(true);
    try {
      const prepared = await prepareForUpload(
        picked,
        crop ? { rect: crop.crop, output: crop.output } : undefined,
      );
      setResult(prepared);
      setChosen(crop?.ratio ?? null);
      setApplied(crop ?? null);
      setAppliedSource(size);
    } catch (failure) {
      setError(failure instanceof MediaError ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const expected = chosen ? ratioById(chosen) : null;

  return (
    <Screen>
      <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
        <Callout kind="warn" title="Developer tool">
          Exercises the picker, the four formats and the optimiser. It writes nothing and needs no
          sign-in. Hidden in a production build.
        </Callout>

        <Button kind="primary" full busy={busy} onPress={() => void choose()}>
          Choose an image
        </Button>

        {/* A fixed file, so the pipeline can be exercised against a KNOWN
            image. The test card carries a perfect circle: if anything in the
            crop path scales the axes independently it becomes an ellipse, which
            is the one distortion failure a screenshot of a photo cannot show. */}
        <Button full busy={busy} onPress={() => void loadFixture('ruood-test-card.jpg')}>
          Load the test card
        </Button>
        <Button full busy={busy} onPress={() => void loadFixture('ruood-test-anim.gif')}>
          Load the test animation
        </Button>

        {error ? <Callout kind="error" title="That did not work">{error}</Callout> : null}

        {result ? (
          <Card title={result.animated ? 'Animation, passed through' : 'Cropped and optimised'}>
            <Image
              source={{ uri: result.previewUri }}
              style={{
                width: '100%',
                aspectRatio: expected
                  ? expected.output.width / expected.output.height
                  : 1,
                borderRadius: RADIUS.md,
              }}
              contentFit="contain"
              autoplay
              transition={0}
            />

            <View style={{ height: SPACE.md }} />

            <View style={{ gap: SPACE.xs }}>
              <Body mono>{`format     ${expected ? `${expected.label} ${expected.shape}` : 'not cropped'}`}</Body>
              <Body mono>{`expected   ${expected ? `${expected.output.width}x${expected.output.height}` : '-'}`}</Body>
              {/* The three that make a silent crop mismatch visible. `source`
                  is the size the editor computed against and `crop` the
                  rectangle it asked for; if `actual` is not the expected size,
                  or the picture above is not the region that was framed, these
                  are what say which of the two was wrong. */}
              <Body mono>{`source     ${appliedSource ? `${appliedSource.width}x${appliedSource.height}` : '-'}`}</Body>
              <Body mono>{`crop       ${applied ? `${applied.crop.originX},${applied.crop.originY} ${applied.crop.width}x${applied.crop.height}` : '-'}`}</Body>
              <Body mono>{`actual     ${result.output ? `${result.output.width}x${result.output.height}` : '-'}`}</Body>
              <Body mono>{`animated   ${result.animated}`}</Body>
              <Body mono>{`original   ${fileSize(result.originalBytes)}`}</Body>
              <Body mono>{`optimised  ${fileSize(result.optimisedBytes)}`}</Body>
              <Body mono>{`filename   ${result.filename}`}</Body>
            </View>

            <View style={{ height: SPACE.sm }} />
            <Hint>
              {result.animated
                ? 'An animation is uploaded untouched, so the frames survive. The publishing build re-encodes it as an animated WebP.'
                : 'The picture above is the exact bytes that would be committed.'}
            </Hint>
          </Card>
        ) : null}
      </View>

      <Modal visible={cropping} animationType="slide" onRequestClose={() => setCropping(false)}>
        {cropping && asset && size ? (
          <ImageCropper
            uri={asset.uri}
            image={size}
            busy={busy}
            debug
            onCancel={() => setCropping(false)}
            onConfirm={(crop) => {
              setCropping(false);
              void run(asset, crop);
            }}
          />
        ) : (
          // The size could not be read yet, or at all. Without this the modal
          // is a blank screen with no way out but the back gesture — which is
          // exactly what a file the app cannot read produces.
          <View style={{ flex: 1, justifyContent: 'center', padding: SPACE.xl, gap: SPACE.lg }}>
            <Body dim>Preparing the picture…</Body>
            <Button
              full
              onPress={() => {
                setCropping(false);
                
              }}
            >
              Cancel
            </Button>
          </View>
        )}
      </Modal>
    </Screen>
  );
}
