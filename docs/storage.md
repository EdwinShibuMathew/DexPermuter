# Storage contracts and baseline

Status: design boundary for #12, parent #11. This PR adds contracts, pure helpers,
offline fixtures, and measurements only. The application still uses its original
localStorage cache. Future implementations must satisfy these contracts before
integration. DexPermuter remains a buildless, browser-only JAMstack application.

## Current implementation inventory

Baseline source: `a3b20f6bab6e58c442184d54ef7c24ea41d66bfa` (merged PR #10).

| Owner | Operations and persisted format |
| --- | --- |
| `js/api.js` | Guard access to localStorage; read/parse/validate a URL envelope; remove corrupt, future-dated, or expired entries; write successful responses; on write failure snapshot keys, prune invalid/expired cache entries, retry once. Memory is currently unbounded. |
| API key | `dexpermuter:v1:` + canonical HTTPS PokéAPI `/api/v2/` URL; value `{savedAt,data}`. The client strips fragments and accepts generic API resource families, including `generation`. |
| `js/teams.js` | Enumerate/read/validate teams; read exact raw revisions; create/save/remove; compare expected raw value before mutation; validate/import v1/v2 backups; export v2. Invalid saved records are preserved and counted. |
| Team key | `dexpermuter:challenges:v1:` + team ID. Namespace stays unchanged for both record versions. v1 selected numbers become sorted v2 members on read, without rewriting the original bytes. v2 member order is meaningful. |
| `js/team-ui.js` | Currently obtains raw revisions and listens to native `storage` events. Note saves are debounced; membership and lifecycle flushes are synchronous. Conflicts retain local edits with copy/export/reload options. These storage details move behind the repository in #13. |

The API manager coalesces consumers by canonical URL and holds at most four network
slots, including JSON body reads. Last-consumer cancellation removes queued work or
aborts active work. A ten-second timeout covers headers and body. Aborted/invalid
responses are never cached. A species/chain error permits a partial Pokémon card;
a failed Pokémon resource rejects that card.

**Warm-core handoff is synchronous:** if Pokémon and species data are already in
memory, `getPokemon` must subscribe to the evolution request before returning to
its caller. The caller can then abort the previous search without aborting shared
evolution work. Even an `await` of fulfilled promises introduces a regression.

## Boundaries and ownership

`js/storage/contracts.js` defines the shared JSDoc vocabulary and pure accounting
and key-ownership helpers. `js/storage/errors.js` classifies sanitized failures.
Neither module is imported by the production entry point in this PR.

- The team repository owns validation, v1 conversion, ordered v2 records, backup
  formats and the 1 MiB UTF-8 library/export limit. A localStorage adapter owns
  raw serialization, revisions and native events. UI code sees neither Storage,
  IndexedDB, serialized values, nor native events.
- `TeamRepository.load` returns `{record,revision}` synchronously. Even absence
  has an opaque revision token. Save/remove require `expectedRevision`, compare
  it immediately before mutation, and fail visibly on conflict. Tokens are never
  persisted in backups. This is optimistic detection, not a cross-tab transaction
  guarantee. Keep raw bytes unchanged until an explicit save.
- `subscribe` emits `{id}` or `{id:null}` for a library invalidation; listeners
  re-read through the repository. Close detaches events without deleting records.
- The cache contains only disposable, validated public API responses. No fallback,
  migration, rollback or emergency path may write bulk API responses to
  localStorage. Never call `localStorage.clear()` or reset the database to recover.

## Resource cache facade

All cache URLs must already be canonical; retain the API client's resource
validation. Returned records/data are read-only by contract (no mandatory deep
clone/freeze). The facade accepts an injected clock, validator, persistent adapter,
diagnostic callback and policy limits; Node tests need no browser installation.

| Method | Required behavior |
| --- | --- |
| `peek(url)` | Synchronous memory-only valid record or `null`. No storage promises; an optional legacy bridge may synchronously promote a requested legacy record during migration. |
| `get(url,{signal})` | Async memory/persistent lookup; validate schema, age and payload before admission. Failures become misses; caller cancellation remains `AbortError`. Storage work consumes no network slot. |
| `put(record,{ifRevision})` | Bounded write/admission returning `{status:'stored'|'memory'|'skipped'}`. `stored` means transaction **complete**, not request success. If specified, `ifRevision:null` means insert only if absent; a string means replace only that revision. Conditions apply consistently in memory and persistence. |
| `remove(url,{ifRevision})` | Bounded conditional delete; `true` only if deleted. A stale revision or failed delete returns `false`, with sanitized diagnostics for failures. |
| `retain(urls)` / `release(token)` | Acquire an opaque lease and release idempotently. Active core responses are protected as temporary working data until `getPokemon` completes/aborts, including newly fetched oversized responses. Leases do not extend TTL. |
| `settled()` | Wait for operations accepted before the call, including queued touches/transfers. Later work does not prolong the snapshot. All waits are bounded. |
| `close()` | Stop accepting work, release leases/listeners, bound settlement and close adapters. Repeated calls are harmless; later peeks/gets miss, writes skip, removes return false. Late opens must be closed. |

Register/join request consumers **before** asynchronous cache reads. Enqueue a
network request only while its pending-entry identity is current and consumers
remain. Preserve synchronous warm-core subscription and keep body-read slots and
network timeouts separate from storage watchdogs. Normal API promises settle after
the bounded cache write; invalid or abandoned responses cannot populate cache.

## Schema, budgets and eviction

Native IndexedDB database: `dexpermuter-api-cache`, version **1**.

- `responses`, key path `url`: `{url,data,schemaVersion:1,revision,savedAt,
  expiresAt,lastAccessed,estimatedBytes}`. Indexes: `expiresAt` and
  `lastAccessedUrl` on `[lastAccessed,url]` (deterministic ties).
- `metadata`, out-of-line key `totals`: `{entries,estimatedBytes}`. Atomically
  update responses and totals on replacement, expiry, removal and LRU eviction.
  Recompute inconsistent metadata from validated records with bounded work.
- Revisions are unique opaque replacement identifiers. Conditional touches/removals
  cannot affect newer records. Older migration data cannot overwrite fresher data.

| Policy | Initial value |
| --- | --- |
| TTL | 7 days; valid iff `0 <= now - savedAt < TTL` and `expiresAt === savedAt + TTL` |
| Persistent cache | 32 MiB estimated bytes **and** 512 entries |
| Reusable memory | 8 MiB estimated bytes **and** 256 entries |
| IndexedDB open / operation watchdog | 1,000 ms each, including transaction completion |
| Network | 4 requests through body reads; 10,000 ms timeout |

Estimate each record as UTF-8 bytes of `JSON.stringify(record)` **excluding
`estimatedBytes`**, plus **128 bytes**. Use the same definition for memory and
persistent budgets. These are accounting estimates, not measured heap/disk usage
or browser quota guarantees. Remove expired/invalid entries first, then LRU until
both limits hold. Reads update last access without renewing TTL. Oversized responses
still reach callers but skip reusable admission; protected active working data can
temporarily exceed memory limits and is released when callers finish. Clock
rollback/future timestamps invalidate an entry rather than making it immortal.

## Failure and lifecycle rules

Open/operation timeout, blocked access, unavailable APIs, unsupported future database
version, transaction abort and quota failure must fall back to bounded memory for
the page session. Close on `versionchange`; close handles delivered after timeout.
Do not request persistent-storage permissions or detect private browsing.

On persistent quota abort, run bounded cleanup in a separate transaction and retry
at most once; then disable persistence for the session. Ordinary cache failures are
nonfatal. Explicit caller cancellation still propagates. Team failures remain
visible and keep unsaved edits retryable/exportable; library-full and conflict are
distinct from physical quota or access failure.

Error categories: `quota`, `access-blocked`, `unavailable`, `timeout`, `aborted`,
`version`, `conflict`, `library-full`, `invalid-data`, `unknown`. Only explicit domain
errors supply domain categories; unknown exceptions are never guessed from message
text. A diagnostic callback receives only `{operation,backend,category}` with
allowlisted values. Ignore callback exceptions. Never forward raw error objects,
messages, stack traces, URLs, team IDs, names, notes, records or backup contents.
No logging/telemetry/debug UI is enabled by these disconnected contracts.

## Migration and synchronous team recovery

Only keys accepted by `legacyCacheUrl` are cache-owned: exact `dexpermuter:v1:`
prefix followed by an absolute canonical HTTPS `pokeapi.co/api/v2/` URL, without
credentials or fragment. Include generic families and query URLs. Preserve team
keys, other apps, future versions, unknown suffixes and noncanonical keys. This
tightens current broad-prefix pruning; never reuse that pruning function wholesale.

Snapshot keys, process bounded batches and yield between batches. Validate envelope,
payload, original timestamp and budget eligibility. Preserve savedAt/expiry; initialize
lastAccessed to savedAt. When persistence works, commit eligible records before
conditionally removing an unchanged raw legacy value. With persistence unavailable,
stage eligible records in bounded memory before cleanup. Expired/invalid or oversized
owned entries may be discarded. Do not persist a completion marker or renew TTL.
Interrupted/repeated migration must be safe; re-read before deletion so an old tab's
rewrite is preserved. Cross-store migration cannot be atomic with an old tab.

Inject a synchronous `LegacyRecovery` hook into team storage; keep it inert until
the migration/API integration PR. On actual team quota failure, stage eligible
entries synchronously in memory, queue bounded persistence transfers, and remove
only owned disposable keys to prioritize team saving. Recheck the expected team
revision after recovery and retry the save once. Other team failures do not trigger
cleanup. Do not block unload saves on asynchronous IndexedDB work. A page closing
during emergency transfer can lose disposable cache entries; user teams take priority.

## Baselines and measurement limits

The investigated source had **75 Node cases and 64 Chromium cases**. A fresh exact
main-source validation copy under ignored `node_modules/.cache/` reruns the Node
baseline without overwriting the existing workspace changes. The CI PR run reruns
the complete browser baseline against that same main source plus these additive
files. New coverage adds seven Node contracts and one prototype per Chromium project.
[CI run 41135411992](https://github.com/EdwinShibuMathew/DexPermuter/actions/runs/41135411992)
passed **82 Node / 66 Chromium**, with no failures or skips. The original
75 Node / 64 Chromium cases all remain present and passed.

`tests/fixtures/storage-sizes.json` records eight public upstream resource blob IDs,
the pinned upstream commit and normalized UTF-8 payload sizes. Source:
[PokeAPI/api-data](https://github.com/PokeAPI/api-data/tree/447bd5c378bf87da964bfe4dd7487a7bf1d97cbd/data/api/v2).
The measurement parses JSON, expands relative `/api/v2/` strings to the public API
origin, then compact-serializes. It does not measure compression or HTTP overhead.

| Resource | Normalized payload bytes |
| --- | ---: |
| pokemon/1 | 282,699 |
| pokemon/25 | 309,106 |
| pokemon/1025 | 22,440 |
| pokemon-species/1 | 33,039 |
| pokemon-species/133 | 47,697 |
| pokemon-species/1025 | 3,423 |
| evolution-chain/1 | 2,023 |
| evolution-chain/67 | 18,594 |

Run `npm test` and `npm run test:browser` after the normal test dependency setup.
For just the prototype: `npm run test:browser -- storage-baseline.spec.js`.
It generates eight synthetic JSON responses with these exact payload sizes in an
isolated Playwright context, measures database open, synchronous legacy parse,
memory transfer/removal and IndexedDB transaction-commit/removal (three samples).
`STORAGE_BASELINE` console records and `storage-baseline.json` report attachments
contain counts, estimated workload and timings only. They never read team contents.
No performance threshold is asserted: CI timing is noisy. This prototype excludes
production validators, bounded batching, contention, full budgets and recovery.

Measured on Ubuntu 24.04 GitHub Actions with Node 24 and pinned Playwright 1.64.1,
run 41135411992 (2026-10-30). Eight records total **719,021 payload bytes**.
Database open is one sample; other columns show the range of three samples.
The first persistent sample inserts records; the remaining two replace the same
synthetic keys. These are primitive timings, not a migration throughput benchmark.

| Chromium project | Open (ms) | Parse startup (ms) | Memory transfer/removal (ms) | IDB commit/removal (ms) |
| --- | ---: | ---: | ---: | ---: |
| Desktop 1280 × 800 | 2.8 | 0.5 | 0.4–1.1 | 6.8–8.7 |
| Mobile emulation 390 × 844 | 2.6 | 0.4–0.5 | 0.4–1.2 | 7.1–8.5 |

Budget suitability, production startup/migration latency, persistent quota isolation,
Firefox/WebKit behavior, physical Safari macOS/iOS and Chrome Android remain
**unverified** here. Mobile Chromium emulation is layout/device emulation, not proof
of branded mobile browser behavior. Retain the starting limits/watchdogs until
representative integration and real-device QA justify a reviewed change.

## Delivery and rollback

Use one active PR at a time. After this PR merges and main passes, proceed through
team adapter, memory policy and native IndexedDB adapter. Activate migration and
API replacement together (#16 + #17), initially in memory mode, before the broader
browser/device matrix (#18). #19 owns the static release flag, sanitized counters,
debug controls, QA evidence and rollback documentation. Enable IndexedDB in a
separate reviewed release only after those gates pass.

Rollback selects memory mode while retaining safe legacy cleanup. Never restore
the bulk localStorage cache writer, delete team records or clear the IndexedDB
database. Keep export and unsaved-edit recovery working. No backend, service worker,
account, runtime dependency or remote telemetry is introduced. Close #11 only after
all child tasks, deployed validation, manual device QA and rollback checks complete.
