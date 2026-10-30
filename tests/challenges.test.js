import test from 'node:test';
import assert from 'node:assert/strict';
import { CHALLENGE_PREFIX, MAX_BACKUP_BYTES, createChallengeStore, validateChallenge } from '../js/challenges.js';
import { createApiClient } from '../js/api.js';

function setup(options = {}) {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  let sequence = 0;
  let time = 1000;
  const store = createChallengeStore({ storage, now: () => time, createId: () => `test-${++sequence}`, ...options });
  return { store, storage, values, advance: () => { time += 1000; } };
}

test('saves independent named searches and returns copies ordered by recent activity', () => {
  const { store, advance } = setup();
  const first = store.save(store.create(1, ' Episode one '), { expectedRaw: null });
  advance();
  store.save(store.create(1, 'Episode two'), { expectedRaw: null });
  assert.deepEqual(store.list().challenges.map(record => record.name), ['Episode two', 'Episode one']);
  const original = store.readRaw(first.id);
  first.selectedNumbers = [1000, 1];
  first.note = 'Pick the spooky one.\nCheck abilities.';
  advance();
  const updated = store.save(first, { expectedRaw: original });
  assert.deepEqual(updated.selectedNumbers, [1, 1000]);
  assert.equal(store.list().challenges[0].id, first.id);
  updated.note = 'Mutated outside the store';
  assert.equal(store.list().challenges[0].note, first.note);
});

test('records persist across store instances and have no API-cache expiry', () => {
  const { store, storage } = setup();
  const record = store.save(store.create(1025));
  const later = createChallengeStore({ storage, now: () => Date.now() + 365 * 86400000 });
  assert.deepEqual(later.list().challenges, [record]);
});

test('validates numbers, shortlist membership, names, notes, versions, IDs, and dates', () => {
  const { store } = setup();
  const original = store.create(1);
  for (const change of [
    { startingNumber: 0 }, { startingNumber: 1026 }, { startingNumber: '1' },
    { selectedNumbers: [2] }, { selectedNumbers: [1, 1] }, { selectedNumbers: ['1'] },
    { selectedNumbers: null }, { name: ' ' }, { name: 'x'.repeat(81) },
    { note: 'x'.repeat(1001) }, { note: null }, { version: 2 },
    { id: '../other' }, { createdAt: 'bad date' }, { updatedAt: new Date(0).toISOString() },
  ]) assert.throws(() => store.save({ ...original, ...change }), JSON.stringify(change));
  assert.equal(store.list().challenges.length, 0);
  assert.deepEqual(validateChallenge({ ...original, selectedNumbers: [1000, 1], ignored: 'discard' }).selectedNumbers, [1, 1000]);
  assert.equal('ignored' in validateChallenge({ ...original, ignored: true }), false);
});

test('unreadable and future records remain untouched alongside readable records', () => {
  const { store, values } = setup();
  const good = store.save(store.create(100));
  values.set(CHALLENGE_PREFIX + 'corrupt', '{');
  values.set(CHALLENGE_PREFIX + 'future', JSON.stringify({ ...good, id: 'future', version: 2 }));
  values.set(CHALLENGE_PREFIX + 'wrong-id', JSON.stringify(good));
  values.set('other-app', 'preserve');
  const before = new Map(values);
  assert.deepEqual(store.list(), { challenges: [good], unreadable: 3, unavailable: false });
  assert.deepEqual(JSON.parse(store.exportBackup()).challenges, [good]);
  assert.deepEqual(values, before);
});

test('blocked storage and quota failures never report a successful write', () => {
  const absent = setup({ storage: null });
  const draft = absent.store.create(1);
  assert.equal(absent.store.list().unavailable, true);
  assert.throws(() => absent.store.save(draft), /unavailable/);
  assert.deepEqual(JSON.parse(absent.store.exportBackup(draft)).challenges, [draft]);
  const { store, storage } = setup();
  const record = store.save(store.create(1));
  const raw = store.readRaw(record.id);
  storage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const edited = { ...record, note: 'Still recoverable' };
  assert.throws(() => store.save(edited), /Could not save/);
  assert.equal(store.readRaw(record.id), raw);
  assert.equal(JSON.parse(store.exportBackup(edited)).challenges[0].note, 'Still recoverable');
});

test('optimistic checks protect other-tab updates and deletions', () => {
  const { store, values } = setup();
  const record = store.save(store.create(1));
  const raw = store.readRaw(record.id);
  values.set(CHALLENGE_PREFIX + record.id, JSON.stringify({ ...record, note: 'Another tab' }));
  assert.throws(() => store.save({ ...record, note: 'Stale tab' }, { expectedRaw: raw }), { name: 'ConflictError' });
  assert.throws(() => store.remove(record.id, { expectedRaw: raw }), { name: 'ConflictError' });
  values.delete(CHALLENGE_PREFIX + record.id);
  assert.throws(() => store.save(record, { expectedRaw: raw }), { name: 'ConflictError' });
  assert.equal(values.size, 0);
});

test('backups round trip, skip matching IDs, and import ID conflicts as copies', () => {
  const first = setup();
  const saved = first.store.save({ ...first.store.create(1, 'My run'), selectedNumbers: [10], note: 'Episode 3' });
  const text = first.store.exportBackup();
  const other = setup();
  assert.deepEqual(other.store.importBackup(text), { imported: 1, skipped: 0, failed: 0, errors: [] });
  assert.equal(other.store.list().challenges[0].note, saved.note);
  assert.equal(other.store.importBackup(text).skipped, 1);
  // Inject IDs from a different device; its generator must make a fresh ID.
  const conflicting = JSON.parse(text);
  conflicting.challenges[0].note = 'Different edits';
  const copyStore = createChallengeStore({ storage: other.storage, now: () => 2000, createId: () => 'import-copy' });
  assert.equal(copyStore.importBackup(JSON.stringify(conflicting)).imported, 1);
  assert.equal(copyStore.list().challenges.length, 2);
  assert.equal(JSON.parse(copyStore.readRaw(saved.id)).note, 'Episode 3');
  assert.equal(JSON.parse(copyStore.readRaw('import-copy')).note, 'Different edits');
});

test('a conflicting unreadable ID is preserved when a valid copy is restored', () => {
  const { store, values } = setup();
  const record = { ...store.create(1), id: 'broken' };
  values.set(CHALLENGE_PREFIX + record.id, 'not-json');
  assert.equal(store.importBackup(JSON.stringify({ version: 1, challenges: [record] })).imported, 1);
  assert.equal(values.get(CHALLENGE_PREFIX + record.id), 'not-json');
  assert.equal(store.list().unreadable, 1);
});

test('backup validation rejects the entire malformed file before writing', () => {
  const { store, values } = setup();
  const valid = store.create(1);
  for (const text of [
    'not json', 'null', JSON.stringify({ version: 2, challenges: [] }),
    JSON.stringify({ version: 1, challenges: [valid, { ...valid, id: 'different', selectedNumbers: [2] }] }),
    JSON.stringify({ version: 1, challenges: [valid, valid] }), ' '.repeat(MAX_BACKUP_BYTES + 1),
  ]) {
    assert.throws(() => store.importBackup(text));
    assert.equal(values.size, 0);
  }
});

test('partial import reports failed records and preserves previous successes', () => {
  const { store, storage, values } = setup();
  const records = [store.create(1, 'First'), store.create(100, 'Second')];
  const set = storage.setItem;
  storage.setItem = (key, value) => {
    if (values.size >= 1) throw new Error('Quota exhausted');
    set(key, value);
  };
  const report = store.importBackup(JSON.stringify({ version: 1, challenges: records }));
  assert.equal(report.imported, 1);
  assert.equal(report.failed, 1);
  assert.match(report.errors[0], /Second/);
  assert.deepEqual(store.list().challenges.map(record => record.name), ['First']);
});

test('exporting current edits replaces only that record, with a standalone recovery option', () => {
  const { store } = setup();
  const first = store.save(store.create(1, 'First'));
  store.save(store.create(12, 'Second'));
  const pending = { ...first, note: 'Not yet persisted' };
  const backup = JSON.parse(store.exportBackup(pending));
  assert.equal(backup.challenges.length, 2);
  assert.equal(backup.challenges.find(record => record.id === first.id).note, pending.note);
  assert.equal(JSON.parse(store.exportBackup(pending, { onlyCurrent: true })).challenges.length, 1);
  assert.equal(store.list().challenges.find(record => record.id === first.id).note, '');
});

test('cache quota recovery never prunes saved challenges', async () => {
  const { store, storage, values } = setup();
  const saved = store.save(store.create(1, 'Keep forever'));
  const expired = 'dexpermuter:v1:https://pokeapi.co/api/v2/generation/1/';
  values.set(expired, JSON.stringify({ savedAt: 0, data: { id: 1 } }));
  const set = storage.setItem;
  storage.setItem = (key, value) => {
    if (values.has(expired)) throw new Error('Full');
    set(key, value);
  };
  const client = createApiClient({ storage, now: () => 8 * 86400000, fetchImpl: async () => ({ ok: true, json: async () => ({ id: 2 }) }) });
  await client.fetchResource('generation/2/');
  assert.equal(values.has(expired), false);
  assert.deepEqual(store.list().challenges, [saved]);
});

test('delete removes only the requested challenge', () => {
  const { store, values } = setup();
  const first = store.save(store.create(1));
  const second = store.save(store.create(12));
  values.set('other-app', 'keep');
  store.remove(first.id, { expectedRaw: store.readRaw(first.id) });
  assert.deepEqual(store.list().challenges, [second]);
  assert.equal(values.get('other-app'), 'keep');
});

test('a conflict backup preserves both saved and in-memory edits under separate IDs', () => {
  const { store } = setup();
  const saved = store.save(store.create(1));
  const backup = JSON.parse(store.exportBackup({ ...saved, note: 'Local conflicting edit' }, { asCopy: true }));
  assert.equal(backup.challenges.length, 2);
  assert.equal(new Set(backup.challenges.map(record => record.id)).size, 2);
  assert.deepEqual(backup.challenges.map(record => record.note), ['', 'Local conflicting edit']);
});
