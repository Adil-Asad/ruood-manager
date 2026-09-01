/**
 * The Manager shell: one loaded state, five screens, and a hash route.
 *
 * There is no router dependency and no client-side store. `ManagerState` is
 * re-fetched after anything that writes, because the repository is the system
 * of record and a cache here would be a second copy of it to disagree with —
 * the same reason the server holds no state either.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { api, ApiFailure } from './api';
import type { ManagerState } from '../shared/api';
import { DashboardScreen } from './screens/dashboard';
import { RecordsScreen } from './screens/records';
import { EditorScreen } from './screens/editor';
import { PublishScreen } from './screens/publish';
import { RepositoryScreen } from './screens/repository';

export interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'error';
}

interface Manager {
  state: ManagerState | null;
  refresh: () => Promise<void>;
  notify: (message: string, kind?: 'ok' | 'error') => void;
  /** Runs an action, reports whatever it throws, and refreshes on success. */
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | null>;
  go: (route: string) => void;
}

const ManagerContext = createContext<Manager | null>(null);

export function useManager(): Manager {
  const manager = useContext(ManagerContext);
  if (!manager) throw new Error('useManager outside the shell');
  return manager;
}

type Route =
  | { name: 'dashboard' }
  | { name: 'records' }
  | { name: 'editor'; id: string }
  | { name: 'publish' }
  | { name: 'repository' };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, tail] = path.split('/');

  if (head === 'records' && tail) return { name: 'editor', id: decodeURIComponent(tail) };
  if (head === 'records') return { name: 'records' };
  if (head === 'publish') return { name: 'publish' };
  if (head === 'repository') return { name: 'repository' };
  return { name: 'dashboard' };
}

export function App(): JSX.Element {
  const [state, setState] = useState<ManagerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await api.state());
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const notify = useCallback((message: string, kind: 'ok' | 'error' = 'ok'): void => {
    const toast: Toast = { id: Date.now() + Math.random(), message, kind };
    setToasts((current) => [...current, toast]);

    // Errors stay long enough to read a validator message; successes do not.
    window.setTimeout(
      () => setToasts((current) => current.filter((entry) => entry.id !== toast.id)),
      kind === 'error' ? 9000 : 3500,
    );
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | null> => {
      try {
        const result = await action();
        await refresh();
        if (success) notify(success);
        return result;
      } catch (failure) {
        // A refusal carries its issues; the first one is the useful sentence.
        const message =
          failure instanceof ApiFailure && failure.issues.length > 0
            ? `${failure.message} ${failure.issues[0]!.message}`
            : (failure as Error).message;
        notify(message, 'error');
        return null;
      }
    },
    [refresh, notify],
  );

  const go = useCallback((next: string): void => {
    window.location.hash = next;
  }, []);

  const manager: Manager = { state, refresh, notify, run, go };

  return (
    <ManagerContext.Provider value={manager}>
      <div className="shell">
        <header className="topbar">
          <span className="brand">RUŌOD Announcements</span>
          {state ? (
            <span className="repo-chip" title={state.repo.root}>
              {state.repo.root}
            </span>
          ) : null}

          <nav className="tabs">
            {(
              [
                ['', 'Dashboard', 'dashboard'],
                ['records', 'Records', 'records'],
                ['publish', 'Publish', 'publish'],
                ['repository', 'Repository', 'repository'],
              ] as const
            ).map(([target, label, name]) => (
              <button
                key={label}
                onClick={() => go(`#/${target}`)}
                aria-current={
                  route.name === name || (name === 'records' && route.name === 'editor')
                    ? 'page'
                    : undefined
                }
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        <main>
          {error ? (
            <div className="callout error">
              <strong>The Manager server is not answering.</strong>
              {error} — check the terminal it was started in.
            </div>
          ) : null}

          {!state && !error ? <div className="loading">Reading the repository…</div> : null}

          {state ? <Screen route={route} state={state} /> : null}
        </main>

        <div className="toasts">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.kind}`}>
              {toast.message}
            </div>
          ))}
        </div>
      </div>
    </ManagerContext.Provider>
  );
}

function Screen({ route, state }: { route: Route; state: ManagerState }): JSX.Element {
  switch (route.name) {
    case 'records':
      return <RecordsScreen state={state} />;
    case 'editor':
      return <EditorScreen id={route.id} />;
    case 'publish':
      return <PublishScreen state={state} />;
    case 'repository':
      return <RepositoryScreen state={state} />;
    case 'dashboard':
      return <DashboardScreen state={state} />;
  }
}
