/**
 * Signing in with GitHub.
 *
 * ## What the administrator does
 *
 * Taps "Sign in with GitHub", reads an eight-character code, opens
 * github.com/login/device on whatever device is nearest, types the code, and
 * approves. The app is polling and lets them in when GitHub says so.
 *
 * That is the entire flow. There is no address, no port, no token, no QR code
 * and no terminal — and, unlike everything that came before it, **no state on
 * this device that has to be recovered if the phone is lost.** Reinstalling the
 * app and doing this again is the whole of recovery.
 *
 * ## Why the code is shown before the browser is opened
 *
 * GitHub's verification page asks for the code, and a person who has already
 * left the app cannot read it. So it is displayed first, large, and the button
 * to open GitHub sits underneath it — and it stays on screen while they are
 * away, because they will come back to check they typed it right.
 *
 * ## Polling is the app's job, not the library's
 *
 * `pollForToken` performs exactly one poll. The waiting lives here because it
 * is the screen that has to stay responsive, show a countdown, honour a
 * `slow_down` permanently, and stop when somebody navigates away. A loop inside
 * the library would own all of that and expose none of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import {
  DeviceFlowError,
  pollDelayMs,
  pollForToken,
  requestDeviceCode,
  type DeviceCode,
} from '@ruood/announcement-github';

import { useManager } from '../src/manager';
import { announcementsRepository, developerToolsAvailable, PRODUCT_NAME } from '../src/config';
import { humanise } from '../src/language';
import { Body, Button, Callout, Card, Heading, Hint, Screen, usePalette } from '../src/components/ui';
import { RADIUS, SPACE } from '../src/theme';
import { router } from 'expo-router';

const http = { fetch: (url: string, init?: unknown) => fetch(url, init as RequestInit) };

export default function LoginScreen(): React.JSX.Element {
  const { signIn, phase, problem, clientId } = useManager();
  const palette = usePalette();

  const [code, setCode] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Set when the screen goes away, so an in-flight poll loop stops rather than
  // calling `setState` on a component that is gone.
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  useEffect(() => {
    if (problem && phase === 'signed-out') setError(problem);
  }, [problem, phase]);

  /**
   * Polls until GitHub answers, the code expires, or the screen goes away.
   *
   * `slow-down` lengthens the interval permanently — GitHub is asking for a
   * longer gap, and going back to the old rate is how a client is throttled out
   * of the flow entirely.
   */
  const awaitApproval = useCallback(
    async (issued: DeviceCode): Promise<void> => {
      let interval = issued.intervalSeconds;

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs(interval)));
        if (cancelled.current) return;

        const result = await pollForToken(issued, { clientId, http, now: Date.now() });

        if (cancelled.current) return;

        switch (result.kind) {
          case 'token':
            // The whole issued token, not just the string: it may carry a
            // refresh token, and dropping that would sign the administrator out
            // every eight hours.
            await signIn(result);
            return;
          case 'pending':
            break;
          case 'slow-down':
            interval = result.intervalSeconds;
            break;
          case 'denied':
            setCode(null);
            setError('That sign-in was declined. You can start again.');
            return;
          case 'expired':
            setCode(null);
            setError('That code expired. Tap to get a new one.');
            return;
        }
      }
    },
    [signIn, clientId],
  );

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      const issued = await requestDeviceCode({ clientId, http, now: Date.now() });
      setCode(issued);
      void awaitApproval(issued);
    } catch (failure) {
      setError(
        failure instanceof DeviceFlowError ? failure.message : humanise(failure),
      );
    } finally {
      setBusy(false);
    }
  }, [awaitApproval, clientId]);

  const repository = announcementsRepository();

  if (!clientId || !repository.owner) {
    // A build nobody finished configuring. A developer's problem, and it gets a
    // developer's sentence rather than a sign-in that could never succeed.
    //
    // The way OUT of this state has to be on this screen. Without it a
    // development build that was assembled without a client id is a dead end:
    // Advanced is where one is set, and Advanced was unreachable because this
    // branch returned before the button that opens it.
    return (
      <Screen topInset>
        <View style={{ paddingTop: SPACE.xl * 2, gap: SPACE.lg }}>
          <Heading>{PRODUCT_NAME}</Heading>

          <Callout kind="warn" title="This app has not been set up">
            {repository.owner
              ? 'It was built without a GitHub client id.'
              : 'It was built without a GitHub client id or an announcements repository.'}
          </Callout>

          {developerToolsAvailable() ? (
            <Card>
              <Body dim>
                This is a {'development'} build, so you can set a client id here instead of
                rebuilding.
              </Body>
              <View style={{ height: SPACE.md }} />
              <Button kind="primary" full onPress={() => router.push('/advanced')}>
                Open Advanced
              </Button>
            </Card>
          ) : (
            <Hint>
              Rebuild with GITHUB_CLIENT_ID, ANNOUNCEMENTS_OWNER and ANNOUNCEMENTS_REPO.
            </Hint>
          )}
        </View>
      </Screen>
    );
  }

  return (
    <Screen topInset>
      <View style={{ paddingTop: SPACE.xl * 2, gap: SPACE.lg }}>
        <View style={{ alignItems: 'center', gap: SPACE.xs }}>
          <Heading>{PRODUCT_NAME}</Heading>
          <Body dim>Sign in to manage RUOOD announcements</Body>
        </View>

        {error ? (
          <Callout kind="error" title="Could not sign in">
            {error}
          </Callout>
        ) : null}

        {code ? (
          <Card title="Your sign-in code">
            <View style={{ alignItems: 'center', gap: SPACE.md }}>
              {/* Large, spaced and tappable-to-copy. Somebody is going to read
                  this aloud or type it on another device, and eight characters
                  in body text is not something you can do either with. */}
              <Pressable
                onPress={() => {
                  void Clipboard.setStringAsync(code.userCode);
                  setCopied(true);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Sign-in code ${code.userCode.split('').join(' ')}. Tap to copy.`}
                style={{
                  backgroundColor: palette.surface2,
                  borderColor: palette.border,
                  borderWidth: 1,
                  borderRadius: RADIUS.lg,
                  paddingVertical: SPACE.lg,
                  paddingHorizontal: SPACE.xl,
                }}
              >
                <Text
                  style={{
                    color: palette.text,
                    fontSize: 30,
                    fontWeight: '700',
                    letterSpacing: 4,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {code.userCode}
                </Text>
              </Pressable>

              <Hint>{copied ? 'Copied' : 'Tap the code to copy it'}</Hint>

              <Body dim>
                Open GitHub, type this code, and approve. This screen will continue on its own.
              </Body>

              <Button
                kind="primary"
                full
                onPress={() => void Linking.openURL(code.verificationUri)}
              >
                Open GitHub
              </Button>

              <Hint>Waiting for you to approve…</Hint>
            </View>
          </Card>
        ) : (
          <Card>
            <Body dim>
              You will need a GitHub account with access to the announcements. Signing in takes
              about a minute and only has to be done once on this device.
            </Body>

            <View style={{ height: SPACE.md }} />

            <Button kind="primary" full busy={busy} onPress={() => void start()}>
              {busy ? 'Starting…' : 'Sign in with GitHub'}
            </Button>
          </Card>
        )}

        <View style={{ alignItems: 'center', gap: SPACE.xs }}>
          <Hint>
            Managing {repository.owner}/{repository.repo}
          </Hint>
          <Hint>Lost your phone? Install the app again and sign in — nothing else is needed.</Hint>
        </View>

        {developerToolsAvailable() ? (
          <View style={{ alignItems: 'center', paddingTop: SPACE.md }}>
            <Button onPress={() => router.push('/advanced')}>Advanced</Button>
          </View>
        ) : null}

        <View style={{ height: SPACE.xl * 2 }} />
      </View>
    </Screen>
  );
}
