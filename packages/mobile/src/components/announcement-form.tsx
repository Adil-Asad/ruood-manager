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
 *   trigger, maxImpressions, minIntervalHours, dismiss
 *                frequency rules with sensible defaults, and four more
 *                decisions on a screen that already asks for five.
 *
 * None of them are removed from the contract — every one is still there, still
 * validated, still editable from the desktop Manager. What changed is which of
 * them a phone puts in front of somebody.
 *
 * **`targeting` used to be on that list and is not any more.** Who an
 * announcement is for is not a technicality — "Android only" and "only the
 * people who have not updated yet" are the two things an operator most often
 * means, and neither could be said from a phone. Both are the existing
 * `targeting` fields, written by the same `applyEdits` the CLI uses; no field
 * was added to the schema for this.
 *
 * ## Nothing here is compulsory except having SOMETHING
 *
 * A picture, a title or a message — any one of the three is an announcement,
 * and an image-only one is a real thing somebody means. So neither text field
 * is marked required and neither is invalid when empty; the two save buttons
 * are what refuse a form carrying all three empty, with the same rule the
 * validator and the publishing build hold.
 *
 * ## The frame decides how much there is room to say
 *
 * A dialog on a phone is one screen, and a Full-screen picture takes most of
 * it. `bodyLimitFor` shrinks the message limit to what will still read under
 * the chosen frame — an authoring guardrail, not a contract change: 500 is
 * still valid, and RUOOD Lab scrolls a long message rather than clipping it.
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

import { BODY_MAX_LENGTH, isVersion, TITLE_MAX_LENGTH } from '@ruood/announcement-schema';

import { DELIVERY_LABELS, fileSize, type Audience } from '../language';
import { MediaError, pickImage, prepareForUpload, type PickedImage } from '../media';
import { bodyLimitFor, frameForSize, ratioById, type RatioId, type Size } from '../crop';
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
  /** `targeting.platforms`, as one of three answers. */
  audience: Audience;
  /** `targeting.minVersion` — this version of RUOOD Lab and above. */
  minVersion: string;
  /** `targeting.maxVersion` — BELOW this version, which is how you reach the
   *  people who have not updated yet. */
  maxVersion: string;
}

/**
 * The frame in force, from whatever the form knows about the picture.
 *
 * A newly cropped image knows its own; an already-published one is read back
 * from its dimensions (`frameForSize`), because the frame is not stored
 * anywhere else and never should be.
 */
export function frameOf(value: FormValue, existingImage?: Size | null): RatioId | null {
  if (value.picked) return value.picked.ratioId ?? null;
  return existingImage ? frameForSize(existingImage) : null;
}

/** Whether this form holds a picture at all, chosen now or already attached. */
export function hasImage(
  value: FormValue,
  existingImageUri?: string | null,
  removed?: boolean,
): boolean {
  if (value.picked) return true;
  return Boolean(existingImageUri) && !removed;
}

/** How many characters the message may have, given the frame. */
export function bodyLimitOf(
  value: FormValue,
  existingImage?: Size | null,
  present = true,
): number {
  return bodyLimitFor(frameOf(value, existingImage), present, BODY_MAX_LENGTH);
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
    // The default `targeting` in `DEFAULT_NEW_RECORD`: both phones, no version
    // bounds. Written here as the same answer rather than a second opinion.
    audience: 'both',
    minVersion: '',
    maxVersion: '',
  };
}

export interface AnnouncementFormProps {
  value: FormValue;
  onChange: (value: FormValue) => void;
  /** An image already attached to this record, as a local uri. Edit screen only. */
  existingImageUri?: string | null;
  /**
   * The published size of that image, when it has one.
   *
   * It is what the frame is read back from — see `frameOf`. Absent for a
   * picture uploaded from a phone that has not been through a publish yet,
   * which has no published dimensions to read.
   */
  existingImageSize?: Size | null;
  onRemoveImage?: () => void;
  disabled?: boolean;
}

export function AnnouncementForm({
  value,
  onChange,
  existingImageUri,
  existingImageSize,
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

        set(
          'picked',
          crop
            ? { ...prepared, ratio: ratioById(crop.ratio).label, ratioId: crop.ratio }
            : prepared,
        );
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

  /**
   * The shape the preview is drawn in.
   *
   * The chosen frame, or the published dimensions of a picture already
   * attached. It used to be a fixed 16:9 whatever had been cropped, so the one
   * screen showing an administrator what they had framed showed them something
   * else — and RUOOD Lab drew the same 16:9, so nobody found out.
   *
   * `null` for an animation, which is never cropped and keeps its own shape:
   * the preview then CONTAINS it rather than cropping to a box nobody chose.
   */
  const previewAspect = value.picked
    ? value.picked.output
      ? value.picked.output.width / value.picked.output.height
      : null
    : existingImageSize
      ? existingImageSize.width / existingImageSize.height
      : null;

  // A picture is on the form when there is something to preview — chosen just
  // now, or already attached and not being removed.
  const bodyLimit = bodyLimitOf(value, existingImageSize, previewUri !== null);

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
                // The frame that was chosen, so this preview is what a RUOOD
                // user will be shown — the app lays out from the published
                // dimensions, which is the same number.
                aspectRatio: previewAspect ?? 4 / 5,
                borderRadius: RADIUS.md,
                backgroundColor: palette.surface2,
              }}
              // A known shape fills its box exactly; an animation, whose shape
              // nobody chose, is contained rather than cropped.
              contentFit={previewAspect ? 'cover' : 'contain'}
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
        {/* Neither field is required. A picture can be the whole announcement,
            and the hint says so once rather than marking both fields optional
            and leaving somebody to work out what that means together. */}
        <Field
          label="Title"
          count={value.title.length}
          limit={TITLE_MAX_LENGTH}
          hint={
            previewUri
              ? 'Optional. The picture can be the whole announcement.'
              : 'Optional, but say something: a title, a message, or a picture.'
          }
        >
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
          limit={bodyLimit}
          hint={
            bodyLimit < BODY_MAX_LENGTH
              ? 'Optional. Plain text, and shorter because the picture takes most of the screen.'
              : 'Optional. Plain text; links and formatting are not shown.'
          }
        >
          <Input
            value={value.body}
            onChangeText={(next) => set('body', next)}
            placeholder="What do you want RUOOD users to know?"
            multiline
            numberOfLines={5}
            editable={!disabled}
            invalid={value.body.length > bodyLimit}
          />
        </Field>

        {value.body.length > bodyLimit ? (
          <Callout kind="warn" title="Too long to read beside the picture">
            {`Shorten it to ${String(bodyLimit)} characters, or choose a shorter frame.`}
          </Callout>
        ) : null}
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
      <Card title="Who should see it?">
        <ChoiceRow
          selected={value.audience === 'both'}
          title="Everyone"
          detail="Android and iPhone."
          disabled={disabled}
          onPress={() => set('audience', 'both')}
        />
        <ChoiceRow
          selected={value.audience === 'android'}
          title="Android only"
          detail="Nobody on an iPhone sees it."
          disabled={disabled}
          onPress={() => set('audience', 'android')}
        />
        <ChoiceRow
          selected={value.audience === 'ios'}
          title="iPhone only"
          detail="Nobody on Android sees it."
          disabled={disabled}
          onPress={() => set('audience', 'ios')}
        />

        <View style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
          <Hint>
            App versions are optional. Leave both empty and everyone on any version sees it.
          </Hint>

          <Field
            label="Only version and above"
            hint="For something that only exists in a newer RUOOD Lab. Example: 1.2.0"
          >
            <Input
              value={value.minVersion}
              onChangeText={(next) => set('minVersion', next.trim())}
              placeholder="1.2.0"
              editable={!disabled}
              autoCapitalize="none"
              invalid={value.minVersion.length > 0 && !isVersion(value.minVersion)}
            />
          </Field>

          <Field
            label="Only below version"
            hint="For telling people to update. Below 1.2.0 means 1.1.9 sees it and 1.2.0 does not."
          >
            <Input
              value={value.maxVersion}
              onChangeText={(next) => set('maxVersion', next.trim())}
              placeholder="1.2.0"
              editable={!disabled}
              autoCapitalize="none"
              invalid={value.maxVersion.length > 0 && !isVersion(value.maxVersion)}
            />
          </Field>

          {/* Version comparison is semantic, so "1.2" is not a version and
              "1.10.0" is above "1.9.0". Saying so beats a rejection later. */}
          {(value.minVersion.length > 0 && !isVersion(value.minVersion)) ||
          (value.maxVersion.length > 0 && !isVersion(value.maxVersion)) ? (
            <Callout kind="error" title="That is not a version">
              Write all three parts, like 1.2.0.
            </Callout>
          ) : null}
        </View>
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
