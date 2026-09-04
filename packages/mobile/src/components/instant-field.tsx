/**
 * Picking a date and a time, and the one rule about them.
 *
 * A stored announcement date is an absolute instant in UTC. It is **authored**
 * in the operator's local time, because that is what they mean when they say
 * "nine in the morning", and it is **displayed back with its offset**, because
 * that is the only way to see whether the thing you meant is the thing you
 * stored.
 *
 * Android's picker is two separate dialogs — a date, then a time — so the date
 * one chains into the time one and the instant is only written when both have
 * been answered. Cancelling either leaves the previous value alone: a
 * half-answered picker must never write a half-correct instant.
 *
 * `fromLocalInput` and `formatInstant` come from the shared client package, so
 * this control and the desktop editor resolve a wall-clock reading to an
 * instant by exactly the same code.
 */

import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { View } from 'react-native';

import { formatInstant, localOffsetLabel } from '@ruood/announcement-client';

import { Button, Field, Hint, Row } from './ui';
import { SPACE } from '../theme';

export function InstantField({
  label,
  value,
  onChange,
  onClear,
  hint,
  error,
  emptyLabel = 'Not set',
}: {
  label: string;
  value: string | null;
  onChange: (instant: string) => void;
  /** Present only where the field is genuinely optional — `endAt`, and only it. */
  onClear?: () => void;
  hint?: string;
  error?: string;
  emptyLabel?: string;
}): React.JSX.Element {
  const [stage, setStage] = useState<'idle' | 'date' | 'time'>('idle');
  const [draft, setDraft] = useState<Date | null>(null);

  const current = value ? new Date(value) : new Date();
  const valid = !Number.isNaN(current.getTime());

  const onDate = (event: DateTimePickerEvent, picked?: Date): void => {
    if (event.type !== 'set' || !picked) {
      // Dismissed. Nothing is written, and the time step is not opened.
      setStage('idle');
      setDraft(null);
      return;
    }

    setDraft(picked);
    setStage('time');
  };

  const onTime = (event: DateTimePickerEvent, picked?: Date): void => {
    setStage('idle');

    if (event.type !== 'set' || !picked || !draft) {
      setDraft(null);
      return;
    }

    // The date from the first dialog, the clock from the second, resolved in
    // the device's own zone — which is exactly the intent being captured — and
    // stored as a canonical UTC instant.
    const combined = new Date(
      draft.getFullYear(),
      draft.getMonth(),
      draft.getDate(),
      picked.getHours(),
      picked.getMinutes(),
      0,
      0,
    );

    setDraft(null);
    onChange(`${combined.toISOString().slice(0, 19)}Z`);
  };

  return (
    <Field label={`${label} (${localOffsetLabel()})`} hint={hint} error={error}>
      <View style={{ gap: SPACE.sm }}>
        <Row wrap>
          <Button onPress={() => setStage('date')}>
            {value ? formatInstant(value) : emptyLabel}
          </Button>
          {onClear && value ? <Button onPress={onClear}>Clear</Button> : null}
        </Row>

        {value ? null : <Hint>{emptyLabel}</Hint>}
      </View>

      {stage === 'date' ? (
        <DateTimePicker
          mode="date"
          value={valid ? current : new Date()}
          onChange={onDate}
        />
      ) : null}

      {stage === 'time' && draft ? (
        <DateTimePicker mode="time" is24Hour value={draft} onChange={onTime} />
      ) : null}
    </Field>
  );
}
