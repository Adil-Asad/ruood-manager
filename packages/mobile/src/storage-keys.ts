/**
 * The keys the app stores things under.
 *
 * Its own module, depending on nothing, so `__tests__/config.test.ts` can pin
 * them under the node-only jest config — `manager.tsx` imports React and Expo
 * and is out of that reach. The same split as `brand.ts`.
 *
 * There is exactly ONE secret on the device now: the GitHub user token. It
 * authenticates a person to GitHub, and GitHub decides what they may do with
 * the announcements repository.
 *
 * It is not the announcement signing key, which is a secret of the publishing
 * workflow and has never been on a phone. The distinction used to need
 * explaining in three files; now it needs explaining in one, because there is
 * only one key here to confuse it with.
 */

/**
 * The GitHub user token. Keystore only, through `expo-secure-store`.
 *
 * Only `[A-Za-z0-9._-]` — `SecureStore` rejects anything else at runtime, on
 * the single call that stores the credential, which is the worst place to find
 * out.
 */
export const GITHUB_TOKEN_KEY = 'ruood.github.token';

/**
 * The refresh token, when the GitHub App issues expiring ones.
 *
 * Keystore too — it is a credential in its own right: it buys a new access
 * token without anybody signing in. Absent when the app is configured not to
 * expire tokens, which is the simpler and preferred setup.
 */
export const GITHUB_REFRESH_KEY = 'ruood.github.refresh';

/**
 * A developer's client-id override. **Preferences, not the keystore.**
 *
 * A device-flow client id is public — the flow exists because a public client
 * cannot keep a secret — so it is not a credential and does not belong beside
 * one. It exists so a development build can be pointed at a GitHub App without
 * a rebuild; `developerToolsAvailable()` is false in production and the screen
 * that writes it is unreachable there.
 */
export const CLIENT_ID_OVERRIDE_KEY = 'ruood.github.clientIdOverride';
