/**
 * Settings.
 *
 * Account, About, Log out. That is the whole of it (§5), and the restraint is
 * the point: the screen this replaced held the pairing token, the server
 * address and the git state, none of which an administrator has any business
 * being shown.
 *
 * Advanced exists and is where all of that went. It appears only in a
 * development or preview build — §37: developer diagnostics may exist, and an
 * ordinary administrator must never encounter them.
 */

import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';

import { useManager } from '../../src/manager';
import {
  announcementsRepository,
  appVariant,
  developerToolsAvailable,
  PRODUCT_NAME,
} from '../../src/config';
import {
  Body,
  Button,
  Card,
  Confirm,
  Hint,
  Screen,
} from '../../src/components/ui';
import { SPACE } from '../../src/theme';

export default function SettingsScreen(): React.JSX.Element {
  const { viewer, signOut } = useManager();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const doSignOut = useCallback(async (): Promise<void> => {
    setBusy(true);
    await signOut();
    setBusy(false);
    setConfirming(false);
  }, [signOut]);

  const repository = announcementsRepository();

  return (
    <Screen>
      <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
        <Card title="Account">
          <View style={{ gap: SPACE.xs }}>
            <Body>{viewer?.name ?? viewer?.login ?? 'Signed in'}</Body>
            {viewer?.login ? <Hint>github.com/{viewer.login}</Hint> : null}
            <Hint>
              Managing {repository.owner}/{repository.repo}
            </Hint>
          </View>

          <View style={{ height: SPACE.md }} />

          <Button full onPress={() => setConfirming(true)}>
            Sign out
          </Button>

          {/* Revoking access on OTHER devices is a GitHub operation, not one
              this app can do honestly: the token belongs to GitHub, and only
              GitHub can revoke it. Offering a button that merely forgot it
              locally would be claiming something untrue about a lost phone. */}
          <View style={{ paddingTop: SPACE.sm }}>
            <Hint>
              Lost a device? Revoke its access in your GitHub settings, under Applications.
            </Hint>
          </View>
        </Card>

        <Card title="About">
          <View style={{ gap: SPACE.xs }}>
            <Body>{PRODUCT_NAME}</Body>
            <Hint>Version 1.0.0</Hint>
            {appVariant() !== 'production' ? (
              // The build badge stays, and only outside production: knowing
              // which build is in your hand is exactly what stops "I tested it
              // on the wrong one".
              <Hint>{appVariant()} build</Hint>
            ) : null}
          </View>
        </Card>

        {developerToolsAvailable() ? (
          <Card title="Advanced">
            <Hint>
              Connection details and diagnostics. Not needed for normal use.
            </Hint>
            <View style={{ height: SPACE.md }} />
            <Button full onPress={() => router.push('/advanced')}>
              Open Advanced
            </Button>
          </Card>
        ) : null}

        <View style={{ height: SPACE.xl }} />
      </View>

      <Confirm
        visible={confirming}
        title="Sign out?"
        confirmLabel="Sign out"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doSignOut()}
      >
        <Body dim>
          You will sign in with GitHub again. Nothing is lost — the announcements live in the
          repository, not on this device.
        </Body>
      </Confirm>
    </Screen>
  );
}
