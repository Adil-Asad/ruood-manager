/**
 * One announcement: read it, change it, switch it off, delete it.
 *
 * ## Every operation is one commit to `content/`
 *
 * There is no publish endpoint any more. Saving a change commits the record;
 * the workflow in the announcements repository picks it up and rebuilds a
 * signed `dist/`. So each button here maps to one pure operation from
 * `@ruood/announcement-authoring` followed by one commit:
 *
 *   Save / Publish Changes   `applyEdits`, then a commit
 *   Deactivate / Activate    `applyTransition('pause' | 'resume')`
 *   Delete                   remove the record and retire the id, together
 *
 * The pure half is the SAME code the publishing build runs. The phone is not
 * approximating an edit for something else to correct.
 *
 * ## Draft and published are the same form with a different button
 *
 * Editing a draft changes something nobody has seen. Editing a published
 * announcement changes something that is already out there and will be rebuilt.
 * The form is identical; the button says which is happening.
 *
 * `rev` is deliberately absent. Bumping it re-shows the announcement to
 * everybody who has already dismissed it, which is a different intention from
 * fixing a typo — it stays a CLI operation.
 *
 * ## Delete
 *
 * It removes the announcement from what RUOOD users receive and retires the id
 * for ever, in one commit. What it cannot do is reach into a phone that already
 * has it in an inbox — no distribution system can promise that — and the
 * confirmation says what actually happens rather than what sounds tidier.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import {
  applyEdits,
  applyTransition,
  availableTransitions,
} from '@ruood/announcement-authoring';
import { deleteRecord, saveRecord } from '@ruood/announcement-github';
import {
  deriveLifecycleStatus,
  type AuthoredAnnouncement,
} from '@ruood/announcement-schema';

import { useManager } from '../../src/manager';
import { deliveryOf, explainStatus, statusOf, surfaceFor } from '../../src/language';
import {
  AnnouncementForm,
  emptyForm,
  type FormValue,
} from '../../src/components/announcement-form';
import {
  Badge,
  Body,
  Button,
  Callout,
  Card,
  Confirm,
  Hint,
  Loading,
  Screen,
} from '../../src/components/ui';
import { SPACE } from '../../src/theme';

type Dialog = 'save' | 'delete' | 'deactivate' | 'activate' | null;

export default function AnnouncementScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, content, run, notify } = useManager();

  const [form, setForm] = useState<FormValue>(() => emptyForm(Date.now()));
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The record, from the snapshot the shell already holds.
   *
   * No fetch: `loadContent` read every record in one tree listing, so opening
   * one is a lookup. That is why this screen has no loading state of its own.
   */
  const record = useMemo(
    () => content?.records.find((entry) => entry.id === id) ?? null,
    [content, id],
  );

  const lifecycle = useMemo(
    () =>
      record
        ? deriveLifecycleStatus(
            { status: record.status, startAt: record.startAt, endAt: record.endAt ?? null },
            Date.now(),
          )
        : null,
    [record],
  );

  // Seed the form whenever the underlying record changes — including after a
  // save, so the screen shows what was actually written.
  useEffect(() => {
    if (!record) return;

    const startAt = new Date(record.startAt);
    setForm({
      title: record.title,
      body: record.body,
      delivery: deliveryOf(record.display.surface),
      timing: startAt.getTime() > Date.now() ? 'later' : 'now',
      startAt,
      picked: null,
    });
    setRemoveImage(false);
    // Keyed on the id and the update stamp, not on `record` itself: a new
    // object with identical content would otherwise reset the form under
    // somebody's fingers on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, record?.updatedAt]);

  /**
   * The stored original, for a preview.
   *
   * Fetched by blob sha, which is a content hash — so this is cached for ever
   * and a replaced image is a different sha and therefore a different fetch.
   * A data URI because a React Native `Image` source carries no `Authorization`
   * header, and the repository may be private.
   */
  const mediaSha = record ? content?.media[record.id]?.sha : undefined;

  useEffect(() => {
    let cancelled = false;
    setImageUri(null);

    const media = record ? content?.media[record.id] : undefined;
    if (!api || !media) return;

    void (async () => {
      try {
        const base64 = await api.readBlobBase64(media.sha);
        if (!cancelled) setImageUri(`data:image/*;base64,${base64}`);
      } catch {
        // A preview that will not load is a missing picture, not an error worth
        // putting on the screen.
        if (!cancelled) setImageUri(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the blob SHA, which is a content hash: the fetch repeats exactly
    // when the picture has actually changed, and never merely because the
    // snapshot object is new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, record?.id, mediaSha]);

  const published = record !== null && record.status !== 'draft';

  const dirty = useMemo(() => {
    if (!record) return false;

    // `timing` is compared separately from `startAt`: moving a scheduled
    // announcement to "Immediately" leaves `startAt` where it was — the picker
    // is simply hidden — so comparing dates alone reported no change and greyed
    // out the button that would have made it live now.
    const wasScheduled = new Date(record.startAt).getTime() > Date.now();

    return (
      form.title !== record.title ||
      form.body !== record.body ||
      form.delivery !== deliveryOf(record.display.surface) ||
      form.timing !== (wasScheduled ? 'later' : 'now') ||
      form.picked !== null ||
      removeImage ||
      (form.timing === 'later' && new Date(record.startAt).getTime() !== form.startAt.getTime())
    );
  }, [record, form, removeImage]);

  /** Applies the form and commits. Shared by both save buttons. */
  const save = useCallback(
    async (alsoPublish: boolean): Promise<boolean> => {
      if (!api || !record) return false;

      const now = Date.now();

      // `applyEdits` refuses anything outside its closed list rather than
      // dropping it, so a bug here is a refusal and not a silent no-op.
      let next: AuthoredAnnouncement = applyEdits(
        record,
        {
          title: form.title.trim(),
          body: form.body.trim(),
          startAt: (form.timing === 'later' ? form.startAt : new Date(now)).toISOString(),
          display: { ...record.display, surface: surfaceFor(form.delivery) },
          ...(removeImage ? { image: null } : {}),
        },
        now,
      );

      if (alsoPublish && availableTransitions(next).includes('publish')) {
        next = applyTransition(next, 'publish', now);
      }

      const result = await run(
        (snapshot) =>
          saveRecord(api, snapshot, {
            record: next,
            ...(form.picked
              ? {
                  image: {
                    base64: form.picked.dataBase64,
                    extension: form.picked.filename.slice(form.picked.filename.lastIndexOf('.')),
                  },
                }
              : {}),
            message: `Update ${next.title}`,
          }),
      );

      return result !== null;
    },
    [api, record, form, removeImage, run],
  );

  const commitChanges = useCallback(async (): Promise<void> => {
    setBusy(true);
    setDialog(null);

    const ok = await save(true);
    setBusy(false);

    if (ok) {
      notify(
        published
          ? 'Changes saved. They will reach RUOOD users shortly.'
          : `Publishing “${form.title.trim()}”. It will reach RUOOD users shortly.`,
      );
      router.replace('/(tabs)/announcements');
    }
  }, [save, notify, published, form.title]);

  const saveDraft = useCallback(async (): Promise<void> => {
    setBusy(true);
    const ok = await save(false);
    setBusy(false);
    if (ok) notify('Changes saved.');
  }, [save, notify]);

  /** Deactivate and activate, which are `pause` and `resume`. */
  const setActive = useCallback(
    async (active: boolean): Promise<void> => {
      if (!api || !record) return;

      setBusy(true);
      setDialog(null);

      const next = applyTransition(record, active ? 'resume' : 'pause', Date.now());
      const ok = await run((snapshot) =>
        saveRecord(api, snapshot, {
          record: next,
          message: `${active ? 'Activate' : 'Deactivate'} ${next.title}`,
        }),
      );

      setBusy(false);
      if (ok !== null) {
        notify(active ? 'Switched on.' : 'Switched off. Nobody will see it.');
      }
    },
    [api, record, run, notify],
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!api || !record) return;

    setBusy(true);
    setDialog(null);

    const ok = await run((snapshot) =>
      deleteRecord(api, snapshot, record.id, `Delete ${record.title}`),
    );

    setBusy(false);
    if (ok !== null) {
      notify('Deleted.');
      router.replace('/(tabs)/announcements');
    }
  }, [api, record, run, notify]);

  // -------------------------------------------------------------------------

  if (!content) return <Loading what="Loading…" />;

  if (!record || !lifecycle) {
    return (
      <Screen>
        <View style={{ paddingTop: SPACE.lg, gap: SPACE.lg }}>
          <Callout kind="warn" title="Not found">
            That announcement no longer exists. It may have been deleted.
          </Callout>
          <Button full onPress={() => router.replace('/(tabs)/announcements')}>
            Back to announcements
          </Button>
        </View>
      </Screen>
    );
  }

  const inactive = record.status === 'paused';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen>
        <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
          <Card>
            <View style={{ gap: SPACE.sm }}>
              <Badge lifecycle={lifecycle}>{statusOf(lifecycle)}</Badge>
              <Body dim>{explainStatus(lifecycle)}</Body>
            </View>
          </Card>

          <AnnouncementForm
            value={form}
            onChange={setForm}
            existingImageUri={removeImage ? null : imageUri}
            onRemoveImage={() => {
              setRemoveImage(true);
              setForm((current) => ({ ...current, picked: null }));
            }}
            disabled={busy}
          />

          <View style={{ gap: SPACE.sm }}>
            <Button
              kind="primary"
              full
              busy={busy}
              disabled={!dirty}
              onPress={() => setDialog('save')}
            >
              {published ? 'Publish Changes' : 'Publish'}
            </Button>

            {!published ? (
              <Button full busy={busy} disabled={!dirty} onPress={() => void saveDraft()}>
                Save Changes
              </Button>
            ) : null}

            {published ? (
              <Button
                full
                busy={busy}
                onPress={() => setDialog(inactive ? 'activate' : 'deactivate')}
              >
                {inactive ? 'Activate' : 'Deactivate'}
              </Button>
            ) : null}

            <Button kind="danger" full busy={busy} onPress={() => setDialog('delete')}>
              Delete Announcement
            </Button>
          </View>

          <View style={{ alignItems: 'center' }}>
            <Hint>Last changed {new Date(record.updatedAt).toLocaleString()}</Hint>
          </View>

          <View style={{ height: SPACE.xl }} />
        </View>
      </Screen>

      <Confirm
        visible={dialog === 'save'}
        title={published ? 'Publish these changes?' : 'Publish this announcement?'}
        confirmLabel="Publish"
        confirmKind="primary"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void commitChanges()}
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

      <Confirm
        visible={dialog === 'deactivate'}
        title="Switch this off?"
        confirmLabel="Deactivate"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void setActive(false)}
      >
        <Body dim>RUOOD users will stop seeing it. You can switch it back on at any time.</Body>
      </Confirm>

      <Confirm
        visible={dialog === 'activate'}
        title="Switch this back on?"
        confirmLabel="Activate"
        confirmKind="primary"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void setActive(true)}
      >
        <Body dim>RUOOD users will start seeing it again.</Body>
      </Confirm>

      <Confirm
        visible={dialog === 'delete'}
        title="Delete announcement?"
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void remove()}
      >
        <Body dim>
          This announcement will no longer be sent to RUOOD users, and it cannot be brought back.
          {'\n\n'}
          Anyone who has already received it keeps it in their inbox — that copy is on their
          device and cannot be recalled.
        </Body>
      </Confirm>
    </KeyboardAvoidingView>
  );
}
