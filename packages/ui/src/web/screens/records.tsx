/**
 * The record list, and the one dialog that creates a new one.
 *
 * Filtering is by derived lifecycle state, and the default order is the CLI's:
 * live first, then what is coming, then the rest. The list is where an operator
 * looks to answer "what is going out right now", so what is going out right now
 * is at the top.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  CATEGORIES,
  ID_MAX_LENGTH,
  LIFECYCLE_STATUSES,
  SURFACES,
  TITLE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  suggestId,
  type Category,
  type LifecycleStatus,
  type Surface,
} from '@ruood/announcement-schema';

import { api } from '../api';
import type { IdCheckResponse, ManagerState, RecordSummary } from '../../shared/api';
import { useManager } from '../app';
import { Badge, Button, Card, Dialog, Empty, Field } from '../components/ui';
import { deliveryFor } from '../delivery';
import { formatWindow } from '../format';

const ORDER: LifecycleStatus[] = ['active', 'scheduled', 'paused', 'draft', 'expired', 'archived'];

export function RecordsScreen({ state }: { state: ManagerState }): JSX.Element {
  const { go } = useManager();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LifecycleStatus | ''>('');
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return state.records
      .filter((record) => !filter || record.lifecycle === filter)
      .filter(
        (record) =>
          !needle ||
          record.id.includes(needle) ||
          record.title.toLowerCase().includes(needle) ||
          record.body.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          ORDER.indexOf(a.lifecycle) - ORDER.indexOf(b.lifecycle) || a.id.localeCompare(b.id),
      );
  }, [state.records, search, filter]);

  return (
    <Card>
      <div className="spread">
        <h2>
          Records <span className="hint">({state.records.length})</span>
        </h2>
        <Button kind="primary" onClick={() => setCreating(true)}>
          New announcement
        </Button>
      </div>

      <div className="row" style={{ margin: '12px 0' }}>
        <input
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Search id, title or body"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          style={{ width: 'auto' }}
          value={filter}
          onChange={(event) => setFilter(event.target.value as LifecycleStatus | '')}
        >
          <option value="">Every state</option>
          {LIFECYCLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status} ({state.counts[status] ?? 0})
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <Empty>
          {state.records.length === 0
            ? 'No announcements yet.'
            : 'Nothing matches that search or filter.'}
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Id</th>
              <th>Title</th>
              <th>Rev</th>
              <th>Delivery</th>
              <th>Pri</th>
              <th>Window</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => (
              <Row key={record.id} record={record} onOpen={() => go(`#/records/${record.id}`)} />
            ))}
          </tbody>
        </table>
      )}

      {creating ? <NewRecordDialog onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

function Row({ record, onOpen }: { record: RecordSummary; onOpen: () => void }): JSX.Element {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td>
        <Badge kind={record.lifecycle}>{record.lifecycle}</Badge>
      </td>
      <td className="mono">{record.id}</td>
      <td>{record.title}</td>
      <td className="mono">r{record.rev}</td>
      <td>
        {record.surface}
        <br />
        <span className="hint">{deliveryFor(record.surface).label}</span>
      </td>
      <td className="mono">{record.priority}</td>
      <td className="mono">{formatWindow(record.startAt, record.endAt)}</td>
      <td>
        <div className="row tight">
          {record.errorCount > 0 ? <Badge kind="error">{record.errorCount} error</Badge> : null}
          {record.errorCount === 0 && record.warningCount > 0 ? (
            <Badge>{record.warningCount} warn</Badge>
          ) : null}
          {record.hasImage ? <Badge>image</Badge> : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * Creating a draft.
 *
 * The id is checked as it is typed, because the two ways it can be unavailable
 * have different answers: a duplicate can be renamed, and a retired one can
 * never be had at all — devices that saw the original still hold its impression
 * count under that id.
 */
function NewRecordDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { run, go } = useManager();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [surface, setSurface] = useState<Surface>('modal');
  const [category, setCategory] = useState<Category>('notice');
  const [check, setCheck] = useState<IdCheckResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Until the id field is touched it tracks the title, which is what an
  // operator expects and what `suggestId` is for. After that it is theirs.
  const effectiveId = idTouched ? id : (suggestId(title) ?? '');

  useEffect(() => {
    if (!effectiveId) {
      setCheck(null);
      return;
    }

    // Debounced, and the in-flight answer is discarded if the id moved on —
    // otherwise a slow reply for "report" lands after a fast one for "reports"
    // and the field reports the wrong verdict.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .checkId(effectiveId)
        .then((result) => {
          if (!cancelled) setCheck(result);
        })
        .catch(() => undefined);
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [effectiveId]);

  const idProblem =
    check && !check.available
      ? check.reason === 'retired'
        ? 'This id belonged to a deleted announcement and can never be reused.'
        : check.reason === 'duplicate'
          ? `Already in use.${check.suggestion ? ` Free: ${check.suggestion}` : ''}`
          : 'Lowercase words joined by single hyphens, 3-64 characters.'
      : undefined;

  const canCreate =
    title.trim().length > 0 && body.trim().length > 0 && check?.available === true && !busy;

  const create = async (): Promise<void> => {
    setBusy(true);
    const created = await run(
      () =>
        api.create({
          id: effectiveId,
          title: title.trim(),
          body: body.trim(),
          surface,
          category,
        }),
      'Draft created.',
    );
    setBusy(false);

    if (created) {
      onClose();
      go(`#/records/${created.record.id}`);
    }
  };

  return (
    <Dialog
      title="New announcement"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={() => void create()} disabled={!canCreate}>
            Create draft
          </Button>
        </>
      }
    >
      <Field label="Title" count={title.length} limit={TITLE_MAX_LENGTH}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
      </Field>

      <Field label="Body" count={body.length} limit={BODY_MAX_LENGTH}>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>

      <Field
        label="Id"
        hint="Permanent. It keys impression state on every device, and is never reused — not even after deletion."
        error={idProblem}
        count={effectiveId.length}
        limit={ID_MAX_LENGTH}
      >
        <input
          className="mono"
          value={effectiveId}
          onChange={(event) => {
            setIdTouched(true);
            setId(event.target.value);
          }}
        />
      </Field>

      <div className="row">
        <Field label="Surface">
          <select value={surface} onChange={(event) => setSurface(event.target.value as Surface)}>
            {SURFACES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Category">
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as Category)}
          >
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="hint">
        It is created as a draft and will not be published until you activate it.
      </p>
    </Dialog>
  );
}
