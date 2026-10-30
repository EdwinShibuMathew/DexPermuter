/**
 * Storage boundary for issues #12–19. This module is not wired into the app.
 * See docs/storage.md for ordering, failure, ownership, and lifecycle semantics.
 *
 * @typedef {Object} CacheRecord
 * @property {string} url Canonical HTTPS PokéAPI resource URL; primary key.
 * @property {Object} data Validated public API response; never a user record.
 * @property {1} schemaVersion
 * @property {string} revision Opaque unique replacement token, not a timestamp.
 * @property {number} savedAt Epoch milliseconds; never renewed by reads/migration.
 * @property {number} expiresAt savedAt plus the configured TTL.
 * @property {number} lastAccessed Epoch milliseconds for deterministic LRU.
 * @property {number} estimatedBytes UTF-8 JSON excluding this field, plus 128.
 *
 * @typedef {'stored'|'memory'|'skipped'} CacheWriteStatus
 * @typedef {Object} CacheWriteResult
 * @property {CacheWriteStatus} status Persistent commit, memory admission, or no admission.
 *
 * @typedef {Object} RetentionToken Opaque, facade-local active-working-data lease.
 *
 * @typedef {Object} ResourceCache
 * @property {(url: string) => CacheRecord|null} peek Synchronous; no I/O or promises.
 * @property {(url: string, options?: {signal?: AbortSignal}) => Promise<CacheRecord|null>} get
 * @property {(record: CacheRecord, options?: {ifRevision?: string|null}) => Promise<CacheWriteResult>} put
 * @property {(url: string, options?: {ifRevision?: string}) => Promise<boolean>} remove
 * @property {(urls: string[]) => RetentionToken} retain Protect core data until release.
 * @property {(token: RetentionToken) => void} release Idempotent; unknown tokens ignored.
 * @property {() => Promise<void>} settled Wait for work accepted before this call.
 * @property {() => Promise<void>} close Bounded, idempotent; release resources.
 *
 * @typedef {Object} PersistentCacheAdapter
 * @property {(url: string, options?: {signal?: AbortSignal}) => Promise<CacheRecord|null>} get
 * @property {(record: CacheRecord, options?: {ifRevision?: string|null}) => Promise<CacheWriteResult>} put
 * @property {(url: string, options?: {ifRevision?: string}) => Promise<boolean>} remove
 * @property {() => Promise<void>} settled
 * @property {() => Promise<void>} close Includes late-open cleanup and versionchange handling.
 *
 * @typedef {{number: number, name: string|null}} TeamMember
 * @typedef {Object} TeamRecord
 * @property {2} version
 * @property {string} id
 * @property {string} name Trimmed, 1–80 characters.
 * @property {TeamMember[]} members Unique numbers 1–1025; order is meaningful.
 * @property {string} note At most 1,000 characters.
 * @property {number|null} searchContext 1–1025, or absent context.
 * @property {string} createdAt Parseable date string.
 * @property {string} updatedAt Not earlier than createdAt.
 *
 * @typedef {Object} LegacyTeamRecord
 * @property {1} version
 * @property {string} id
 * @property {string} name
 * @property {number} startingNumber
 * @property {number[]} selectedNumbers Unique valid permutations of startingNumber.
 * @property {string} note
 * @property {string} createdAt
 * @property {string} updatedAt
 * @typedef {{version: 1, challenges: LegacyTeamRecord[]}|{version: 2, teams: TeamRecord[]}} TeamBackup
 *
 * @typedef {Object} RevisionToken Opaque team revision; clients may only compare/pass it.
 * @typedef {{raw: string|null, revision: RevisionToken}} RawTeamSnapshot Adapter-only.
 * @typedef {Object} TeamSnapshot
 * @property {TeamRecord|null} record Validated v2 view, or null for absence.
 * @property {RevisionToken} revision Includes a token for observed absence.
 *
 * @typedef {Object} TeamChange
 * @property {string|null} id null means re-read the library (e.g. storage clear).
 *
 * @typedef {Object} TeamStorage Adapter used only by the repository, never UI code.
 * @property {(id: string) => RawTeamSnapshot} read
 * @property {() => string[]} ids Snapshot only team-owned identifiers.
 * @property {(id: string, raw: string, options: {expectedRevision: RevisionToken}) => RevisionToken} write
 * @property {(id: string, options: {expectedRevision: RevisionToken}) => void} remove
 * @property {(listener: (change: TeamChange) => void) => (() => void)} subscribe
 * @property {() => void} close
 *
 * @typedef {Object} TeamRepository
 * @property {(id: string) => TeamSnapshot} load Synchronous; never exposes raw JSON.
 * @property {() => {teams: TeamRecord[], unreadable: number, unavailable: boolean}} list
 * @property {(name?: string) => TeamRecord} create
 * @property {(record: TeamRecord, options: {expectedRevision: RevisionToken}) => TeamSnapshot} save
 * @property {(id: string, options: {expectedRevision: RevisionToken}) => void} remove
 * @property {(current?: TeamRecord|null, options?: {onlyCurrent?: boolean, asCopy?: boolean}) => string} exportBackup
 * @property {(text: string) => {imported: number, skipped: number, failed: number, errors: string[]}} importBackup
 * @property {(listener: (change: TeamChange) => void) => (() => void)} subscribe
 * @property {() => void} close Unsubscribe native events; no deletion.
 *
 * @callback LegacyRecovery
 * @returns {void} Synchronously stage eligible cache data and remove owned keys;
 * schedule bounded transfers without waiting. Caller rechecks revision before retry.
 *
 * @typedef {'quota'|'access-blocked'|'unavailable'|'timeout'|'aborted'|'version'|'conflict'|'library-full'|'invalid-data'|'unknown'} StorageErrorCategory
 * @typedef {'open'|'read'|'write'|'remove'|'cleanup'|'migrate'|'recover'|'close'} StorageOperation
 * @typedef {'memory'|'indexeddb'|'localstorage'} StorageBackend
 * @typedef {Object} StorageDiagnostic
 * @property {StorageOperation} operation
 * @property {StorageBackend} backend
 * @property {StorageErrorCategory} category
 * @callback DiagnosticCallback
 * @param {StorageDiagnostic} event Allowlisted fields only; callback exceptions ignored.
 * @returns {void}
 */

const LEGACY_CACHE_PREFIX = 'dexpermuter:v1:';

/** Ownership predicate only; envelope validation/admission belongs to migration. */
export function legacyCacheUrl(key) {
  if (typeof key !== 'string' || !key.startsWith(LEGACY_CACHE_PREFIX)) return null;
  const suffix = key.slice(LEGACY_CACHE_PREFIX.length);
  try {
    const url = new URL(suffix);
    url.hash = '';
    if (url.origin !== 'https://pokeapi.co' || url.username || url.password ||
        !url.pathname.startsWith('/api/v2/') || url.href !== suffix) return null;
    return url.href;
  } catch { return null; }
}

/** Application accounting estimate, not browser disk or JavaScript heap usage. */
export function estimateRecordBytes(record) {
  const { estimatedBytes, ...serialized } = record;
  return new TextEncoder().encode(JSON.stringify(serialized)).byteLength + 128;
}
