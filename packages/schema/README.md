# @ruood/announcement-schema

The announcement data contract, shared by the Announcement Manager (Node) and
by RUOOD Lab (React Native).

**Zero runtime dependencies, and no platform imports.** That is a contract, not
an accident — `src/__tests__/isolation.test.ts` fails if it is broken. It is
what lets the same validator run under a node-only jest config and inside a
Hermes bundle, which is what makes "one validator, two consumers" true rather
than aspirational.

## What is in here

| Module | Owns |
| --- | --- |
| `types.ts` | The three record shapes and the manifest. |
| `constants.ts` | Every limit and closed enum. The paper equivalent of RUOOD Lab's `constants/layout.ts`. |
| `routes.ts` | The closed set of action destinations, and the external-URL rule. |
| `issues.ts` | Issue codes, severities, and the collector. |
| `instant.ts` | Absolute instants. Refuses a naive local date. |
| `semver.ts` | Semver 2.0.0 precedence and range tests. |
| `id.ts` | Id format, availability, suggestion. |
| `validate-record.ts` | The one record validator, in `authored` and `published` modes. |
| `validate-manifest.ts` | Envelope, size, duplicate ids, overlap warnings. |
| `parse-manifest.ts` | The client's reader. Never throws, fails closed, drops bad records individually. |

## The three entry points

```ts
// Manager, before saving a record
validateAnnouncementRecord(record, { now, mode: 'authored', idRegistry });

// Manager, before pushing — runs the CLIENT's reader over the exact bytes
verifyPublishable(JSON.stringify(manifest), { now });

// RUOOD Lab, on every fetch
parseManifestText(responseText, { now, receivedBytes });
```

## Rules worth knowing before changing anything

- **`now` is always injected.** Nothing here reads the clock; the isolation
  test fails on `Date.now()` in production code. A scheduling rule that reads
  the clock cannot be pinned to a fixed instant, and so cannot be tested.
- **Errors block, warnings confirm.** A warning must never be something that
  makes a manifest unreadable, and an error must never be something a device
  legitimately encounters — which is why "this expired" is an error while
  authoring and fine while parsing.
- **Fail closed on unknown enum values, tolerate unknown fields.** Skipping a
  record this build cannot render is safety; dropping a record because it
  carries a field from a later version would break forward compatibility.
- **Ids are permanent.** Never reused, including after deletion.

## Commands

```bash
npm test        # 255 tests, 7 suites
npm run typecheck
npm run build   # dist/ — CJS plus .d.ts
```

`jest.config.js` points ts-jest at `tsconfig.test.json` deliberately. An inline
`{ module, target }` override replaces the project's compiler options wholesale,
which quietly disables `strict` and lets type errors sit in test files while
jest stays green.
