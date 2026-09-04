/**
 * Where a credential may live on a device, and where it may not.
 *
 * ## What this used to be
 *
 * It held a whole session model: a base URL, a repository name, a paired-at
 * stamp, an administrator identity, and two constructors for the two ways a
 * session could begin. All of that existed because the app talked to a Manager
 * server that had to be located, paired with, and logged into separately.
 *
 * None of it survived the move to GitHub. There is no address to store — the
 * repository is compiled in. There is no pairing. There is no separate
 * identity, because GitHub is the identity. What is left is the one thing that
 * was always the point:
 *
 * **A token goes in the platform keystore, and nothing else does.**
 *
 * ## Why the port has two halves
 *
 * `readSecret`/`writeSecret` reach the Android keystore through
 * `expo-secure-store`; `read`/`write` are ordinary preferences. They are
 * separate methods rather than one `set(key, value)` because the distinction
 * has to be impossible to get wrong at a call site — and a single method would
 * leave it to discipline, on a phone, with a credential.
 *
 * ## The one secret, and what it is not
 *
 * The device holds a GitHub user token. It authenticates a person to GitHub,
 * and GitHub decides what that person may do with the announcements
 * repository.
 *
 * It is not, and must never be confused with, the **announcement signing key**.
 * That key is a secret of the publishing workflow. It is not on the phone, not
 * in the app, not in any build of it, and not on any administrator's machine —
 * and unlike every previous arrangement, losing the phone does not put it at
 * risk, because the phone never had it.
 */

/**
 * The persistence port.
 *
 * Injected rather than imported so this package stays platform-neutral and the
 * storage can be faked in a test — the same reason the transport is injected.
 */
export interface SessionStore {
  /** The platform keystore. Android: `expo-secure-store` over the AndroidKeyStore. */
  readSecret(key: string): Promise<string | null>;
  writeSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;

  /** Ordinary preferences. Never a token. */
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Which build of the Manager app this is.
 *
 * Kept because the build variant is still a real distinction — a preview build
 * and a production build install side by side and must be tellable apart.
 *
 * It is NOT a publish channel. Those were two different axes with two different
 * names on purpose, and only one of them still exists here: publishing happens
 * in the announcements repository's workflow now, and the channel is a property
 * of what the CLI is asked to build there.
 */
export type AppEnvironment = 'development' | 'preview' | 'production';

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}
