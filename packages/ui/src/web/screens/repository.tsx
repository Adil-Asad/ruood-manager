/**
 * The repository: git state, the publication history, and the way back.
 *
 * There is no second publication history anywhere in this system — `git log`
 * IS the history, which is why a publish is one commit with a message naming
 * what changed. This screen is a reader for it, plus the two operations that
 * act on it: push what is committed, and revert a publish.
 */

import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';
import type { GitLogEntry, ManagerState } from '../../shared/api';
import { useManager } from '../app';
import { Button, Callout, Card, Dialog, Empty } from '../components/ui';
import { formatBytes, formatInstant } from '../format';

export function RepositoryScreen({ state }: { state: ManagerState }): JSX.Element {
  const { run, notify } = useManager();
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [reverting, setReverting] = useState<GitLogEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLog = useCallback(async (): Promise<void> => {
    if (!state.git.ok) return;
    try {
      setLog(await api.log(30));
    } catch (failure) {
      notify((failure as Error).message, 'error');
    }
  }, [state.git.ok, notify]);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  if (!state.git.ok) {
    return (
      <Card>
        <h2>Repository</h2>
        <Callout kind="error" title="Not usable for publishing">
          {state.git.reason}
        </Callout>
        <p className="hint">
          Create it with <code className="mono">announce init --repo {state.repo.root}</code>, then
          add a remote and enable GitHub Pages on the default branch.
        </p>
      </Card>
    );
  }

  const git = state.git.status;

  return (
    <>
      <Card>
        <h2>Git</h2>

        <table>
          <tbody>
            <tr>
              <td>Path</td>
              <td className="mono">{state.repo.root}</td>
            </tr>
            <tr>
              <td>Branch</td>
              <td className="mono">{git.branch}</td>
            </tr>
            <tr>
              <td>Working tree</td>
              <td>{git.clean ? 'clean' : 'uncommitted changes'}</td>
            </tr>
            <tr>
              <td>Remote</td>
              <td>
                {git.hasRemote
                  ? `ahead ${git.ahead}, behind ${git.behind}`
                  : 'none configured — publishing commits locally only'}
              </td>
            </tr>
            {state.published ? (
              <tr>
                <td>Published</td>
                <td>
                  revision {state.published.revision}, {state.published.records} record(s),{' '}
                  {formatBytes(state.published.bytes)}, generated{' '}
                  {formatInstant(state.published.generatedAt)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {!git.clean ? (
          <Callout kind="warn" title="The working tree has uncommitted changes">
            <ul>
              {[...git.staged, ...git.modified, ...git.untracked].slice(0, 20).map((file) => (
                <li key={file} className="mono">
                  {file}
                </li>
              ))}
            </ul>
            A publish stages only <span className="mono">dist/</span> and{' '}
            <span className="mono">content/</span>, so it will not sweep anything else up.
          </Callout>
        ) : null}

        {git.hasRemote && git.ahead > 0 ? (
          <Callout kind="warn" title={`${git.ahead} commit(s) are committed but not pushed`}>
            Nothing is half-published — the unit of publication is the commit — but no install has
            these yet.
            <div style={{ marginTop: 8 }}>
              <Button
                small
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void run(() => api.push()).then((outcome) => {
                    setBusy(false);
                    if (outcome) {
                      notify(
                        outcome.pushed
                          ? 'Pushed. Clients pick it up on their next check.'
                          : (outcome.detail ?? 'Not pushed.'),
                        outcome.pushed ? 'ok' : 'error',
                      );
                    }
                    void loadLog();
                  });
                }}
              >
                Push now
              </Button>
            </div>
          </Callout>
        ) : null}
      </Card>

      <Card>
        <h2>History</h2>
        <p className="hint">
          Every publish is one commit carrying the manifest and its images together, so reverting
          one takes them all back at once.
        </p>

        {log.length === 0 ? (
          <Empty>No commits yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Commit</th>
                <th>When</th>
                <th>Subject</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {log.map((entry) => (
                <tr key={entry.hash}>
                  <td className="mono">{entry.hash}</td>
                  <td className="mono">{entry.date.slice(0, 16).replace('T', ' ')}</td>
                  <td>{entry.message.split('\n')[0]}</td>
                  <td>
                    {entry.message.startsWith('Publish ') ? (
                      <Button small onClick={() => setReverting(entry)}>
                        Revert
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2>Retired ids</h2>
        <p className="hint">
          {state.retiredIds.length === 0
            ? 'None. An id goes on this list when its record is deleted, and can never be used again.'
            : 'These can never be used again — devices that saw the original still hold its impression count under each one.'}
        </p>
        {state.retiredIds.length > 0 ? (
          <div className="row tight">
            {state.retiredIds.map((id) => (
              <span key={id} className="badge">
                {id}
              </span>
            ))}
          </div>
        ) : null}
      </Card>

      {reverting ? (
        <Dialog
          title={`Revert ${reverting.hash}?`}
          onClose={() => setReverting(null)}
          actions={
            <>
              <Button onClick={() => setReverting(null)}>Cancel</Button>
              <Button
                kind="danger"
                onClick={() => {
                  const commit = reverting.hash;
                  setReverting(null);
                  void run(() => api.revert(commit), `Reverted ${commit}.`).then(() => loadLog());
                }}
              >
                Revert
              </Button>
            </>
          }
        >
          <p className="mono">{reverting.message.split('\n')[0]}</p>
          <p>
            This adds a new commit that undoes that one — history is never rewritten and nothing is
            force-pushed. <span className="mono">dist/</span> and{' '}
            <span className="mono">content/</span> both go back together.
          </p>
          <p className="hint">
            It is local until it is pushed. Note that{' '}
            <span className="mono">content/state.json</span> goes back too, so the next publish
            reuses that revision number — revision tracks what is published, not how many times you
            have published.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
