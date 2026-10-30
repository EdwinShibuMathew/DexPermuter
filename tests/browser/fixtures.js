import { test as base, expect } from '@playwright/test';

export const API_ROOT = 'https://pokeapi.co/api/v2/';
export const CACHE_PREFIX = 'dexpermuter:v1:';
export const STREAM_PATH = '/DexPermuter/__test__/streams/';
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

/** The same lifecycle is used by normal tests and the failure-path self-test. */
export async function withApiFixture({ page, context, baseURL }, use) {
  const calls = [];
  const unexpected = [];
  const errors = [];
  const held = [];
  const queued = new Map();
  const requests = new Map();
  let active = 0;
  let maximum = 0;
  let shouldHold = () => false;
  const origin = new URL(baseURL).origin;
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);

  // Request identity distinguishes retries to the same URL. These events include
  // body download, unlike fetch's header-only fulfillment. Never wrap Response.
  const onRequest = request => {
    const url = request.url();
    const parsed = new URL(url);
    const streamed = parsed.origin === origin && parsed.pathname.startsWith(STREAM_PATH) && request.method() === 'GET';
    if (!url.startsWith(API_ROOT) && !streamed) return;
    requests.set(request, { url, aborted: false, done: false });
    active += 1;
    maximum = Math.max(maximum, active);
  };
  const finish = (request, aborted = false) => {
    const entry = requests.get(request);
    if (!entry || entry.done) return;
    entry.done = true;
    entry.aborted = aborted;
    active -= 1;
  };
  const onFinished = request => finish(request);
  const onFailed = request => finish(request, /ERR_ABORTED/.test(request.failure()?.errorText || ''));
  context.on('request', onRequest);
  context.on('requestfinished', onFinished);
  context.on('requestfailed', onFailed);

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
  // The context owns this guard. It must outlive api-fixture teardown, including
  // failures, screenshots, and any follow-up requests triggered during cleanup.
  await context.route('**/*', handler);
  context.once('close', () => {
    for (const request of requests.keys()) finish(request, true);
    held.length = 0;
    context.off('request', onRequest);
    context.off('requestfinished', onFinished);
    context.off('requestfailed', onFailed);
    page.off('pageerror', onError);
  });

  const api = {
    calls,
    count: resource => calls.filter(value => value === resource).length,
    hold: predicate => { shouldHold = predicate; },
    respondOnce(resource, data, status = 200) {
      queued.set(resource, [...(queued.get(resource) || []), { data, status }]);
    },
    async probe() {
      return { requests: [...requests.values()].map(entry => ({ ...entry })), active, maximum };
    },
    assertClean() {
      expect(unexpected, 'All external requests must have a local API fixture').toEqual([]);
      expect(errors, 'The real page must not throw uncaught errors').toEqual([]);
    },
    async release() {
      if (page.isClosed()) return;
      shouldHold = () => false;
      for (const entry of held.splice(0)) {
        const request = entry.route.request();
        if (requests.get(request)?.aborted || request.failure()) continue;
        try { await fulfill(entry.route, entry.data, entry.status); } catch (error) {
          if (!page.isClosed() && !requests.get(request)?.aborted && !request.failure()) throw error;
        }
      }
    },
  };
  try { await use(api); } finally {
    // Do not restart held work or remove interception. Playwright's normal
    // context closure cancels pending requests and preserves failure artifacts.
    api.assertClean();
  }
}

export const test = base.extend({
  api: async ({ page, context, baseURL }, use) => withApiFixture({ page, context, baseURL }, use),
});

export { expect };
