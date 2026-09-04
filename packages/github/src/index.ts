/**
 * @ruood/announcement-github
 *
 * How the Manager app reaches the announcements repository: device-flow
 * sign-in, and reading and writing `content/` through GitHub's Git Data API.
 *
 * ## What replaced what
 *
 * This package is what the Manager server used to be. The server existed
 * because a phone cannot hold a git checkout, cannot run `sharp`, and must
 * never hold the signing key — so something on the operator's machine did all
 * three and the phone asked it to.
 *
 * Only one of those three was ever really about the phone. GitHub holds the
 * checkout; a workflow runs `sharp`; and the signing key is a repository
 * secret that neither the phone nor the operator's machine needs to see. What
 * is left for the phone is writing `content/`, which is exactly what an
 * authenticated GitHub client can do.
 *
 * The consequences are the point:
 *
 *   - **No single-device dependency.** Nothing waits on a particular machine
 *     being awake.
 *   - **Recovery is reinstalling.** A lost phone is replaced by installing the
 *     app and signing in to GitHub again. There is no key to restore, no
 *     pairing to redo, and no state on the old device worth recovering.
 *   - **Revocation is GitHub's.** Removing somebody's write access, or
 *     revoking one authorisation, is a thing the platform already does
 *     properly — with an audit trail this project would otherwise have had to
 *     build.
 *
 * ## The boundary this package must not cross
 *
 * It addresses the announcements repository by `{owner, repo, branch}` at
 * runtime and contains no announcement content of its own. The Manager
 * repository builds the app; the announcements repository holds the
 * announcements; this is the client between them. Vendoring one into the other
 * — a submodule, a checked-in copy, a hard-coded default — would collapse a
 * separation that exists so either can be replaced without the other.
 *
 * ## Platform-neutral, like everything the phone imports
 *
 * The transport is injected (`Http` from `@ruood/announcement-client`) and
 * there is no `fs`, no `Buffer` and no clock. `__tests__/isolation.test.ts`
 * sweeps for all of it.
 */

export * from './device-flow';
export * from './repository';
export * from './content';
