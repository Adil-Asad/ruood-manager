/**
 * Choosing a format, and framing a picture inside it.
 *
 * ## Why this is hand-written
 *
 * Pinch and pan, with no new dependency. `react-native-gesture-handler` and
 * `react-native-reanimated` would both do it more smoothly and would both mean
 * a native rebuild and two significant packages for a screen with one frame and
 * two gestures. React Native's own `PanResponder` reports every touch, which is
 * all a pinch is, and `Animated` moves the image without a re-render.
 *
 * The same judgement `ChoiceRow` records: a dependency for a circle is a bad
 * trade, and so is a dependency for a drag.
 *
 * ## The state model
 *
 * `scale` and `offset` are held in refs and mirrored into `Animated.Value`s.
 * The gesture writes the animated values directly, so dragging never re-renders
 * — a `setState` per touch move is exactly the thing that makes a crop editor
 * feel broken. React state is updated only on release, because that is when the
 * numbers matter to anything else.
 *
 * All the arithmetic lives in `../crop` and is tested there. Nothing in this
 * file decides what a crop IS; it decides when a finger moved.
 *
 * ## Animations never reach this screen
 *
 * An animated GIF is not croppable on the phone: every path through
 * `expo-image-manipulator` returns frame one. The form does not open this
 * editor for one, and `media.ts` sends the original bytes untouched. Cropping a
 * GIF here would produce a still image that looked exactly like a success.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_RATIO,
  RATIOS,
  clampOffset,
  clampScale,
  cropRectFor,
  fitCover,
  frameFor,
  outputSizeFor,
  ratioById,
  type CropRect,
  type RatioId,
  type Size,
} from '../crop';
import { sourceSize } from '../media';
import { Body, Button, Hint, usePalette } from './ui';
import { RADIUS, SPACE, TOUCH_TARGET } from '../theme';

export interface CropResult {
  ratio: RatioId;
  crop: CropRect;
  /** What to encode the crop at. Never larger than the crop itself. */
  output: Size;
}

export interface ImageCropperProps {
  uri: string;
  /** The source's true pixel size. Everything is computed against it. */
  image: Size;
  initialRatio?: RatioId;
  onCancel: () => void;
  onConfirm: (result: CropResult) => void;
  busy?: boolean;
  /**
   * Shows what the gesture handler is actually receiving.
   *
   * Developer builds only — `image-editor-preview` is the one caller that
   * passes it. A pinch that does nothing looks identical whether the touches
   * never arrived or the arithmetic refused them, and on a device there is no
   * other way to tell those apart.
   */
  debug?: boolean;
}

export function ImageCropper({
  uri,
  image,
  initialRatio = DEFAULT_RATIO,
  onCancel,
  onConfirm,
  busy,
  debug,
}: ImageCropperProps): React.JSX.Element {
  const palette = usePalette();

  // This is a full-screen Modal, so it sits OUTSIDE `Screen` and gets none of
  // its insets: without this the heading is drawn under the status bar clock.
  const insets = useSafeAreaInsets();

  const [ratioId, setRatioId] = useState<RatioId>(initialRatio);
  const [available, setAvailable] = useState<Size>({ width: 0, height: 0 });

  const ratio = ratioById(ratioId);
  const frame = useMemo(
    () => (available.width > 0 ? frameFor(available, ratio) : { width: 0, height: 0 }),
    [available, ratio],
  );

  // The committed transform. Refs rather than state because the gesture reads
  // them on every touch and a stale closure would make the image jump.
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });

  // What is actually drawn. Written directly by the gesture, so a drag costs no
  // re-render at all.
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const scaleValue = useRef(new Animated.Value(1)).current;

  /** Puts the image back inside the frame and redraws it. */
  const apply = useCallback(
    (nextScale: number, nextOffset: { x: number; y: number }) => {
      if (frame.width <= 0) return;

      const scale = clampScale(nextScale, image, frame);
      const offset = clampOffset(nextOffset, image, frame, scale);

      scaleRef.current = scale;
      offsetRef.current = offset;

      scaleValue.setValue(scale);
      translate.setValue(offset);
    },
    [frame, image, scaleValue, translate],
  );

  // Re-fit whenever the frame changes — which is every time the administrator
  // picks a different format. Starting from `fitCover` means the new shape is
  // filled immediately rather than showing an edge until somebody drags.
  useEffect(() => {
    if (frame.width <= 0) return;
    apply(fitCover(image, frame), { x: 0, y: 0 });
    // Keyed on the DIMENSIONS rather than on the objects: `frame` is recomputed
    // every render and `apply` with it, so depending on either would re-fit the
    // image on every frame and make dragging impossible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.width, frame.height, image.width, image.height]);

  /** The pinch distance when the second finger landed, and the scale then. */
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const panStart = useRef({ x: 0, y: 0 });

  // What the last touch actually looked like. Written only when `debug` is on,
  // because a setState per touch move is exactly what the refs above exist to
  // avoid.
  const [trace, setTrace] = useState('no touches yet');

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,

        onPanResponderGrant: () => {
          panStart.current = { ...offsetRef.current };
          pinch.current = null;
        },

        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;

          if (debug) {
            setTrace(
              `touches ${touches.length} · scale ${scaleRef.current.toFixed(3)} · dx ${Math.round(gesture.dx)}`,
            );
          }

          if (touches.length >= 2) {
            const [a, b] = touches;
            const distance = Math.hypot(a!.pageX - b!.pageX, a!.pageY - b!.pageY);

            // The first frame of a pinch only establishes the baseline. Zooming
            // from it would make the image leap by whatever the fingers already
            // were apart.
            if (!pinch.current) {
              pinch.current = { distance, scale: scaleRef.current };
              panStart.current = { ...offsetRef.current };
              return;
            }

            if (pinch.current.distance > 0) {
              apply(pinch.current.scale * (distance / pinch.current.distance), offsetRef.current);
            }
            return;
          }

          // One finger: a drag. The pinch baseline is cleared so lifting one
          // finger mid-pinch does not read as an enormous drag.
          if (pinch.current) {
            pinch.current = null;
            panStart.current = { ...offsetRef.current };
            return;
          }

          apply(scaleRef.current, {
            x: panStart.current.x + gesture.dx,
            y: panStart.current.y + gesture.dy,
          });
        },

        onPanResponderRelease: () => {
          pinch.current = null;
          panStart.current = { ...offsetRef.current };
        },
        onPanResponderTerminate: () => {
          pinch.current = null;
        },
      }),
    [apply, debug],
  );

  const confirm = useCallback(() => {
    const crop = cropRectFor(image, frame, scaleRef.current, offsetRef.current);
    onConfirm({ ratio: ratioId, crop, output: outputSizeFor(crop, ratio) });
  }, [image, frame, ratioId, ratio, onConfirm]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setAvailable({ width, height });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg, paddingTop: insets.top }}>
      <View style={{ padding: SPACE.lg, gap: SPACE.xs }}>
        <Body>Choose a shape</Body>
        <Hint>Drag to move. Pinch to zoom. The picture is never stretched.</Hint>
      </View>

      {/* ------------------------------------------------------------------ */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, paddingHorizontal: SPACE.lg }}>
        {RATIOS.map((entry) => (
          <RatioChip
            key={entry.id}
            label={entry.label}
            shape={entry.shape}
            selected={entry.id === ratioId}
            onPress={() => setRatioId(entry.id)}
          />
        ))}
      </View>

      {/* The stage. `onLayout` gives the space the frame is fitted into. */}
      <View
        onLayout={onLayout}
        style={{
          flex: 1,
          margin: SPACE.lg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {frame.width > 0 ? (
          <View
            {...responder.panHandlers}
            style={{
              width: frame.width,
              height: frame.height,
              // The window. Everything outside it is what the crop discards.
              overflow: 'hidden',
              borderRadius: RADIUS.md,
              backgroundColor: palette.surface2,
              borderWidth: 1,
              borderColor: palette.borderStrong,
            }}
          >
            <Animated.Image
              source={{ uri }}
              // Laid out at the image's OWN pixel size and then scaled by one
              // factor. That is what makes stretching impossible: there is no
              // second axis to get wrong.
              style={{
                width: image.width,
                height: image.height,
                position: 'absolute',
                left: (frame.width - image.width) / 2,
                top: (frame.height - image.height) / 2,
                transform: [
                  { translateX: translate.x },
                  { translateY: translate.y },
                  { scale: scaleValue },
                ],
              }}
              // `contain` inside a box that is already the image's exact size is
              // a no-op that guarantees no resampling decision is made here.
              resizeMode="contain"
            />
          </View>
        ) : null}
      </View>

      {/* ------------------------------------------------------------------ */}
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.lg + insets.bottom, gap: SPACE.sm }}>
        {debug ? <Hint>{trace}</Hint> : null}

        <Hint>
          {ratio.label} · {ratio.shape} · {ratio.output.width} × {ratio.output.height}
        </Hint>

        <Button kind="primary" full busy={busy} onPress={confirm}>
          Use this crop
        </Button>
        <Button full disabled={busy} onPress={onCancel}>
          Cancel
        </Button>
      </View>
    </View>
  );
}

/**
 * One format.
 *
 * The word is the primary label and the ratio sits under it in smaller type —
 * a non-technical administrator picks "Square", and "1:1" is there for anyone
 * who wants to know what that means.
 */
function RatioChip({
  label,
  shape,
  selected,
  onPress,
}: {
  label: string;
  shape: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}, ${shape}`}
      style={{
        backgroundColor: selected ? palette.accent : palette.surface,
        borderColor: selected ? palette.accent : palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.sm,
        minHeight: TOUCH_TARGET,
        justifyContent: 'center',
        alignItems: 'center',
        minWidth: 78,
      }}
    >
      <Text
        style={{
          color: selected ? palette.accentText : palette.text,
          fontSize: 13,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: selected ? palette.accentText : palette.textFaint,
          fontSize: 11,
          fontVariant: ['tabular-nums'],
        }}
      >
        {shape}
      </Text>
    </Pressable>
  );
}

/**
 * The size to compute a crop against, or `null`.
 *
 * This asks `media.sourceSize`, which asks the MANIPULATOR — deliberately, and
 * `Image.getSize` is deliberately not used. See the comment there: a size from
 * anywhere else produces an editor that is perfectly self-consistent on screen
 * and cuts a different rectangle out of the file.
 */
export function useImageSize(uri: string | null): Size | null {
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    setSize(null);
    if (!uri) return;

    let cancelled = false;

    void sourceSize(uri).then((result) => {
      // An image whose size cannot be read cannot be cropped against. The
      // caller falls back to sending it uncropped rather than failing.
      if (!cancelled) setSize(result);
    });

    return () => {
      cancelled = true;
    };
  }, [uri]);

  return size;
}
