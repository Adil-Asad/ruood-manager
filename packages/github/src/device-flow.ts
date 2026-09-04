/**
 * Signing in to GitHub from a phone, with nothing to paste.
 *
 * ## Why the device flow and not anything else
 *
 * The administrator has to end up holding a GitHub credential, and there are
 * only a few honest ways to get one onto a phone:
 *
 *   a pasted token      what the product explicitly rejects. A fine-grained
 *                       PAT is a 90-character string somebody has to generate
 *                       on a laptop and transfer to a phone, and the transfer
 *                       is the insecure part.
 *   a redirect flow     needs a registered redirect URI and a browser round
 *                       trip back into the app. Workable, and it means a
 *                       custom scheme that other apps can claim.
 *   the DEVICE flow     the app shows an eight-character code, the person
 *                       types it at github.com/login/device on whatever device
 *                       is nearest, and the app is handed a token.
 *
 * The device flow is the one designed for this shape of client, and it is the
 * only one that needs **no client secret** — which matters absolutely here,
 * because anything compiled into an APK is readable by anyone who unzips it.
 * There is no secret to leak because there is no secret.
 *
 * ## The cost, stated
 *
 * GitHub's own guidance is that the device flow has no redirect URI, so an
 * attacker can start a device flow of their own and phish somebody into
 * approving it. The defence is entirely in the words on screen: the
 * verification page names the application asking, and this app shows the same
 * name beside the code. That is why the screen says who is asking rather than
 * just printing a code.
 *
 * ## What it must be pointed at
 *
 * A **GitHub App** is preferred over an OAuth App. A GitHub App's user token is
 * limited to the repositories the app is installed on and to the permissions it
 * declares — `Contents: write` on the announcements repository, and crucially
 * NOT `Workflows`. An OAuth App token carries a coarse scope (`public_repo`
 * reaches every public repository the person can write to), which works and
 * grants far more than this app needs.
 *
 * Either way, the "Device flow" checkbox has to be ticked on the app's
 * settings page. Until it is, GitHub answers these endpoints with 400 and a
 * body that does not explain why — hence `deviceFlowDisabled` below.
 *
 * Everything here takes its transport and its clock as parameters, so the whole
 * flow is testable without a network and without waiting.
 */

import { type Http } from '@ruood/announcement-client';

/** Where the flow happens. Not the API host — these two live on github.com. */
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** The grant type string, which is long and must be exact. */
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    /** True when the app itself is misconfigured rather than the person wrong. */
    readonly configuration = false,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceCode {
  /** Sent back when polling. Never shown to anybody. */
  deviceCode: string;
  /** The eight characters the administrator types. Shown large. */
  userCode: string;
  /** Where they type it — `https://github.com/login/device`. */
  verificationUri: string;
  /** Seconds between polls. GitHub refuses a faster caller. */
  intervalSeconds: number;
  /** Absolute instant the code stops working. */
  expiresAt: number;
}

export interface DeviceFlowOptions {
  /** The OAuth App or GitHub App client id. Public, and compiled in. */
  clientId: string;
  http: Http;
  /** Injected, like everywhere else in this project. */
  now: number;
  /**
   * Only for an OAuth App. A GitHub App ignores it entirely — its permissions
   * come from the installation, which is the reason to prefer one.
   */
  scope?: string;
}

/**
 * Asks GitHub for a code to show.
 *
 * The response is deliberately re-shaped rather than passed through: GitHub's
 * field names are snake_case and its expiry is a duration, and a screen that
 * had to know both would be a screen coupled to the wire format.
 */
export async function requestDeviceCode(options: DeviceFlowOptions): Promise<DeviceCode> {
  const body = formBody({
    client_id: options.clientId,
    ...(options.scope ? { scope: options.scope } : {}),
  });

  const response = await options.http.fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await parse(response.text());

  // 400 here almost always means one thing, and the body does not say it.
  if (!response.ok || payload.error) {
    if (response.status === 400 || payload.error === 'unauthorized_client') {
      throw new DeviceFlowError(
        'This app is not set up for device sign-in yet. Enable the device flow on the ' +
          'GitHub App and try again.',
        true,
      );
    }

    throw new DeviceFlowError(describe(payload.error) ?? 'GitHub would not start the sign-in.');
  }

  const deviceCode = string(payload.device_code);
  const userCode = string(payload.user_code);
  const verificationUri = string(payload.verification_uri);

  if (!deviceCode || !userCode || !verificationUri) {
    throw new DeviceFlowError('GitHub answered the sign-in request with something unusable.');
  }

  const expiresIn = number(payload.expires_in) ?? 900;
  // GitHub's documented default is 5 seconds, and it enforces it: polling
  // faster earns a `slow_down` rather than a token.
  const intervalSeconds = number(payload.interval) ?? 5;

  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds,
    expiresAt: options.now + expiresIn * 1000,
  };
}

/**
 * One poll.
 *
 * Deliberately ONE, rather than a loop with its own timer. The caller owns the
 * waiting, because the caller is a screen that has to stay responsive, show a
 * countdown, and stop when somebody navigates away. A loop in here would own
 * all of that and expose none of it.
 *
 * `slow-down` is a real answer rather than an error: GitHub asks for a longer
 * interval and the caller must lengthen it permanently, not retry immediately.
 */
/**
 * A token, and the refresh token that comes with it when the app opts into
 * expiring ones.
 *
 * GitHub Apps can be configured either way. With "Expire user authorization
 * tokens" ON — the default for a new app — a user token lasts eight hours and
 * arrives with a refresh token good for six months. With it OFF, the token does
 * not expire and there is no refresh token at all.
 *
 * The app supports BOTH rather than assuming, because the difference is a
 * checkbox on somebody else's settings page and the symptom of getting it wrong
 * is an administrator being signed out mid-morning, every morning, with no
 * explanation.
 */
export interface IssuedToken {
  token: string;
  /** `ghr_…`, present only when the app issues expiring tokens. */
  refreshToken: string | null;
  /** When the token stops working, or `null` when it does not expire. */
  expiresAt: number | null;
}

export type PollResult =
  | ({ kind: 'token' } & IssuedToken)
  | { kind: 'pending' }
  | { kind: 'slow-down'; intervalSeconds: number }
  | { kind: 'expired' }
  | { kind: 'denied' };

export async function pollForToken(
  code: DeviceCode,
  options: DeviceFlowOptions,
): Promise<PollResult> {
  // Checked before the request, so an expired code costs nothing and cannot be
  // mistaken for a network failure.
  if (options.now >= code.expiresAt) return { kind: 'expired' };

  const body = formBody({
    client_id: options.clientId,
    device_code: code.deviceCode,
    grant_type: DEVICE_GRANT,
  });

  const response = await options.http.fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await parse(response.text());

  const token = string(payload.access_token);
  if (token) return { kind: 'token', ...issued(payload, options.now) };

  switch (payload.error) {
    case 'authorization_pending':
      // The person has not finished typing the code yet. By far the commonest
      // answer, and not a failure.
      return { kind: 'pending' };
    case 'slow_down':
      return { kind: 'slow-down', intervalSeconds: number(payload.interval) ?? code.intervalSeconds + 5 };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied' };
    default:
      throw new DeviceFlowError(
        describe(payload.error) ?? 'GitHub would not finish the sign-in.',
        payload.error === 'unauthorized_client',
      );
  }
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * Only ever needed when the GitHub App issues expiring tokens. The caller tries
 * this before signing anybody out, because "your session expired" after eight
 * hours is a worse answer than silently continuing to work.
 *
 * A refused refresh is a value rather than a throw: an expired or revoked
 * refresh token means the person genuinely has to sign in again, which is a
 * screen and not an error.
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: DeviceFlowOptions,
): Promise<IssuedToken | null> {
  const response = await options.http.fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: formBody({
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const payload = await parse(response.text());
  const token = string(payload.access_token);

  return token ? issued(payload, options.now) : null;
}

/** The token half of a response, with its expiry resolved to an instant. */
function issued(payload: Payload, now: number): IssuedToken {
  const expiresIn = number(payload.expires_in);

  return {
    token: string(payload.access_token) ?? '',
    refreshToken: string(payload.refresh_token),
    // Absent means the app does not expire tokens at all, which is a different
    // thing from "expires now" and must not be conflated with it.
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
  };
}

/**
 * The wait before the next poll, in milliseconds.
 *
 * Exported so the screen does not have to know that GitHub's `interval` is in
 * seconds — the kind of unit confusion that produces a client GitHub throttles.
 */
export function pollDelayMs(intervalSeconds: number): number {
  return Math.max(intervalSeconds, 1) * 1000;
}

// ---------------------------------------------------------------------------

/**
 * A form-encoded body, built by hand.
 *
 * `URLSearchParams` exists in every runtime this package targets, but it is
 * typed by `DOM` and by `@types/node` — and this package compiles with neither,
 * deliberately, so that a `document` reference cannot slip in behind them. The
 * same reasoning that gave `client/src/http.ts` its narrow `runtime` view.
 *
 * Three known fields with no exotic characters is not a case worth reaching for
 * a global to solve.
 */
function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

type Payload = Record<string, unknown>;

async function parse(text: Promise<string>): Promise<Payload> {
  const body = await text;

  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Payload) : {};
  } catch {
    // GitHub answers form-encoded unless `Accept: application/json` is sent,
    // which it is. A body that is not JSON therefore means something else
    // answered — a captive portal, a proxy — and saying so beats a parse error.
    throw new DeviceFlowError(
      'The reply did not come from GitHub. Check the network and try again.',
    );
  }
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** GitHub's error codes, as sentences. Unknown codes get no invented meaning. */
function describe(error: unknown): string | null {
  switch (error) {
    case 'unauthorized_client':
      return 'This app is not set up for device sign-in yet.';
    case 'incorrect_client_credentials':
      return 'This app was built with the wrong GitHub client id.';
    case 'incorrect_device_code':
      return 'That sign-in has expired. Start again.';
    case 'device_flow_disabled':
      return 'Device sign-in is switched off for this app.';
    default:
      return null;
  }
}
