/**
 * Home.
 *
 * ## What it says, and what it deliberately does not
 *
 * It answers one question — "what is going out right now" — in four numbers,
 * and then gets out of the way.
 *
 * The screen this replaced was a Dashboard, and it showed the git state, the
 * publication revision, the signing key id and whether `dist/` was stale.
 * Every one of those is true, useful, and meaningless to the person now holding
 * the phone. They are not hidden because they are embarrassing; they are hidden
 * because a number nobody can act on is noise sitting on top of the four that
 * matter.
 *
 * Where a genuine problem exists — an announcement that would not publish — it
 * is surfaced, in the administrator's words, with the way to fix it one tap
 * away. That is the distinction being drawn throughout: **the system's state is
 * hidden, the administrator's problems are not.**
 *
 * ## Subscriptions is here on purpose
 *
 * A "coming soon" tile is usually clutter. This one is the shape of §35 made
 * visible: it is what proves the navigation holds a second module without being
 * redesigned, and it is one `<ModuleTile>` away from being real.
 */

import { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { deriveLifecycleStatus } from '@ruood/announcement-schema';

import { useManager } from '../../src/manager';
import { PRODUCT_NAME } from '../../src/config';
import {
  Body,
  Button,
  Callout,
  Card,
  Heading,
  Hint,
  Loading,
  Screen,
  usePalette,
} from '../../src/components/ui';
import { RADIUS, SPACE, TOUCH_TARGET } from '../../src/theme';

export default function HomeScreen(): React.JSX.Element {
  const { content, viewer, phase, problem, refresh } = useManager();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  /**
   * The four numbers, derived here with the SHARED function.
   *
   * There is no server to count them any more, so this screen and the list
   * screen each derive their own — and they cannot disagree, because
   * `deriveLifecycleStatus` is the one place a status comes from. Storing a
   * count anywhere would be the thing that let them drift.
   */
  const counts = useMemo(() => {
    const now = Date.now();
    const tally = { active: 0, scheduled: 0, draft: 0, inactive: 0 };

    for (const record of content?.records ?? []) {
      const lifecycle = deriveLifecycleStatus(
        { status: record.status, startAt: record.startAt, endAt: record.endAt ?? null },
        now,
      );

      if (lifecycle === 'active') tally.active += 1;
      else if (lifecycle === 'scheduled') tally.scheduled += 1;
      else if (lifecycle === 'draft') tally.draft += 1;
      else if (lifecycle === 'paused') tally.inactive += 1;
    }

    return tally;
  }, [content]);

  /**
   * Files in `content/` that would not parse.
   *
   * The equivalent of the old "would not publish" warning, and it is the honest
   * one to surface here: full validation happens in the publishing workflow,
   * where it can refuse. What this screen can see is a record it could not even
   * read — which is worth saying, because that announcement is invisible.
   */
  const broken = content?.failures ?? [];

  if (phase === 'unreachable') {
    return (
      <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
        <View style={{ gap: SPACE.lg, paddingTop: SPACE.lg }}>
          <Callout kind="warn" title="Can’t reach your announcements">
            {problem ?? 'Check that you are on the same network, then pull down to try again.'}
          </Callout>
          <Button full onPress={() => void onRefresh()}>
            Try again
          </Button>
        </View>
      </Screen>
    );
  }

  if (phase === 'no-access') {
    return (
      <Screen>
        <View style={{ gap: SPACE.lg, paddingTop: SPACE.lg }}>
          <Callout kind="warn" title="You do not have access yet">
            You are signed in to GitHub, but your account cannot change these announcements yet.
            Ask whoever looks after the repository to give you write access, then pull down to
            try again.
          </Callout>
          <Button full onPress={() => void onRefresh()}>
            Try again
          </Button>
        </View>
      </Screen>
    );
  }

  if (!content) return <Loading what="Loading…" />;

  return (
    <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
      <View style={{ gap: SPACE.lg, paddingVertical: SPACE.md }}>
        <View style={{ gap: 2 }}>
          <Heading>{PRODUCT_NAME}</Heading>
          <Body dim>{viewer?.name ? `Welcome back, ${viewer.name}` : 'Welcome back'}</Body>
        </View>

        {broken.length > 0 ? (
          <Callout
            kind="warn"
            title={
              broken.length === 1
                ? 'One announcement could not be read'
                : `${broken.length} announcements could not be read`
            }
          >
            They will not be published until they are fixed. This needs somebody with a computer.
          </Callout>
        ) : null}

        <Card title="Announcements">
          <View style={{ gap: SPACE.xs }}>
            <CountRow label="Active" value={counts.active} tone="ok" />
            <CountRow label="Scheduled" value={counts.scheduled} tone="accent" />
            <CountRow label="Drafts" value={counts.draft} />
            {counts.inactive > 0 ? (
              <CountRow label="Inactive" value={counts.inactive} tone="warn" />
            ) : null}
          </View>

          <View style={{ height: SPACE.md }} />

          <Button kind="primary" full onPress={() => router.push('/(tabs)/announcements')}>
            Manage Announcements
          </Button>
        </Card>

        <ModuleTile
          icon="card-account-details-outline"
          title="Subscriptions"
          detail="Coming soon"
        />

        <ModuleTile icon="account-group-outline" title="Users" detail="Coming soon" />

        <View style={{ alignItems: 'center', paddingTop: SPACE.md }}>
          <Hint>Pull down to refresh</Hint>
        </View>
      </View>
    </Screen>
  );
}

/**
 * One number, with its word.
 *
 * The number is the larger element rather than the label, because the reader is
 * scanning for "is anything live" and not reading a table.
 */
function CountRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'accent' | 'warn';
}): React.JSX.Element {
  const palette = usePalette();

  const colour =
    tone === 'ok'
      ? palette.ok
      : tone === 'accent'
        ? palette.accent
        : tone === 'warn'
          ? palette.warn
          : palette.text;

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        minHeight: 34,
      }}
    >
      <Text style={{ color: palette.textDim, fontSize: 14 }}>{label}</Text>
      <Text
        style={{
          color: value === 0 ? palette.textFaint : colour,
          fontSize: 20,
          fontWeight: '700',
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * A module that is not built yet.
 *
 * Deliberately not pressable and deliberately not styled as disabled-but-real:
 * a tile that looks tappable and does nothing is worse than one that plainly
 * says it is not ready.
 */
function ModuleTile({
  icon,
  title,
  detail,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  detail: string;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.lg,
        padding: SPACE.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        minHeight: TOUCH_TARGET,
        opacity: 0.65,
      }}
    >
      <MaterialCommunityIcons name={icon} size={22} color={palette.textFaint} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.textDim, fontSize: 15, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: palette.textFaint, fontSize: 12 }}>{detail}</Text>
      </View>
    </View>
  );
}
