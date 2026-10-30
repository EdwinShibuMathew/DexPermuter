import { permuteDexNumber, validateDexNumber } from './permute.js';

// Retain the deployed namespace so existing records and other tabs stay visible.
export const TEAM_PREFIX = 'dexpermuter:challenges:v1:';
export const MAX_BACKUP_BYTES = 1024 * 1024;

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function bytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

function validateLegacyChallenge(value) {
  if (!value || value.version !== 1) throw new Error('Unsupported saved record version.');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)) throw new Error('Invalid team identifier.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('Use a team name of 1–80 characters.');
  validateDexNumber(value.startingNumber);
  const allowed = new Set(permuteDexNumber(value.startingNumber));
  if (!Array.isArray(value.selectedNumbers) || value.selectedNumbers.length > allowed.size ||
      new Set(value.selectedNumbers).size !== value.selectedNumbers.length || !value.selectedNumbers.every(number => allowed.has(number))) {
    throw new Error('Shortlisted numbers must be valid permutations of the starting number.');
  }
  if (typeof value.note !== 'string' || value.note.length > 1000) throw new Error('Notes must contain at most 1,000 characters.');
  if (![value.createdAt, value.updatedAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date))) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error('Invalid team dates.');
  return {
    version: 1, id: value.id, name: value.name.trim(), startingNumber: value.startingNumber,
    selectedNumbers: [...value.selectedNumbers].sort((a, b) => a - b), note: value.note,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function validateTeam(value) {
  if (value?.version === 1) {
    const legacy = validateLegacyChallenge(value);
    value = { ...legacy, version: 2, members: legacy.selectedNumbers.map(number => ({ number, name: null })), searchContext: legacy.startingNumber };
  }
  if (!value || value.version !== 2) throw new Error('Unsupported team version.');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)) throw new Error('Invalid team identifier.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('Use a team name of 1–80 characters.');
  if (!Array.isArray(value.members)) throw new Error('Team members must be a list.');
  const members = value.members.map(member => {
    validateDexNumber(member?.number);
    if (member.name != null && (typeof member.name !== 'string' || !member.name.trim() || member.name.length > 200)) throw new Error('Invalid Pokémon display name.');
    return { number: member.number, name: member.name ?? null };
  });
  if (new Set(members.map(member => member.number)).size !== members.length) throw new Error('A Pokémon can only appear once in a team.');
  if (value.searchContext != null) validateDexNumber(value.searchContext);
  if (typeof value.note !== 'string' || value.note.length > 1000) throw new Error('Notes must contain at most 1,000 characters.');
  if (![value.createdAt, value.updatedAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date))) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error('Invalid team dates.');
  return {
    version: 2, id: value.id, name: value.name.trim(), members, note: value.note,
    searchContext: value.searchContext ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function backupText(teams) {
  return JSON.stringify({ version: 2, teams }, null, 2);
}

function conflict() {
  const error = new Error('This team changed in another tab. Reload it or save your edits as a copy.');
  error.name = 'ConflictError';
  return error;
}

/** Only user records live here; API cache cleanup must never own this namespace. */
export function createTeamStore({ storage = browserStorage(), now = Date.now, createId = () => globalThis.crypto.randomUUID() } = {}) {
  function readRaw(id) {
    if (!storage) throw new Error('Browser storage is unavailable. Download a backup to keep your work.');
    return storage.getItem(TEAM_PREFIX + id);
  }

  function list() {
    const teams = [];
    let unreadable = 0;
    try {
      if (!storage) throw new Error('Storage unavailable');
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (!key?.startsWith(TEAM_PREFIX)) continue;
        try {
          const record = validateTeam(JSON.parse(storage.getItem(key)));
          if (key !== TEAM_PREFIX + record.id) throw new Error('Identifier mismatch');
          teams.push(record);
        } catch { unreadable += 1; }
      }
    } catch { return { teams, unreadable, unavailable: true }; }
    teams.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    return { teams, unreadable, unavailable: false };
  }

  function create(name = 'My team') {
    const date = new Date(now()).toISOString();
    return validateTeam({ version: 2, id: createId(), name, members: [], note: '', searchContext: null, createdAt: date, updatedAt: date });
  }

  function save(record, { expectedRaw } = {}) {
    const validated = validateTeam(record);
    const existing = readRaw(validated.id);
    if (expectedRaw !== undefined && existing !== expectedRaw) throw conflict();
    validated.updatedAt = new Date(Math.max(now(), Date.parse(validated.createdAt))).toISOString();
    const library = list();
    if (library.unavailable) throw new Error('Could not read browser storage. Your edits have not been saved.');
    const records = [...library.teams.filter(item => item.id !== validated.id), validated];
    if (bytes(backupText(records)) > MAX_BACKUP_BYTES) throw new Error('Your team library is full. Download a backup and remove an older team.');
    try { storage.setItem(TEAM_PREFIX + validated.id, JSON.stringify(validated)); } catch {
      throw new Error('Could not save on this device. Browser storage may be full or blocked. Retry or download a backup.');
    }
    return validated;
  }

  function remove(id, { expectedRaw } = {}) {
    const existing = readRaw(id);
    if (expectedRaw !== undefined && existing !== expectedRaw) throw conflict();
    storage.removeItem(TEAM_PREFIX + id);
  }

  function exportBackup(current = null, { onlyCurrent = false, asCopy = false } = {}) {
    const records = onlyCurrent ? [] : list().teams;
    if (current) {
      const validated = validateTeam(current);
      if (asCopy) validated.id = createId();
      const index = records.findIndex(record => record.id === validated.id);
      if (index < 0) records.push(validated);
      else records[index] = validated;
    }
    const text = backupText(records);
    if (bytes(text) > MAX_BACKUP_BYTES) throw new Error('This backup exceeds 1 MiB. Export your current team separately.');
    return text;
  }

  function importBackup(text) {
    if (typeof text !== 'string' || bytes(text) > MAX_BACKUP_BYTES) throw new Error('Choose a JSON backup no larger than 1 MiB.');
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('This file is not a valid JSON backup.'); }
    const entries = envelope?.version === 1 ? envelope.challenges : envelope?.version === 2 ? envelope.teams : null;
    if (!Array.isArray(entries) || entries.some(record => record?.version !== envelope.version)) throw new Error('Unsupported backup format or version.');
    // Validate the entire file before the first write; unknown fields are discarded.
    const records = entries.map(validateTeam);
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('The backup contains duplicate team identifiers.');
    const report = { imported: 0, skipped: 0, failed: 0, errors: [] };
    for (const record of records) {
      try {
        const raw = readRaw(record.id);
        if (raw !== null) {
          let existing;
          try { existing = validateTeam(JSON.parse(raw)); } catch { /* Preserve unreadable originals by importing a copy. */ }
          if (existing?.id === record.id && ['name', 'searchContext', 'note', 'members'].every(key => JSON.stringify(existing[key]) === JSON.stringify(record[key]))) {
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
