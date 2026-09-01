/**
 * Publishing: the dry run, read, then confirmed.
 *
 * The dry run is not a convenience. The one thing that reliably stops a wrong
 * publish is seeing, in words, that it removes an announcement you did not mean
 * to remove — so the diff is computed and shown before anything is written, and
 * the button that writes is not available until it has been.
 *
 * Two things are called out rather than listed: a `rev` change, because it
 * re-shows the announcement to every device that has already seen it, and the
 * kill switch, because it silences every install at once.
 */

import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';
import type { ManagerState, PublishDiff, PublishResponse } from '../../shared/api';
import { useManager } from '../app';
import { Button, Callout, Card, Dialog, Issues } from '../components/ui';
import { formatBytes, formatSigned } from '../format';

export function PublishScreen({ state }: { state: ManagerState }): JSX.Element {
  const { run, notify, refresh, go } = useManager();

  const [preview, setPreview] = useState<PublishResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [message, setMessage] = useState('');

  const dryRun = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      setPreview(await api.publish({ dryRun: true }));
    } catch (failure) {
      notify((failure as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  }, [notify]);

  useEffect(() => {
    void dryRun();
  }, [dryRun]);

  const publish = async (paused?: boolean): Promise<void> => {
    setPublishing(true);
    const result = await run(() =>
      api.publish({
        dryRun: false,
        acceptWarnings,
        ...(typeof paused === 'boolean' ? { paused } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      }),
    );
    setPublishing(false);
    setConfirming(false);

    if (!result) return;

    switch (result.status) {
      case 'published':
        notify(`Published ${result.commit?.slice(0, 8)} at revision ${result.diff.revisionTo}.`);
        break;
      case 'committed':
        // Not a success: the commit exists, but no install has it.
        notify(
          result.push?.detail ??
            'Committed but not pushed. Your commit is intact locally — nothing is half-published.',
          'error',
        );
        break;
      case 'no-changes':
        notify('Nothing to publish.');
        break;
      case 'blocked':
        notify(result.blockedBy ?? 'Publishing refused.', 'error');
        break;
      default:
        break;
    }

    setPreview(result.status === 'blocked' ? result : null);
    await dryRun();
    await refresh();
  };

  const build = preview?.build;
  const diff = preview?.diff;
  const blocked = build ? !build.ok : false;
  const warningsOutstanding = (build?.warnings.length ?? 0) > 0 && !acceptWarnings;

  return (
    <>
      {state.published?.paused ? (
        <div className="kill-switch" style={{ marginBottom: 12 }}>
          THE KILL SWITCH IS ON — every install is showing nothing at all.
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => void publish(false)} disabled={publishing}>
              Publish and turn the kill switch off
            </Button>
          </div>
        </div>
      ) : null}

      <Card>
        <div className="spread">
          <div>
            <h2>What this publish would do</h2>
            <p className="hint">
              Computed by running the whole build in memory. Nothing has been written.
            </p>
          </div>
          <Button small onClick={() => void dryRun()} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </Button>
        </div>

        {checking && !preview ? <div className="loading">Building…</div> : null}

        {build ? (
          <>
            {build.problems.length > 0 ? (
              <Callout kind="error" title={`${build.problems.length} problem(s)`}>
                <ul>
                  {build.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            <Issues issues={build.errors} severity="error" />
            <Issues issues={build.warnings} severity="warning" />

            {build.excluded.length > 0 ? (
              <Callout title="Not published">
                <ul>
                  {build.excluded.map((entry) => (
                    <li key={entry.id}>
                      <span className="mono">{entry.id}</span> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            {diff ? <Diff diff={diff} /> : null}

            {build.warnings.length > 0 && build.ok ? (
              <label className="row tight" style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={acceptWarnings}
                  onChange={(event) => setAcceptWarnings(event.target.checked)}
                />
                These {build.warnings.length} warning(s) are what I meant.
              </label>
            ) : null}

            <div className="row" style={{ marginTop: 16 }}>
              <Button
                kind="primary"
                disabled={blocked || warningsOutstanding || publishing || diff?.empty}
                onClick={() => setConfirming(true)}
                title={
                  blocked
                    ? 'Errors are never overridable.'
                    : warningsOutstanding
                      ? 'Accept the warnings first.'
                      : diff?.empty
                        ? 'Nothing would change.'
                        : undefined
                }
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>

              {!state.published?.paused ? (
                <Button
                  kind="danger"
                  disabled={publishing}
                  onClick={() => void publish(true)}
                  title="Suppresses every announcement on every install until it is turned back off."
                >
                  Publish with the kill switch ON
                </Button>
              ) : null}

              <Button
                disabled={publishing}
                onClick={() =>
                  void run(() => api.build(), 'Wrote dist/ without committing.').then(() =>
                    dryRun(),
                  )
                }
              >
                Build only
              </Button>
            </div>

            {state.git.ok === false ? (
              <Callout kind="error" title="There is no git repository here">
                {state.git.reason}
              </Callout>
            ) : null}
          </>
        ) : null}
      </Card>

      {confirming && diff ? (
        <Dialog
          title="Publish?"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button kind="primary" onClick={() => void publish()} disabled={publishing}>
                Commit and push
              </Button>
            </>
          }
        >
          <Diff diff={diff} />

          {diff.modified.some((change) => change.resetsImpressions) ? (
            <Callout kind="error" title="This re-shows announcements">
              A revision changed, so impression counters reset on every device for those ids.
              Anyone who has already seen — or dismissed — them will see them again.
            </Callout>
          ) : null}

          {diff.removed.length > 0 ? (
            <Callout kind="warn" title={`${diff.removed.length} announcement(s) disappear`}>
              They stop being delivered to any install that fetches after this.
            </Callout>
          ) : null}

          <label className="field" style={{ marginTop: 12 }}>
            <span className="label">
              <span>Commit message (optional)</span>
            </span>
            <input
              placeholder={`Publish r${diff.revisionTo}`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <span className="field-note">
              The default names what changed, so <span className="mono">git log</span> reads as the
              publication history.
            </span>
          </label>
        </Dialog>
      ) : null}

      <Card>
        <h2>Records</h2>
        <p className="hint">
          Only <span className="mono">published</span> and <span className="mono">paused</span>{' '}
          records reach the manifest; drafts, archived and expired ones are excluded by the build.
        </p>
        <Button small onClick={() => go('#/records')}>
          Open the record list
        </Button>
      </Card>
    </>
  );
}

/**
 * The diff, in the same words the CLI prints.
 *
 * Deliberately the same wording: an operator who has read one has read the
 * other, and the CLI's version is what ends up in the commit message.
 */
function Diff({ diff }: { diff: PublishDiff }): JSX.Element {
  if (diff.empty) {
    return (
      <Callout kind="ok" title="No changes">
        dist/ is already what content/ produces.
      </Callout>
    );
  }

  return (
    <pre className="diff">
      {diff.added.map((record) => (
        <div className="diff-line added" key={`+${record.id}`}>
          {`  + ${record.id}  (${record.display.surface})`}
        </div>
      ))}

      {diff.modified.map((change) => (
        <div
          className={`diff-line${change.resetsImpressions ? ' reshow' : ''}`}
          key={`~${change.id}`}
        >
          {`  ~ ${change.id}  ${change.fields.join(', ')}`}
          {change.resetsImpressions ? '  [RE-SHOWS to everyone who saw it]' : ''}
        </div>
      ))}

      {diff.removed.map((record) => (
        <div className="diff-line removed" key={`-${record.id}`}>
          {`  - ${record.id}`}
        </div>
      ))}

      {diff.imagesAdded.length > 0 || diff.imagesRemoved.length > 0 ? '\n' : null}

      {diff.imagesAdded.map((image) => (
        <div className="diff-line added" key={`+${image.path}`}>
          {`  + ${image.path}  (${formatBytes(image.bytes)})`}
        </div>
      ))}

      {diff.imagesRemoved.map((image) => (
        <div className="diff-line removed" key={`-${image.path}`}>
          {`  - ${image.path}`}
        </div>
      ))}

      {diff.pausedChanged ? (
        <div className="diff-line reshow">
          {diff.pausedChanged.to
            ? '\n  !! KILL SWITCH ON — every install will show nothing'
            : '\n  !! kill switch off — announcements resume'}
        </div>
      ) : null}

      <div>
        {`\n  manifest ${formatBytes(diff.manifestBytesBefore)} → ${formatBytes(
          diff.manifestBytesAfter,
        )} (${formatSigned(diff.manifestBytesAfter - diff.manifestBytesBefore)} bytes),` +
          ` revision ${diff.revisionFrom ?? '-'} → ${diff.revisionTo}`}
      </div>
    </pre>
  );
}
