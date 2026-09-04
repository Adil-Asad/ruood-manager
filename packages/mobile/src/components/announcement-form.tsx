/**
 * The announcement form: image, title, message, delivery, when.
 *
 * Shared by the create screen and the edit screen, because they ask for exactly
 * the same five things and the only difference is what happens when the button
 * at the bottom is pressed. Two copies of this would be two places for the
 * character limits and the delivery mapping to drift.
 *
 * ## Five fields, and what is deliberately absent
 *
 * The schema has eighteen. The ones missing from this form are missing on
 * purpose, and each for its own reason:
 *
 *   id           generated (§11). Asking a non-technical person to invent a
 *                permanent, never-reused, hyphen-separated identifier is asking
 *                them to make a decision they cannot evaluate.
 *   rev          has its own operation and its own confirmation. Bumping it
 *                re-shows the announcement on every device, and the entire
 *                point of it being a separate field is lost the moment it can
 *                be changed while fixing a typo.
 *   status       the legal moves are a table; `applyTransition` owns them.
 *   priority     0-100, meaningful only relative to other announcements. Left
 *                at its default; the desktop Manager still exposes it.
 *   category     `feature` / `fix` / `notice` / `tip`. Real, and invisible to
 *                the RUOOD user, so it is a taxonomy nobody is asking for.
 *   targeting    platform and version ranges. A genuine capability and a
 *                genuinely technical one.
 *   trigger, maxImpressions, minIntervalHours, dismiss
 *                frequency rules with sensible defaults, and four more
 *                decisions on a screen that already asks for five.
 *
 * None of them are removed from the contract — every one is still there, still
 * validated, still editable from the desktop Manager. What changed is which of
 * them a phone puts in front of somebody.
 *
 * ## The id
 *
 * Derived from the title, which is what makes it readable in a git log later,
 * and de-duplicated against the server before it is used. It is never shown.
 */

import { useCallback, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH } from '@ruood/announcement-schema';

import { DELIVERY_LABELS, fileSize } from '../language';
import { MediaError, pickImage, prepareForUpload, type PickedImage } from '../media';
import { ratioById } from '../crop';
import { ImageCropper, useImageSize, type CropResult } from './image-cropper';
import { Body, Button, Callout, Card, Field, Hint, Input, usePalette } from './ui';
import { RADIUS, SPACE, TOUCH_TARGET } from '../theme';

export type Delivery = 'active' | 'passive';
export type Timing = 'now' | 'later';

export interface FormValue {
  title: string;
  body: string;
  delivery: Delivery;
  timing: Timing;
  /** Local wall-clock the administrator picked. Converted to an instant on save. */
  startAt: Date;
  /** A newly chosen image, or `null` when nothing was picked this session. */
  picked: PickedImage | null;
}

export function emptyForm(now: number): FormValue {
  return {
    title: '',
    body: '',
    delivery: 'active',
    timing: 'now',
    // An hour out, rounded, so "Schedule for later" opens on something
    // plausible rather than on a time that has already passed by the time
    // anybody presses the button.
    startAt: new Date(Math.ceil((now + 60 * 60 * 1000) / (15 * 60 * 1000)) * 15 * 60 * 1000),
    picked: null,
  };
}

export interface AnnouncementFormProps {
  value: FormValue;
  onChange: (value: FormValue) => void;
  /** An image already attached to this record, as a local uri. Edit screen only. */
  existingImageUri?: string | null;
  onRemoveImage?: () => void;
  disabled?: boolean;
}

export function AnnouncementForm({
  value,
  onChange,
  existingImageUri,
  onRemoveImage,
  disabled,
}: AnnouncementFormProps): React.JSX.Element {
  const palette = usePalette();

  const [optimising, setOptimising] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);

  /**
   * The asset waiting to be cropped.
   *
   * Set only for a STILL image. An animation goes straight through — see
   * `choose` below and the header of `media.ts`.
   */
  const [cropping, setCropping] = useState<{ uri: string; animated: boolean } | null>(null);
  const cropSize = useImageSize(cropping?.uri ?? null);
  const [pendingAsset, setPendingAsset] = useState<Awaited<
    ReturnType<typeof pickImage>
  > | null>(null);

  const set = <K extends keyof FormValue>(key: K, next: FormValue[K]): void =>
    onChange({ ...value, [key]: next });

  /**
   * Prepares an asset and puts it on the form.
   *
   * `crop` is undefined for an animation, always. `prepareForUpload` ignores it
   * for one anyway, which is deliberate belt and braces: the cost of cropping
   * an animation is a still image that looks like a success.
   */
  const prepare = useCallback(
    async (
      asset: NonNullable<Awaited<ReturnType<typeof pickImage>>>,
      crop?: CropResult,
    ): Promise<void> => {
      setOptimising(true);
      try {
        const prepared = await prepareForUpload(
          asset,
          crop ? { rect: crop.crop, output: crop.output } : undefined,
        );

        set('picked', crop ? { ...prepared, ratio: ratioById(crop.ratio).label } : prepared);
      } catch (failure) {
        setMediaError(
          failure instanceof MediaError
            ? failure.message
            : 'That image could not be used. Please choose another one.',
        );
      } finally {
        setOptimising(false);
      }
    },
    // `set` closes over `value` and `onChange` and is rebuilt every render, so
    // depending on it would rebuild this callback on every keystroke in the
    // title field. `value` is what it actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value],
  );

  const choose = async (): Promise<void> => {
    setMediaError(null);

    const asset = await pickImage();
    // Backing out of the picker is not a failure and must not be reported as
    // one — it is the commonest thing that happens in a picker.
    if (!asset) return;

    // An animation is never cropped. Opening the editor for one would be
    // offering a control that destroys the thing it is editing.
    const looksAnimated =
      asset.mimeType === 'image/gif' || /\.gif$/i.test(asset.fileName ?? asset.uri);

    if (looksAnimated) {
      await prepare(asset);
      return;
    }

    setPendingAsset(asset);
    setCropping({ uri: asset.uri, animated: false });
  };

  const confirmCrop = useCallback(
    async (result: CropResult): Promise<void> => {
      const asset = pendingAsset;
      setCropping(null);
      setPendingAsset(null);
      if (asset) await prepare(asset, result);
    },
    [pendingAsset, prepare],
  );

  const previewUri = value.picked?.previewUri ?? existingImageUri ?? null;

  return (
    <View style={{ gap: SPACE.lg }}>
      {/* ---------------------------------------------------------------- */}
      <Card title="Image">
        {previewUri ? (
          <View style={{ gap: SPACE.sm }}>
            <Image
              source={{ uri: previewUri }}
              style={{
                width: '100%',
                aspectRatio: 16 / 9,
                borderRadius: RADIUS.md,
                backgroundColor: palette.surface2,
              }}
              contentFit="cover"
              // The preview animates, because `expo-image` decodes animation
              // and React Native's own Image draws frame one. An administrator
              // choosing an animation has to be able to SEE that it moves —
              // otherwise the first confirmation they get is on a user's phone.
              autoplay
              transition={0}
            />

            {value.picked ? (
              <Callout
                kind="ok"
                title={value.picked.animated ? 'Animation ready' : 'Image ready'}
              >
                {value.picked.animated
                  ? `${fileSize(value.picked.originalBytes)} · kept as an animation`
                  : `${
                      value.picked.ratio ? `${value.picked.ratio} · ` : ''
                    }${fileSize(value.picked.originalBytes)} → ${fileSize(
                      value.picked.optimisedBytes,
                    )}`}
              </Callout>
            ) : null}

            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              <View style={{ flex: 1 }}>
                <Button full disabled={disabled || optimising} onPress={() => void choose()}>
                  Replace
                </Button>
              </View>
              {onRemoveImage ? (
                <View style={{ flex: 1 }}>
                  <Button kind="danger" full disabled={disabled} onPress={onRemoveImage}>
                    Remove
                  </Button>
                </View>
              ) : null}
            </View>
          </View>
        ) : (
          <Pressable
            onPress={disabled || optimising ? undefined : () => void choose()}
            accessibilityRole="button"
            accessibilityLabel="Upload image"
            style={{
              borderWidth: 1,
              borderStyle: 'dashed',
              borderColor: palette.borderStrong,
              borderRadius: RADIUS.md,
              paddingVertical: SPACE.xl,
              alignItems: 'center',
              gap: SPACE.sm,
              minHeight: 120,
              justifyContent: 'center',
            }}
          >
            <MaterialCommunityIcons
              name={optimising ? 'progress-clock' : 'image-plus'}
              size={28}
              color={palette.textFaint}
            />
            <Text style={{ color: palette.textDim, fontSize: 14, fontWeight: '600' }}>
              {optimising ? 'Optimising image…' : 'Upload Image'}
            </Text>
            <Hint>Optional. JPEG, PNG, WebP or GIF.</Hint>
            <Hint>You will choose a shape next. Animations keep their own.</Hint>
          </Pressable>
        )}

        {mediaError ? (
          <View style={{ paddingTop: SPACE.sm }}>
            <Callout kind="error" title="That image can’t be used">
              {mediaError}
            </Callout>
          </View>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <Field label="Title" count={value.title.length} limit={TITLE_MAX_LENGTH}>
          <Input
            value={value.title}
            onChangeText={(next) => set('title', next)}
            placeholder="What is this about?"
            editable={!disabled}
            invalid={value.title.length > TITLE_MAX_LENGTH}
          />
        </Field>

        <Field
          label="Message"
          count={value.body.length}
          limit={BODY_MAX_LENGTH}
          hint="Plain text. Links and formatting are not shown."
        >
          <Input
            value={value.body}
            onChangeText={(next) => set('body', next)}
            placeholder="What do you want RUOOD users to know?"
            multiline
            numberOfLines={5}
            editable={!disabled}
            invalid={value.body.length > BODY_MAX_LENGTH}
          />
        </Field>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card title="Delivery">
        <ChoiceRow
          selected={value.delivery === 'active'}
          title={DELIVERY_LABELS.active.title}
          detail={DELIVERY_LABELS.active.detail}
          disabled={disabled}
          onPress={() => set('delivery', 'active')}
        />
        <ChoiceRow
          selected={value.delivery === 'passive'}
          title={DELIVERY_LABELS.passive.title}
          detail={DELIVERY_LABELS.passive.detail}
          disabled={disabled}
          onPress={() => set('delivery', 'passive')}
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card title="When should it appear?">
        <ChoiceRow
          selected={value.timing === 'now'}
          title="Immediately"
          detail="As soon as it is published."
          disabled={disabled}
          onPress={() => set('timing', 'now')}
        />
        <ChoiceRow
          selected={value.timing === 'later'}
          title="Schedule for later"
          detail="Published now, and shown to RUOOD users at the time you choose."
          disabled={disabled}
          onPress={() => set('timing', 'later')}
        />

        {value.timing === 'later' ? (
          <View style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              <View style={{ flex: 1 }}>
                <Button full disabled={disabled} onPress={() => setPicker('date')}>
                  {value.startAt.toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button full disabled={disabled} onPress={() => setPicker('time')}>
                  {value.startAt.toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Button>
              </View>
            </View>

            {/* The one thing worth saying about time, said once. The date is
                entered in local time and stored as an absolute instant, so an
                administrator in one timezone and a user in another still see
                it appear at the same moment. */}
            <Hint>Your local time. RUOOD users see it at the same moment, wherever they are.</Hint>

            {value.startAt.getTime() < Date.now() ? (
              <Callout kind="warn" title="That time has passed">
                It will appear as soon as it is published.
              </Callout>
            ) : null}
          </View>
        ) : null}
      </Card>

      {/* Full screen, because framing a picture through a small window is not
          framing it. `presentationStyle` is left alone so Android's own back
          gesture closes it, which is what the hardware button should do. */}
      <Modal
        visible={cropping !== null}
        animationType="slide"
        onRequestClose={() => {
          setCropping(null);
          setPendingAsset(null);
        }}
      >
        {cropping && cropSize ? (
          <ImageCropper
            uri={cropping.uri}
            image={cropSize}
            busy={optimising}
            onCancel={() => {
              setCropping(null);
              setPendingAsset(null);
            }}
            onConfirm={(result) => void confirmCrop(result)}
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
                setCropping(null);
                setPendingAsset(null);
              }}
            >
              Cancel
            </Button>
          </View>
        )}
      </Modal>

      {picker ? (
        <DateTimePicker
          value={value.startAt}
          mode={picker}
          is24Hour={false}
          onChange={(event, next) => {
            setPicker(null);
            if (event.type !== 'set' || !next) return;

            // Merged rather than replaced: the date picker returns a Date whose
            // time is midnight, and the time picker one whose date is today.
            // Taking either wholesale silently discards the other half.
            const merged = new Date(value.startAt);
            if (picker === 'date') {
              merged.setFullYear(next.getFullYear(), next.getMonth(), next.getDate());
            } else {
              merged.setHours(next.getHours(), next.getMinutes(), 0, 0);
            }
            set('startAt', merged);
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * One of a pair of choices.
 *
 * A radio in everything but name. Written by hand rather than reached for from
 * a library because the whole control is a row with a dot, and the alternative
 * was a dependency for a circle.
 */
function ChoiceRow({
  selected,
  title,
  detail,
  onPress,
  disabled,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACE.md,
        paddingVertical: SPACE.sm,
        minHeight: TOUCH_TARGET,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: selected ? palette.accent : palette.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {selected ? (
          <View
            style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: palette.accent }}
          />
        ) : null}
      </View>

      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: palette.textDim, fontSize: 12, lineHeight: 17 }}>{detail}</Text>
      </View>
    </Pressable>
  );
}
