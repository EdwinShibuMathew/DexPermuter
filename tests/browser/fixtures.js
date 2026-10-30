import { test as base, expect } from '@playwright/test';

export const API_ROOT = 'https://pokeapi.co/api/v2/';
export const CACHE_PREFIX = 'dexpermuter:v1:';
const STAT_KEYS = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];
const NAMES = { 1: 'Bulbasaur', 10: 'Caterpie', 100: 'Voltorb', 1000: 'Gholdengo' };

export function apiData(resource) {
  const match = resource.match(/^(pokemon|pokemon-species|evolution-chain)\/(\d+)\/$/);
  if (!match) throw new Error(`Unexpected fixture resource: ${resource}`);
  const [, family, id] = match;
  const name = (NAMES[id] || `pokemon-${id}`).toLowerCase();
  if (family === 'pokemon') {
    return {
      name,
      stats: STAT_KEYS.map((key, index) => ({ stat: { name: key }, base_stat: [45, 49, 49, 65, 65, 45][index] })),
      types: (id === '1' ? ['grass', 'poison'] : ['normal']).map((type, index) => ({ slot: index + 1, type: { name: type } })),
      abilities: [
        { slot: 1, is_hidden: false, ability: { name: 'overgrow' } },
        { slot: 3, is_hidden: true, ability: { name: 'chlorophyll' } },
      ],
    };
  }
  if (family === 'pokemon-species') {
    return { name, names: [{ name: NAMES[id] || `Pokémon ${id}`, language: { name: 'en' } }], evolution_chain: { url: `${API_ROOT}evolution-chain/${id}/` } };
  }
  return { chain: { species: { name }, evolution_details: [], evolves_to: [] } };
}

export async function freezeTime(page) {
  await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-30T12:00:01Z'));
}

export async function submit(page, value) {
  const input = page.getByLabel('YOUR STARTING POKÉDEX NUMBER');
  await input.fill(value);
  await input.press('Enter');
}

export const test = base.extend({
  api: async ({ page, baseURL }, use) => {
    const calls = [];
    const unexpected = [];
    const errors = [];
    const held = [];
    const queued = new Map();
    let shouldHold = () => false;
    const origin = new URL(baseURL).origin;
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);

    // Observe real AbortSignals without changing application code or fetch results.
    await page.addInitScript(apiRoot => {
      const original = window.fetch.bind(window);
      const probe = { requests: [], active: 0, maximum: 0 };
      window.__dexProbe = probe;
      window.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith(apiRoot)) return original(input, options);
        const signal = options?.signal;
        const entry = { url, aborted: Boolean(signal?.aborted) };
        let finished = false;
        const finish = () => {
          if (!finished) { finished = true; probe.active -= 1; }
        };
        const abort = () => { entry.aborted = true; finish(); };
        probe.requests.push(entry);
        probe.active += 1;
        probe.maximum = Math.max(probe.maximum, probe.active);
        signal?.addEventListener('abort', abort, { once: true });
        return original(input, options).finally(() => {
          finish();
          signal?.removeEventListener('abort', abort);
        });
      };
    }, API_ROOT);

    const fulfill = (route, data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(data),
    });
    const handler = async route => {
      const url = route.request().url();
      if (new URL(url).origin === origin) { await route.continue(); return; }
      if (!url.startsWith(API_ROOT)) {
        unexpected.push(url);
        await route.abort();
        return;
      }
      const resource = url.slice(API_ROOT.length);
      calls.push(resource);
      let data;
      try { data = apiData(resource); } catch {
        unexpected.push(url);
        await route.abort();
        return;
      }
      const next = queued.get(resource)?.shift();
      const response = next || { data, status: 200 };
      if (shouldHold(resource)) held.push({ route, url, ...response });
      else await fulfill(route, response.data, response.status);
    };
    await page.route('**/*', handler);

    const api = {
      calls,
      count: resource => calls.filter(value => value === resource).length,
      hold: predicate => { shouldHold = predicate; },
      respondOnce(resource, data, status = 200) {
        queued.set(resource, [...(queued.get(resource) || []), { data, status }]);
      },
      async probe() { return page.evaluate(() => window.__dexProbe); },
      async release() {
        shouldHold = () => false;
        const probe = await api.probe();
        const canceled = new Set(probe.requests.filter(entry => entry.aborted).map(entry => entry.url));
        for (const entry of held.splice(0)) {
          if (entry.route.request().failure()) continue;
          try { await fulfill(entry.route, entry.data, entry.status); } catch (error) {
            if (!canceled.has(entry.url) && !entry.route.request().failure()) throw error;
          }
        }
      },
    };
    try { await use(api); } finally {
      // Release held routes before Playwright closes the page, including after failures.
      if (!page.isClosed()) {
        await api.release();
        await page.unroute('**/*', handler);
      }
      page.off('pageerror', onError);
      expect(unexpected, 'All external requests must have a local API fixture').toEqual([]);
      expect(errors, 'The real page must not throw uncaught errors').toEqual([]);
    }
  },
});

export { expect };
