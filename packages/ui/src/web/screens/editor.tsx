/**
 * One announcement: its fields, its lifecycle, its image and its preview.
 *
 * Two things here are worth knowing before changing anything.
 *
 * **It validates in the browser with the real validator.**
 * `@ruood/announcement-schema` is zero-dependency and platform-neutral, so the
 * exact code that will refuse a bad record at publish time — and that RUOOD Lab
 * will run over the downloaded file — runs against every keystroke here. The
 * server validates again before writing; this is not a substitute for that, it
 * is the same answer arriving early enough to be useful.
 *
 * **`rev` is not on this form.** Bumping it re-shows the announcement to every
 * device that has already seen it, and that is a decision, not an edit. It has
 * its own button, its own confirmation and its own sentence. The same goes for
 * `status`, which moves only through the transition table, and `id`, which is
 * immutable because it keys impression state on every device.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ACTION_LABEL_MAX_LENGTH,
  BODY_LENGTH_WARNING,
  BODY_MAX_LENGTH,
  CATEGORIES,
  DISMISS_BEHAVIOURS,
  EXTERNAL_HOST_ALLOWLIST,
  IMAGE_ALT_MAX_LENGTH,
  PLATFORMS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  ROUTE_TARGETS,
  SURFACES,
  TITLE_MAX_LENGTH,
  TRIGGERS,
  canonicalCompactJson,
  deriveLifecycleStatus,
  validateAnnouncementRecord,
  type AnnouncementAction,
  type AuthoredAnnouncement,
  type Category,
  type DismissBehaviour,
  type Platform,
  type RouteTarget,
  type Surface,
  type Trigger,
  type ValidationIssue,
} from '@ruood/announcement-schema';

import { api } from '../api';
import type { RecordDetail, Transition } from '../../shared/api';
import { useManager } from '../app';
import { Badge, Button, Callout, Card, Dialog, Field, Issues } from '../components/ui';
import { Preview } from '../components/preview';
import {
  formatBytes,
  formatInstant,
  fromLocalInput,
  localOffsetLabel,
  toLocalInput,
} from '../format';

/** Exactly the fields this form writes. The server refuses anything else. */
function editableSlice(record: AuthoredAnnouncement): Record<string, unknown> {
  return {
    title: record.title,
    body: record.body,
    category: record.category,
    priority: record.priority,
    startAt: record.startAt,
    endAt: record.endAt ?? null,
    display: record.display,
    targeting: record.targeting,
    action: record.action ?? null,
    internalNote: record.internalNote ?? null,
  };
}

export function EditorScreen({ id }: { id: string }): JSX.Element {
  const { run, go, refresh } = useManager();

  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [draft, setDraft] = useState<AuthoredAnnouncement | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState<'delete' | 'bump' | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const loaded = await api.record(id);
      setDetail(loaded);
      setDraft(loaded.record);
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <Card>
        <Callout kind="error" title={`No announcement with id "${id}".`}>
          It may have been deleted. <Button small onClick={() => go('#/records')}>Back to records</Button>
        </Callout>
      </Card>
    );
  }

  if (!detail || !draft) return <div className="loading">Loading…</div>;

  const dirty =
    canonicalCompactJson(editableSlice(draft)) !== canonicalCompactJson(editableSlice(detail.record));

  // The record as it would be, validated with the validator the app itself
  // uses. `now` is the browser's, which is right for a live form.
  const now = Date.now();
  const live = validateAnnouncementRecord(draft, { now, mode: 'authored' });
  const lifecycle = deriveLifecycleStatus(
    { status: draft.status, startAt: draft.startAt, endAt: draft.endAt ?? null },
    now,
  );

  const patch = (changes: Partial<AuthoredAnnouncement>): void =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const save = async (): Promise<void> => {
    const saved = await run(() => api.edit(id, editableSlice(draft)), 'Saved.');
    if (saved) {
      setDetail(saved);
      setDraft(saved.record);
    }
  };

  const transition = async (move: Transition): Promise<void> => {
    const moved = await run(() => api.transition(id, move), `${id}: ${move}.`);
    if (moved) {
      setDetail(moved);
      setDraft(moved.record);
    }
  };

  return (
    <>
      <Card>
        <div className="spread">
          <div>
            <h2>
              {draft.title || <span className="hint">Untitled</span>}{' '}
              <Badge kind={lifecycle}>{lifecycle}</Badge>
            </h2>
            <p className="hint mono">
              {draft.id} · r{draft.rev} · updated {formatInstant(detail.record.updatedAt)}
            </p>
          </div>

          <div className="row tight">
            <Button onClick={() => go('#/records')}>Back</Button>
            <Button kind="primary" onClick={() => void save()} disabled={!dirty || !live.ok}>
              {dirty ? 'Save changes' : 'Saved'}
            </Button>
          </div>
        </div>

        {dirty ? (
          <Callout kind="warn" title="Unsaved changes">
            Nothing is written until you save, and nothing reaches an install until you publish.
          </Callout>
        ) : null}

        <Issues issues={live.errors} severity="error" />
        <Issues issues={live.warnings} severity="warning" />
      </Card>

      <div className="columns">
        <div>
          <Card>
            <h3>Content</h3>

            <Field label="Title" count={draft.title.length} limit={TITLE_MAX_LENGTH}>
              <input
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </Field>

            <Field
              label="Body"
              count={draft.body.length}
              limit={BODY_MAX_LENGTH}
              hint={
                draft.body.length > BODY_LENGTH_WARNING
                  ? `Over ${BODY_LENGTH_WARNING} characters scrolls inside a phone-width modal.`
                  : 'Plain text. Angle brackets and control characters are refused, so stored text can never read as markup.'
              }
            >
              <textarea
                rows={6}
                value={draft.body}
                onChange={(event) => patch({ body: event.target.value })}
              />
            </Field>

            <div className="row">
              <Field label="Category">
                <select
                  value={draft.category}
                  onChange={(event) => patch({ category: event.target.value as Category })}
                >
                  {CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Priority"
                hint={`${PRIORITY_MIN}–${PRIORITY_MAX}. Ordering among eligible records, not urgency.`}
              >
                <input
                  type="number"
                  min={PRIORITY_MIN}
                  max={PRIORITY_MAX}
                  value={draft.priority}
                  onChange={(event) => patch({ priority: Number(event.target.value) })}
                />
              </Field>
            </div>

            <Field
              label="Internal note"
              hint="Operator-only. Never published, never shown to a user."
            >
              <input
                value={draft.internalNote ?? ''}
                onChange={(event) =>
                  patch({ internalNote: event.target.value || undefined })
                }
              />
            </Field>
          </Card>

          <ScheduleCard draft={draft} patch={patch} errors={live.errors} />
          <DisplayCard draft={draft} patch={patch} />
          <TargetingCard draft={draft} patch={patch} />
          <ActionCard draft={draft} patch={patch} />
        </div>

        <div>
          <LifecycleCard
            detail={detail}
            dirty={dirty}
            onTransition={(move) => void transition(move)}
            onBump={() => setConfirming('bump')}
            onDelete={() => setConfirming('delete')}
          />

          <ImageCard detail={detail} onChanged={(next) => {
            setDetail(next);
            setDraft((current) => (current ? { ...current, image: next.record.image } : current));
            void refresh();
          }} />
        </div>
      </div>

      <Card>
        <Preview record={draft} imageUrl={detail.imageUrl} />
      </Card>

      {confirming === 'bump' ? (
        <Dialog
          title="Re-show this announcement to everyone?"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                kind="danger"
                onClick={() => {
                  setConfirming(null);
                  void run(() => api.bump(id), 'Revision bumped.').then((next) => {
                    if (next) {
                      setDetail(next);
                      setDraft(next.record);
                    }
                  });
                }}
              >
                Bump to r{draft.rev + 1}
              </Button>
            </>
          }
        >
          <p>
            Bumping the revision <strong>resets the impression counters for this id on every
            device</strong>. Anyone who has already seen this announcement — and anyone who
            dismissed it — will see it again after the next publish.
          </p>
          <p className="hint">
            To correct a typo quietly, close this and just save your edit. That is what the two
            being separate is for.
          </p>
        </Dialog>
      ) : null}

      {confirming === 'delete' ? (
        <Dialog
          title={`Delete "${id}" and retire its id?`}
          onClose={() => setConfirming(null)}
          actions={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  setConfirming(null);
                  void transition('archive');
                }}
              >
                Archive instead
              </Button>
              <Button
                kind="danger"
                onClick={() => {
                  setConfirming(null);
                  void run(() => api.remove(id), `Deleted "${id}".`).then((done) => {
                    if (done) go('#/records');
                  });
                }}
              >
                Delete for ever
              </Button>
            </>
          }
        >
          <p>
            Deleting is permanent in one specific way: <strong>the id can never be used
            again</strong>. It goes onto <code className="mono">content/retired-ids.json</code>,
            because devices that saw the original still hold its impression count under that id —
            a reused id would silently fail to show for exactly the users paying attention.
          </p>
          <p className="hint">
            Archiving keeps the record and its id, and it can be restored later. It is almost
            always what you want.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- schedule -- */

function ScheduleCard({
  draft,
  patch,
  errors,
}: {
  draft: AuthoredAnnouncement;
  patch: (changes: Partial<AuthoredAnnouncement>) => void;
  errors: readonly ValidationIssue[];
}): JSX.Element {
  const offset = localOffsetLabel();
  const dateError = errors.find((issue) => issue.path === 'endAt' || issue.path === 'startAt');

  return (
    <Card>
      <h3>Schedule</h3>
      <p className="hint">
        Authored in your local time ({offset}) and stored as an absolute instant. A date without
        an offset is not a fact a device in another timezone can act on.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <Field label={`Starts (${offset})`} hint={formatInstant(draft.startAt)}>
          <input
            type="datetime-local"
            value={toLocalInput(draft.startAt)}
            onChange={(event) => {
              const instant = fromLocalInput(event.target.value);
              if (instant) patch({ startAt: instant });
            }}
          />
        </Field>

        <Field
          label={`Ends (${offset})`}
          hint={draft.endAt ? formatInstant(draft.endAt) : 'Runs until it is unpublished.'}
          error={dateError?.path === 'endAt' ? dateError.message : undefined}
        >
          <input
            type="datetime-local"
            value={toLocalInput(draft.endAt)}
            onChange={(event) => patch({ endAt: fromLocalInput(event.target.value) })}
          />
        </Field>
      </div>

      {draft.endAt === null ? (
        <p className="field-note">
          No end date. An expired record drops out of the manifest on its own; one without an end
          date has to be remembered.
        </p>
      ) : (
        <Button small onClick={() => patch({ endAt: null })}>
          Clear the end date
        </Button>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- display -- */

function DisplayCard({
  draft,
  patch,
}: {
  draft: AuthoredAnnouncement;
  patch: (changes: Partial<AuthoredAnnouncement>) => void;
}): JSX.Element {
  const setDisplay = (changes: Partial<AuthoredAnnouncement['display']>): void =>
    patch({ display: { ...draft.display, ...changes } });

  return (
    <Card>
      <h3>Display</h3>
      <p className="hint">
        Four independent axes. How intrusive, when it may appear, how often, and what dismissing
        means — mixing them into one setting is what made an earlier design half nonsense.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <Field
          label="Surface"
          hint={
            draft.display.surface === 'modal'
              ? 'A blocking dialog. At most one per session.'
              : draft.display.surface === 'banner'
                ? 'An inline notice on a list screen. Never blocks.'
                : 'Only in Settings › Announcements. Never presented.'
          }
        >
          <select
            value={draft.display.surface}
            onChange={(event) => setDisplay({ surface: event.target.value as Surface })}
          >
            {SURFACES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Trigger"
          hint={
            draft.display.trigger === 'next-launch'
              ? 'Shown the next time the app opens. Never interrupts work in progress.'
              : 'May be shown during the session it was fetched in.'
          }
        >
          <select
            value={draft.display.trigger}
            onChange={(event) => setDisplay({ trigger: event.target.value as Trigger })}
          >
            {TRIGGERS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="row">
        <Field label="Max impressions" hint="Total times it may ever be shown on one device.">
          <div className="row tight">
            <input
              type="number"
              min={1}
              disabled={draft.display.maxImpressions === null}
              value={draft.display.maxImpressions ?? ''}
              onChange={(event) => setDisplay({ maxImpressions: Number(event.target.value) })}
            />
            <label className="row tight" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={draft.display.maxImpressions === null}
                onChange={(event) =>
                  setDisplay({ maxImpressions: event.target.checked ? null : 1 })
                }
              />
              unlimited
            </label>
          </div>
        </Field>

        <Field label="Minimum hours between" hint="0 may repeat within a session; 24 is once a day.">
          <input
            type="number"
            min={0}
            value={draft.display.minIntervalHours}
            onChange={(event) => setDisplay({ minIntervalHours: Number(event.target.value) })}
          />
        </Field>
      </div>

      <Field
        label="Dismiss"
        hint="`none` never means it cannot be closed — nothing here may produce a dialog a user cannot get out of."
      >
        <select
          value={draft.display.dismiss}
          onChange={(event) => setDisplay({ dismiss: event.target.value as DismissBehaviour })}
        >
          {DISMISS_BEHAVIOURS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </Field>
    </Card>
  );
}

/* ------------------------------------------------------------ targeting -- */

function TargetingCard({
  draft,
  patch,
}: {
  draft: AuthoredAnnouncement;
  patch: (changes: Partial<AuthoredAnnouncement>) => void;
}): JSX.Element {
  const setTargeting = (changes: Partial<AuthoredAnnouncement['targeting']>): void =>
    patch({ targeting: { ...draft.targeting, ...changes } });

  const toggle = (platform: Platform): void => {
    const next = draft.targeting.platforms.includes(platform)
      ? draft.targeting.platforms.filter((entry) => entry !== platform)
      : [...draft.targeting.platforms, platform];
    setTargeting({ platforms: next });
  };

  return (
    <Card>
      <h3>Targeting</h3>
      <p className="hint">
        Fails closed: a record whose targeting the client cannot fully evaluate is skipped, never
        shown.
      </p>

      <Field label="Platforms" hint="A platform absent from the list never sees this record.">
        <div className="row tight">
          {PLATFORMS.map((platform) => (
            <label key={platform} className="row tight" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={draft.targeting.platforms.includes(platform)}
                onChange={() => toggle(platform)}
              />
              {platform}
            </label>
          ))}
        </div>
      </Field>

      <div className="row">
        <Field label="Minimum version" hint="Inclusive (≥). Blank for no lower bound.">
          <input
            className="mono"
            placeholder="2.4.0"
            value={draft.targeting.minVersion ?? ''}
            onChange={(event) => setTargeting({ minVersion: event.target.value || null })}
          />
        </Field>

        <Field
          label="Maximum version"
          hint="EXCLUSIVE (<), so every 2.5.x is min 2.5.0 / max 2.6.0."
        >
          <input
            className="mono"
            placeholder="2.6.0"
            value={draft.targeting.maxVersion ?? ''}
            onChange={(event) => setTargeting({ maxVersion: event.target.value || null })}
          />
        </Field>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- action -- */

function ActionCard({
  draft,
  patch,
}: {
  draft: AuthoredAnnouncement;
  patch: (changes: Partial<AuthoredAnnouncement>) => void;
}): JSX.Element {
  const action = draft.action;

  const setAction = (next: AnnouncementAction | undefined): void => patch({ action: next });

  return (
    <Card>
      <h3>Action</h3>
      <p className="hint">
        A route action names a screen from a closed list, never a URL — so a compromised
        repository can only send a user somewhere that already exists.
      </p>

      <Field label="Kind">
        <select
          value={action?.type ?? 'none'}
          onChange={(event) => {
            const kind = event.target.value;
            if (kind === 'none') return setAction(undefined);
            if (kind === 'route') {
              return setAction({
                type: 'route',
                label: action?.label ?? 'Open',
                target: 'app.settings',
              });
            }
            setAction({ type: 'external', label: action?.label ?? 'Open', target: '' });
          }}
        >
          <option value="none">No action</option>
          <option value="route">Route — a screen in the app</option>
          <option value="external">External — an https link</option>
        </select>
      </Field>

      {action ? (
        <>
          <Field label="Button label" count={action.label.length} limit={ACTION_LABEL_MAX_LENGTH}>
            <input
              value={action.label}
              onChange={(event) => setAction({ ...action, label: event.target.value })}
            />
          </Field>

          {action.type === 'route' ? (
            <Field label="Destination" hint="The complete set of places an announcement may send a user.">
              <select
                value={action.target}
                onChange={(event) =>
                  setAction({ ...action, target: event.target.value as RouteTarget })
                }
              >
                {ROUTE_TARGETS.map((target) => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label="URL"
              hint={`https only, no embedded credentials, and only: ${EXTERNAL_HOST_ALLOWLIST.join(', ')}`}
            >
              <input
                className="mono"
                placeholder="https://github.com/…"
                value={action.target}
                onChange={(event) => setAction({ ...action, target: event.target.value })}
              />
            </Field>
          )}
        </>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------ lifecycle -- */

const TRANSITION_LABELS: Record<Transition, string> = {
  publish: 'Activate',
  pause: 'Pause',
  resume: 'Resume',
  archive: 'Archive',
  restore: 'Restore',
};

function LifecycleCard({
  detail,
  dirty,
  onTransition,
  onBump,
  onDelete,
}: {
  detail: RecordDetail;
  dirty: boolean;
  onTransition: (move: Transition) => void;
  onBump: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <Card>
      <h3>Lifecycle</h3>
      <p className="hint">
        Stored status is <span className="mono">{detail.record.status}</span>; the state shown
        elsewhere is derived from that and the dates.
      </p>

      <div className="row tight" style={{ marginTop: 10 }}>
        {(['publish', 'pause', 'resume', 'archive', 'restore'] as Transition[]).map((move) => (
          <Button
            key={move}
            small
            disabled={!detail.transitions.includes(move) || dirty}
            title={
              dirty
                ? 'Save your changes first.'
                : detail.transitions.includes(move)
                  ? undefined
                  : `Not available from "${detail.record.status}".`
            }
            onClick={() => onTransition(move)}
          >
            {TRANSITION_LABELS[move]}
          </Button>
        ))}
      </div>

      {detail.record.status === 'paused' ? (
        <p className="field-note">
          A paused record stays in the manifest carrying <span className="mono">paused: true</span>,
          so resuming needs no re-download on any device.
        </p>
      ) : null}

      <h3>Revision</h3>
      <div className="row tight">
        <span className="mono">r{detail.record.rev}</span>
        <Button small kind="danger" onClick={onBump}>
          Bump — re-show to everyone
        </Button>
      </div>
      <p className="field-note">
        Separate from every other edit on purpose. Correcting a typo and telling every device to
        look again are different intentions.
      </p>

      <h3>Dates</h3>
      <p className="field-note">
        Created {formatInstant(detail.record.createdAt)}
        <br />
        {detail.record.publishedAt
          ? `First published ${formatInstant(detail.record.publishedAt)}`
          : 'Never published'}
      </p>

      <h3>Danger</h3>
      <Button small kind="danger" onClick={onDelete}>
        Delete and retire this id
      </Button>
    </Card>
  );
}

/* ---------------------------------------------------------------- image -- */

function ImageCard({
  detail,
  onChanged,
}: {
  detail: RecordDetail;
  onChanged: (next: RecordDetail) => void;
}): JSX.Element {
  const { notify } = useManager();
  const input = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState(detail.record.image?.alt ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAlt(detail.record.image?.alt ?? '');
  }, [detail.record.image?.alt]);

  const image = detail.record.image;

  const upload = async (file: File): Promise<void> => {
    if (!image && !alt.trim()) {
      notify('Alt text is required the first time an image is attached.', 'error');
      return;
    }

    setBusy(true);
    try {
      const next = await api.attachImage(detail.record.id, file, alt.trim() || null);
      onChanged(next);
      notify(
        `Attached: ${next.encoded.width}×${next.encoded.height}, ` +
          `${formatBytes(next.encoded.bytes)} at quality ${next.encoded.quality}.`,
      );
    } catch (failure) {
      notify((failure as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card>
      <h3>Image</h3>

      {image ? (
        <>
          <img
            src={detail.imageUrl ?? ''}
            alt={image.alt}
            style={{ width: '100%', borderRadius: 6, display: 'block', marginBottom: 8 }}
          />
          <p className="field-note mono">
            {image.width}×{image.height} · {formatBytes(image.bytes)}
            <br />
            {image.path}
          </p>
        </>
      ) : (
        <p className="hint">
          No image. An announcement without one is perfectly normal — and on the device an image
          that fails to download shows the announcement without it, never suppresses it.
        </p>
      )}

      <Field
        label="Alt text"
        count={alt.length}
        limit={IMAGE_ALT_MAX_LENGTH}
        hint="What a screen reader announces, and the only description if the image fails to load."
      >
        <input value={alt} onChange={(event) => setAlt(event.target.value)} />
      </Field>

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <div className="row tight">
        <Button small disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Encoding…' : image ? 'Replace image' : 'Attach image'}
        </Button>
        {image ? (
          <Button
            small
            kind="danger"
            disabled={busy}
            onClick={() => {
              void api
                .detachImage(detail.record.id)
                .then(onChanged)
                .catch((failure: Error) => notify(failure.message, 'error'));
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>

      <p className="field-note">
        PNG, JPEG or WebP. Resized to 1080px on the long edge and encoded to WebP under 150 KB —
        every install downloads this file. SVG is not accepted: it is a script vector.
      </p>
    </Card>
  );
}
