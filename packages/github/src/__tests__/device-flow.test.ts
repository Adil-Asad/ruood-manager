/**
 * The device flow, against a scripted GitHub.
 *
 * No network and no waiting: the clock is a parameter and the transport is
 * injected, so "the code expired" is a value rather than a fifteen-minute test.
 *
 * What is worth asserting here is not that JSON round-trips. It is that every
 * answer GitHub can give maps to something the login screen can act on —
 * because the ones that matter (`authorization_pending`, `slow_down`) are not
 * errors, and treating them as errors is how a device flow ends up hammering
 * GitHub until it is throttled.
 */

import type { Http, HttpRequestInit } from '@ruood/announcement-client';

import {
  ACCESS_TOKEN_URL,
  DEVICE_CODE_URL,
  DeviceFlowError,
  pollDelayMs,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  type DeviceCode,
} from '../device-flow';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const CLIENT_ID = 'Iv1.0123456789abcdef';

/** A GitHub that answers each call from a queue, and records what it was sent. */
function scripted(
  answers: { status?: number; body: unknown }[],
): Http & { calls: { url: string; init?: HttpRequestInit }[] } {
  const calls: { url: string; init?: HttpRequestInit }[] = [];
  let at = 0;

  return {
    calls,
    async fetch(url: string, init?: HttpRequestInit) {
      calls.push({ url, init });
      const answer = answers[Math.min(at, answers.length - 1)]!;
      at += 1;

      const status = answer.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () =>
          typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
      };
    },
  };
}

const CODE_RESPONSE = {
  device_code: 'device-code-abc',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

function deviceCode(overrides: Partial<DeviceCode> = {}): DeviceCode {
  return {
    deviceCode: 'device-code-abc',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    intervalSeconds: 5,
    expiresAt: NOW + 900_000,
    ...overrides,
  };
}

describe('requesting a code', () => {
  it('asks github.com, not the API host, and sends no secret', async () => {
    const http = scripted([{ body: CODE_RESPONSE }]);
    await requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW });

    const [call] = http.calls;
    expect(call!.url).toBe(DEVICE_CODE_URL);

    // The whole reason the device flow is usable from an APK: there is no
    // client secret to compile in, so there is none to extract.
    expect(call!.init?.body).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`);
    expect(call!.init?.body).not.toMatch(/secret/i);
  });

  it('asks for JSON, because the default is form-encoded', async () => {
    const http = scripted([{ body: CODE_RESPONSE }]);
    await requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW });

    expect(http.calls[0]!.init?.headers?.accept).toBe('application/json');
  });

  it('turns the duration into an absolute instant', async () => {
    const http = scripted([{ body: CODE_RESPONSE }]);
    const code = await requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW });

    // A screen counting down needs a deadline, not a duration it has to
    // subtract from a clock it would then have to read itself.
    expect(code.expiresAt).toBe(NOW + 900_000);
    expect(code.userCode).toBe('WDJB-MJHT');
    expect(code.intervalSeconds).toBe(5);
  });

  it('names the real cause of a 400, which GitHub does not', async () => {
    const http = scripted([{ status: 400, body: { error: 'unauthorized_client' } }]);

    // Practically always means the device flow checkbox is unticked. The body
    // says nothing useful, so the message has to.
    await expect(requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW })).rejects.toThrow(
      /device sign-in/i,
    );

    const failure = await requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW }).catch(
      (error: DeviceFlowError) => error,
    );
    expect((failure as DeviceFlowError).configuration).toBe(true);
  });

  it('says something useful when the reply is not from GitHub', async () => {
    const http = scripted([{ body: '<html>captive portal</html>' }]);

    await expect(requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW })).rejects.toThrow(
      /did not come from GitHub/i,
    );
  });

  it('refuses a reply missing the fields it needs', async () => {
    const http = scripted([{ body: { device_code: 'x' } }]);

    await expect(requestDeviceCode({ clientId: CLIENT_ID, http, now: NOW })).rejects.toThrow(
      DeviceFlowError,
    );
  });
});

describe('polling', () => {
  it('returns the token once it is granted', async () => {
    const http = scripted([{ body: { access_token: 'gho_the_token' } }]);
    const result = await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    expect(result).toMatchObject({ kind: 'token', token: 'gho_the_token' });
  });

  it('reports a NON-expiring token as having no expiry, not as expiring now', () => {
    // With "Expire user authorization tokens" off, GitHub sends no `expires_in`
    // at all. Reading that as zero would sign the administrator out instantly,
    // for ever, with no way to tell why.
    return pollForToken(deviceCode(), {
      clientId: CLIENT_ID,
      http: scripted([{ body: { access_token: 'gho_permanent' } }]),
      now: NOW,
    }).then((result) => {
      expect(result).toMatchObject({ expiresAt: null, refreshToken: null });
    });
  });

  it('carries the refresh token when the app issues expiring ones', async () => {
    const http = scripted([
      { body: { access_token: 'gho_x', refresh_token: 'ghr_y', expires_in: 28800 } },
    ]);

    const result = await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    // Eight hours, which is GitHub's default for a GitHub App. Without the
    // refresh token the administrator would be signed out every morning.
    expect(result).toMatchObject({
      kind: 'token',
      refreshToken: 'ghr_y',
      expiresAt: NOW + 28800 * 1000,
    });
  });

  it('reports waiting as PENDING, not as a failure', async () => {
    const http = scripted([{ body: { error: 'authorization_pending' } }]);
    const result = await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    // By far the commonest answer — it is what GitHub says for every poll
    // before the person finishes typing. Treating it as an error would abort
    // the sign-in the moment it started.
    expect(result).toEqual({ kind: 'pending' });
  });

  it('carries the longer interval back on slow_down', async () => {
    const http = scripted([{ body: { error: 'slow_down', interval: 10 } }]);
    const result = await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    // GitHub is asking for a permanently longer gap. Retrying at the old rate
    // is how a client gets throttled out of the flow entirely.
    expect(result).toEqual({ kind: 'slow-down', intervalSeconds: 10 });
  });

  it('suggests a longer interval even when GitHub names none', async () => {
    const http = scripted([{ body: { error: 'slow_down' } }]);
    const result = await pollForToken(deviceCode({ intervalSeconds: 5 }), {
      clientId: CLIENT_ID,
      http,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'slow-down', intervalSeconds: 10 });
  });

  it.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
  ])('maps %s to %s', async (error, kind) => {
    const http = scripted([{ body: { error } }]);
    const result = await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    expect(result.kind).toBe(kind);
  });

  it('reports an expired code WITHOUT asking GitHub', async () => {
    const http = scripted([{ body: { access_token: 'should-not-be-reached' } }]);

    const result = await pollForToken(deviceCode({ expiresAt: NOW - 1 }), {
      clientId: CLIENT_ID,
      http,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'expired' });
    // Checked before the request, so an expired code cannot be mistaken for a
    // network failure and cannot cost a round trip.
    expect(http.calls).toHaveLength(0);
  });

  it('sends the grant type GitHub requires, exactly', async () => {
    const http = scripted([{ body: { error: 'authorization_pending' } }]);
    await pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW });

    expect(http.calls[0]!.url).toBe(ACCESS_TOKEN_URL);
    expect(http.calls[0]!.init?.body).toContain(
      encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code'),
    );
  });

  it('throws on an error it does not recognise', async () => {
    const http = scripted([{ body: { error: 'something_new' } }]);

    // A code this build has never heard of must not be guessed at. Failing is
    // the honest answer; inventing a meaning is how a flow silently misbehaves.
    await expect(
      pollForToken(deviceCode(), { clientId: CLIENT_ID, http, now: NOW }),
    ).rejects.toThrow(DeviceFlowError);
  });
});

describe('pollDelayMs', () => {
  it('converts seconds to milliseconds', () => {
    // The unit confusion this exists to prevent produces a client that polls
    // a thousand times too fast and is throttled immediately.
    expect(pollDelayMs(5)).toBe(5000);
  });

  it('never returns zero', () => {
    expect(pollDelayMs(0)).toBe(1000);
    expect(pollDelayMs(-1)).toBe(1000);
  });
});

describe('refreshing', () => {
  it('exchanges a refresh token for a new access token', async () => {
    const http = scripted([
      { body: { access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 28800 } },
    ]);

    const issued = await refreshAccessToken('ghr_old', { clientId: CLIENT_ID, http, now: NOW });

    expect(issued).toMatchObject({ token: 'gho_new', refreshToken: 'ghr_new' });
    expect(http.calls[0]!.init?.body).toContain('grant_type=refresh_token');
    expect(http.calls[0]!.init?.body).toContain('refresh_token=ghr_old');
  });

  it('sends no client secret, because there is none', async () => {
    const http = scripted([{ body: { access_token: 'gho_new' } }]);
    await refreshAccessToken('ghr_old', { clientId: CLIENT_ID, http, now: NOW });

    expect(http.calls[0]!.init?.body).not.toMatch(/secret/i);
  });

  it('answers null when the refresh token is spent', async () => {
    const http = scripted([{ body: { error: 'bad_refresh_token' } }]);

    // A refused refresh means the person genuinely has to sign in again, which
    // is a screen and not an error to throw at them.
    await expect(
      refreshAccessToken('ghr_old', { clientId: CLIENT_ID, http, now: NOW }),
    ).resolves.toBeNull();
  });
});
