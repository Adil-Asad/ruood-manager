/**
 * Creating an announcement.
 *
 * ## There is no publish step any more, and that is the architecture
 *
 * This screen used to save a record, transition it, and then call a publish
 * endpoint that built, signed, committed and pushed. Every one of those was a
 * thing the Manager server did on the operator's machine.
 *
 * Now writing `content/` **is** publishing. The commit this screen makes
 * triggers the workflow in the announcements repository, which encodes the
 * image, builds the manifest, verifies it with the client's own parser, signs
 * it and commits `dist/`. So the two buttons differ by one field:
 *
 *   Save Draft   `status: 'draft'`      — the build excludes drafts entirely
 *   Publish      `status: 'published'`  — the build includes it
 *
 * That is not a simplification of the rules; it is the same rules with the
 * orchestration moved to where it belongs. `applyTransition` still owns which
 * moves are legal, and the build still refuses anything the validator refuses.
 *
 * ## The record is built with the SAME code the build reads it with
 *
 * `createRecord` and `applyTransition` come from
 * `@ruood/announcement-authoring`, which the publishing workflow also uses.
 * The phone is not producing an approximation of a record for a server to
 * correct — it is producing the record.
 */

import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import { applyTransition, createRecord } from '@ruood/announcement-authoring';
import { saveRecord } from '@ruood/announcement-github';
import {
  isVersion,
  TITLE_MAX_LENGTH,
  validateAnnouncementRecord,
} from '@ruood/announcement-schema';

import { useManager } from '../../src/manager';
import { availableId } from '../../src/ids';
import { announcementLabel, platformsFor, surfaceFor } from '../../src/language';
import {
  AnnouncementForm,
  bodyLimitOf,
  emptyForm,
  hasImage,
  type FormValue,
} from '../../src/components/announcement-form';
import { Body, Button, Callout, Confirm, Screen } from '../../src/components/ui';
import { SPACE } from '../../src/theme';

export default function NewAnnouncementScreen(): React.JSX.Element {
  const { api, content, run, notify } = useManager();

  const [form, setForm] = useState<FormValue>(() => emptyForm(Date.now()));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Whether this can be saved at all.
   *
   * A picture, a title or a message — any ONE of the three is an announcement.
   * An image-only announcement is a real thing somebody means, and demanding a
   * caption to go with a picture produces a caption nobody needed. What is
   * refused is all three being empty, which is the same rule the validator and
   * the publishing build hold; this is only the immediate half of it.
   *
   * The message limit is the frame's, not the schema's — a Full-screen picture
   * leaves room for a fraction of 500 characters. The version fields are
   * optional and, when filled in, must be versions: `satisfiesVersionRange`
   * fails CLOSED on one it cannot parse, so a typo would silently target
   * nobody.
   */
  const hasContent =
    form.title.trim().length > 0 || form.body.trim().length > 0 || hasImage(form);

  const ready =
    hasContent &&
    form.title.length <= TITLE_MAX_LENGTH &&
    form.body.length <= bodyLimitOf(form, null, hasImage(form)) &&
    (form.minVersion.length === 0 || isVersion(form.minVersion)) &&
    (form.maxVersion.length === 0 || isVersion(form.maxVersion));

  /**
   * Writes the record, published or not, as one commit.
   *
   * The image goes into the SAME commit — see `saveRecord`. A repository
   * observed between a record and its picture is one the build refuses, and
   * with two administrators on two phones that is not a theoretical window.
   */
  const save = useCallback(
    async (publish: boolean): Promise<boolean> => {
      if (!api || !content) return false;

      const now = Date.now();
      // From the title, or from the message when there is no title. Either
      // leaves something readable in a `git log` a year later; an image-only
      // announcement has neither and takes the dated fallback in `idFromTitle`.
      const id = availableId(content, form.title.trim() || form.body.trim(), now);

      const draft = createRecord({
        id,
        title: form.title.trim(),
        body: form.body.trim(),
        now,
        // Local wall-clock in, absolute instant out. "Tomorrow at 10" has no
        // meaning in a file read by devices in other timezones.
        startAt: (form.timing === 'later' ? form.startAt : new Date(now)).toISOString(),
      });

      // Delivery IS `surface` and no other field. A second boolean beside it
      // would be free to disagree with it. Targeting is the same rule one field
      // over: three answers and two optional bounds, written into the
      // `targeting` the schema already has.
      const withDelivery = {
        ...draft,
        display: { ...draft.display, surface: surfaceFor(form.delivery) },
        targeting: {
          platforms: platformsFor(form.audience),
          minVersion: form.minVersion.length > 0 ? form.minVersion : null,
          maxVersion: form.maxVersion.length > 0 ? form.maxVersion : null,
        },
      };

      const record = publish ? applyTransition(withDelivery, 'publish', now) : withDelivery;

      // What to call it in the commit and in the sentence afterwards. An
      // image-only announcement has no title, and `Publish ` with nothing after
      // it is a commit nobody can read.
      const label = announcementLabel({ ...record, image: form.picked ?? undefined });

      // Validated here for an immediate answer. The publishing workflow
      // validates again, authoritatively, with the same function — this is the
      // same "client for the feedback, server for the truth" split the image
      // pipeline uses.
      const check = validateAnnouncementRecord(record, {
        now,
        mode: 'authored',
        idRegistry: { active: content.records.map((entry) => entry.id), retired: content.retiredIds },
        // The picture goes up as an ORIGINAL in the same commit; the record
        // carries no `image` object because only an encode can produce one.
        // Saying so here is what lets an image-only announcement pass the same
        // check the build will run over it.
        pendingImage: form.picked !== null,
      });

      if (check.errors.length > 0) {
        notify(check.errors[0]!.message, 'error');
        return false;
      }

      const result = await run(
        (snapshot) =>
          saveRecord(api, snapshot, {
            record,
            ...(form.picked
              ? {
                  image: {
                    base64: form.picked.dataBase64,
                    extension: form.picked.filename.slice(form.picked.filename.lastIndexOf('.')),
                  },
                }
              : {}),
            message: publish ? `Publish ${label}` : `Draft ${label}`,
          }),
      );

      return result !== null;
    },
    [api, content, form, run, notify],
  );

  const saveDraft = useCallback(async (): Promise<void> => {
    setBusy(true);
    const ok = await save(false);
    setBusy(false);

    if (ok) {
      notify('Saved as a draft.');
      router.replace('/(tabs)/announcements');
    }
  }, [save, notify]);

  const publish = useCallback(async (): Promise<void> => {
    setBusy(true);
    setConfirming(false);

    const ok = await save(true);
    setBusy(false);

    if (ok) {
      // Deliberately "will be" rather than "is". The workflow builds and signs
      // after this commit, and it takes a minute or two — claiming it is
      // already live would be the app lying about something checkable.
      notify(
        `Publishing “${announcementLabel({
          title: form.title,
          body: form.body,
          image: form.picked ?? undefined,
        })}”. It will reach RUOOD users shortly.`,
      );
      router.replace('/(tabs)/announcements');
    }
  }, [save, notify, form.title, form.body, form.picked]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen>
        <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
          <AnnouncementForm value={form} onChange={setForm} disabled={busy} />

          <View style={{ gap: SPACE.sm }}>
            <Button
              kind="primary"
              full
              busy={busy}
              disabled={!ready}
              onPress={() => setConfirming(true)}
            >
              Publish
            </Button>

            <Button full busy={busy} disabled={!ready} onPress={() => void saveDraft()}>
              Save Draft
            </Button>

            {!ready ? (
              <Callout kind="info" title="Almost there">
                {hasContent
                  ? 'Check the highlighted fields to continue.'
                  : 'Add a picture, a title or a message to continue.'}
              </Callout>
            ) : null}
          </View>

          <View style={{ height: SPACE.xl }} />
        </View>
      </Screen>

      <Confirm
        visible={confirming}
        title="Publish this announcement?"
        confirmLabel="Publish"
        confirmKind="primary"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void publish()}
      >
        <Body dim>
          {form.timing === 'later'
            ? `RUOOD users will see this from ${form.startAt.toLocaleString(undefined, {
                day: 'numeric',
                month: 'long',
                hour: 'numeric',
                minute: '2-digit',
              })}.`
            : 'Every RUOOD user will be able to see this.'}
        </Body>
      </Confirm>
    </KeyboardAvoidingView>
  );
}
