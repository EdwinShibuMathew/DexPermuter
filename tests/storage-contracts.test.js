import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamStore, TEAM_PREFIX, validateTeam } from '../js/teams.js';
import { createApiClient } from '../js/api.js';
import { estimateRecordBytes, legacyCacheUrl } from '../js/storage/contracts.js';
import { StorageError, classifyStorageError, storageDiagnostic } from '../js/storage/errors.js';
import { backups, legacyTeam, orderedTeam, ownership, warmCore } from './fixtures/storage.js';

function storageFixture() {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('legacy reads preserve bytes while exposing a v2 view; v2 preserves member order', () => {
  const storage = storageFixture();
  const raw = JSON.stringify(legacyTeam, null, 4);
  storage.setItem(TEAM_PREFIX + legacyTeam.id, raw);
  const store = createTeamStore({ storage });
  const result = store.list();
  assert.equal(result.unreadable, 0);
  assert.deepEqual(result.teams[0].members.map(member => member.number), [1, 10, 100]);
  assert.equal(result.teams[0].searchContext, 1);
  assert.equal(storage.getItem(TEAM_PREFIX + legacyTeam.id), raw);
  assert.deepEqual(validateTeam(orderedTeam), orderedTeam);
});

test('v1 and v2 backups round-trip as v2 without losing notes, context, or order', () => {
  for (const backup of backups) {
    const store = createTeamStore({ storage: storageFixture(), now: () => Date.parse(orderedTeam.createdAt) });
    assert.deepEqual(store.importBackup(JSON.stringify(backup)), { imported: 1, skipped: 0, failed: 0, errors: [] });
    const expected = validateTeam((backup.teams ?? backup.challenges)[0]);
    assert.deepEqual(JSON.parse(store.exportBackup()), { version: 2, teams: [expected] });
  }
});

test('legacy cache ownership excludes user, future, foreign, and noncanonical keys', () => {
  for (const [key, owned] of ownership) {
    assert.equal(legacyCacheUrl(key) !== null, owned, key);
    if (owned) assert.equal('dexpermuter:v1:' + legacyCacheUrl(key), key);
  }
  assert.equal(legacyCacheUrl(null), null);
});

test('record estimate uses UTF-8, excludes its previous estimate, and adds 128 bytes', () => {
  const record = { url: 'https://pokeapi.co/api/v2/generation/1/', data: { name: 'é⚡' }, schemaVersion: 1,
    revision: 'synthetic', savedAt: 1, expiresAt: 604800001, lastAccessed: 1 };
  const expected = Buffer.byteLength(JSON.stringify(record), 'utf8') + 128;
  assert.equal(estimateRecordBytes(record), expected);
  assert.equal(estimateRecordBytes({ ...record, estimatedBytes: 999 }), expected);
});

test('storage classification exposes only fixed categories, including explicit domain failures', () => {
  const cases = { QuotaExceededError: 'quota', NS_ERROR_DOM_QUOTA_REACHED: 'quota', SecurityError: 'access-blocked',
    NotAllowedError: 'access-blocked', InvalidStateError: 'unavailable', TimeoutError: 'timeout', AbortError: 'aborted',
    VersionError: 'version', ConflictError: 'conflict', DataError: 'invalid-data', DataCloneError: 'invalid-data', SyntaxError: 'invalid-data' };
  for (const [name, category] of Object.entries(cases)) {
    assert.equal(classifyStorageError({ name, message: 'PRIVATE CONTENT', cause: orderedTeam }), category);
  }
  for (const category of ['unavailable', 'library-full', 'conflict']) {
    assert.equal(classifyStorageError(new StorageError(category)), category);
  }
  assert.equal(classifyStorageError(new Error('quota')), 'unknown');
  assert.equal(classifyStorageError({ category: 'quota' }), 'unknown');
  assert.equal(classifyStorageError({ get name() { throw new Error('PRIVATE'); } }), 'unknown');
  assert.equal(classifyStorageError(null), 'unknown');
});

test('diagnostics cannot include raw errors or caller-supplied labels', () => {
  const error = { name: 'QuotaExceededError', message: JSON.stringify(orderedTeam), stack: 'PRIVATE', url: 'PRIVATE' };
  assert.deepEqual(storageDiagnostic('write', 'localstorage', error), { operation: 'write', backend: 'localstorage', category: 'quota' });
  assert.equal(storageDiagnostic(error.message, 'localstorage', error), null);
  assert.equal(storageDiagnostic('write', error.message, error), null);
  const safe = new StorageError('unknown');
  assert.equal(safe.cause, undefined);
  assert.equal(JSON.stringify(storageDiagnostic('open', 'indexeddb', error)).includes('PRIVATE'), false);
});

test('warm core handoff subscribes to shared evolution before the previous consumer aborts', async () => {
  const storage = storageFixture();
  for (const [resource, data] of [['pokemon/1/', warmCore.pokemon], ['pokemon-species/1/', warmCore.species]]) {
    storage.setItem('dexpermuter:v1:https://pokeapi.co/api/v2/' + resource, JSON.stringify({ savedAt: 1000, data }));
  }
  let complete;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const body = new Promise(resolve => { complete = resolve; });
  let calls = 0;
  let networkSignal;
  const client = createApiClient({ storage, now: () => 1001, fetchImpl: async (_, { signal }) => {
    calls += 1;
    networkSignal = signal;
    started();
    return { ok: true, json: () => body };
  } });
  const previous = new AbortController();
  const current = new AbortController();
  const oldResult = assert.rejects(client.getPokemon(1, { signal: previous.signal }), { name: 'AbortError' });
  await waiting;
  const newResult = client.getPokemon(1, { signal: current.signal });
  try {
    previous.abort();
    await oldResult;
    assert.equal(networkSignal.aborted, false);
    assert.equal(calls, 1);
    complete(warmCore.chain);
    assert.equal((await newResult).evolutionError, null);
  } finally {
    current.abort();
    complete(warmCore.chain);
    await Promise.allSettled([newResult]);
  }
});
