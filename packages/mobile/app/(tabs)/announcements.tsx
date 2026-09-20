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
 * ## Selecting several, and deleting them together
 *
 * Deleting announcements one at a time is one commit each, and therefore one
 * publishing run each — four of which, clearing out five, publish a manifest
 * nobody asked anyone to see. So the list has a select mode: tick several, and
 * `deleteRecords` removes them and retires every id in a SINGLE commit.
 *
 * The mode is a mode rather than a permanent row of checkboxes because reading
 * the list is what this screen is mostly for, and a checkbox beside every row
 * is a screen that asks a question nobody was asking. Tapping a card navigates
 * exactly as it did; only in select mode does it tick instead.
 *
 * What is ticked and what a delete acts on are not quite the same thing, and
 * `src/selection.ts` is where that is settled: the filters and the search box
 * are still live in select mode, and a selection that outlived its filter
 * would delete announcements that are not on the screen.
 *
 * ## Why the thumbnail is not fetched here
 *
 * A list of twenty announcements would be twenty authenticated image requests
 * on a phone connection, to draw twenty 40-pixel squares. The card shows that
 * an image exists; the detail screen loads it. That is the same reason the
 * desktop Manager's list does not either.
 */

import { useCallback, useMemo, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import {
  deriveLifecycleStatus,
  type AuthoredAnnouncement,
  type LifecycleStatus,
} from '@ruood/announcement-schema';

import { deleteRecords } from '@ruood/announcement-github';

import { sortedRecords, useManager } from '../../src/manager';
import { announcementLabel, deliveryOf, statusOf } from '../../src/language';
import {
  chosenFrom,
  deleteConfirmTitle,
  selectAllState,
  selectionLabel,
  toggle,
  toggleAll,
} from '../../src/selection';
import {
  Badge,
  Body,
  Button,
  Callout,
  Confirm,
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
  const { api, content, phase, problem, refresh, run, notify } = useManager();
  const palette = usePalette();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [refreshing, setRefreshing] = useState(false);

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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
          (entry.record.title ?? '').toLowerCase().includes(needle) ||
          (entry.record.body ?? '').toLowerCase().includes(needle),
      );
  }, [content, query, filter]);

  const visibleIds = useMemo(() => visible.map((entry) => entry.record.id), [visible]);

  // What a delete would act on. Never more than what is on the screen — see
  // `src/selection.ts` for why a selection is not allowed to outlive its filter.
  const chosen = useMemo(() => chosenFrom(selected, visibleIds), [selected, visibleIds]);
  const allState = selectAllState(selected, visibleIds);

  const leaveSelectMode = useCallback((): void => {
    setSelecting(false);
    setSelected([]);
    setConfirming(false);
  }, []);

  /**
   * Leaving the screen ends select mode.
   *
   * A tick is about the list in front of somebody, and coming back to a
   * half-made selection from an announcement they went off to read is a Delete
   * button armed with a decision they have stopped thinking about. Cheap to
   * remake, and the alternative is the expensive kind of surprise.
   */
  useFocusEffect(
    useCallback(
      () => () => {
        leaveSelectMode();
      },
      [leaveSelectMode],
    ),
  );

  const removeChosen = useCallback(async (): Promise<void> => {
    // The guard is not decoration: the confirm button is disabled at zero, and
    // this is what makes that true rather than merely displayed.
    if (!api || chosen.length === 0) return;

    setBusy(true);
    setConfirming(false);

    // ONE commit, one publishing run, one entry in the history — and one
    // `git revert` that undoes exactly what the administrator did. Looping the
    // single delete would also be refused on the second call, since each write
    // is built on the snapshot this one read.
    //
    // One announcement is named, exactly as the detail screen's Delete names
    // it: a `git log` a year later should not be able to tell which screen the
    // deletion was made from. Several are counted, because a commit subject
    // listing twelve titles is one nobody reads.
    const only = chosen.length === 1 ? visible.find((entry) => entry.record.id === chosen[0]) : null;
    const label = only
      ? `Delete ${announcementLabel(only.record)}`
      : `Delete ${chosen.length} announcements`;

    // `deleteRecords` answers `null` only for an empty list, which the guard
    // above has already excluded — so a `null` here is `run` reporting that the
    // write failed, and nothing else.
    const ok = await run((snapshot) => deleteRecords(api, snapshot, chosen, label));

    setBusy(false);

    if (ok !== null) {
      notify(chosen.length === 1 ? 'Deleted.' : `Deleted ${chosen.length} announcements.`);
      leaveSelectMode();
    }
  }, [api, chosen, visible, run, notify, leaveSelectMode]);

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
        {selecting ? (
          <View style={{ gap: SPACE.sm }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: SPACE.sm,
              }}
            >
              {/* The count is the fact somebody checks before tapping
                  something irreversible, so it is the text on the row rather
                  than a subtitle under it. */}
              <Text style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}>
                {selectionLabel(chosen.length)}
              </Text>

              <Pressable
                onPress={() => setSelected(toggleAll(selected, visibleIds))}
                disabled={visibleIds.length === 0}
                accessibilityRole="button"
                accessibilityState={{ disabled: visibleIds.length === 0 }}
                style={{ minHeight: TOUCH_TARGET, justifyContent: 'center', paddingHorizontal: SPACE.sm }}
              >
                <Text
                  style={{
                    color: visibleIds.length === 0 ? palette.textFaint : palette.accent,
                    fontSize: 15,
                    fontWeight: '600',
                  }}
                >
                  {allState === 'all' ? 'Deselect All' : 'Select All'}
                </Text>
              </Pressable>
            </View>

            <Button
              kind="danger"
              full
              // Nothing ticked is nothing to delete. Disabled rather than
              // hidden: a button that vanishes leaves somebody wondering where
              // the one they were about to press went.
              disabled={chosen.length === 0 || busy}
              busy={busy}
              onPress={() => setConfirming(true)}
            >
              {chosen.length === 0 ? 'Delete' : `Delete ${chosen.length}`}
            </Button>

            <Button full onPress={leaveSelectMode}>
              Cancel
            </Button>
          </View>
        ) : (
          <View style={{ gap: SPACE.sm }}>
            <Button kind="primary" full onPress={() => router.push('/announcements/new')}>
              New Announcement
            </Button>

            {content.records.length > 0 ? (
              <Button full onPress={() => setSelecting(true)}>
                Select
              </Button>
            ) : null}
          </View>
        )}

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
                selecting={selecting}
                selected={selected.includes(entry.record.id)}
                onToggle={() => setSelected(toggle(selected, entry.record.id))}
                // A picture chosen on a phone has no `image` object until the
                // publishing build encodes it, so the ORIGINAL is what says
                // there is one. Reading only the record would show an
                // image-only announcement as an empty row.
                hasImage={
                  entry.record.image !== undefined || content.media[entry.record.id] !== undefined
                }
              />
            ))}
          </View>
        )}

        <View style={{ height: SPACE.xl }} />
      </View>

      {/* The Manager's one confirmation component, as every other destructive
          action on this app uses — Cancel first, the destructive button second
          and never the one a thumb lands on by default. */}
      <Confirm
        visible={confirming}
        title={deleteConfirmTitle(chosen.length)}
        confirmLabel={chosen.length === 1 ? 'Delete' : `Delete ${chosen.length}`}
        confirmKind="danger"
        busy={busy}
        confirmDisabled={chosen.length === 0}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void removeChosen()}
      >
        <Body>
          {chosen.length === 1
            ? 'This announcement will be removed. Anyone who has not seen it never will.'
            : `These ${chosen.length} announcements will be removed. Anyone who has not seen ` +
              'them never will.'}
        </Body>
        <Body>This cannot be undone from here.</Body>
      </Confirm>
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
  hasImage,
  selecting,
  selected,
  onToggle,
}: {
  record: AuthoredAnnouncement;
  lifecycle: LifecycleStatus;
  hasImage: boolean;
  /** Whether the list is choosing announcements rather than opening them. */
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const palette = usePalette();
  const delivery = deliveryOf(record.display.surface);

  return (
    <Pressable
      // The whole card is the target in select mode, not just the box. A
      // checkbox on a phone is a small thing to hit repeatedly, and a row that
      // does nothing when tapped beside it reads as broken.
      onPress={
        selecting
          ? onToggle
          : () => router.push(`/announcements/${encodeURIComponent(record.id)}`)
      }
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${announcementLabel(record)}, ${statusOf(lifecycle)}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? palette.surface2 : palette.surface,
        // The ticked state is carried by the border as well as the box, so a
        // selection is legible while scrolling rather than only on inspection.
        borderColor: selecting && selected ? palette.accent : palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.lg,
        padding: SPACE.md,
        gap: SPACE.sm,
        minHeight: TOUCH_TARGET,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md }}>
        {selecting ? (
          <View style={{ justifyContent: 'center', minHeight: 44 }}>
            <MaterialCommunityIcons
              name={selected ? 'checkbox-marked' : 'checkbox-blank-outline'}
              size={24}
              color={selected ? palette.accent : palette.textFaint}
            />
          </View>
        ) : null}

        <Thumbnail hasImage={hasImage} />

        <View style={{ flex: 1, gap: 4 }}>
          {/* An announcement may be a picture and nothing else. The row still
              needs a line to read, so the message stands in for a missing
              title — and an empty second line is not drawn at all, rather than
              left as a gap that reads as content that failed to load. */}
          <Text
            numberOfLines={1}
            style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}
          >
            {announcementLabel({ title: record.title, body: record.body, image: hasImage })}
          </Text>
          {(record.title ?? '').trim().length > 0 && (record.body ?? '').trim().length > 0 ? (
            <Text numberOfLines={2} style={{ color: palette.textDim, fontSize: 13, lineHeight: 18 }}>
              {record.body}
            </Text>
          ) : null}
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
