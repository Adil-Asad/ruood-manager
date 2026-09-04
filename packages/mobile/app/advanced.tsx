/**
 * Advanced — the developer's screen, and nobody else's.
 *
 * ## What is left of it
 *
 * It used to hold a server address to override and a pairing line to paste,
 * because the app talked to a Manager server on somebody's PC and both could go
 * wrong. Neither exists now: the app talks to GitHub, the repository is
 * compiled in, and the credential comes from a device-flow sign-in.
 *
 * So what remains is genuinely only diagnostics — the values a developer would
 * otherwise have to guess at when the app will not connect. There is nothing
 * here to change, which is the right amount of configuration for a screen that
 * an administrator should never see.
 *
 * It is reachable only when `developerToolsAvailable()` is true, which a
 * production build makes false.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { router } from 'expo-router';

import { useManager } from '../src/manager';
import {
  announcementsRepository,
  appVariant,
  compiledClientId,
  PRODUCT_NAME,
} from '../src/config';
import { Body, Button, Callout, Card, Field, Hint, Input, Screen } from '../src/components/ui';
import { SPACE } from '../src/theme';

export default function AdvancedScreen(): React.JSX.Element {
  const { api, content, viewer, phase, problem, clientId, setClientId } = useManager();

  const [head, setHead] = useState<string | null>(null);

  // The commit the app is looking at. The single most useful diagnostic when
  // "my change did not appear" — it says whether the phone is behind.
  useEffect(() => {
    setHead(content?.commit ?? null);
  }, [content?.commit]);

  const repository = announcementsRepository();
  const [draftClientId, setDraftClientId] = useState(clientId);
  const [saving, setSaving] = useState(false);

  return (
    <Screen>
      <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
        <Callout kind="warn" title="Developer diagnostics">
          Nothing here is needed for normal use, and there is nothing to change. It is hidden in a
          production build.
        </Callout>

        <Card title="This build">
          <View style={{ gap: SPACE.xs }}>
            <Body mono>{`app         ${PRODUCT_NAME}`}</Body>
            <Body mono>{`variant     ${appVariant()}`}</Body>
            {/* Truncated because it is long and its tail says nothing. It is
                not a secret — a device-flow client has none — but a screenshot
                of a diagnostics screen should still not be a wall of it. */}
            <Body mono>{`client id   ${clientId ? `${clientId.slice(0, 12)}…` : '(not set)'}`}</Body>
            <Body mono>{`compiled in ${compiledClientId() ? 'yes' : 'no'}`}</Body>
          </View>
        </Card>

        <Card title="GitHub App">
          <Field
            label="Client ID"
            hint={
              compiledClientId()
                ? `Compiled in: ${compiledClientId()}. An override replaces it on this device only.`
                : 'This build had no GITHUB_CLIENT_ID, so one must be set here to sign in.'
            }
          >
            <Input
              value={draftClientId}
              onChangeText={setDraftClientId}
              placeholder="Iv23li..."
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
            />
          </Field>

          <Hint>
            A device-flow client id is public — the flow exists because a public client cannot
            keep a secret — so this is not a credential. It is stored in preferences, not the
            keystore, and this whole screen is absent from a production build.
          </Hint>

          <View style={{ height: SPACE.md }} />

          <Button
            kind="primary"
            full
            busy={saving}
            onPress={() => {
              setSaving(true);
              void setClientId(draftClientId).finally(() => setSaving(false));
            }}
          >
            Use this client ID
          </Button>

          <View style={{ paddingTop: SPACE.sm }}>
            <Hint>Changing it signs you out: the token was issued by a different app.</Hint>
          </View>
        </Card>

        <Card title="Announcements repository">
          <View style={{ gap: SPACE.xs }}>
            <Body mono>{`owner       ${repository.owner || '(not set)'}`}</Body>
            <Body mono>{`repo        ${repository.repo || '(not set)'}`}</Body>
            <Body mono>{`branch      ${repository.branch}`}</Body>
            <Body mono>{`commit      ${head ? head.slice(0, 10) : '(not loaded)'}`}</Body>
            <Body mono>{`records     ${content?.records.length ?? 0}`}</Body>
            <Body mono>{`retired ids ${content?.retiredIds.length ?? 0}`}</Body>
          </View>

          {content && content.failures.length > 0 ? (
            <View style={{ paddingTop: SPACE.md, gap: SPACE.xs }}>
              <Hint>Files that would not parse:</Hint>
              {content.failures.map((failure) => (
                <Body key={failure.path} mono>
                  {`${failure.path}: ${failure.error}`}
                </Body>
              ))}
            </View>
          ) : null}
        </Card>

        <Card title="Image editor">
          <Hint>
            Exercises the picker, the four formats, the gestures and the optimiser without a
            sign-in and without writing anything.
          </Hint>
          <View style={{ height: SPACE.md }} />
          <Button full onPress={() => router.push('/image-editor-preview')}>
            Open the image editor
          </Button>
        </Card>

        <Card title="Session">
          <View style={{ gap: SPACE.xs }}>
            <Body mono>{`phase       ${phase}`}</Body>
            <Body mono>{`signed in   ${viewer?.login ?? '(nobody)'}`}</Body>
            <Body mono>{`client      ${api ? 'ready' : 'none'}`}</Body>
            {problem ? <Body mono>{`problem     ${problem}`}</Body> : null}
          </View>

          <View style={{ height: SPACE.md }} />

          <Hint>
            The announcement signing key is not on this device and never has been. Signing happens
            in the publishing workflow, from a repository secret that this app cannot read and
            cannot change.
          </Hint>
        </Card>

        <View style={{ height: SPACE.xl }} />
      </View>
    </Screen>
  );
}
