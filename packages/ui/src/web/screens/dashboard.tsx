/**
 * Where things stand.
 *
 * The same three questions `announce status` answers — what is in `content/`,
 * what is published, what git thinks — with the one thing a terminal cannot do:
 * put the states that need attention above the ones that do not.
 *
 * Counts are by DERIVED lifecycle state, never by stored status. A record
 * stored as `published` may be scheduled, active or expired depending only on
 * its dates, and "3 published" would hide all three distinctions.
 */

import type { LifecycleStatus } from '@ruood/announcement-schema';

import type { ManagerState } from '../../shared/api';
import { useManager } from '../app';
import { Badge, Button, Callout, Card, Stat } from '../components/ui';
import { formatBytes, formatInstant, formatRelative } from '../format';

/** Most actionable first: what is live, then what is coming, then the rest. */
const ORDER: LifecycleStatus[] = ['active', 'scheduled', 'paused', 'draft', 'expired', 'archived'];

export function DashboardScreen({ state }: { state: ManagerState }): JSX.Element {
  const { go } = useManager();
  const now = Date.parse(state.now);

  const upcoming = state.records
    .filter((record) => record.lifecycle === 'scheduled')
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .slice(0, 5);

  const broken = state.records.filter((record) => record.errorCount > 0);

  return (
    <>
      {state.published?.paused ? (
        <div className="kill-switch" style={{ marginBottom: 12 }}>
          THE KILL SWITCH IS ON — every install is showing nothing at all. Turn it off from the
          Publish screen.
        </div>
      ) : null}

      {state.git.ok === false ? (
        <Callout kind="error" title="Publishing is not possible yet">
          {state.git.reason} Run <code className="mono">announce init --repo …</code> in this
          directory, then reload.
        </Callout>
      ) : null}

      {state.failures.length > 0 ? (
        <Callout
          kind="error"
          title={`${state.failures.length} file(s) in content/ could not be read`}
        >
          <ul>
            {state.failures.map((failure) => (
              <li key={failure.file} className="mono">
                {failure.file}: {failure.error}
              </li>
            ))}
          </ul>
          These block every build until they are repaired.
        </Callout>
      ) : null}

      {broken.length > 0 ? (
        <Callout kind="error" title={`${broken.length} record(s) would block a publish`}>
          <div className="row tight">
            {broken.map((record) => (
              <Button key={record.id} small onClick={() => go(`#/records/${record.id}`)}>
                {record.id}
              </Button>
            ))}
          </div>
        </Callout>
      ) : null}

      <Card>
        <div className="spread">
          <h2>Announcements</h2>
          <Button small onClick={() => go('#/records')}>
            All records
          </Button>
        </div>

        <div className="grid-2" style={{ marginTop: 12 }}>
          {ORDER.map((status) => (
            <Stat key={status} value={state.counts[status] ?? 0} label={status} />
          ))}
        </div>

        {state.retiredIds.length > 0 ? (
          <p className="hint">
            {state.retiredIds.length} retired id(s) — permanently unusable, because each one still
            keys impression state on devices that saw the original.
          </p>
        ) : null}
      </Card>

      <Card>
        <h2>Published</h2>
        {state.published ? (
          <>
            <div className="grid-2" style={{ marginTop: 12 }}>
              <Stat value={`r${state.published.revision}`} label="revision" />
              <Stat value={state.published.records} label="records in the manifest" />
              <Stat value={state.published.images} label="images" />
              <Stat value={formatBytes(state.published.bytes)} label="manifest size" />
            </div>
            <p className="hint">
              Generated {formatInstant(state.published.generatedAt)}.{' '}
              {state.published.signedBy
                ? `Signed by ${state.published.signedBy}.`
                : 'Unsigned.'}
            </p>
          </>
        ) : (
          <p className="hint">
            Nothing published yet — <code className="mono">dist/announcements.json</code> does not
            exist.
          </p>
        )}

        {state.distStale ? (
          <Callout kind="warn" title="dist/ is behind content/">
            The revision counter says {state.contentRevision} but the published manifest says{' '}
            {state.published?.revision ?? 0}. Nothing has reached an install yet.
          </Callout>
        ) : null}

        {state.git.ok && state.git.status.hasRemote && state.git.status.ahead > 0 ? (
          <Callout kind="warn" title={`${state.git.status.ahead} commit(s) are not pushed`}>
            They are committed locally, so nothing is half-published — but no install has them.
          </Callout>
        ) : null}

        {state.publishedStaging && state.publishedStaging.revision > 0 ? (
          <p className="hint">
            Staging: revision {state.publishedStaging.revision},{' '}
            {state.publishedStaging.records} record(s) — dev builds only, and it includes drafts.
          </p>
        ) : null}

        <div className="row" style={{ marginTop: 12 }}>
          <Button kind="primary" onClick={() => go('#/publish')}>
            Review and publish
          </Button>
        </div>
      </Card>

      {upcoming.length > 0 ? (
        <Card>
          <h2>Starting soon</h2>
          <table>
            <tbody>
              {upcoming.map((record) => (
                <tr key={record.id} className="clickable" onClick={() => go(`#/records/${record.id}`)}>
                  <td style={{ width: 1 }}>
                    <Badge kind="scheduled">scheduled</Badge>
                  </td>
                  <td>{record.title}</td>
                  <td className="mono">{formatRelative(record.startAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}
