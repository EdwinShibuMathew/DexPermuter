import { permuteDexNumber, validateDexNumber } from './permute.js';

export const CHALLENGE_PREFIX = 'dexpermuter:challenges:v1:';
export const MAX_BACKUP_BYTES = 1024 * 1024;

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function bytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

export function validateChallenge(value) {
  if (!value || value.version !== 1) throw new Error('Unsupported challenge version.');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)) throw new Error('Invalid challenge identifier.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('Use a challenge name of 1–80 characters.');
  validateDexNumber(value.startingNumber);
  const allowed = new Set(permuteDexNumber(value.startingNumber));
  if (!Array.isArray(value.selectedNumbers) || value.selectedNumbers.length > allowed.size ||
      new Set(value.selectedNumbers).size !== value.selectedNumbers.length || !value.selectedNumbers.every(number => allowed.has(number))) {
    throw new Error('Shortlisted numbers must be valid permutations of the starting number.');
  }
  if (typeof value.note !== 'string' || value.note.length > 1000) throw new Error('Notes must contain at most 1,000 characters.');
  if (![value.createdAt, value.updatedAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date))) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error('Invalid challenge dates.');
  return {
    version: 1, id: value.id, name: value.name.trim(), startingNumber: value.startingNumber,
    selectedNumbers: [...value.selectedNumbers].sort((a, b) => a - b), note: value.note,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function backupText(challenges) {
  return JSON.stringify({ version: 1, challenges }, null, 2);
}

function conflict() {
  const error = new Error('This challenge changed in another tab. Reload it or save your edits as a copy.');
  error.name = 'ConflictError';
  return error;
}

/** Only user records live here; API cache cleanup must never own this namespace. */
export function createChallengeStore({ storage = browserStorage(), now = Date.now, createId = () => globalThis.crypto.randomUUID() } = {}) {
  function readRaw(id) {
    if (!storage) throw new Error('Browser storage is unavailable. Download a backup to keep your work.');
    return storage.getItem(CHALLENGE_PREFIX + id);
  }

  function list() {
    const challenges = [];
    let unreadable = 0;
    try {
      if (!storage) throw new Error('Storage unavailable');
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (!key?.startsWith(CHALLENGE_PREFIX)) continue;
        try {
          const record = validateChallenge(JSON.parse(storage.getItem(key)));
          if (key !== CHALLENGE_PREFIX + record.id) throw new Error('Identifier mismatch');
          challenges.push(record);
        } catch { unreadable += 1; }
      }
    } catch { return { challenges, unreadable, unavailable: true }; }
    challenges.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    return { challenges, unreadable, unavailable: false };
  }

  function create(startingNumber, name = `Challenge #${String(startingNumber).padStart(4, '0')}`) {
    const date = new Date(now()).toISOString();
    return validateChallenge({ version: 1, id: createId(), name, startingNumber, selectedNumbers: [], note: '', createdAt: date, updatedAt: date });
  }

  function save(record, { expectedRaw } = {}) {
    const validated = validateChallenge(record);
    const existing = readRaw(validated.id);
    if (expectedRaw !== undefined && existing !== expectedRaw) throw conflict();
    validated.updatedAt = new Date(Math.max(now(), Date.parse(validated.createdAt))).toISOString();
    const library = list();
    if (library.unavailable) throw new Error('Could not read browser storage. Your edits have not been saved.');
    const records = [...library.challenges.filter(item => item.id !== validated.id), validated];
    if (bytes(backupText(records)) > MAX_BACKUP_BYTES) throw new Error('Your challenge library is full. Download a backup and remove an older challenge.');
    try { storage.setItem(CHALLENGE_PREFIX + validated.id, JSON.stringify(validated)); } catch {
      throw new Error('Could not save on this device. Browser storage may be full or blocked. Retry or download a backup.');
    }
    return validated;
  }

  function remove(id, { expectedRaw } = {}) {
    const existing = readRaw(id);
    if (expectedRaw !== undefined && existing !== expectedRaw) throw conflict();
    storage.removeItem(CHALLENGE_PREFIX + id);
  }

  function exportBackup(current = null, { onlyCurrent = false, asCopy = false } = {}) {
    const records = onlyCurrent ? [] : list().challenges;
    if (current) {
      const validated = validateChallenge(current);
      if (asCopy) validated.id = createId();
      const index = records.findIndex(record => record.id === validated.id);
      if (index < 0) records.push(validated);
      else records[index] = validated;
    }
    const text = backupText(records);
    if (bytes(text) > MAX_BACKUP_BYTES) throw new Error('This backup exceeds 1 MiB. Export your current challenge separately.');
    return text;
  }

  function importBackup(text) {
    if (typeof text !== 'string' || bytes(text) > MAX_BACKUP_BYTES) throw new Error('Choose a JSON backup no larger than 1 MiB.');
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('This file is not a valid JSON backup.'); }
    if (envelope?.version !== 1 || !Array.isArray(envelope.challenges)) throw new Error('Unsupported backup format or version.');
    // Validate the entire file before the first write; unknown fields are discarded.
    const records = envelope.challenges.map(validateChallenge);
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('The backup contains duplicate challenge identifiers.');
    const report = { imported: 0, skipped: 0, failed: 0, errors: [] };
    for (const record of records) {
      try {
        const raw = readRaw(record.id);
        if (raw !== null) {
          let existing;
          try { existing = validateChallenge(JSON.parse(raw)); } catch { /* Preserve unreadable originals by importing a copy. */ }
          if (existing && ['name', 'startingNumber', 'note', 'selectedNumbers'].every(key => JSON.stringify(existing[key]) === JSON.stringify(record[key]))) {
            report.skipped += 1;
            continue;
          }
          record.id = createId();
        }
        save(record, { expectedRaw: null });
        report.imported += 1;
      } catch (error) {
        report.failed += 1;
        report.errors.push(`${record.name}: ${error.message}`);
      }
    }
    return report;
  }

  return { create, list, readRaw, save, remove, exportBackup, importBackup };
}
