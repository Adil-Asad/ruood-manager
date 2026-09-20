/**
 * Choosing several announcements, and what a delete would then act on.
 *
 * The screen is not testable; this is, which is the whole reason the
 * arithmetic was pulled out of it. The case that matters most is the one a
 * person would have to notice by hand: a selection made under one filter,
 * still ticked when the filter narrows, and a Delete button that must not act
 * on what the administrator can no longer see.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  chosenFrom,
  deleteConfirmTitle,
  selectAllState,
  selectionLabel,
  toggle,
  toggleAll,
} from '../selection';

/** The list as it is on screen, newest first, as `sortedRecords` leaves it. */
const VISIBLE = ['alpha', 'bravo', 'charlie', 'delta'];

describe('ticking one', () => {
  it('selects one announcement', () => {
    expect(toggle([], 'bravo')).toEqual(['bravo']);
  });

  it('selects several', () => {
    const selected = toggle(toggle(toggle([], 'alpha'), 'charlie'), 'delta');
    expect(chosenFrom(selected, VISIBLE)).toEqual(['alpha', 'charlie', 'delta']);
  });

  it('unticks one that was ticked', () => {
    expect(toggle(['alpha', 'bravo'], 'alpha')).toEqual(['bravo']);
  });
});

describe('select all', () => {
  it('selects every announcement on screen', () => {
    expect(toggleAll([], VISIBLE).sort()).toEqual([...VISIBLE].sort());
    expect(selectAllState(toggleAll([], VISIBLE), VISIBLE)).toBe('all');
  });

  it('finishes a partial selection rather than throwing it away', () => {
    // Tapping "Select All" with two of four ticked means "I want them all",
    // never "start again".
    expect(toggleAll(['bravo'], VISIBLE).sort()).toEqual([...VISIBLE].sort());
  });

  it('deselects everything once everything is selected', () => {
    const all = toggleAll([], VISIBLE);
    expect(chosenFrom(toggleAll(all, VISIBLE), VISIBLE)).toEqual([]);
  });

  it('reports some, not all, after one is unticked again', () => {
    const all = toggleAll([], VISIBLE);
    const minusOne = toggle(all, 'charlie');

    expect(selectAllState(minusOne, VISIBLE)).toBe('some');
    expect(chosenFrom(minusOne, VISIBLE)).toEqual(['alpha', 'bravo', 'delta']);
  });

  it('is "none" when there is nothing on screen to select', () => {
    // A filter that matches nothing. The control is disabled, and this is what
    // makes that the honest answer rather than a cosmetic one.
    expect(selectAllState(['alpha'], [])).toBe('none');
  });
});

describe('a selection never outlives what is on screen', () => {
  it('acts only on the announcements the filter still shows', () => {
    // Three ticked under "All", then narrowed to a filter showing one of them.
    // Deleting must remove that one — not the three that were ticked when the
    // administrator could see them.
    const selected = ['alpha', 'bravo', 'charlie'];
    expect(chosenFrom(selected, ['bravo'])).toEqual(['bravo']);
  });

  it('restores the ticks when the filter widens again', () => {
    // Intersected on the way out rather than pruned on the way in: somebody
    // who searched for one more announcement gets their earlier ticks back.
    const selected = ['alpha', 'bravo', 'charlie'];
    expect(chosenFrom(selected, ['bravo'])).toEqual(['bravo']);
    expect(chosenFrom(selected, VISIBLE)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('drops an id that is no longer in the list at all', () => {
    // What a refresh after somebody else's deletion leaves behind.
    expect(chosenFrom(['alpha', 'ghost'], VISIBLE)).toEqual(['alpha']);
  });

  it('reads back in the order the list shows, not the order they were ticked', () => {
    expect(chosenFrom(['delta', 'alpha'], VISIBLE)).toEqual(['alpha', 'delta']);
  });

  it('select-all only selects what is visible under the filter', () => {
    const narrowed = ['bravo', 'charlie'];
    expect(chosenFrom(toggleAll([], narrowed), VISIBLE)).toEqual(['bravo', 'charlie']);
  });

  it('deselect-all leaves ticks made outside the current filter alone', () => {
    // "Deselect All" is about the screen, like every other answer here.
    const selected = ['alpha', 'bravo', 'charlie'];
    expect(toggleAll(selected, ['bravo', 'charlie'])).toEqual(['alpha']);
  });
});

describe('an empty selection cannot delete anything', () => {
  it('has nothing to act on', () => {
    expect(chosenFrom([], VISIBLE)).toEqual([]);
  });

  it('has nothing to act on when every tick is off screen', () => {
    // The state that would otherwise arm a Delete button over invisible rows.
    expect(chosenFrom(['ghost'], VISIBLE)).toEqual([]);
  });
});

describe('the words an administrator reads', () => {
  it('counts what is selected', () => {
    expect(selectionLabel(0)).toBe('0 selected');
    expect(selectionLabel(3)).toBe('3 selected');
  });

  it('never says "1 announcements"', () => {
    // A dialog that cannot count is one nobody trusts to have counted right.
    expect(deleteConfirmTitle(1)).toBe('Delete this announcement?');
    expect(deleteConfirmTitle(3)).toBe('Delete 3 announcements?');
  });

  it('names the number, because that is what is being agreed to', () => {
    expect(deleteConfirmTitle(12)).toContain('12');
  });
});

describe('the list deletes through the batch, not a loop', () => {
  /** Comments are stripped: the ones explaining this quote what it replaced. */
  const source = readFileSync(
    join(__dirname, '..', '..', 'app', '(tabs)', 'announcements.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('calls deleteRecords once rather than deleteRecord per announcement', () => {
    // A loop would be N commits and N publishing runs — and the second call
    // would be REFUSED, because each write is built on the snapshot the last
    // one read and that parent is stale the moment the first lands.
    expect(source).toMatch(/deleteRecords\(/);
    expect(source).not.toMatch(/deleteRecord\(/);
    expect(source).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*delete/i);
  });

  it('confirms before deleting, through the Manager’s own dialog', () => {
    // The existing confirmation component, not a second one. Cancel is its
    // first button and the destructive action is never where a thumb lands.
    expect(source).toMatch(/<Confirm/);
    expect(source).toMatch(/deleteConfirmTitle\(/);

    // The confirm is what calls the delete. Nothing else may.
    expect(source).toMatch(/onConfirm=\{\(\) => void removeChosen\(\)\}/);
  });

  it('acts on the visible intersection, never on the raw ticks', () => {
    // `chosen`, not `selected`. The distinction is the whole of
    // "a selection never outlives its filter".
    expect(source).toMatch(/deleteRecords\(api, snapshot, chosen, label\)/);
  });

  it('clears the selection when the screen loses focus', () => {
    expect(source).toMatch(/useFocusEffect/);
    expect(source).toMatch(/leaveSelectMode/);
  });
});
