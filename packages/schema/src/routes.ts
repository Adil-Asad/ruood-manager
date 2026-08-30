/**
 * The closed set of destinations an announcement's action may reach.
 *
 * This is the single most important security decision in the contract, so it
 * gets its own file. An action does NOT carry a URL or a deep link: it carries
 * one of these ids, which RUOOD Lab maps through a hard-coded table to a
 * navigation action. A repository compromise can therefore only send a user to
 * a screen that already exists and that the app already decided is a reasonable
 * place to land.
 *
 * Free-form `ruood-lab://` deep links would let remote data drive the app into
 * arbitrary internal state — and RUOOD Lab has destructive operations behind
 * some of those screens (Factory Reset, Clear Both Libraries, Restore Backup).
 * None of those is reachable from this list, and none should ever be added:
 * an announcement points at a place, never at an operation.
 */

export const ROUTE_TARGETS = [
  // Tab roots.
  'app.materials',
  'app.formulas',
  'app.notes',
  'app.tools',
  'app.settings',

  // Tools.
  'tools.reports',
  'tools.formula-builder',
  'tools.data-management',
  'tools.material-layout',
  'tools.material-fields',
  'tools.ruood-library',

  // Settings.
  'settings.backup',
  'settings.units',
  'settings.appearance',
] as const;

export type RouteTarget = (typeof ROUTE_TARGETS)[number];

const ROUTE_TARGET_SET: ReadonlySet<string> = new Set<string>(ROUTE_TARGETS);

export function isRouteTarget(value: unknown): value is RouteTarget {
  return typeof value === 'string' && ROUTE_TARGET_SET.has(value);
}

/**
 * Hosts an `external` action may link to.
 *
 * Deliberately tiny. An external link leaves the app entirely, so every entry
 * here is a place you are content to send a user who trusted a message that
 * appeared inside RUOOD Lab. Add a host only when you actually need it; the
 * validator takes an override so a call site can narrow this further, never
 * widen it silently.
 */
export const EXTERNAL_HOST_ALLOWLIST = ['github.com', 'www.github.com'] as const;

/**
 * Whether an external action URL is acceptable.
 *
 * `https:` only — no `http:`, no `data:`, no app scheme. Credentials in the URL
 * are refused outright: `https://github.com@evil.example` reads as GitHub to a
 * human and resolves to `evil.example`, which is precisely the confusion an
 * allowlist exists to prevent.
 */
export function isAllowedExternalUrl(
  value: unknown,
  allowlist: readonly string[] = EXTERNAL_HOST_ALLOWLIST,
): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;

  const host = url.hostname.toLowerCase();
  return allowlist.some((allowed) => allowed.toLowerCase() === host);
}
