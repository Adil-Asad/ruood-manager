# Schema reference — v1

The published manifest, field by field. Types are in
`packages/schema/src/types.ts`; the rules enforcing them are in
`validate-record.ts` and `validate-manifest.ts`.

## The manifest

```jsonc
{
  "schemaVersion": 1,
  "revision": 47,
  "generatedAt": "2026-08-30T14:02:11Z",
  "paused": false,
  "announcements": [ /* ... */ ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | integer | Bumped only for a breaking structural change. A client above/below its range refuses the file whole. |
| `revision` | integer ≥ 1 | Monotonic, set by the build. For logs and support, never for client logic — `ETag` does that job. |
| `generatedAt` | instant | ISO-8601 with an explicit offset. |
| `paused` | boolean | Global kill switch. `true` and clients show nothing. A **missing** value reads as `false`. |
| `announcements` | array | At most 50. Whole file at most 256 KB. |

## A record

```jsonc
{
  "id": "reports-center-launch",
  "rev": 2,
  "minSchema": 1,

  "title": "Reports Center",
  "body": "Eight new library reports are now available under Tools.",
  "category": "feature",
  "priority": 50,

  "startAt": "2026-09-01T06:00:00Z",
  "endAt": "2026-09-10T20:59:00Z",
  "paused": false,

  "display": {
    "surface": "modal",
    "trigger": "next-launch",
    "maxImpressions": 3,
    "minIntervalHours": 24,
    "dismiss": "permanent"
  },

  "targeting": {
    "platforms": ["android", "ios"],
    "minVersion": "2.4.0",
    "maxVersion": null
  },

  "image": {
    "path": "images/reports-center-a3f91c22.webp",
    "width": 1080, "height": 608,
    "bytes": 41203,
    "sha256": "a3f9...",
    "alt": "The Reports Center screen"
  },

  "action": { "type": "route", "label": "Open Reports", "target": "tools.reports" },

  "signature": null
}
```

### Identity

| Field | Rule |
| --- | --- |
| `id` | `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–64 chars. Immutable. **Never reused, including after deletion.** |
| `rev` | Integer ≥ 1. **Bumping it resets impression counters on every device.** Leave it alone to correct a typo quietly; bump it to re-show a corrected message. |
| `minSchema` | Integer ≥ 1. A client skips a record above its support and reads the rest of the file. |

### Content

| Field | Rule |
| --- | --- |
| `title` | **Optional.** Up to 60 chars, single line. Absent and `""` mean the same thing. |
| `body` | **Optional.** Up to 500 chars. Newlines allowed (paragraph breaks are preserved). Warning above 300 — it will scroll on a phone. |
| `category` | `feature` \| `fix` \| `notice` \| `tip` |
| `priority` | 0–100. Ordering among simultaneously eligible records. **Not urgency.** |

Both strings refuse control characters, U+2028/U+2029 and `<` `>`, so stored
text can never read as markup.

**An announcement must carry at least one of a picture, a title or a message**
(`content-empty`). Neither text field is required on its own, because a picture
can be the whole announcement — demanding a caption for one produces a caption
nobody needed. What is refused is a record with all three empty, which renders
as an empty dialog with a Dismiss button.

While authoring, the picture may not be in the record yet: a record committed
from the Android Manager carries an original at `content/media/<id>.<ext>` and
no `image` object, because only an encode can produce one. The
`pendingImage` validation option is how a caller that can see `content/media/`
says so — an authoring-time fact like `idRegistry`, stored nowhere. A published
manifest always carries the `image` object itself, so it never applies there.

### Scheduling

| Field | Rule |
| --- | --- |
| `startAt` | Instant with an explicit offset. Required. |
| `endAt` | Instant, or `null` for no expiry. Must be **later** than `startAt`. |
| `paused` | Optional boolean. Published but suppressed; reversible without touching the dates. |

The window is half-open, `[startAt, endAt)`, so a record ending at T and one
starting at T are never both live.

Authoring-only judgements: an `endAt` already in the past is an error for a
live record (it would show to nobody); no end date is a warning; a start more
than 90 days out is a warning.

### `display`

| Field | Values | Meaning |
| --- | --- | --- |
| `surface` | `modal` | Blocking dialog. One per session, priority-ordered. |
| | `banner` | Inline notice on a list screen. Never blocks. |
| | `inbox` | Settings → Announcements only. Never presented. |
| `trigger` | `next-launch` | Shown next time the app opens. **The default.** Never interrupts work in progress. |
| | `immediate` | May be shown during the session it was fetched in. |
| `maxImpressions` | integer ≥ 1, or `null` | Total times it may ever be shown on one device. |
| `minIntervalHours` | integer ≥ 0 | `0` = may repeat in a session; `24` = once a day. |
| `dismiss` | `permanent` \| `session` \| `snooze-24h` \| `none` | What dismissing means. |

`none` never means "cannot be closed". The validator **rejects** a `modal` with
`dismiss: 'none'`, `maxImpressions: null` and `endAt: null` — that combination
is a remote brick.

The old option list maps on:

| Wanted | Expressed as |
| --- | --- |
| Show once | `maxImpressions: 1` |
| Show N times | `maxImpressions: N` |
| Once per day | `minIntervalHours: 24` |
| Once per session | `minIntervalHours: 0` + the one-modal-per-session rule |
| Until dismissed | `maxImpressions: null`, `dismiss: 'permanent'` |
| While active | `maxImpressions: null`, `dismiss: 'none'` (+ an end date) |

### `targeting`

| Field | Rule |
| --- | --- |
| `platforms` | Non-empty subset of `android`, `ios`, `web`. |
| `minVersion` | Semver, **inclusive** (`>=`), or `null`. |
| `maxVersion` | Semver, **exclusive** (`<`), or `null`. |

"Every 2.5.x" is `min 2.5.0 / max 2.6.0`. A range nothing can satisfy —
transposed or equal bounds — is an error.

Targeting fails closed: an unreadable app version or bound means the record is
not shown.

Region, language, device capability and user segment are **deliberately absent**.
RUOOD Lab has no accounts and no backend, so there is no identity to segment on
and no way to resolve a region without adding a network call to an offline-first
app.

### `image` (optional)

| Field | Rule |
| --- | --- |
| `path` | `images/<slug>-<8 hex>.webp`. Content-addressed. |
| `width`, `height` | 16–1080. |
| `bytes` | ≤ 150 KB at publish. |
| `sha256` | 64 lowercase hex characters. |
| `alt` | 1–120 chars. |

Content addressing means an image is never mutated, only replaced — which
answers cache invalidation and old-image cleanup at once.

An image is **always optional at display time**: a failed, oversized or
unverifiable download shows the announcement without it, never suppresses it.

### `action` (optional)

```jsonc
{ "type": "route",    "label": "Open Reports",  "target": "tools.reports" }
{ "type": "external", "label": "Release notes", "target": "https://github.com/..." }
```

`label` is 1–24 chars.

A **route** target must be one of `ROUTE_TARGETS` (see
`packages/schema/src/routes.ts`) — a closed list of screens, never a URL or a
deep link. Nothing destructive is on it, and nothing destructive should be
added: an announcement points at a place, never at an operation.

An **external** target must be `https:`, carry no embedded credentials, and be
on the host allowlist. `https://github.com@evil.example` is refused — it reads
as GitHub to a human and resolves elsewhere.

### `signature`

`null` in v1, and still unused.

Phase 3 signs the **manifest envelope** rather than each record, because
`paused`, `revision` and which records are present at all are not inside any
record — and those are the three most valuable things to tamper with. See
`manifest.signature` below, and *Signing* in `ARCHITECTURE.md`.

The field stays reserved: removing it from a shipped schema would cost more than
leaving it.

## Authored-only fields

Present in `content/`, never emitted into `dist/`:

| Field | Notes |
| --- | --- |
| `status` | `draft` \| `published` \| `paused` \| `archived`. **Stored states only.** |
| `createdAt`, `updatedAt` | Required instants. |
| `publishedAt`, `archivedAt` | Optional instants. |
| `internalNote` | Operator-only. Never published. |

`scheduled`, `active` and `expired` are **derived** from the dates by
`deriveLifecycleStatus`, never stored — a stored copy would disagree with the
dates the moment one was edited. Same rule as `usedInFormulas` in RUOOD Lab.

## Validation summary

**Errors** block publishing. **Warnings** proceed after confirmation.

| Warning | Meaning |
| --- | --- |
| `unknown-field` | Probably a typo. Tolerated for forward compatibility. |
| `text-long-warning` | Body over 300 chars; it will scroll. |
| `no-end-date-warning` | Runs until paused or unpublished. |
| `start-far-future-warning` | Starts more than 90 days out. |
| `version-missing-warning` | A `feature` announcement with no version floor will reach installs too old to have the feature. |
| `inbox-with-immediate-trigger` | An inbox record is never presented, so its trigger has no effect. |
| `overlapping-category-warning` | Two same-category records overlap in time. |
| `too-many-modals-warning` | More than 3 modals live at once; at one per session the last may wait days. |

Full issue-code list: `packages/schema/src/issues.ts`.

## Manifest signature (Phase 3)

Two optional fields on the manifest envelope.

```jsonc
{
  "schemaVersion": 1,
  "revision": 4,
  "generatedAt": "2026-09-15T12:00:00Z",
  "paused": false,
  "announcements": [ /* ... */ ],

  "keyId": "5af5f4d8",
  "signature": "base64, 88 characters"
}
```

### `keyId`

The first 8 hex characters of the sha256 of the raw 32-byte Ed25519 public key.
Derived from the key, never assigned.

A **hint**, not a credential: it tells a client which of its pinned keys to try.
A client that does not recognise it refuses the manifest rather than trying its
keys in turn.

### `signature`

Ed25519, base64, over `manifestSigningInput(envelope)` — the canonical
**compact** JSON of the whole envelope with `signature` removed and `keyId` left
in.

| Property | Why |
| --- | --- |
| Compact, not pretty | the file is pretty-printed so it diffs like source; a signature must survive reformatting |
| `keyId` covered | so it cannot be relabelled to point at another key |
| Unknown fields covered | adding one changes the covered bytes and breaks the signature |
| `signature` excluded | it cannot cover itself |

Verification is injected, never implemented in this package — it has no crypto,
so the same code runs under a node-only jest config and inside a Hermes bundle.

**A signature that does not verify refuses the whole file**, before any record
is read. There is no partial acceptance and no downgrade to unsigned.

Both fields are optional. A repository that has not run `announce keygen`
publishes without them, and a client without pinned keys ignores them — signing
is something each side turns on, and `requireSignature` is a third switch again,
so "start checking" and "start requiring" can happen at different times.
