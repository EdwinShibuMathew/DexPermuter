import { validateDexNumber } from './permute.js';

const API_ROOT = 'https://pokeapi.co/api/v2/';
const CACHE_PREFIX = 'dexpermuter:v1:';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const STAT_KEYS = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function displayName(value = '') {
  return value.replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

/** Format conditions without assuming a particular game or default regional form. */
export function describeEvolutionMethod(detail = {}) {
  const trigger = detail.trigger?.name;
  const conditions = [];
  if (trigger === 'level-up') {
    conditions.push(detail.min_level != null ? `at level ${detail.min_level} or higher` : 'by leveling up');
  } else if (trigger === 'trade') {
    conditions.push('by trading');
  } else if (trigger === 'use-item') {
    conditions.push(detail.item ? `using ${displayName(detail.item.name)}` : 'using an evolution item');
  } else {
    const triggers = {
      shed: 'with a spare party slot and a Poké Ball when Nincada evolves',
      spin: 'by spinning',
      'tower-of-darkness': 'by completing the Tower of Darkness',
      'tower-of-waters': 'by completing the Tower of Waters',
      'three-critical-hits': 'after landing three critical hits in one battle',
      'take-damage': 'after taking the required damage',
      'agile-style-move': 'by using the required move in Agile Style',
      'strong-style-move': 'by using the required move in Strong Style',
      'recoil-damage': 'after taking the required recoil damage',
    };
    conditions.push(triggers[trigger] || 'by a special evolution method (check your game)');
    if (detail.min_level != null) conditions.push(`at level ${detail.min_level} or higher`);
  }
  if (detail.item && trigger !== 'use-item') conditions.push(`using ${displayName(detail.item.name)}`);
  if (detail.held_item) conditions.push(`while holding ${displayName(detail.held_item.name)}`);
  if (detail.trade_species) conditions.push(`in exchange for ${displayName(detail.trade_species.name)}`);
  if (detail.gender != null) conditions.push(`while ${detail.gender === 1 ? 'female' : detail.gender === 2 ? 'male' : 'the required gender'}`);
  if (detail.min_happiness != null) conditions.push(`with friendship of at least ${detail.min_happiness}`);
  if (detail.min_beauty != null) conditions.push(`with beauty of at least ${detail.min_beauty}`);
  if (detail.min_affection != null) conditions.push(`with affection of at least ${detail.min_affection}`);
  if (detail.time_of_day) conditions.push(`during ${displayName(detail.time_of_day).toLowerCase()}`);
  if (detail.known_move) conditions.push(`knowing ${displayName(detail.known_move.name)}`);
  if (detail.known_move_type) conditions.push(`knowing a ${displayName(detail.known_move_type.name)} move`);
  if (detail.location) conditions.push(`at ${displayName(detail.location.name)}`);
  if (detail.region) conditions.push(`in ${displayName(detail.region.name)}`);
  if (detail.required_pokemon_form) conditions.push(`from the ${displayName(detail.required_pokemon_form.name)} form`);
  if (detail.evolved_pokemon_form) conditions.push(`into the ${displayName(detail.evolved_pokemon_form.name)} form`);
  if (detail.near_special_rock) conditions.push('near the required special rock');
  if (detail.needs_multiplayer) conditions.push('during multiplayer link play');
  if (detail.needs_overworld_rain) conditions.push('while it is raining in the overworld');
  if (detail.turn_upside_down) conditions.push('with the console held upside down');
  if (detail.party_species) conditions.push(`with ${displayName(detail.party_species.name)} in the party`);
  if (detail.party_type) conditions.push(`with a ${displayName(detail.party_type.name)} Pokémon in the party`);
  if (detail.relative_physical_stats != null) {
    const relation = { '-1': 'lower than', 0: 'equal to', 1: 'higher than' }[detail.relative_physical_stats];
    conditions.push(relation ? `with Attack ${relation} Defense` : 'with the required Attack/Defense relationship');
  }
  if (detail.used_move) {
    const count = detail.min_move_count != null ? ` at least ${detail.min_move_count} times` : '';
    conditions.push(`after using ${displayName(detail.used_move.name)}${count}`);
  } else if (detail.min_move_count != null) {
    conditions.push(`after using the required move at least ${detail.min_move_count} times`);
  }
  if (detail.min_steps != null) conditions.push(`after walking at least ${detail.min_steps} steps`);
  if (detail.min_damage_taken != null) conditions.push(`after taking at least ${detail.min_damage_taken} damage`);
  if (detail.allowed_natures?.length) conditions.push(`with a ${detail.allowed_natures.map(nature => displayName(nature.name)).join(' or ')} nature`);
  if (detail.condition_expression) {
    const expression = detail.condition_expression;
    const variables = expression.variables?.map(variable => displayName(variable.name)).join(', ');
    const chance = expression.percentage_chance;
    conditions.push(`with an additional ${variables || 'game-specific'} condition${chance != null ? ` (${chance}% of cases)` : ''}`);
  }
  const knownFields = new Set([
    'trigger', 'item', 'held_item', 'trade_species', 'gender', 'min_level', 'min_happiness',
    'min_beauty', 'min_affection', 'time_of_day', 'known_move', 'known_move_type', 'location',
    'region', 'required_pokemon_form', 'evolved_pokemon_form', 'near_special_rock',
    'needs_multiplayer', 'needs_overworld_rain', 'turn_upside_down', 'party_species',
    'party_type', 'relative_physical_stats', 'used_move', 'min_move_count', 'min_steps',
    'min_damage_taken', 'allowed_natures', 'condition_expression', 'version_group', 'is_default',
  ]);
  const hasUnknownCondition = Object.entries(detail).some(([key, value]) =>
    !knownFields.has(key) && value != null && value !== false && value !== '' && (!Array.isArray(value) || value.length > 0));
  if (hasUnknownCondition) conditions.push('with additional requirements (check your game)');
  return conditions.join(', ');
}

/** Describe the complete family, retaining each branch and alternative method. */
export function summarizeEvolution(evolutionChain) {
  const root = evolutionChain?.chain;
  if (!root?.species?.name) throw new ApiError('Evolution data is incomplete.');
  if (!root.evolves_to?.length) return `${displayName(root.species.name)} does not evolve.`;
  const sentences = [];
  function visit(parent) {
    for (const child of parent.evolves_to || []) {
      const details = child.evolution_details || [];
      const methods = [...new Set(details.map(describeEvolutionMethod))];
      const condition = methods.length ? methods.join('; alternatively, ') : 'by a method not specified in PokéAPI';
      sentences.push(`${displayName(parent.species.name)} evolves into ${displayName(child.species.name)} ${condition}.`);
      visit(child);
    }
  }
  visit(root);
  return sentences.join(' ');
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function resourceUrl(resource) {
  const parsed = new URL(resource, API_ROOT);
  if (parsed.origin !== 'https://pokeapi.co' || !parsed.pathname.startsWith('/api/v2/')) throw new ApiError('An unexpected API resource was requested.');
  parsed.hash = '';
  return parsed.href;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = value => typeof value === 'string' && value.trim().length > 0;
const isNamedResource = value => isObject(value) && isName(value.name);

function validEvolutionDetail(detail) {
  if (!isObject(detail)) return false;
  const namedConditions = ['trigger', 'item', 'held_item', 'trade_species', 'known_move', 'known_move_type', 'location', 'region', 'required_pokemon_form', 'evolved_pokemon_form', 'party_species', 'party_type', 'used_move'];
  if (!namedConditions.every(key => detail[key] == null || isNamedResource(detail[key]))) return false;
  if (detail.allowed_natures != null && (!Array.isArray(detail.allowed_natures) || !detail.allowed_natures.every(isNamedResource))) return false;
  const expression = detail.condition_expression;
  return expression == null || (isObject(expression) && (expression.variables == null ||
    (Array.isArray(expression.variables) && expression.variables.every(isNamedResource))));
}

/** Check only the resource fields this application consumes, not the full API schema. */
function validateResource(url, data) {
  if (!isObject(data)) throw new ApiError('PokéAPI returned invalid data. Please retry.');
  const family = new URL(url).pathname.match(/^\/api\/v2\/(pokemon|pokemon-species|evolution-chain)\/[^/]+\/?$/)?.[1];
  if (family === 'pokemon') {
    if (!isName(data.name) || !Array.isArray(data.stats) || !Array.isArray(data.types) || !Array.isArray(data.abilities)) throw new ApiError('Pokémon data is incomplete. Please retry.');
    for (const key of STAT_KEYS) {
      const value = data.stats.find(stat => stat?.stat?.name === key)?.base_stat;
      if (!Number.isInteger(value) || value < 0) throw new ApiError('Pokémon stats are incomplete. Please retry.');
    }
    if (!data.types.length || !data.types.every(entry => isNamedResource(entry?.type) && Number.isInteger(entry.slot)) ||
        !data.abilities.every(entry => isNamedResource(entry?.ability) && Number.isInteger(entry.slot) && typeof entry.is_hidden === 'boolean')) {
      throw new ApiError('Pokémon types or abilities are incomplete. Please retry.');
    }
  } else if (family === 'pokemon-species') {
    if (!isName(data.name) || !Array.isArray(data.names) || !data.names.every(entry => isName(entry?.name) && isNamedResource(entry.language)) ||
        !Object.hasOwn(data, 'evolution_chain') || (data.evolution_chain !== null && !isName(data.evolution_chain?.url))) {
      throw new ApiError('Species data is incomplete. Please retry.');
    }
    if (data.evolution_chain && !/^\/api\/v2\/evolution-chain\/[^/]+\/?$/.test(new URL(resourceUrl(data.evolution_chain.url)).pathname)) {
      throw new ApiError('Species evolution data is incomplete. Please retry.');
    }
  } else if (family === 'evolution-chain') {
    const links = [data.chain];
    while (links.length) {
      const link = links.pop();
      if (!isNamedResource(link?.species) || !Array.isArray(link.evolves_to) ||
          (link.evolution_details != null && (!Array.isArray(link.evolution_details) || !link.evolution_details.every(validEvolutionDetail)))) {
        throw new ApiError('Evolution data is incomplete. Please retry.');
      }
      links.push(...link.evolves_to);
    }
    // The formatter also checks optional conditions that can contain nested lists.
    try { summarizeEvolution(data); } catch { throw new ApiError('Evolution data is incomplete. Please retry.'); }
  }
}

/** Dependencies can be supplied for offline tests; browser defaults need no setup. */
export function createApiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  storage = browserStorage(),
  concurrency = 4,
  timeoutMs = 10_000,
  cacheTtlMs = WEEK_MS,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be a positive integer.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Timeout must be positive.');
  const memory = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      entry.state = 'active';
      active += 1;
      Promise.resolve().then(() => request(entry.url, entry.controller)).then(
        data => finish(entry, null, data),
        error => finish(entry, error),
      ).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function finish(entry, error, data) {
    entry.state = 'settled';
    if (pending.get(entry.url) === entry) pending.delete(entry.url);
    for (const consumer of entry.consumers) {
      consumer.cleanup();
      if (error) consumer.reject(error);
      else consumer.resolve(data);
    }
    entry.consumers.clear();
  }

  function subscribe(entry, signal) {
    return new Promise((resolve, reject) => {
      const consumer = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
      function cancel() {
        consumer.cleanup();
        entry.consumers.delete(consumer);
        reject(new DOMException('The request was canceled.', 'AbortError'));
        if (!entry.consumers.size) {
          if (pending.get(entry.url) === entry) pending.delete(entry.url);
          if (entry.state === 'queued') queue.splice(queue.indexOf(entry), 1);
          entry.controller.abort();
        }
      }
      entry.consumers.add(consumer);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  function evictCache(url) {
    memory.delete(url);
    try { storage?.removeItem(CACHE_PREFIX + url); } catch { /* Storage can be blocked. */ }
  }

  function validEntry(url, entry) {
    if (!entry || !Number.isFinite(entry.savedAt)) return false;
    const age = now() - entry.savedAt;
    if (age < 0 || age >= cacheTtlMs) return false;
    try { validateResource(url, entry.data); return true; } catch { return false; }
  }

  function readCache(url) {
    let entry = memory.get(url);
    if (!entry) {
      try { entry = JSON.parse(storage?.getItem(CACHE_PREFIX + url) || 'null'); } catch { evictCache(url); return null; }
    }
    if (!validEntry(url, entry)) {
      evictCache(url);
      return null;
    }
    memory.set(url, entry);
    return entry.data;
  }

  function pruneStorage() {
    // Snapshot keys before deletion; Storage indexes shift when entries are removed.
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(CACHE_PREFIX)) continue;
      const url = key.slice(CACHE_PREFIX.length);
      let valid = false;
      try { valid = resourceUrl(url) === url && validEntry(url, JSON.parse(storage.getItem(key))); } catch { /* Invalid owned entry. */ }
      if (!valid) {
        // Remove only the persisted copy; memory may hold a newer response.
        storage.removeItem(key);
      }
    }
  }

  function writeCache(url, data) {
    const entry = { savedAt: now(), data };
    memory.set(url, entry);
    if (!storage) return;
    try { storage.setItem(CACHE_PREFIX + url, JSON.stringify(entry)); } catch {
      try {
        pruneStorage();
        storage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
      } catch { /* In-memory caching remains available when storage is full or blocked. */ }
    }
  }

  async function request(url, controller) {
    const { signal } = controller;
    signal.throwIfAborted();
    let onAbort;
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new ApiError('PokéAPI took too long to respond. Please retry.')), timeoutMs);
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
          if (!response.ok) {
            throw new ApiError(response.status === 404 ? 'This Pokémon resource was not found (404).' : `PokéAPI returned an error (${response.status}). Please retry.`, response.status);
          }
          return response.json();
        })(),
        canceled,
      ]);
      signal.throwIfAborted();
      validateResource(url, data);
      writeCache(url, data);
      return data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApiError) throw error;
      throw new ApiError('Could not reach PokéAPI. Check your connection and retry.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function fetchResource(resource, { signal } = {}) {
    signal?.throwIfAborted();
    const url = resourceUrl(resource);
    const cached = readCache(url);
    if (cached) return cached;
    let entry = pending.get(url);
    if (!entry) {
      entry = { url, controller: new AbortController(), consumers: new Set(), state: 'queued' };
      pending.set(url, entry);
      queue.push(entry);
    }
    const promise = subscribe(entry, signal);
    pump();
    return promise;
  }

  async function getPokemon(number, { signal } = {}) {
    validateDexNumber(number);
    signal?.throwIfAborted();
    const [pokemonResult, speciesResult] = await Promise.allSettled([
      fetchResource(`pokemon/${number}/`, { signal }),
      fetchResource(`pokemon-species/${number}/`, { signal }),
    ]);
    signal?.throwIfAborted();
    if (pokemonResult.status === 'rejected') throw pokemonResult.reason;
    const pokemon = pokemonResult.value;
    if (!pokemon.name || !Array.isArray(pokemon.stats) || !Array.isArray(pokemon.types) || !Array.isArray(pokemon.abilities)) throw new ApiError('Pokémon data is incomplete. Please retry.');
    const stats = STAT_KEYS.map(key => {
      const value = pokemon.stats.find(stat => stat?.stat?.name === key)?.base_stat;
      if (!Number.isInteger(value) || value < 0) throw new ApiError('Pokémon stats are incomplete. Please retry.');
      return { key, value };
    });
    const species = speciesResult.status === 'fulfilled' ? speciesResult.value : null;
    const name = species?.names?.find(entry => entry.language?.name === 'en')?.name || displayName(species?.name || pokemon.name);
    const abilities = [...pokemon.abilities].sort((a, b) => a.slot - b.slot);
    const data = {
      number,
      name,
      types: [...pokemon.types].sort((a, b) => a.slot - b.slot).map(entry => entry.type.name),
      abilities: abilities.filter(entry => !entry.is_hidden).map(entry => displayName(entry.ability.name)),
      hiddenAbilities: abilities.filter(entry => entry.is_hidden).map(entry => displayName(entry.ability.name)),
      stats,
      bst: stats.reduce((sum, stat) => sum + stat.value, 0),
      evolution: 'Evolution information is unavailable.',
      evolutionError: null,
    };
    try {
      if (speciesResult.status === 'rejected') throw speciesResult.reason;
      if (!species?.evolution_chain?.url) throw new ApiError('No evolution chain was provided by PokéAPI.');
      data.evolution = summarizeEvolution(await fetchResource(species.evolution_chain.url, { signal }));
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      data.evolutionError = error.message || 'Evolution information could not be loaded.';
    }
    signal?.throwIfAborted();
    return data;
  }

  return { fetchResource, getPokemon };
}
