# Architecture

The decisions behind the announcement system, and the reasoning that is not
visible in any one file. Phase 0 implements only the contract; everything below
the schema section describes what the later phases must hold to.

## The shape of the system

One operator authors announcements. A build produces a small static file plus
images. RUOOD Lab — offline-first, no accounts, no backend, no analytics —
fetches that file opportunistically and decides locally what to show.

Three properties follow, and they drive everything:

- **The client is the only decision-maker.** Scheduling, frequency and
  targeting are evaluated on-device, against a device clock and a device state
  file. The remote file is data, never instructions.
- **There is no feedback channel.** You will never learn that an announcement
  was malformed on 2% of installs. That argues for a small, boring schema and a
  loud validator that refuses at publish time.
- **The channel controls what the app displays and where it navigates.** That
  makes it a security surface, which is why the action target is a closed enum
  and the body is plain text.

## Why the repository is the system of record

The Manager holds no database. `content/` in the announcements repository is
the source of truth, including drafts and archived records.

Putting drafts in git buys backup, history, diffs, and the ability to run the
Manager from a second machine, for nothing. The alternative — Manager-local
state, publishing only the built output — loses every draft and the entire
audit trail when a laptop dies.

It also means the audit questions answer themselves. "When was this published,
and by which change?" is `git log`. There is deliberately **no second
publication history**; the only audit fields stored on a record are the four
that git cannot answer cheaply (`createdAt`, `updatedAt`, `publishedAt`,
`archivedAt`).

## Why publishing is one commit

A commit updates one ref, atomically. JSON and images land together or not at
all.

This is the answer to "what if the JSON succeeds but the image upload fails" —
that state is unreachable, rather than handled. The GitHub Contents API, which
writes one file per call, is precisely the design that creates the problem.

The rest falls out:

| Concern | Handled by |
| --- | --- |
| Atomicity | one ref update |
| Concurrent publication | non-fast-forward rejection → rebase and retry, never force |
| Rollback | `git revert` of the publish commit |
| Publication history | `git log` |
| Authentication | existing git credentials; the Manager holds no token |
| GitHub unreachable | the commit is already local; push is retried |

If publishing ever has to happen without a working copy, the equivalent is the
GitHub **Git Data API** (blobs → tree → commit → `PATCH /git/refs` with the
expected SHA as a compare-and-swap). Also atomic. The Contents API is not.

## Why GitHub Pages rather than raw.githubusercontent.com

Pages gives a CDN, real `ETag` / `Cache-Control` headers — so the client's
conditional GET returns `304` and costs ~0 bytes — and a stable URL that can
later move to a custom domain without shipping a new app version.
`raw.githubusercontent.com` has opaque caching outside your control.

## One validator, two consumers

`@ruood/announcement-schema` is consumed by the Manager (Node) and by RUOOD Lab
(React Native). It is zero-dependency and platform-neutral so the same code can
run under a node-only jest config and inside a Hermes bundle.

This is the `write-planner.ts` discipline from RUOOD Lab — one plan behind both
the preview and the commit. If the Manager validated with one set of rules and
the app parsed with another, they would drift, and the first you would hear of
it is a user.

`verifyPublishable` makes it operational rather than aspirational: publishing
runs the **client's own parser** over the exact bytes about to be written, and
refuses if the client would silently skip any record.

### The two modes, and why they differ

| | `authored` | `published` |
| --- | --- | --- |
| Status and audit dates | required | must be absent |
| Id checked against the registry | yes | no |
| An end date already in the past | error | fine |

The last row is the important one. A device legitimately holds a manifest whose
records have since expired; rejecting the file over that would discard every
other announcement in it. Eligibility is a separate question, decided in Phase 4.

## Fail closed, and the one exception

Anything the client cannot render **correctly** is skipped:

- an unknown `surface`, `trigger`, `dismiss`, `category`, `platform` or
  `action.type`;
- a `minSchema` higher than the build supports;
- a targeting bound that will not parse.

Never a fallback default. An old build guessing at a new record type shows the
wrong thing to exactly the users who cannot be reached with a correction.

Forward compatibility requires the opposite treatment for **unknown optional
fields**: they are ignored, and the record is kept. That is what lets a v2 field
be added without stranding v1 installs.

The one deliberate exception is the kill switch. A missing `paused` reads as
`false`, because failing to the suppressed side would let a dropped field
silence every announcement everywhere.

## Versioning: two levels

- **`schemaVersion`** at the root — bumped only for a breaking structural
  change. A client refuses a manifest above its supported version *whole*,
  because it cannot know what any of it means.
- **`minSchema`** per record — a floor. A client skips a record above its
  support and still reads the rest of the file.

Without the second, adding one field to one new announcement would break the
entire manifest for every install that had not updated. In practice the root
version should approximately never move.

## Instants, not wall-clock readings

Every stored date carries an explicit offset. The Manager resolves the author's
local intent to an absolute instant at publish time and displays it back with
the zone it was authored in.

"September 1, 9:00 AM" is not a fact a device in another timezone can act on,
and a naive string is the classic way a scheduled thing fires eight hours early
for half the users. `parseInstant` refuses one, and says why.

Device clocks are still wrong sometimes. Phase 4 uses the server's `Date`
response header as a sanity anchor and declines to act on a device clock more
than 24 hours off it. Nothing security-relevant depends on device time.

## Version ranges: min inclusive, max exclusive

`minVersion` is `>=`; `maxVersion` is `<`. So "every 2.5.x" is
`min 2.5.0 / max 2.6.0`, with no invented patch number.

`isRangeSatisfiable` rejects a range nothing can satisfy — transposed bounds,
or equal bounds, which exclude their own lower bound. Both are publishable-but-
dead targeting, and there is no feedback channel that would ever tell you.

Prerelease handling follows plain semver precedence rather than npm's range
exclusion: `2.5.0-beta.1` satisfies `min 2.4.0`. npm's rule exists to stop a
public resolver picking up an alpha; the targets here are the operator's own
builds, and "the beta of 2.5 counts as past 2.4" is what an operator means.

## Ids are permanent

An id keys impression state on every device, and that state outlives the
announcement by up to the 60-day retention grace period.

So an id is never reused, **including after deletion**. A reused id inherits the
previous announcement's impression counters, so the new message silently fails
to show for the users most likely to be paying attention.

This is why the repository keeps a retired-id ledger rather than deriving "ids
in use" from the files that still exist — a deleted file leaves nothing behind
to check against. `checkIdAvailable` reports `duplicate` and `retired`
separately, because the fix differs: rename, versus you can never have this one.

## Security

The practical threat is one bad or malicious file. Four mitigations, none of
which requires a backend:

1. **`action.target` is a closed enum, not a URL.** A route action names a
   screen from `ROUTE_TARGETS`, which the app maps through a hard-coded table.
   A compromised repository can only send a user somewhere that already exists.
   Free-form deep links would let remote data drive the app into arbitrary
   internal state — and RUOOD Lab has destructive operations behind some of
   those screens. External links are `https:` only, no embedded credentials, to
   an allowlisted host.
2. **Body renders as plain text.** No HTML, no markdown-with-links, no WebView.
   The validator refuses angle brackets and control characters so stored text
   can never read as markup, whatever a future renderer does.
3. **Hard resource limits.** 256 KB manifest, 50 records, 150 KB image at
   publish (500 KB at the client, so a legitimate image never trips its own
   defence), 1080px maximum dimension.
4. **Nothing can produce an inescapable dialog.** `dismiss: 'none'` never means
   "cannot be closed", and the validator refuses the one combination — a modal
   that is never dismissed, never limited and never expires — that would be a
   remote brick.

`signature` was reserved per-record in v1 and Phase 3 implemented signing at the
**manifest** level instead — see *Signing* below for why the per-record field
would have left the kill switch, the revision and the record set unprotected. It
remains reserved and unused.

The manifest URL is compiled into the app. The manifest must never be able to
tell the client where to fetch next time.

## Display rules are orthogonal

An earlier draft had a single `displayMode` enum mixing "not published yet",
"starts later" and "may interrupt the current session". Those are three
different axes, so every combination had to be validated against the other two
and half of them were nonsense.

| Earlier mode | What it actually is |
| --- | --- |
| Scheduled | `startAt` in the future |
| Manual | `status: 'draft'` — never published |
| Immediately | `trigger: 'immediate'` |
| Next App Open | `trigger: 'next-launch'` (the default) |

Only the last two are display timing. Frequency collapsed the same way: seven
overlapping options became `maxImpressions`, `minIntervalHours` and `dismiss`.

`surface` is the axis that was missing. Without it every announcement is a
blocking modal, and the practical result is that you stop sending them.

## Signing (Phase 3)

The practical threat has always been one bad file. Four mitigations answered it
without a backend; signing is the fifth, and it is the one that makes the other
four hold even if the repository or the Pages domain is taken.

### Why the manifest, not each record

v1 reserved a per-record `signature`. Implementing it there would have been
faithful to the reservation and close to useless, because the three most
valuable things to tamper with are not inside any record:

| Target | Consequence of leaving it unsigned |
| --- | --- |
| `paused` | the kill switch, flipped either way, for every install at once |
| `revision` | an old manifest replayed as the current one |
| the record set | an announcement deleted without forging anything |

So the signature is over the envelope: `keyId` and `signature` at the manifest
root, covering every record inside it as well as all three of the above. The
per-record field stays reserved and unused.

Adding two optional fields to the envelope was free precisely because no client
had shipped. That was the whole reason `signature` was reserved in v1 — to avoid
changing a schema already on devices — and Phase 4 has not happened, so the cost
the reservation was insuring against does not exist yet.

### What the bytes are

`manifestSigningInput`: the canonical **compact** form of the envelope with
`signature` removed.

- **Compact**, because the published file is pretty-printed so it diffs like
  source. A signature that broke on reformatting could not be verified twice.
- **`keyId` included**, so it cannot be relabelled to point at another key.
- **Unknown fields included**, so adding one changes the covered bytes and the
  signature stops verifying. Tolerating unknown fields is a rule about what a
  client may still *read*; it was never a licence to leave them unauthenticated.

### Where the crypto lives, and where it does not

`@ruood/announcement-schema` defines what is signed and what a verdict means,
and carries **no crypto at all** — the isolation sweep bans `node:crypto`
alongside `fs` and `Buffer`. The Ed25519 is injected: `node:crypto` in the
Manager, a Hermes-compatible implementation in RUŌOD Lab in Phase 4.

Two implementations of the algorithm, one definition of the covered bytes. That
split is deliberate: an algorithm mismatch fails loudly on every file, while a
mismatch about *what is covered* would be nearly impossible to diagnose.

### Failing closed, and rolling out

A signature that does not verify refuses the **whole file**, before any record
is read. No "unknown key, so show it anyway", no salvaging records from a file
that failed — either would make pinning decorative.

Checking is opt-in on the client having both keys and a verifier, and
`requireSignature` is a third, separate switch. The two roll out at different
times: a build can start checking signatures before every published file has
one, and only later start requiring them. Requiring a signature a build cannot
check is a misconfiguration, and it fails closed.

### The key

Ed25519. The private half lives outside every repository — `saveSigningKey`
refuses a path inside one by path containment, not by trusting a `.gitignore`,
because the failure being prevented is exactly the missing ignore rule. The
public half is committed, and a publish stages `keys/` so it travels with the
first signed manifest.

`keyId` is the first 8 hex of the sha256 of the raw public key: derived, so it
is a fact about the key rather than a label to keep in step. It is a hint about
which pinned key to try, never a credential — an unrecognised one refuses the
file rather than causing keys to be tried in turn.

**Rotation is an app release.** The public key is compiled into the binary, so a
new key means every install on the old build rejects everything until it
updates. `keygen` refuses to overwrite without `--force`, and the private key is
not recoverable.

## The staging channel

`dist/staging/announcements.json` in the same repository, read by dev and
TestFlight builds. Considered and rejected: a `staging` branch (two histories to
keep in step, and rollback spans both) and a second repository (two remotes, two
Pages sites, `content/` duplicated or synced).

Staging carries **drafts** as well as everything production gets. That is the
entire point — previewing an announcement on a real device before deciding it is
ready — and a staging manifest that excluded drafts would be a copy of
production. Archived and expired records stay out of both: one is deliberately
retired, the other can never be shown again.

**One publish is one channel, so it is one commit.** Each is still atomic, each
gets its own `git log` line naming the channel, and reverting staging does not
revert production. A single commit touching both would have made "roll back
staging" mean rolling back production too.

## CI: verification, not revalidation

`scripts/verify-manifest.mjs` and its workflow are scaffolded into the
announcements repository, because what CI has to catch is a commit the Manager
did not produce — a hand edit, a force-push, a fix applied straight on GitHub.

It does not re-run the validator. Every field rule was already enforced at
publish time by `verifyPublishable`, which runs the client's own parser over the
exact bytes; repeating that in CI would need a copy of the validator, and a copy
drifts. So CI asks the one question publish time cannot answer: **is this still
the file that was signed?** The envelope signature answers it completely, and
the image hashes inside that now-authentic manifest extend the answer to the
bytes beside it.

The script has zero dependencies and no secrets, so nothing sits between a push
and the check. It carries its own `canonicalCompactJson`, which is a deliberate
second implementation: if it ever drifts, CI fails on every correctly signed
manifest — loud and immediate, never quietly permissive.

Revision 0 is the scaffolded placeholder that exists so a client fetching before
the first publish reads a well-formed file rather than a 404. It predates the
key and is skipped. A build always increments, so nothing else can be 0. A
manifest that *is* signed while the public key is missing fails rather than
skipping — deleting the key file must not be a way to pass.

## The Manager UI

A local web app over `core`. The decisions worth recording are the ones that
were not obvious.

### Why a server at all

A browser cannot touch the filesystem, run git, or encode an image with `sharp`.
So there is a Fastify process, and it is kept to exactly that: it maps HTTP onto
`core` calls and back. It holds no state, because the repository is the system
of record and a cache in the server would be a second copy to disagree with it.

`GET /api/state` answers the whole shell in one request. Two requests would let
the counts and the git state disagree by however long the second one took.

### Why the UI implements nothing

Every operation already existed as a `core` function the CLI calls. Two front
ends over one set of functions cannot drift about what "archive" means; two
implementations will. Where the UI needed something `core` lacked, it went into
`core` and got a CLI command as well:

| Added to `core` | CLI | Why the UI needed it |
| --- | --- | --- |
| `applyEdits` | `announce edit` | a form writes arbitrary fields; `touch` accepts any of them |
| `attachImage` | (used by `announce image`) | one original per id, enforced |
| `readEncodedImage` | — | preview bytes before a build has run |

`applyEdits` also fixed something that was latent: `content/media/` must hold
exactly one original per id, because the build finds an original by filename
stem and cannot choose between two. Attaching an image now removes the one it
replaces. The CLI had the same hole; making image replacement easy in a UI is
what would have found it in production.

### Why `rev` is not on the editor form

Bumping it resets impression counters on every device. It has its own button,
its own confirmation and its own sentence, and `applyEdits` refuses it outright.
Keeping the field separate in the schema achieves nothing if the UI lets it be
changed while fixing a typo.

`id` and `status` are excluded from the same list for the same kind of reason —
an id is immutable because it keys device state, and status moves only through
the transition table. `applyEdits` **refuses** rather than dropping: a silent
drop looks to the caller like a successful save.

### Why the server checks Host and Origin

It binds `127.0.0.1`, which stops anything off the machine. It does not stop a
browser: any page on any site can issue requests to a loopback port, and DNS
rebinding can make one same-origin by the browser's reckoning. This process can
commit and push to the repository every install reads.

Three checks, no dependency and no token to store:

- `Host` must name loopback — a rebinding request carries the attacker's
  hostname, which is what gives it away;
- `Origin`, when the browser sends one, must be an origin we serve;
- a mutation must be `application/json` or `application/octet-stream`, neither
  of which an HTML form can produce.

A token was considered and rejected: it would be state to store and to get to
the client, and it buys nothing the above does not already cover.

### Why the browser runs the real validator

`@ruood/announcement-schema` is zero-dependency and platform-neutral, so the
editor imports it directly and validates every keystroke with the same code that
will refuse the record at publish time and that RUOOD Lab will run over the
downloaded file. The server validates again before writing — this is not a
substitute for that, it is the same answer arriving early enough to act on.

Vite aliases the package to its TypeScript source. It has to: the built output
is CommonJS, and `export *` compiles to an `__exportStar` call that Rollup
cannot analyse, so named imports resolve as types and then fail at bundle time.

### Why the preview is a copy

RUOOD Lab's tokens are copied into a stylesheet, not shared. A component
rendering in both React Native and the DOM would be a dependency between two
repositories with different release cycles — and an app-store review sitting in
the middle of it — to buy pixel fidelity in a preview. The preview says on
screen that it is approximate, and it is good for the question an operator
actually has: does this title fit, does this body run to six lines, does the
image crop badly.

Four frames always: 360 and 430 wide, light and dark. An announcement is
authored once and seen in whichever theme the user has set.

## What the client will store (Phase 4)

One AsyncStorage key. Not a table, not a repository, not a provider other things
depend on.

```jsonc
{
  "v": 1,
  "etag": "...",
  "fetchedAt": 0,
  "manifest": { /* last good manifest */ },
  "seen": { "<id>": { "rev": 2, "n": 2, "last": 0, "dis": null } },
  "lastShownAt": 0
}
```

Retention: a `seen` entry is pruned 60 days after its id last appeared in a
manifest — **not on first absence**. An announcement can legitimately vanish and
return (paused, a reverted publish, a republished fix), and pruning immediately
would re-show it to everyone who had already dismissed it. Capped at 200 entries.

Three decisions that follow from RUOOD Lab's existing precedents:

- announcement state does **not** travel in a backup — it is device-and-session
  shaped, like OAuth tokens and the undo history;
- Factory Reset clears it, so announcements re-show. That is consistent with
  "returns the app to a clean state";
- the checker is **not** in the `(tabs)/_layout.tsx` data provider stack. It has
  no dependents and holds no data anyone else needs. It mounts beside
  `AppModalHost` and presents through `AppModal`, so it cannot open a second
  window.

## Phase 4 constraints, written down now

- The fetch runs after `AppReady`, behind `InteractionManager.runAfterInteractions`.
  Never on the startup path, never awaited.
- Conditional GET with `If-None-Match`; at most one fetch per 6 hours.
- 8s manifest timeout, one retry, then silence until the next window.
- Images downloaded lazily — only for a record about to be shown, or starting
  within 48 hours. Verified against `bytes` and `sha256`; a mismatch shows the
  announcement **without** its image rather than suppressing it.
- One modal per session, highest `priority` first.
- Never present over an already-open dialog, and never while the user is
  mid-edit in the Formula Editor or the Material editor.
- Do not present on a user's very first app open.
