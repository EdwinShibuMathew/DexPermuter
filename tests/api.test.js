import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, STAT_KEYS, createApiClient, describeEvolutionMethod, summarizeEvolution } from '../js/api.js';

const root = 'https://pokeapi.co/api/v2/';
const response = data => ({ ok: true, json: async () => data });
const node = (name, children = [], details = []) => ({ species: { name }, evolves_to: children, evolution_details: details });
const level = number => ({ trigger: { name: 'level-up' }, min_level: number });

function memoryStorage() {
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

const speciesFixture = () => ({ name: 'bulbasaur', names: [], evolution_chain: { url: root + 'evolution-chain/1/' } });
const cacheKey = resource => 'dexpermuter:v1:' + root + resource;
const settle = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixtureFor(url) {
  if (url.includes('/pokemon/')) return pokemonFixture();
  if (url.includes('/pokemon-species/')) return speciesFixture();
  return { chain: node('bulbasaur') };
}

test('malformed resources are not cached and retries recover without refetching valid neighbors', async t => {
  const cases = [
    ['stats', 'pokemon/1/', { ...pokemonFixture(), stats: [] }],
    ['types', 'pokemon/1/', { ...pokemonFixture(), types: [{}] }],
    ['abilities', 'pokemon/1/', { ...pokemonFixture(), abilities: [null] }],
    ['species', 'pokemon-species/1/', { ...speciesFixture(), names: {} }],
    ['species chain URL', 'pokemon-species/1/', { ...speciesFixture(), evolution_chain: { url: root + 'pokemon/1/' } }],
    ['nested evolution', 'evolution-chain/1/', { chain: node('bulbasaur', [{ species: { name: 'ivysaur' }, evolves_to: {} }]) }],
    ['evolution conditions', 'evolution-chain/1/', { chain: node('bulbasaur', [node('ivysaur', [], [{ allowed_natures: {} }])]) }],
  ];
  for (const [label, resource, invalid] of cases) {
    await t.test(label, async () => {
      const storage = memoryStorage();
      const calls = new Map();
      let broken = true;
      const options = { storage, fetchImpl: async url => {
        calls.set(url, (calls.get(url) || 0) + 1);
        return response(broken && url === root + resource ? invalid : fixtureFor(url));
      } };
      const client = createApiClient(options);
      if (resource === 'pokemon/1/') await assert.rejects(client.getPokemon(1), ApiError);
      else assert.ok((await client.getPokemon(1)).evolutionError);
      assert.equal(storage.getItem(cacheKey(resource)), null);
      broken = false;
      assert.equal((await client.getPokemon(1)).evolutionError, null);
      assert.equal((await createApiClient(options).getPokemon(1)).bst, 318);
      assert.equal(calls.get(root + resource), 2);
      for (const [url, count] of calls) if (url !== root + resource) assert.equal(count, 1);
    });
  }
});

test('old malformed persisted resources are evicted and corrected on the first new load', async () => {
  for (const resource of ['pokemon/1/', 'pokemon-species/1/', 'evolution-chain/1/']) {
    const storage = memoryStorage();
    for (const other of ['pokemon/1/', 'pokemon-species/1/', 'evolution-chain/1/']) {
      storage.setItem(cacheKey(other), JSON.stringify({ savedAt: 1000, data: other === resource ? {} : fixtureFor(root + other) }));
    }
    const calls = [];
    const options = { storage, now: () => 1001, fetchImpl: async url => { calls.push(url); return response(fixtureFor(url)); } };
    assert.equal((await createApiClient(options).getPokemon(1)).evolutionError, null);
    assert.deepEqual(calls, [root + resource]);
    assert.equal((await createApiClient(options).getPokemon(1)).bst, 318);
    assert.equal(calls.length, 1);
  }
});

test('nullable species chains and unknown evolution conditions remain usable and cached', async () => {
  const storage = memoryStorage();
  const client = createApiClient({ storage, fetchImpl: async url => response(url.includes('/pokemon-species/') ? { ...speciesFixture(), evolution_chain: null } : pokemonFixture()) });
  const data = await client.getPokemon(1);
  assert.equal(data.bst, 318);
  assert.match(data.evolutionError, /No evolution chain/);
  assert.ok(storage.getItem(cacheKey('pokemon-species/1/')));
  const chain = { chain: node('bulbasaur', [node('ivysaur', [], [{ trigger: { name: 'future-trigger' }, future_requirement: true, held_item: null }])]) };
  const evolution = createApiClient({ storage: null, fetchImpl: async () => response(chain) });
  assert.match(summarizeEvolution(await evolution.fetchResource('evolution-chain/1/')), /special evolution method.*additional requirements/);
});

test('canceling one consumer preserves a coalesced request needed by another', async () => {
  const body = deferred();
  const controller = new AbortController();
  let networkSignal;
  let calls = 0;
  const client = createApiClient({ storage: null, fetchImpl: async (_, { signal }) => { calls += 1; networkSignal = signal; return { ok: true, json: () => body.promise }; } });
  const first = client.fetchResource('generation/1/', { signal: controller.signal });
  const canceled = assert.rejects(first, { name: 'AbortError' });
  const retained = client.fetchResource(root + 'generation/1/');
  await settle();
  controller.abort();
  await canceled;
  assert.equal(networkSignal.aborted, false);
  body.resolve({ id: 1 });
  assert.deepEqual(await retained, { id: 1 });
  assert.equal(calls, 1);
});

test('abandoning all consumers drops queued requests and frees the four active slots promptly', async () => {
  const controller = new AbortController();
  const starts = [];
  let active = 0;
  let maximum = 0;
  let aborted = 0;
  const client = createApiClient({ storage: null, fetchImpl: (url, { signal }) => {
    starts.push(url);
    active += 1;
    maximum = Math.max(maximum, active);
    if (url.endsWith('/100/')) { active -= 1; return Promise.resolve(response({ id: 100 })); }
    return new Promise((_, reject) => signal.addEventListener('abort', () => { active -= 1; aborted += 1; reject(signal.reason); }, { once: true }));
  } });
  const old = Promise.allSettled(Array.from({ length: 16 }, (_, index) => client.fetchResource(`generation/${index + 1}/`, { signal: controller.signal })));
  await settle();
  assert.equal(starts.length, 4);
  controller.abort();
  assert.deepEqual(await client.fetchResource('generation/100/'), { id: 100 });
  assert.ok((await old).every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(starts.length, 5);
  assert.equal(aborted, 4);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});

test('canceling before scheduling or a cache hit starts no network work', async () => {
  let calls = 0;
  const client = createApiClient({ storage: null, fetchImpl: async () => { calls += 1; return response({ id: 1 }); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.fetchResource('generation/1/', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(client.getPokemon(1, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const immediate = new AbortController();
  const canceled = assert.rejects(client.fetchResource('generation/2/', { signal: immediate.signal }), { name: 'AbortError' });
  immediate.abort();
  await canceled;
  await settle();
  assert.equal(calls, 0);
  await client.fetchResource('generation/1/');
  await assert.rejects(client.fetchResource('generation/1/', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a coalesced request aborts only when its last signaled consumer leaves', async () => {
  let networkSignal;
  let calls = 0;
  const first = new AbortController();
  const second = new AbortController();
  const client = createApiClient({ storage: null, fetchImpl: (_, { signal }) => {
    calls += 1;
    networkSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const a = assert.rejects(client.fetchResource('generation/1/', { signal: first.signal }), { name: 'AbortError' });
  const b = assert.rejects(client.fetchResource('generation/1/', { signal: second.signal }), { name: 'AbortError' });
  await settle();
  first.abort();
  await a;
  assert.equal(networkSignal.aborted, false);
  second.abort();
  await b;
  assert.equal(networkSignal.aborted, true);
  assert.equal(calls, 1);
});

test('a canceled body cannot poison caching or delete a replacement pending request', async () => {
  const storage = memoryStorage();
  const bodies = [deferred(), deferred()];
  const signals = [];
  let calls = 0;
  const options = { storage, fetchImpl: async (_, { signal }) => {
    signals.push(signal);
    const body = bodies[calls++];
    return { ok: true, json: () => body.promise };
  } };
  const client = createApiClient(options);
  const controller = new AbortController();
  const old = assert.rejects(client.fetchResource('generation/1/', { signal: controller.signal }), { name: 'AbortError' });
  await settle();
  controller.abort();
  const replacement = client.fetchResource('generation/1/');
  await old;
  await settle();
  const joined = client.fetchResource('generation/1/');
  assert.equal(signals[0].aborted, true);
  bodies[0].resolve({ id: 'obsolete' });
  await settle();
  assert.equal(storage.getItem(cacheKey('generation/1/')), null);
  bodies[1].resolve({ id: 'current' });
  assert.deepEqual(await replacement, { id: 'current' });
  assert.deepEqual(await joined, { id: 'current' });
  assert.deepEqual(await createApiClient(options).fetchResource('generation/1/'), { id: 'current' });
  assert.equal(calls, 2);
});

test('getPokemon propagates cancellation during species and evolution loading', async () => {
  for (const stalled of ['/pokemon-species/', '/evolution-chain/']) {
    const controller = new AbortController();
    const started = deferred();
    const client = createApiClient({ storage: null, fetchImpl: async (url, { signal }) => {
      if (!url.includes(stalled)) return response(fixtureFor(url));
      started.resolve();
      return { ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
    } });
    const canceled = assert.rejects(client.getPokemon(1, { signal: controller.signal }), { name: 'AbortError' });
    await started.promise;
    controller.abort();
    await canceled;
  }
});

test('expired entries are reclaimed after quota exhaustion and caching works across reloads', async () => {
  const storage = memoryStorage();
  const save = storage.setItem;
  storage.setItem('unrelated', 'keep');
  storage.setItem = (key, value) => {
    if (!storage.values.has(key) && [...storage.values.keys()].some(key => key.startsWith('dexpermuter:v1:'))) throw new DOMException('Full', 'QuotaExceededError');
    save(key, value);
  };
  let clock = 1000;
  let calls = 0;
  const options = { storage, now: () => clock, cacheTtlMs: 100, fetchImpl: async () => { calls += 1; return response(pokemonFixture()); } };
  await createApiClient(options).fetchResource('pokemon/1/');
  clock += 100;
  await createApiClient(options).fetchResource('pokemon/2/');
  await createApiClient(options).fetchResource('pokemon/2/');
  assert.equal(calls, 2);
  assert.equal(storage.getItem(cacheKey('pokemon/1/')), null);
  assert.ok(storage.getItem(cacheKey('pokemon/2/')));
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('quota recovery prunes all invalid owned entries and preserves fresh and unrelated data', async () => {
  const storage = memoryStorage();
  const entry = (savedAt, data = pokemonFixture()) => JSON.stringify({ savedAt, data });
  for (const [key, value] of [
    [cacheKey('pokemon/1/'), entry(500)],
    [cacheKey('pokemon/2/'), '{broken'],
    [cacheKey('pokemon/3/'), entry(2000)],
    [cacheKey('pokemon/4/'), entry(1000, {})],
    [cacheKey('pokemon/5/'), entry(1000)],
    ['other-app', 'keep'],
    ['dexpermuter:v2:future', 'keep'],
  ]) storage.setItem(key, value);
  const save = storage.setItem;
  let writes = 0;
  storage.setItem = (key, value) => {
    writes += 1;
    if (storage.length >= 7) throw new DOMException('Full', 'QuotaExceededError');
    save(key, value);
  };
  const client = createApiClient({ storage, now: () => 1001, cacheTtlMs: 100, fetchImpl: async () => response(pokemonFixture()) });
  await client.fetchResource('pokemon/6/');
  assert.equal(writes, 2);
  for (const id of [1, 2, 3, 4]) assert.equal(storage.getItem(cacheKey(`pokemon/${id}/`)), null);
  assert.equal(storage.getItem(cacheKey('pokemon/5/')), entry(1000));
  assert.ok(storage.getItem(cacheKey('pokemon/6/')));
  assert.equal(storage.getItem('other-app'), 'keep');
  assert.equal(storage.getItem('dexpermuter:v2:future'), 'keep');
});

test('invalid persisted envelopes are removed on read, including null and future timestamps', async () => {
  for (const invalid of ['null', 'false', '{broken', JSON.stringify({ savedAt: 2000, data: pokemonFixture() }), JSON.stringify({ savedAt: 1000, data: [] })]) {
    const storage = memoryStorage();
    storage.setItem(cacheKey('pokemon/1/'), invalid);
    const remove = storage.removeItem;
    let removed = false;
    storage.removeItem = key => { if (key === cacheKey('pokemon/1/')) removed = true; remove(key); };
    const client = createApiClient({ storage, now: () => 1001, fetchImpl: async () => response(pokemonFixture()) });
    assert.equal((await client.fetchResource('pokemon/1/')).name, 'bulbasaur');
    assert.equal(removed, true);
  }
});

test('persistent failures retry at most once and retain memory caching and fresh entries', async () => {
  for (const failure of ['quota', 'enumeration', 'removal']) {
    const storage = memoryStorage();
    const fresh = JSON.stringify({ savedAt: 1000, data: pokemonFixture() });
    storage.setItem(cacheKey('pokemon/9/'), fresh);
    if (failure === 'enumeration') storage.key = () => { throw new Error('Blocked'); };
    if (failure === 'removal') {
      storage.setItem(cacheKey('pokemon/8/'), '{broken');
      storage.removeItem = () => { throw new Error('Blocked'); };
    }
    let writes = 0;
    let calls = 0;
    storage.setItem = () => { writes += 1; throw new Error('Full'); };
    const client = createApiClient({ storage, now: () => 1001, fetchImpl: async () => { calls += 1; return response(pokemonFixture()); } });
    await client.fetchResource('pokemon/1/');
    await client.fetchResource('pokemon/1/');
    assert.equal(calls, 1);
    assert.ok(writes >= 1 && writes <= 2);
    assert.equal(storage.getItem(cacheKey('pokemon/9/')), fresh);
  }
});

test('pruning an old persisted copy preserves a newer memory response if the retry fails', async () => {
  const storage = memoryStorage();
  storage.setItem(cacheKey('pokemon/1/'), JSON.stringify({ savedAt: 500, data: pokemonFixture() }));
  const remove = storage.removeItem;
  let removals = 0;
  let writes = 0;
  let calls = 0;
  storage.removeItem = key => {
    removals += 1;
    if (removals === 1) throw new Error('Temporarily blocked');
    remove(key);
  };
  storage.setItem = () => { writes += 1; throw new Error('Full'); };
  const client = createApiClient({ storage, now: () => 1001, cacheTtlMs: 100, fetchImpl: async () => { calls += 1; return response(pokemonFixture()); } });
  await client.fetchResource('pokemon/1/');
  await client.fetchResource('pokemon/1/');
  assert.equal(calls, 1);
  assert.equal(writes, 2);
  assert.equal(storage.getItem(cacheKey('pokemon/1/')), null);
});

test('coalesces matching in-flight URLs and caches in memory', async () => {
  let calls = 0;
  const client = createApiClient({ storage: null, fetchImpl: async () => { calls += 1; return response({ id: 1 }); } });
  const results = await Promise.all([client.fetchResource('generation/1/'), client.fetchResource(root + 'generation/1/')]);
  assert.deepEqual(results, [{ id: 1 }, { id: 1 }]);
  await client.fetchResource('generation/1/');
  assert.equal(calls, 1);
});

test('persists across clients, then expires cached responses', async () => {
  const storage = memoryStorage();
  let calls = 0;
  let clock = 1000;
  const options = { storage, now: () => clock, cacheTtlMs: 100, fetchImpl: async () => response({ calls: ++calls }) };
  await createApiClient(options).fetchResource('generation/1/');
  assert.deepEqual(await createApiClient(options).fetchResource('generation/1/'), { calls: 1 });
  clock += 100;
  assert.deepEqual(await createApiClient(options).fetchResource('generation/1/'), { calls: 2 });
});

test('corrupt or blocked storage does not prevent requests or memory caching', async () => {
  for (const storage of [
    { getItem: () => '{broken', setItem() { throw new Error('Full'); } },
    { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } },
  ]) {
    let calls = 0;
    const client = createApiClient({ storage, fetchImpl: async () => { calls += 1; return response({ id: 1 }); } });
    await client.fetchResource('generation/1/');
    await client.fetchResource('generation/1/');
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
  const results = await Promise.allSettled(Array.from({ length: 15 }, (_, index) => client.fetchResource(`generation/${index + 1}/`)));
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
  await assert.rejects(client.fetchResource('generation/1/'), error => error instanceof ApiError && error.status === 404);
  await assert.rejects(client.fetchResource('generation/1/'), /connection/);
  assert.deepEqual(await client.fetchResource('generation/1/'), { id: 1 });
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
  const results = await Promise.allSettled([client.fetchResource('generation/1/'), client.fetchResource('generation/2/')]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /too long/);
  assert.equal(aborted, true);
  assert.deepEqual(results[1].value, { id: 2 });
});

test('rejects unexpected resource origins and invalid top-level JSON', async () => {
  const client = createApiClient({ storage: null, fetchImpl: async () => response([]) });
  await assert.rejects(client.fetchResource('https://example.com/api/v2/generation/1/'), /unexpected/);
  await assert.rejects(client.fetchResource('generation/1/'), /invalid data/);
});

test('normalizes names, type order, abilities, six stats, and BST', async () => {
  const client = createApiClient({ storage: null, fetchImpl: async url => {
    if (url.includes('/pokemon/')) return response(pokemonFixture());
    if (url.includes('/pokemon-species/')) return response({ name: 'bulbasaur', names: [{ language: { name: 'en' }, name: 'Bulbasaur' }], evolution_chain: { url: root + 'evolution-chain/1/' } });
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
      if (url.includes('/pokemon-species/')) return response({ name: 'bulbasaur', names: [], evolution_chain: { url: root + 'evolution-chain/1/' } });
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
