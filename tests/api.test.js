import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, STAT_KEYS, createApiClient, describeEvolutionMethod, summarizeEvolution } from '../js/api.js';

const root = 'https://pokeapi.co/api/v2/';
const response = data => ({ ok: true, json: async () => data });
const node = (name, children = [], details = []) => ({ species: { name }, evolves_to: children, evolution_details: details });
const level = number => ({ trigger: { name: 'level-up' }, min_level: number });

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function pokemonFixture() {
  return {
    name: 'bulbasaur',
    stats: STAT_KEYS.map((name, index) => ({ stat: { name }, base_stat: [45, 49, 49, 65, 65, 45][index] })),
    types: [{ slot: 2, type: { name: 'poison' } }, { slot: 1, type: { name: 'grass' } }],
    abilities: [
      { slot: 3, ability: { name: 'chlorophyll' }, is_hidden: true },
      { slot: 1, ability: { name: 'overgrow' }, is_hidden: false },
    ],
  };
}

test('coalesces matching in-flight URLs and caches in memory', async () => {
  let calls = 0;
  const client = createApiClient({ storage: null, fetchImpl: async () => { calls += 1; return response({ id: 1 }); } });
  const results = await Promise.all([client.fetchResource('pokemon/1/'), client.fetchResource(root + 'pokemon/1/')]);
  assert.deepEqual(results, [{ id: 1 }, { id: 1 }]);
  await client.fetchResource('pokemon/1/');
  assert.equal(calls, 1);
});

test('persists across clients, then expires cached responses', async () => {
  const storage = memoryStorage();
  let calls = 0;
  let clock = 1000;
  const options = { storage, now: () => clock, cacheTtlMs: 100, fetchImpl: async () => response({ calls: ++calls }) };
  await createApiClient(options).fetchResource('pokemon/1/');
  assert.deepEqual(await createApiClient(options).fetchResource('pokemon/1/'), { calls: 1 });
  clock += 100;
  assert.deepEqual(await createApiClient(options).fetchResource('pokemon/1/'), { calls: 2 });
});

test('corrupt or blocked storage does not prevent requests or memory caching', async () => {
  for (const storage of [
    { getItem: () => '{broken', setItem() { throw new Error('Full'); } },
    { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } },
  ]) {
    let calls = 0;
    const client = createApiClient({ storage, fetchImpl: async () => { calls += 1; return response({ id: 1 }); } });
    await client.fetchResource('pokemon/1/');
    await client.fetchResource('pokemon/1/');
    assert.equal(calls, 1);
  }
});

test('limits actual requests globally and releases slots after failures', async () => {
  let active = 0;
  let maximum = 0;
  const client = createApiClient({ storage: null, concurrency: 4, fetchImpl: async url => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    if (url.endsWith('/3/')) throw new Error('Offline');
    return response({ url });
  } });
  const results = await Promise.allSettled(Array.from({ length: 15 }, (_, index) => client.fetchResource(`pokemon/${index + 1}/`)));
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('reports 404 and network errors and does not cache failures', async () => {
  let calls = 0;
  const client = createApiClient({ storage: null, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 404 };
    if (calls === 2) throw new Error('Offline');
    return response({ id: 1 });
  } });
  await assert.rejects(client.fetchResource('pokemon/1/'), error => error instanceof ApiError && error.status === 404);
  await assert.rejects(client.fetchResource('pokemon/1/'), /connection/);
  assert.deepEqual(await client.fetchResource('pokemon/1/'), { id: 1 });
  assert.equal(calls, 3);
});

test('timeouts include response-body reads, abort, and release the queue', async () => {
  let calls = 0;
  let aborted = false;
  const client = createApiClient({ storage: null, concurrency: 1, timeoutMs: 15, fetchImpl: async (_, { signal }) => {
    calls += 1;
    if (calls > 1) return response({ id: 2 });
    signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  const results = await Promise.allSettled([client.fetchResource('pokemon/1/'), client.fetchResource('pokemon/2/')]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /too long/);
  assert.equal(aborted, true);
  assert.deepEqual(results[1].value, { id: 2 });
});

test('rejects unexpected resource origins and invalid top-level JSON', async () => {
  const client = createApiClient({ storage: null, fetchImpl: async () => response([]) });
  await assert.rejects(client.fetchResource('https://example.com/api/v2/pokemon/1/'), /unexpected/);
  await assert.rejects(client.fetchResource('pokemon/1/'), /invalid data/);
});

test('normalizes names, type order, abilities, six stats, and BST', async () => {
  const client = createApiClient({ storage: null, fetchImpl: async url => {
    if (url.includes('/pokemon/')) return response(pokemonFixture());
    if (url.includes('/pokemon-species/')) return response({ names: [{ language: { name: 'en' }, name: 'Bulbasaur' }], evolution_chain: { url: root + 'evolution-chain/1/' } });
    return response({ chain: node('bulbasaur', [node('ivysaur', [], [level(16)])]) });
  } });
  const data = await client.getPokemon(1);
  assert.equal(data.name, 'Bulbasaur');
  assert.equal(data.bst, 318);
  assert.deepEqual(data.types, ['grass', 'poison']);
  assert.deepEqual(data.abilities, ['Overgrow']);
  assert.deepEqual(data.hiddenAbilities, ['Chlorophyll']);
  assert.equal(data.evolutionError, null);
  assert.match(data.evolution, /Ivysaur at level 16/);
});

test('species or chain failure preserves core data and can be retried', async () => {
  for (const failedEndpoint of ['/pokemon-species/', '/evolution-chain/']) {
    let fail = true;
    const client = createApiClient({ storage: null, fetchImpl: async url => {
      if (fail && url.includes(failedEndpoint)) throw new Error('Offline');
      if (url.includes('/pokemon/')) return response(pokemonFixture());
      if (url.includes('/pokemon-species/')) return response({ evolution_chain: { url: root + 'evolution-chain/1/' } });
      return response({ chain: node('bulbasaur') });
    } });
    const partial = await client.getPokemon(1);
    assert.equal(partial.bst, 318);
    assert.match(partial.evolutionError, /connection/);
    fail = false;
    const complete = await client.getPokemon(1);
    assert.equal(complete.evolutionError, null);
    assert.match(complete.evolution, /does not evolve/);
  }
});

test('core failures and incomplete stats reject the card', async () => {
  const client = createApiClient({ storage: null, fetchImpl: async url => {
    if (url.includes('/pokemon/')) return response({ ...pokemonFixture(), stats: [] });
    return response({});
  } });
  await assert.rejects(client.getPokemon(1), /stats are incomplete/);
  await assert.rejects(client.getPokemon(0), RangeError);
});

test('evolution summaries retain all branches, deduplicate methods, and handle no evolution', () => {
  const chain = { chain: node('eevee', [
    node('vaporeon', [], [{ trigger: { name: 'use-item' }, item: { name: 'water-stone' } }]),
    node('espeon', [], [{ ...level(null), min_happiness: 160, time_of_day: 'day' }]),
  ]) };
  const summary = summarizeEvolution(chain);
  assert.match(summary, /Eevee evolves into Vaporeon using Water Stone/);
  assert.match(summary, /Eevee evolves into Espeon by leveling up, with friendship of at least 160, during day/);
  assert.equal(summarizeEvolution({ chain: node('ditto') }), 'Ditto does not evolve.');
  const duplicate = summarizeEvolution({ chain: node('a', [node('b', [], [level(20), level(20), level(30)])]) });
  assert.equal((duplicate.match(/level 20/g) || []).length, 1);
  assert.match(duplicate, /alternatively.*level 30/);
});

test('trade/item, zero-valued stat relations, regional forms, and unknown conditions remain explicit', () => {
  const trade = describeEvolutionMethod({ trigger: { name: 'trade' }, held_item: { name: 'metal-coat' } });
  assert.equal(trade, 'by trading, while holding Metal Coat');
  assert.match(describeEvolutionMethod({ ...level(20), relative_physical_stats: 0 }), /Attack equal to Defense/);
  assert.match(describeEvolutionMethod({ ...level(20), required_pokemon_form: { name: 'rattata-alola' }, region: { name: 'alola' } }), /in Alola, from the Rattata Alola form/);
  assert.match(describeEvolutionMethod({ ...level(20), future_requirement: true }), /additional requirements/);
  assert.match(describeEvolutionMethod({ trigger: { name: 'future-trigger' } }), /special evolution method/);
  assert.match(describeEvolutionMethod({ ...level(25), condition_expression: { percentage_chance: 1, variables: [{ name: 'encryption-constant' }] } }), /Encryption Constant condition \(1% of cases\)/);
});
