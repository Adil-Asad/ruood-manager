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
import { validateAnnouncementRecord } from '@ruood/announcement-schema';

import { useManager } from '../../src/manager';
import { availableId } from '../../src/ids';
import { surfaceFor } from '../../src/language';
import {
  AnnouncementForm,
  emptyForm,
  type FormValue,
} from '../../src/components/announcement-form';
import { Body, Button, Callout, Confirm, Screen } from '../../src/components/ui';
import { SPACE } from '../../src/theme';

export default function NewAnnouncementScreen(): React.JSX.Element {
  const { api, content, run, notify } = useManager();

  const [form, setForm] = useState<FormValue>(() => emptyForm(Date.now()));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const ready = form.title.trim().length > 0 && form.body.trim().length > 0;

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
      const id = availableId(content, form.title, now);

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
      // would be free to disagree with it.
      const withDelivery = {
        ...draft,
        display: { ...draft.display, surface: surfaceFor(form.delivery) },
      };

      const record = publish ? applyTransition(withDelivery, 'publish', now) : withDelivery;

      // Validated here for an immediate answer. The publishing workflow
      // validates again, authoritatively, with the same function — this is the
      // same "client for the feedback, server for the truth" split the image
      // pipeline uses.
      const check = validateAnnouncementRecord(record, {
        now,
        mode: 'authored',
        idRegistry: { active: content.records.map((entry) => entry.id), retired: content.retiredIds },
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
            message: publish ? `Publish ${record.title}` : `Draft ${record.title}`,
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
      notify(`Publishing “${form.title.trim()}”. It will reach RUOOD users shortly.`);
      router.replace('/(tabs)/announcements');
    }
  }, [save, notify, form.title]);

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
                Add a title and a message to continue.
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
