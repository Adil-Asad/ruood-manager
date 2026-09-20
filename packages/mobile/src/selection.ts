/**
 * Choosing several announcements at once, and what "all" means when a filter
 * is on.
 *
 * Pure, and separated from the screen for the usual reason: the arithmetic of
 * a selection is the part that can be quietly wrong — a stale id surviving a
 * filter change, "select all" meaning more than what is on screen — and a
 * screen is not testable while this is.
 *
 * ## The one rule: a selection is what the administrator can SEE
 *
 * The list is filtered and searched. A selection that outlived its filter
 * would let somebody select three announcements under "All", narrow to
 * "Draft", read "1 selected", and delete three — two of which are not on the
 * screen and one of which they had stopped thinking about.
 *
 * So every answer here is computed against the ids currently visible.
 * `chosenFrom` is the only thing the delete acts on, and it cannot contain an
 * id the administrator is not looking at.
 *
 * The raw selection is deliberately NOT pruned when the filter changes, only
 * intersected on the way out: narrowing and then widening again restores what
 * was ticked, which is what somebody who was scrolling for one more
 * announcement expects. What they can delete never grows beyond the screen
 * either way.
 */

/** Where the "select all" control stands, given what is ticked. */
export type SelectAllState = 'none' | 'some' | 'all';

/** Ticks or unticks one id. */
export function toggle(selected: readonly string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((candidate) => candidate !== id)
    : [...selected, id];
}

/**
 * What a delete would actually act on: the ticked ids that are on screen.
 *
 * Ordered by the visible list rather than by the order they were ticked, so a
 * confirmation that names them reads in the order they appear.
 */
export function chosenFrom(selected: readonly string[], visibleIds: readonly string[]): string[] {
  const ticked = new Set(selected);
  return visibleIds.filter((id) => ticked.has(id));
}

/** None of the visible ones, some, or every one. */
export function selectAllState(
  selected: readonly string[],
  visibleIds: readonly string[],
): SelectAllState {
  if (visibleIds.length === 0) return 'none';

  const chosen = chosenFrom(selected, visibleIds).length;
  if (chosen === 0) return 'none';
  return chosen === visibleIds.length ? 'all' : 'some';
}

/**
 * What the "select all" control does next.
 *
 * Everything visible becomes ticked, unless it already is — then the visible
 * ones are unticked and anything ticked outside the filter is left alone. That
 * is the normal semantics of the control, and the asymmetry is deliberate:
 * "select all" from a partial selection should finish the job rather than
 * throw away the ticks already made.
 */
export function toggleAll(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  if (selectAllState(selected, visibleIds) === 'all') {
    const visible = new Set(visibleIds);
    return selected.filter((id) => !visible.has(id));
  }

  return [...new Set([...selected, ...visibleIds])];
}

/**
 * How the count reads.
 *
 * The number is the point, so it leads. "1 selected" rather than "1
 * announcement selected": the row it sits in is a list of announcements and
 * saying so again is noise.
 */
export function selectionLabel(count: number): string {
  return `${count} selected`;
}

/**
 * What the confirmation is titled.
 *
 * Names the number, because that is the fact somebody needs to check before
 * agreeing to something irreversible — and says "announcement" or
 * "announcements" properly, since a dialog that says "Delete 1 announcements?"
 * is one nobody trusts to have counted.
 */
export function deleteConfirmTitle(count: number): string {
  return count === 1 ? 'Delete this announcement?' : `Delete ${count} announcements?`;
}
