/**
 * The app shell's state: who is signed in, the GitHub client, and the content.
 *
 * ## What this replaced
 *
 * It used to hold a session against a Manager server on the operator's PC and
 * re-fetch `ManagerState` from it. There is no such server now. The same
 * discipline survives the move, because it was never about the server:
 *
 * **The repository is the system of record, so there is no client-side store.**
 * The snapshot is re-read after anything that writes. A cache here would be a
 * second copy of the repository to disagree with — and now that two
 * administrators can hold two phones, that is not a theoretical concern.
 *
 * ## The blob cache is not an exception to that
 *
 * `BlobCache` keys on git blob shas, and a blob sha IS a hash of the content.
 * A cached entry cannot be stale: if the content changed, the sha changed, and
 * the cache is missed. It makes a refresh cost one tree listing instead of
 * fifty blob reads, and it cannot make the app show something out of date.
 *
 * ## The phases
 *
 *   loading        reading the keystore
 *   unconfigured   this build has no GitHub client id (a developer's problem)
 *   signed-out     no token, or it expired — the sign-in screen
 *   no-access      signed in to GitHub, but no write access to the repository
 *   unreachable    signed in, and GitHub did not answer
 *   ready          signed in and working
 *
 * `no-access` is its own state because it is the one failure that is nobody's
 * bug: the person is who they say they are and has not been given access yet.
 * Collapsing it into "signed out" would send them round the sign-in loop
 * forever without ever saying what is wrong.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { AuthoredAnnouncement } from '@ruood/announcement-schema';
import {
  ConcurrentUpdate,
  GitHubError,
  createGitHubClient,
  emptyCache,
  loadContent,
  refreshAccessToken,
  type BlobCache,
  type ContentSnapshot,
  type GitHubClient,
  type GitHubUser,
  type IssuedToken,
} from '@ruood/announcement-github';

import { androidSessionStore } from './storage';
import { CLIENT_ID_OVERRIDE_KEY, GITHUB_REFRESH_KEY, GITHUB_TOKEN_KEY } from './storage-keys';
import {
  announcementsRepository,
  compiledClientId,
  developerToolsAvailable,
  hasRepository,
} from './config';
import { humanise } from './language';

export type Phase =
  | 'loading'
  | 'unconfigured'
  | 'signed-out'
  | 'no-access'
  | 'unreachable'
  | 'ready';

export interface Toast {
  id: number;
  message: string;
  kind: 'ok' | 'error';
}

export interface Manager {
  phase: Phase;
  /** Who is signed in to GitHub. Display only; GitHub decides what they may do. */
  viewer: GitHubUser | null;
  /** Null until signed in. Every screen that uses it is gated on `ready`. */
  api: GitHubClient | null;
  /** The announcements as they are in the repository right now. */
  content: ContentSnapshot | null;
  problem: string | null;

  /** The client id in use — compiled in, or a developer's override. */
  clientId: string;

  refresh: () => Promise<void>;
  signIn: (issued: IssuedToken) => Promise<void>;
  signOut: () => Promise<void>;
  /** Developer builds only. Points this device at a different GitHub App. */
  setClientId: (clientId: string) => Promise<void>;

  notify: (message: string, kind?: 'ok' | 'error') => void;
  toasts: Toast[];
  /**
   * Runs a write, reports what it throws in plain words, and re-reads after.
   *
   * The re-read is not a nicety. A write is built on a specific commit, so the
   * next one must be built on what the last one produced — otherwise every
   * second write in a row would be refused as a concurrent update.
   */
  run: <T>(action: (snapshot: ContentSnapshot) => Promise<T>, success?: string) => Promise<T | null>;
}

const ManagerContext = createContext<Manager | null>(null);

export function useManager(): Manager {
  const manager = useContext(ManagerContext);
  if (!manager) throw new Error('useManager was called outside the shell.');
  return manager;
}

/** Records as the list screen wants them: newest change first. */
export function sortedRecords(content: ContentSnapshot | null): AuthoredAnnouncement[] {
  return [...(content?.records ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function ManagerProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [viewer, setViewer] = useState<GitHubUser | null>(null);
  const [content, setContent] = useState<ContentSnapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clientId, setClientIdState] = useState<string>(compiledClientId());

  /** Kept in a ref so a 401 handler can use it without re-rendering. */
  const refreshToken = useRef<string | null>(null);

  // Kept across loads, so a refresh only fetches what actually changed. Safe
  // because it keys on content hashes — see the header.
  const cache = useRef<BlobCache>(emptyCache());

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const api = useMemo(
    () =>
      token
        ? createGitHubClient({
            token,
            repository: announcementsRepository(),
            http: { fetch: (url, init) => fetch(url, init as RequestInit) },
          })
        : null,
    [token],
  );

  const notify = useCallback((message: string, kind: 'ok' | 'error' = 'ok'): void => {
    const toast: Toast = { id: Date.now() + Math.random(), message, kind };
    setToasts((current) => [...current, toast]);

    const timer = setTimeout(
      () => setToasts((current) => current.filter((entry) => entry.id !== toast.id)),
      kind === 'error' ? 9000 : 3500,
    );
    timers.current.push(timer);
  }, []);

  /** Signs out locally. The token is GitHub's to revoke; this only forgets it. */
  const forget = useCallback(async (): Promise<void> => {
    await androidSessionStore.deleteSecret(GITHUB_TOKEN_KEY);
    await androidSessionStore.deleteSecret(GITHUB_REFRESH_KEY);
    refreshToken.current = null;
    setToken(null);
    setViewer(null);
    setContent(null);
    cache.current = emptyCache();
  }, []);

  const load = useCallback(
    async (client: GitHubClient): Promise<void> => {
      try {
        const [who, writable] = await Promise.all([client.viewer(), client.canWrite()]);
        setViewer(who);

        if (!writable) {
          // Signed in, and not allowed. Said here rather than at the first
          // failed write, so nobody composes an announcement they cannot save.
          setContent(null);
          setProblem(null);
          setPhase('no-access');
          return;
        }

        setContent(await loadContent(client, cache.current));
        setProblem(null);
        setPhase('ready');
      } catch (failure) {
        if (failure instanceof GitHubError && failure.isAuthFailure) {
          // Expiring tokens last eight hours. Before telling somebody their
          // session ended, try the refresh token — being signed out every
          // morning is the symptom of not doing this, and it looks like a bug
          // in the app rather than a setting on a GitHub App.
          if (refreshToken.current) {
            const issued = await refreshAccessToken(refreshToken.current, {
              clientId,
              http: { fetch: (url, init) => fetch(url, init as RequestInit) },
              now: Date.now(),
            }).catch(() => null);

            if (issued) {
              await androidSessionStore.writeSecret(GITHUB_TOKEN_KEY, issued.token);
              if (issued.refreshToken) {
                await androidSessionStore.writeSecret(GITHUB_REFRESH_KEY, issued.refreshToken);
                refreshToken.current = issued.refreshToken;
              }
              setToken(issued.token);
              return;
            }
          }

          // Revoked, or the refresh token is spent too. Keeping a token that
          // cannot authenticate leaves every action failing for no visible
          // reason.
          await forget();
          setProblem('Your GitHub sign-in has expired. Please sign in again.');
          setPhase('signed-out');
          return;
        }

        if (failure instanceof GitHubError && failure.isPermissionFailure) {
          setPhase('no-access');
          return;
        }

        setProblem(humanise(failure));
        setPhase('unreachable');
      }
    },
    [forget, clientId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return;
    await load(api);
  }, [api, load]);

  // Restore the token on launch.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // A developer's override wins over what was compiled in, and only exists
      // in a build where the screen that writes it is reachable at all.
      const override = developerToolsAvailable()
        ? ((await androidSessionStore.read(CLIENT_ID_OVERRIDE_KEY)) ?? '').trim()
        : '';

      const resolved = override || compiledClientId();
      if (cancelled) return;
      setClientIdState(resolved);

      if (!resolved || !hasRepository()) {
        setPhase('unconfigured');
        return;
      }

      const [stored, refresh] = await Promise.all([
        androidSessionStore.readSecret(GITHUB_TOKEN_KEY),
        androidSessionStore.readSecret(GITHUB_REFRESH_KEY),
      ]);
      if (cancelled) return;

      refreshToken.current = refresh;

      if (!stored) {
        setPhase('signed-out');
        return;
      }

      setToken(stored);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // A token arriving — from launch or from a sign-in — is what triggers a load.
  useEffect(() => {
    if (!api) return;
    void load(api);
  }, [api, load]);

  const signIn = useCallback(async (issued: IssuedToken): Promise<void> => {
    // The keystore, and nowhere else. `expo-secure-store` puts it in the
    // Android keystore; preferences would put it in a file any backup copies.
    await androidSessionStore.writeSecret(GITHUB_TOKEN_KEY, issued.token);

    if (issued.refreshToken) {
      await androidSessionStore.writeSecret(GITHUB_REFRESH_KEY, issued.refreshToken);
      refreshToken.current = issued.refreshToken;
    }

    setProblem(null);
    setPhase('loading');
    setToken(issued.token);
  }, []);

  const setClientId = useCallback(
    async (next: string): Promise<void> => {
      // Changing which GitHub App this device talks to invalidates the token it
      // holds: that credential was issued by a different one.
      await forget();
      await androidSessionStore.write(CLIENT_ID_OVERRIDE_KEY, next.trim());

      const resolved = next.trim() || compiledClientId();
      setClientIdState(resolved);
      setPhase(resolved && hasRepository() ? 'signed-out' : 'unconfigured');
    },
    [forget],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await forget();
    setProblem(null);
    setPhase('signed-out');
  }, [forget]);

  const run = useCallback(
    async <T,>(
      action: (snapshot: ContentSnapshot) => Promise<T>,
      success?: string,
    ): Promise<T | null> => {
      if (!api || !content) return null;

      try {
        const result = await action(content);

        // Re-read before anything else. The next write has to be built on what
        // this one produced, or it would be refused as a concurrent update.
        await load(api);
        if (success) notify(success);
        return result;
      } catch (failure) {
        if (failure instanceof ConcurrentUpdate) {
          // Somebody else's phone got there first. Re-read so the screen shows
          // what is actually there, and say so — silently retrying would
          // overwrite work nobody had seen.
          await load(api);
          notify(
            'Someone else changed the announcements while you were working. Your change was not ' +
              'saved — check the list and try again.',
            'error',
          );
          return null;
        }

        notify(humanise(failure), 'error');

        if (failure instanceof GitHubError && failure.isAuthFailure) {
          await forget();
          setPhase('signed-out');
        }

        return null;
      }
    },
    [api, content, load, notify, forget],
  );

  const manager: Manager = {
    phase,
    viewer,
    api,
    content,
    problem,
    clientId,
    setClientId,
    refresh,
    signIn,
    signOut,
    notify,
    toasts,
    run,
  };

  return <ManagerContext.Provider value={manager}>{children}</ManagerContext.Provider>;
}

