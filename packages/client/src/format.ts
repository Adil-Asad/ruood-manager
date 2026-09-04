/**
 * Dates, and the one rule about them.
 *
 * A stored announcement date is an absolute instant in UTC. It is *authored* in
 * the operator's local time, because that is what they mean when they say "nine
 * in the morning", and it is *displayed back with its offset*, because that is
 * the only way to see whether the thing you meant is the thing you stored.
 *
 * "September 1, 9:00 AM" is not a fact a device in another timezone can act on.
 * A naive string is the classic way a scheduled thing fires eight hours early
 * for half the users, which is why `parseInstant` in the schema refuses one
 * outright — everything here exists to make sure the Manager never offers it
 * the chance.
 *
 * ## Intl, and why it is reached for defensively
 *
 * `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` are present in every
 * browser and in the Hermes builds Expo ships. They are still guarded, because
 * the cost of being wrong is asymmetric: a missing formatter throws during
 * render, and a date that reads a little plainer is a far better outcome than
 * an announcement editor that will not open. The fallbacks produce the same
 * instant, spelled less prettily.
 */

/** `YYYY-MM-DDTHH:mm` in local time, for a date picker. */
export function toLocalInput(instant: string | null | undefined): string {
  if (!instant) return '';

  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * A local wall-clock reading resolved to the instant it names here.
 *
 * `new Date('2026-09-01T09:00')` — no offset — is interpreted in the browser's
 * own zone, which is exactly the intent being captured. The result is stored in
 * canonical UTC, so the ambiguity ends at this function.
 */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return `${date.toISOString().slice(0, 19)}Z`;
}

/** `UTC+05:00` for the browser's current zone. */
export function localOffsetLabel(at: Date = new Date()): string {
  // getTimezoneOffset is minutes to ADD to local to reach UTC, so its sign is
  // the opposite of the one written in an ISO offset.
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** Built once, and never allowed to take a screen down with it. */
const DATE_TIME: { format(date: Date): string } = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return {
      format: (date: Date): string =>
        `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
  }
})();

/** An instant in local time, with the offset it is being shown in. */
export function formatInstant(instant: string | null | undefined): string {
  if (!instant) return '—';

  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return `${instant} (unreadable)`;

  return `${DATE_TIME.format(date)} ${localOffsetLabel(date)}`;
}

/** Just the date, for a dense table. */
export function formatDate(instant: string | null | undefined): string {
  if (!instant) return '—';
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? '?' : instant.slice(0, 10);
}

export function formatWindow(startAt: string, endAt: string | null): string {
  return endAt ? `${formatDate(startAt)} → ${formatDate(endAt)}` : `${formatDate(startAt)} → never`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatSigned(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/** "in 3 days" / "6 hours ago", for a schedule the operator is scanning. */
export function formatRelative(instant: string | null | undefined, now: number): string {
  if (!instant) return '';

  const at = new Date(instant).getTime();
  if (Number.isNaN(at)) return '';

  const seconds = Math.round((at - now) / 1000);
  const absolute = Math.abs(seconds);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];

  let formatter: { format(value: number, unit: Intl.RelativeTimeFormatUnit): string };
  try {
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  } catch {
    formatter = {
      format: (value, unit) =>
        value < 0
          ? `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'} ago`
          : `in ${value} ${unit}${value === 1 ? '' : 's'}`,
    };
  }

  for (const [unit, size] of units) {
    if (absolute >= size) return formatter.format(Math.round(seconds / size), unit);
  }

  return formatter.format(seconds, 'second');
}
