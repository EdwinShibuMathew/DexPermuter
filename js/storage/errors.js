/** @import { StorageErrorCategory, StorageDiagnostic } from './contracts.js' */

const MESSAGES = Object.freeze({
  quota: 'Storage quota was exceeded.',
  'access-blocked': 'Storage access was blocked.',
  unavailable: 'Storage is unavailable.',
  timeout: 'Storage did not settle in time.',
  aborted: 'Storage work was canceled.',
  version: 'The storage version is unsupported.',
  conflict: 'The saved team changed.',
  'library-full': 'The team library exceeds its limit.',
  'invalid-data': 'Stored data is invalid.',
  unknown: 'Storage work failed.',
});
const NAMES = Object.freeze({
  QuotaExceededError: 'quota',
  NS_ERROR_DOM_QUOTA_REACHED: 'quota',
  SecurityError: 'access-blocked',
  NotAllowedError: 'access-blocked',
  InvalidStateError: 'unavailable',
  TimeoutError: 'timeout',
  AbortError: 'aborted',
  VersionError: 'version',
  ConflictError: 'conflict',
  DataError: 'invalid-data',
  DataCloneError: 'invalid-data',
  SyntaxError: 'invalid-data',
});
const OPERATIONS = new Set(['open', 'read', 'write', 'remove', 'cleanup', 'migrate', 'recover', 'close']);
const BACKENDS = new Set(['memory', 'indexeddb', 'localstorage']);

/** Errors created here never retain the original error, message, or cause. */
export class StorageError extends Error {
  /** @param {import('./contracts.js').StorageErrorCategory} category */
  constructor(category) {
    const safeCategory = Object.hasOwn(MESSAGES, category) ? category : 'unknown';
    super(MESSAGES[safeCategory]);
    this.name = 'StorageError';
    this.category = safeCategory;
  }
}

/** @returns {StorageErrorCategory} Never inspect or propagate an error message. */
export function classifyStorageError(error) {
  try {
    if (error instanceof StorageError && Object.hasOwn(MESSAGES, error.category)) return error.category;
    const name = error?.name;
    return typeof name === 'string' && Object.hasOwn(NAMES, name) ? NAMES[name] : 'unknown';
  } catch { return 'unknown'; }
}

/** @returns {StorageDiagnostic|null} Reject unrecognized operation/backend labels. */
export function storageDiagnostic(operation, backend, error) {
  if (!OPERATIONS.has(operation) || !BACKENDS.has(backend)) return null;
  return Object.freeze({ operation, backend, category: classifyStorageError(error) });
}
