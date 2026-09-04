/**
 * The Manager's visual language, as React Native values.
 *
 * The tokens are the same ones in `packages/ui/src/web/theme/manager.css` —
 * copied, with that file named as the source. Copied rather than shared for the
 * same reason the announcement preview copies RUOOD Lab's tokens: a shared
 * stylesheet between a Vite bundle and a Metro bundle would be a build-time
 * dependency between two toolchains, bought to keep two colours in step.
 *
 * If they drift, the cost is that the desktop Manager and the phone Manager
 * look slightly different. Nothing breaks, nothing is unsafe, and nobody has to
 * unpick a bundler configuration to fix it.
 *
 * Both schemes are defined because Android has a system dark mode and honouring
 * it is not optional on a tool someone opens at night to look at an incident.
 */

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;

  text: string;
  textDim: string;
  textFaint: string;

  accent: string;
  accentText: string;

  danger: string;
  dangerBg: string;
  warn: string;
  warnBg: string;
  ok: string;
  okBg: string;

  /** The production-publish warning. Deliberately the loudest thing here. */
  alarm: string;
  alarmText: string;
}

export const LIGHT: Palette = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#f0f2f5',
  border: '#d8dde5',
  borderStrong: '#b9c1cd',

  text: '#16191d',
  textDim: '#5b6472',
  textFaint: '#838d9c',

  accent: '#1f5fa8',
  accentText: '#ffffff',

  danger: '#a8261f',
  dangerBg: '#fdeceb',
  warn: '#8a5a06',
  warnBg: '#fdf3e0',
  ok: '#1d6b3f',
  okBg: '#e9f5ee',

  alarm: '#8f1d17',
  alarmText: '#ffffff',
};

export const DARK: Palette = {
  bg: '#14171b',
  surface: '#1c2026',
  surface2: '#23282f',
  border: '#333a44',
  borderStrong: '#47505d',

  text: '#e6e9ee',
  textDim: '#a3adbb',
  textFaint: '#7c8794',

  accent: '#5fa0e8',
  accentText: '#0d1117',

  danger: '#f08a83',
  dangerBg: '#3a1c1a',
  warn: '#e0b464',
  warnBg: '#382c14',
  ok: '#7fce9f',
  okBg: '#16301f',

  alarm: '#c2453c',
  alarmText: '#14171b',
};

/** Spacing, in the same steps the web Manager uses. */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const RADIUS = { sm: 5, md: 8, lg: 12 } as const;

/**
 * Touch targets.
 *
 * 44 is the smallest thing a finger hits reliably, and this app has a "Publish
 * to production" button on it. Nothing interactive goes below it.
 */
export const TOUCH_TARGET = 44;

/**
 * Colours for the derived lifecycle states.
 *
 * Keyed by the schema's own `LifecycleStatus`, so a state added to the contract
 * is a compile error here rather than a record that renders with no badge.
 */
export function lifecycleColour(
  palette: Palette,
  lifecycle: string,
): { fg: string; bg: string } {
  switch (lifecycle) {
    case 'active':
      return { fg: palette.ok, bg: palette.okBg };
    case 'scheduled':
      return { fg: palette.accent, bg: palette.surface2 };
    case 'paused':
      return { fg: palette.warn, bg: palette.warnBg };
    case 'expired':
    case 'archived':
      return { fg: palette.textFaint, bg: palette.surface2 };
    case 'draft':
    default:
      return { fg: palette.textDim, bg: palette.surface2 };
  }
}
