/**
 * Settings.
 *
 * Account, how many announcements stay published, About, Log out. The
 * restraint is the point: the screen this replaced held the pairing token, the
 * server address and the git state, none of which an administrator has any
 * business being shown.
 *
 * The retention limit is here rather than in Advanced because it is not a
 * diagnostic — it changes what RUOOD users receive, and the person who decides
 * that is the person writing the announcements. It is worded for them: how many
 * announcements people can see, not how many records are in a manifest.
 *
 * Advanced exists and is where all of that went. It appears only in a
 * development or preview build — §37: developer diagnostics may exist, and an
 * ordinary administrator must never encounter them.
 */

import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';

import {
  parseRetentionLimit,
  RETENTION_MAX,
  RETENTION_MIN,
  retentionLimitProblem,
} from '@ruood/announcement-authoring';
import { saveSettings } from '@ruood/announcement-github';

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
  Field,
  Hint,
  Input,
  Screen,
} from '../../src/components/ui';
import { SPACE } from '../../src/theme';

export default function SettingsScreen(): React.JSX.Element {
  const { api, content, run, viewer, signOut } = useManager();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const retained = content?.settings.maxRetained ?? null;

  /**
   * The field, as text.
   *
   * Text rather than a number, because a number field cannot hold "" while
   * somebody is clearing it to type a different value — and a field that
   * snapped back to 20 the moment it was emptied would be unusable.
   */
  const [limit, setLimit] = useState('');

  // Follows the repository whenever it is re-read, so another administrator's
  // change shows up here rather than being silently overwritten by this
  // screen's stale idea of the value.
  useEffect(() => {
    if (retained !== null) setLimit(String(retained));
  }, [retained]);

  const problem = limit.trim().length > 0 ? retentionLimitProblem(limit) : null;
  const parsed = parseRetentionLimit(limit);
  const changed = parsed !== null && parsed !== retained;

  const saveLimit = useCallback(async (): Promise<void> => {
    if (!api || !content || parsed === null) return;

    setBusy(true);
    await run(
      (snapshot) =>
        saveSettings(api, snapshot, { maxRetained: parsed }, `Keep the newest ${parsed}`),
      `RUOOD users will see the newest ${parsed} announcements.`,
    );
    setBusy(false);
  }, [api, content, parsed, run]);

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

        {/* Only once the repository has been read. Showing the field with a
            guess in it would let somebody "save" a number they never chose. */}
        {content ? (
          <Card title="Announcements people see">
            <Field
              label="Maximum retained announcements"
              hint={
                'RUOOD users receive only this many announcements — the newest ones. Older ' +
                'ones stay here in your history, nothing is deleted, and raising this sends ' +
                `them again. Between ${RETENTION_MIN} and ${RETENTION_MAX}.`
              }
              {...(problem ? { error: problem } : {})}
            >
              <Input
                value={limit}
                onChangeText={setLimit}
                keyboardType="number-pad"
                maxLength={3}
                editable={!busy}
                invalid={problem !== null}
                accessibilityLabel="Maximum retained announcements"
              />
            </Field>

            <Button full busy={busy} disabled={!changed} onPress={() => void saveLimit()}>
              Save
            </Button>

            {/* "Shortly" rather than "now", for the same reason publishing says
                it: the change takes effect on the next publish, which is a
                minute or two away and not something to claim has happened. */}
            <Hint>This takes effect the next time an announcement is published.</Hint>
          </Card>
        ) : null}

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
