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
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function readCache(url) {
    let entry = memory.get(url);
    if (!entry) {
      try { entry = JSON.parse(storage?.getItem(CACHE_PREFIX + url) || 'null'); } catch { return null; }
    }
    if (!entry || !Number.isFinite(entry.savedAt) || now() - entry.savedAt < 0 || now() - entry.savedAt >= cacheTtlMs || !entry.data || typeof entry.data !== 'object') return null;
    memory.set(url, entry);
    return entry.data;
  }

  function writeCache(url, data) {
    const entry = { savedAt: now(), data };
    memory.set(url, entry);
    try { storage?.setItem(CACHE_PREFIX + url, JSON.stringify(entry)); } catch { /* In-memory caching remains available when storage is full or blocked. */ }
  }

  async function request(url) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiError('PokéAPI took too long to respond. Please retry.'));
      }, timeoutMs);
    });
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (!response.ok) {
            throw new ApiError(response.status === 404 ? 'This Pokémon resource was not found (404).' : `PokéAPI returned an error (${response.status}). Please retry.`, response.status);
          }
          const json = await response.json();
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ApiError('PokéAPI returned invalid data. Please retry.');
          return json;
        })(),
        timeout,
      ]);
      writeCache(url, data);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) throw new ApiError('PokéAPI took too long to respond. Please retry.');
      throw new ApiError('Could not reach PokéAPI. Check your connection and retry.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchResource(resource) {
    const parsed = new URL(resource, API_ROOT);
    if (parsed.origin !== 'https://pokeapi.co' || !parsed.pathname.startsWith('/api/v2/')) throw new ApiError('An unexpected API resource was requested.');
    parsed.hash = '';
    const url = parsed.href;
    const cached = readCache(url);
    if (cached) return cached;
    if (pending.has(url)) return pending.get(url);
    const promise = schedule(() => request(url));
    pending.set(url, promise);
    try { return await promise; } finally { pending.delete(url); }
  }

  async function getPokemon(number) {
    validateDexNumber(number);
    const [pokemonResult, speciesResult] = await Promise.allSettled([
      fetchResource(`pokemon/${number}/`),
      fetchResource(`pokemon-species/${number}/`),
    ]);
    if (pokemonResult.status === 'rejected') throw pokemonResult.reason;
    const pokemon = pokemonResult.value;
    if (!pokemon.name || !Array.isArray(pokemon.stats) || !Array.isArray(pokemon.types) || !Array.isArray(pokemon.abilities)) throw new ApiError('Pokémon data is incomplete. Please retry.');
    const stats = STAT_KEYS.map(key => {
      const value = pokemon.stats.find(stat => stat.stat?.name === key)?.base_stat;
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
      data.evolution = summarizeEvolution(await fetchResource(species.evolution_chain.url));
    } catch (error) {
      data.evolutionError = error.message || 'Evolution information could not be loaded.';
    }
    return data;
  }

  return { fetchResource, getPokemon };
}
