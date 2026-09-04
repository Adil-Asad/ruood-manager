/**
 * The announcement list.
 *
 * Search, filter, and a card per announcement — which is what §5 asks for, and
 * is also just what a list of things somebody owns should look like.
 *
 * ## The filters are the administrator's words, not the schema's
 *
 * "Active", "Passive" and "Inactive" sit beside each other in the filter bar,
 * and they are not the same KIND of thing — the first and third are lifecycle
 * states and the second is a delivery choice. That is deliberate and it is not
 * sloppiness: those are the three questions somebody actually asks about an
 * announcement ("is it live", "does it interrupt", "did I switch it off"), and
 * making the reader learn which axis each one belongs to would be making them
 * learn the data model.
 *
 * The mapping is in one place, `matches` below, so the two axes cannot get
 * confused anywhere else.
 *
 * ## Why the thumbnail is not fetched here
 *
 * A list of twenty announcements would be twenty authenticated image requests
 * on a phone connection, to draw twenty 40-pixel squares. The card shows that
 * an image exists; the detail screen loads it. That is the same reason the
 * desktop Manager's list does not either.
 */

import { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import {
  deriveLifecycleStatus,
  type AuthoredAnnouncement,
  type LifecycleStatus,
} from '@ruood/announcement-schema';

import { sortedRecords, useManager } from '../../src/manager';
import { deliveryOf, statusOf } from '../../src/language';
import {
  Badge,
  Button,
  Callout,
  Empty,
  Input,
  Loading,
  Screen,
  usePalette,
} from '../../src/components/ui';
import { RADIUS, SPACE, TOUCH_TARGET } from '../../src/theme';

/**
 * The filters, in the order somebody would look for them.
 *
 * "All" first because it is the default; then the two states that mean
 * something is going out; then the three that mean it is not.
 */
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'draft', label: 'Draft' },
  { key: 'passive', label: 'Passive' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'expired', label: 'Expired' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

/**
 * Whether a record belongs under a filter.
 *
 * The one place the two axes meet. `passive` is a delivery question and every
 * other key is a lifecycle question, and keeping that distinction here rather
 * than in the filter bar is what stops it leaking into the labels.
 */
function matches(
  record: AuthoredAnnouncement,
  lifecycle: LifecycleStatus,
  filter: FilterKey,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'passive') return deliveryOf(record.display.surface) === 'passive';
  if (filter === 'inactive') return lifecycle === 'paused';
  return lifecycle === filter;
}

/**
 * The lifecycle, derived here rather than read off the record.
 *
 * `scheduled`, `active` and `expired` are computed from the dates and must
 * never be stored — a stored copy disagrees with the dates the moment one is
 * edited. There is no server to derive them any more, so the screen calls the
 * same shared function the build does.
 */
function lifecycleOf(record: AuthoredAnnouncement, now: number): LifecycleStatus {
  return deriveLifecycleStatus(
    { status: record.status, startAt: record.startAt, endAt: record.endAt ?? null },
    now,
  );
}

export default function AnnouncementsScreen(): React.JSX.Element {
  const { content, phase, problem, refresh } = useManager();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const now = Date.now();

    // Sorted most-recently-changed first by `sortedRecords`: somebody looking
    // for an announcement is overwhelmingly looking for the one they just
    // worked on.
    return sortedRecords(content)
      .map((record) => ({ record, lifecycle: lifecycleOf(record, now) }))
      .filter((entry) => matches(entry.record, entry.lifecycle, filter))
      .filter(
        (entry) =>
          !needle ||
          entry.record.title.toLowerCase().includes(needle) ||
          entry.record.body.toLowerCase().includes(needle),
      );
  }, [content, query, filter]);

  if (phase === 'unreachable') {
    return (
      <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
        <View style={{ gap: SPACE.lg, paddingTop: SPACE.lg }}>
          <Callout kind="warn" title="Can’t reach your announcements">
            {problem ?? 'Check that you are on the same network, then try again.'}
          </Callout>
          <Button full onPress={() => void onRefresh()}>
            Try again
          </Button>
        </View>
      </Screen>
    );
  }

  if (!content) return <Loading what="Loading announcements…" />;

  return (
    <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
      <View style={{ gap: SPACE.md, paddingVertical: SPACE.md }}>
        <Button kind="primary" full onPress={() => router.push('/announcements/new')}>
          New Announcement
        </Button>

        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search announcements"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
          {FILTERS.map((entry) => (
            <FilterChip
              key={entry.key}
              label={entry.label}
              selected={filter === entry.key}
              onPress={() => setFilter(entry.key)}
            />
          ))}
        </View>

        {visible.length === 0 ? (
          <Empty>
            {content.records.length === 0
              ? 'No announcements yet. Tap New Announcement to write your first one.'
              : 'Nothing matches that.'}
          </Empty>
        ) : (
          <View style={{ gap: SPACE.sm }}>
            {visible.map((entry) => (
              <AnnouncementCard
                key={entry.record.id}
                record={entry.record}
                lifecycle={entry.lifecycle}
              />
            ))}
          </View>
        )}

        <View style={{ height: SPACE.xl }} />
      </View>
    </Screen>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        backgroundColor: selected ? palette.accent : palette.surface,
        borderColor: selected ? palette.accent : palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACE.md,
        // 36 rather than 44: a chip sits in a row of seven and is not the
        // primary target on the screen. The buttons that change something all
        // clear 44.
        height: 36,
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: selected ? palette.accentText : palette.textDim,
          fontSize: 13,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One announcement, as a card.
 *
 * Title, a preview of the message, its status, and — where it matters — when it
 * is due. Nothing about revisions, ids, priorities or platforms: all real, none
 * of them the reason somebody is scanning this list.
 */
function AnnouncementCard({
  record,
  lifecycle,
}: {
  record: AuthoredAnnouncement;
  lifecycle: LifecycleStatus;
}): React.JSX.Element {
  const palette = usePalette();
  const delivery = deliveryOf(record.display.surface);

  return (
    <Pressable
      onPress={() => router.push(`/announcements/${encodeURIComponent(record.id)}`)}
      accessibilityRole="button"
      accessibilityLabel={`${record.title}, ${statusOf(lifecycle)}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? palette.surface2 : palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.lg,
        padding: SPACE.md,
        gap: SPACE.sm,
        minHeight: TOUCH_TARGET,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md }}>
        <Thumbnail hasImage={record.image !== undefined} />

        <View style={{ flex: 1, gap: 4 }}>
          <Text
            numberOfLines={1}
            style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}
          >
            {record.title}
          </Text>
          <Text numberOfLines={2} style={{ color: palette.textDim, fontSize: 13, lineHeight: 18 }}>
            {record.body}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm }}>
        <Badge lifecycle={lifecycle}>{statusOf(lifecycle)}</Badge>

        {delivery === 'passive' ? <Badge kind="plain">Passive</Badge> : null}

        {lifecycle === 'scheduled' ? (
          <Text style={{ color: palette.textFaint, fontSize: 12 }}>{whenReadable(record.startAt)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * A placeholder rather than the image itself.
 *
 * See the header: twenty authenticated requests to draw twenty small squares is
 * not a trade worth making on a phone connection.
 */
function Thumbnail({ hasImage }: { hasImage: boolean }): React.JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        width: 44,
        height: 44,
        borderRadius: RADIUS.md,
        backgroundColor: palette.surface2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <MaterialCommunityIcons
        name={hasImage ? 'image-outline' : 'text-box-outline'}
        size={20}
        color={palette.textFaint}
      />
    </View>
  );
}

/**
 * A date somebody would say out loud.
 *
 * The device's own locale and timezone, because that is the one the person
 * reading it is standing in — the same choice `src/web/format.ts` makes.
 */
function whenReadable(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';

  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
