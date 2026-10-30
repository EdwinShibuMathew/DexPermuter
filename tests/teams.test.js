import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_PREFIX, MAX_BACKUP_BYTES, createTeamStore, validateTeam } from '../js/teams.js';
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
  const store = createTeamStore({ storage, now: () => time, createId: () => `test-${++sequence}`, ...options });
  return { store, storage, values, advance: () => { time += 1000; } };
}

test('saves independent teams and preserves member order without mutating resources', () => {
  const { store, advance } = setup();
  const first = store.save(store.create(' Episode one '), { expectedRaw: null });
  advance();
  store.save(store.create('Episode two'), { expectedRaw: null });
  assert.deepEqual(store.list().teams.map(record => record.name), ['Episode two', 'Episode one']);
  const original = store.readRaw(first.id);
  first.members = [{ number: 1000, name: null }, { number: 1, name: null }];
  first.note = 'Pick the spooky one.\nCheck abilities.';
  advance();
  const updated = store.save(first, { expectedRaw: original });
  assert.deepEqual(updated.members.map(member => member.number), [1000, 1]);
  assert.equal(store.list().teams[0].id, first.id);
  updated.note = 'Mutated outside the store';
  assert.equal(store.list().teams[0].note, first.note);
});

test('records persist across store instances and have no API-cache expiry', () => {
  const { store, storage } = setup();
  const record = store.save(store.create());
  const later = createTeamStore({ storage, now: () => Date.now() + 365 * 86400000 });
  assert.deepEqual(later.list().teams, [record]);
});

test('validates member numbers, uniqueness, names, notes, versions, IDs, and dates', () => {
  const { store } = setup();
  const original = store.create();
  for (const change of [
    { searchContext: 0 }, { searchContext: 1026 }, { searchContext: '1' },
    { members: [2] }, { members: [{ number: 1 }, { number: 1 }] }, { members: ['1'] },
    { members: null }, { members: [{ number: 0 }] }, { members: [{ number: 1026 }] },
    { members: [{ number: 1, name: {} }] }, { members: [{ number: 1, name: 'x'.repeat(201) }] },
    { name: ' ' }, { name: 'x'.repeat(81) },
    { note: 'x'.repeat(1001) }, { note: null }, { version: 3 },
    { id: '../other' }, { createdAt: 'bad date' }, { updatedAt: new Date(0).toISOString() },
  ]) assert.throws(() => store.save({ ...original, ...change }), JSON.stringify(change));
  assert.equal(store.list().teams.length, 0);
  assert.deepEqual(validateTeam({ ...original, members: [{ number: 1000 }, { number: 1 }], ignored: 'discard' }).members.map(member => member.number), [1000, 1]);
  assert.equal('ignored' in validateTeam({ ...original, ignored: true }), false);
});

function legacy(id = 'legacy') {
  return { version: 1, id, name: 'Challenge from my stream', startingNumber: 12,
    selectedNumbers: [210, 12, 102], note: 'Keep my original note.',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
}

test('legacy reads and exports convert without rewriting original records', () => {
  const { store, values } = setup();
  const original = legacy();
  const raw = JSON.stringify(original);
  values.set(TEAM_PREFIX + original.id, raw);
  const team = store.list().teams[0];
  assert.deepEqual(team, {
    version: 2, id: original.id, name: original.name, note: original.note,
    members: [12, 102, 210].map(number => ({ number, name: null })), searchContext: 12,
    createdAt: original.createdAt, updatedAt: original.updatedAt,
  });
  assert.equal(store.readRaw(team.id), raw);
  assert.deepEqual(JSON.parse(store.exportBackup()), { version: 2, teams: [team] });
  assert.equal(store.readRaw(team.id), raw);
  const updated = store.save({ ...team, members: [...team.members, { number: 4 }] }, { expectedRaw: raw });
  assert.equal(JSON.parse(store.readRaw(team.id)).version, 2);
  assert.deepEqual(updated.members.map(member => member.number), [12, 102, 210, 4]);
});

test('legacy imports skip equivalent converted teams and preserve conflicts as copies', () => {
  const { store, storage } = setup();
  const backup = JSON.stringify({ version: 1, challenges: [legacy()] });
  assert.equal(store.importBackup(backup).imported, 1);
  assert.equal(store.importBackup(backup).skipped, 1);
  const old = store.list().teams[0];
  store.save({ ...old, note: 'Changed in the new app' });
  assert.equal(store.importBackup(backup).imported, 1);
  assert.deepEqual(store.list().teams.map(team => team.note).sort(), ['Changed in the new app', legacy().note].sort());
  assert.equal(storage.length, 2);
});

test('legacy validation still rejects invalid permutations before any import writes', () => {
  const { store, values } = setup();
  assert.throws(() => store.importBackup(JSON.stringify({ version: 1, challenges: [legacy(), { ...legacy('bad'), selectedNumbers: [4] }] })), /valid permutations/);
  assert.equal(values.size, 0);
  assert.throws(() => store.importBackup(JSON.stringify({ version: 2, teams: [legacy()] })), /format or version/);
});

test('mixed stored versions support ordered teams larger than six and repeated restores', () => {
  const { store, values } = setup();
  values.set(TEAM_PREFIX + 'legacy', JSON.stringify(legacy()));
  const numbers = [1025, 4, 1, 12, 34, 6, 98, 500];
  const team = store.save({ ...store.create(), members: numbers.map(number => ({ number, name: null })) });
  assert.deepEqual(store.list().teams.find(item => item.id === team.id).members.map(member => member.number), numbers);
  assert.equal(store.list().teams.length, 2);
  const target = setup();
  assert.equal(target.store.importBackup(store.exportBackup()).imported, 2);
  assert.equal(target.store.importBackup(store.exportBackup()).skipped, 2);
  assert.deepEqual(target.store.list().teams.find(item => item.id === team.id).members, team.members);
});

test('library capacity failures retain saved data and allow a standalone recovery export', () => {
  const { store, values } = setup();
  const base = { ...store.create(), note: 'x'.repeat(1000) };
  // Seed a readable library at its byte boundary without thousands of writes.
  const records = [];
  while (Buffer.byteLength(JSON.stringify({ version: 2, teams: records }, null, 2)) < MAX_BACKUP_BYTES - 2600) {
    const record = { ...base, id: `full-${records.length}` };
    records.push(record);
    values.set(TEAM_PREFIX + record.id, JSON.stringify(record));
  }
  const draft = { ...store.create('Recovery'), members: Array.from({ length: 100 }, (_, index) => ({ number: index + 1, name: null })) };
  const before = new Map(values);
  assert.throws(() => store.save(draft), /library is full/);
  assert.deepEqual(values, before);
  assert.deepEqual(JSON.parse(store.exportBackup(draft, { onlyCurrent: true })).teams, [draft]);
});

test('unreadable and future records remain untouched alongside readable records', () => {
  const { store, values } = setup();
  const good = store.save(store.create());
  values.set(TEAM_PREFIX + 'corrupt', '{');
  values.set(TEAM_PREFIX + 'future', JSON.stringify({ ...good, id: 'future', version: 3 }));
  values.set(TEAM_PREFIX + 'wrong-id', JSON.stringify(good));
  values.set('other-app', 'preserve');
  const before = new Map(values);
  assert.deepEqual(store.list(), { teams: [good], unreadable: 3, unavailable: false });
  assert.deepEqual(JSON.parse(store.exportBackup()).teams, [good]);
  assert.deepEqual(values, before);
});

test('blocked storage and quota failures never report a successful write', () => {
  const absent = setup({ storage: null });
  const draft = absent.store.create();
  assert.equal(absent.store.list().unavailable, true);
  assert.throws(() => absent.store.save(draft), /unavailable/);
  assert.deepEqual(JSON.parse(absent.store.exportBackup(draft)).teams, [draft]);
  const { store, storage } = setup();
  const record = store.save(store.create());
  const raw = store.readRaw(record.id);
  storage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const edited = { ...record, note: 'Still recoverable' };
  assert.throws(() => store.save(edited), /Could not save/);
  assert.equal(store.readRaw(record.id), raw);
  assert.equal(JSON.parse(store.exportBackup(edited)).teams[0].note, 'Still recoverable');
});

test('optimistic checks protect other-tab updates and deletions', () => {
  const { store, values } = setup();
  const record = store.save(store.create());
  const raw = store.readRaw(record.id);
  values.set(TEAM_PREFIX + record.id, JSON.stringify({ ...record, note: 'Another tab' }));
  assert.throws(() => store.save({ ...record, note: 'Stale tab' }, { expectedRaw: raw }), { name: 'ConflictError' });
  assert.throws(() => store.remove(record.id, { expectedRaw: raw }), { name: 'ConflictError' });
  values.delete(TEAM_PREFIX + record.id);
  assert.throws(() => store.save(record, { expectedRaw: raw }), { name: 'ConflictError' });
  assert.equal(values.size, 0);
});

test('backups round trip, skip matching IDs, and import ID conflicts as copies', () => {
  const first = setup();
  const saved = first.store.save({ ...first.store.create('My run'), members: [{ number: 10, name: null }], note: 'Episode 3' });
  const text = first.store.exportBackup();
  const other = setup();
  assert.deepEqual(other.store.importBackup(text), { imported: 1, skipped: 0, failed: 0, errors: [] });
  assert.equal(other.store.list().teams[0].note, saved.note);
  assert.equal(other.store.importBackup(text).skipped, 1);
  // Inject IDs from a different device; its generator must make a fresh ID.
  const conflicting = JSON.parse(text);
  conflicting.teams[0].note = 'Different edits';
  const copyStore = createTeamStore({ storage: other.storage, now: () => 2000, createId: () => 'import-copy' });
  assert.equal(copyStore.importBackup(JSON.stringify(conflicting)).imported, 1);
  assert.equal(copyStore.list().teams.length, 2);
  assert.equal(JSON.parse(copyStore.readRaw(saved.id)).note, 'Episode 3');
  assert.equal(JSON.parse(copyStore.readRaw('import-copy')).note, 'Different edits');
});

test('a conflicting unreadable ID is preserved when a valid copy is restored', () => {
  const { store, values } = setup();
  const record = { ...store.create(), id: 'broken' };
  values.set(TEAM_PREFIX + record.id, 'not-json');
  assert.equal(store.importBackup(JSON.stringify({ version: 2, teams: [record] })).imported, 1);
  assert.equal(values.get(TEAM_PREFIX + record.id), 'not-json');
  assert.equal(store.list().unreadable, 1);
});

test('backup validation rejects the entire malformed file before writing', () => {
  const { store, values } = setup();
  const valid = store.create();
  for (const text of [
    'not json', 'null', JSON.stringify({ version: 3, teams: [] }),
    JSON.stringify({ version: 2, teams: [valid, { ...valid, id: 'different', members: [2] }] }),
    JSON.stringify({ version: 2, teams: [valid, valid] }), ' '.repeat(MAX_BACKUP_BYTES + 1),
  ]) {
    assert.throws(() => store.importBackup(text));
    assert.equal(values.size, 0);
  }
});

test('partial import reports failed records and preserves previous successes', () => {
  const { store, storage, values } = setup();
  const records = [store.create('First'), store.create('Second')];
  const set = storage.setItem;
  storage.setItem = (key, value) => {
    if (values.size >= 1) throw new Error('Quota exhausted');
    set(key, value);
  };
  const report = store.importBackup(JSON.stringify({ version: 2, teams: records }));
  assert.equal(report.imported, 1);
  assert.equal(report.failed, 1);
  assert.match(report.errors[0], /Second/);
  assert.deepEqual(store.list().teams.map(record => record.name), ['First']);
});

test('exporting current edits replaces only that record, with a standalone recovery option', () => {
  const { store } = setup();
  const first = store.save(store.create('First'));
  store.save(store.create('Second'));
  const pending = { ...first, note: 'Not yet persisted' };
  const backup = JSON.parse(store.exportBackup(pending));
  assert.equal(backup.teams.length, 2);
  assert.equal(backup.teams.find(record => record.id === first.id).note, pending.note);
  assert.equal(JSON.parse(store.exportBackup(pending, { onlyCurrent: true })).teams.length, 1);
  assert.equal(store.list().teams.find(record => record.id === first.id).note, '');
});

test('cache quota recovery never prunes saved teams', async () => {
  const { store, storage, values } = setup();
  const saved = store.save(store.create('Keep forever'));
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
  assert.deepEqual(store.list().teams, [saved]);
});

test('delete removes only the requested team', () => {
  const { store, values } = setup();
  const first = store.save(store.create());
  const second = store.save(store.create());
  values.set('other-app', 'keep');
  store.remove(first.id, { expectedRaw: store.readRaw(first.id) });
  assert.deepEqual(store.list().teams, [second]);
  assert.equal(values.get('other-app'), 'keep');
});

test('a conflict backup preserves both saved and in-memory edits under separate IDs', () => {
  const { store } = setup();
  const saved = store.save(store.create());
  const backup = JSON.parse(store.exportBackup({ ...saved, note: 'Local conflicting edit' }, { asCopy: true }));
  assert.equal(backup.teams.length, 2);
  assert.equal(new Set(backup.teams.map(record => record.id)).size, 2);
  assert.deepEqual(backup.teams.map(record => record.note), ['', 'Local conflicting edit']);
});
