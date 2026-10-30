import { test, expect, API_ROOT, CACHE_PREFIX, apiData, freezeTime, submit } from './fixtures.js';

test('validates input, debounces searches, and renders accessible sorted cards', async ({ page, api }) => {
  await freezeTime(page);
  await page.goto('./');
  const input = page.getByLabel('YOUR STARTING POKÉDEX NUMBER');
  await expect(page.getByText('A new lineup is a few digits away.')).toBeVisible();
  for (const invalid of ['0', '1026', '1.5']) {
    await submit(page, invalid);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#input-error')).toContainText('1 to 1025');
    await expect(page.locator('.pokemon-card')).toHaveCount(0);
  }
  await input.fill('1');
  await page.clock.runFor(249);
  expect(api.calls).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expect(page.locator('.dex-number')).toHaveText(['#0001', '#0010', '#0100', '#1000']);
  const card = page.getByRole('article', { name: '#0001 Bulbasaur', exact: true });
  await expect(card.getByRole('heading', { name: 'Bulbasaur', exact: true })).toBeVisible();
  await expect(card.locator('.type-badge')).toHaveText(['Grass', 'Poison']);
  await expect(card.locator('.abilities')).toContainText('Overgrow');
  await expect(card.locator('.abilities')).toContainText('Chlorophyll');
  await expect(card.locator('.bst')).toHaveText('318');
  await expect(card.locator('.stat-row')).toHaveCount(6);
  await expect(card.locator('.evolution')).toContainText('Bulbasaur does not evolve.');
  await input.focus();
  await page.keyboard.press('Tab');
  const shuffle = page.getByRole('button', { name: 'Find digit permutations' });
  await expect(shuffle).toBeFocused();
  await expect(shuffle).toHaveCSS('outline-style', 'solid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const count = api.calls.length;
  await submit(page, '100');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.calls).toHaveLength(count);
  await input.fill('');
  await page.clock.runFor(250);
  await expect(page.locator('.pokemon-card')).toHaveCount(0);
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('malformed HTTP 200 data can be retried and valid resources survive reload', async ({ page, api }) => {
  api.respondOnce('pokemon/1/', { ...apiData('pokemon/1/'), stats: [] });
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('3 loaded · 1 failed');
  await page.getByRole('button', { name: 'Retry Pokémon', exact: true }).click();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.count('pokemon/1/')).toBe(2);
  expect(api.count('pokemon-species/1/')).toBe(1);
  const count = api.calls.length;
  await page.reload();
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.calls).toHaveLength(count);
});

test('invalid persisted data is evicted without losing valid neighboring resources', async ({ page, api }) => {
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  const count = api.calls.length;
  await page.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data: {} })), { key: `${CACHE_PREFIX}${API_ROOT}pokemon/1/` });
  await page.reload();
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.calls.slice(count)).toEqual(['pokemon/1/']);
  const cached = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `${CACHE_PREFIX}${API_ROOT}pokemon/1/`);
  expect(cached.data.name).toBe('bulbasaur');
});

test('quota recovery reclaims expired entries and persists new data across reloads', async ({ page, api }) => {
  const expiredKey = `${CACHE_PREFIX}${API_ROOT}pokemon/999/`;
  await page.addInitScript(({ expiredKey, data }) => {
    const set = Storage.prototype.setItem;
    if (!localStorage.getItem('regression-seeded')) {
      set.call(localStorage, 'regression-seeded', 'yes');
      set.call(localStorage, 'other-app', 'keep');
      set.call(localStorage, expiredKey, JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, data }));
    }
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('dexpermuter:v1:') && this.getItem(expiredKey) !== null && this.getItem(key) === null) {
        throw new DOMException('Simulated full storage', 'QuotaExceededError');
      }
      return set.call(this, key, value);
    };
  }, { expiredKey, data: apiData('pokemon/999/') });
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  const entries = await page.evaluate(({ expiredKey, currentKey }) => ({ expired: localStorage.getItem(expiredKey), unrelated: localStorage.getItem('other-app'), saved: localStorage.getItem(currentKey) }), { expiredKey, currentKey: `${CACHE_PREFIX}${API_ROOT}pokemon/1/` });
  expect(entries.expired).toBeNull();
  expect(entries.unrelated).toBe('keep');
  expect(JSON.parse(entries.saved).data.name).toBe('bulbasaur');
  const count = api.calls.length;
  await page.reload();
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.calls).toHaveLength(count);
});

test('switching searches drops obsolete work and clearing cancels remaining requests', async ({ page, api }) => {
  await freezeTime(page);
  api.hold(() => true);
  await page.goto('./');
  await submit(page, '12');
  await expect.poll(() => api.calls.length).toBe(4);
  expect((await api.probe()).maximum).toBe(4);
  const old = [...api.calls];
  api.hold(resource => old.includes(resource));
  await submit(page, '34');
  await expect(page.locator('#results-status')).toContainText('6 loaded');
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toBeFocused();
  const obsolete = new Set([12, 21, 102, 120, 201, 210, 1002, 1020]);
  expect(api.calls.slice(4).some(resource => obsolete.has(Number(resource.split('/')[1])))).toBe(false);
  await expect.poll(async () => (await api.probe()).requests.filter(entry => entry.aborted).length).toBe(4);
  await expect.poll(async () => (await api.probe()).active).toBe(0);
  let probe = await api.probe();
  expect(probe.requests.filter(entry => entry.aborted)).toHaveLength(4);
  expect(probe.requests.every(entry => entry.done)).toBe(true);
  // Chromium can announce replacement requests before the obsolete requests'
  // terminal events. Check each held cohort instead of that transient overlap.
  const searchStart = api.calls.length;
  const requestStart = probe.requests.length;
  api.hold(() => true);
  await submit(page, '56');
  await expect.poll(async () => (await api.probe()).active).toBe(4);
  expect(api.calls).toHaveLength(searchStart + 4);
  await page.getByLabel('YOUR STARTING POKÉDEX NUMBER').fill('');
  await page.clock.runFor(250);
  await expect(page.locator('.pokemon-card')).toHaveCount(0);
  await expect.poll(async () => (await api.probe()).active).toBe(0);
  probe = await api.probe();
  expect(api.calls).toHaveLength(searchStart + 4);
  expect(probe.requests.slice(requestStart)).toHaveLength(4);
  expect(probe.requests.slice(requestStart).every(entry => entry.done && entry.aborted)).toBe(true);
  await api.release();
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toBeFocused();
  await expect(page.locator('.pokemon-card')).toHaveCount(0);
  expect(api.calls).toHaveLength(searchStart + 4);
  await expect(page.locator('#results-status')).not.toContainText('failed');
});

test('overlapping searches preserve the original evolution requests and their deadlines', async ({ page, api }) => {
  await freezeTime(page);
  api.hold(resource => resource.startsWith('evolution-chain/'));
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.filter(resource => resource.startsWith('evolution-chain/')).length).toBe(4);
  for (const number of ['10', '100', '1000']) {
    await page.clock.runFor(1000);
    await submit(page, number);
    await expect(page.locator('.original-badge')).toHaveCount(1);
    expect(api.calls).toHaveLength(12);
    const probe = await api.probe();
    expect(probe.requests.some(entry => entry.aborted)).toBe(false);
    expect(probe.maximum).toBe(4);
  }
  await api.release();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.calls).toHaveLength(12);
  await expect(page.getByRole('article', { name: '#1000 Gholdengo', exact: true }).locator('.original-badge')).toBeVisible();
});

test('copies a plain-text overlay summary and provides a working clipboard fallback', async ({ page, context, api }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  const copy = page.getByRole('button', { name: 'Copy summary for Bulbasaur', exact: true });
  await copy.click();
  await expect(copy).toContainText('Copied!');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('#0001 Bulbasaur\nTypes: Grass / Poison');
  expect(text).toContain('Abilities: Overgrow\nHidden ability: Chlorophyll\nBST: 318');
  expect(text).toContain('Evolution: Bulbasaur does not evolve.');
  await page.evaluate(async () => {
    window.__readClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
    await navigator.clipboard.writeText('before-fallback');
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  });
  await copy.click();
  await expect(copy).toContainText('Copied!');
  expect(await page.evaluate(() => window.__readClipboard())).toBe(text);
  expect(api.count('pokemon/1/')).toBe(1);
});

test('shared evolution requests keep their original timeout after a handoff', async ({ page, api }) => {
  await freezeTime(page);
  api.hold(resource => resource.startsWith('evolution-chain/'));
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.filter(resource => resource.startsWith('evolution-chain/')).length).toBe(4);
  await page.clock.runFor(6000);
  await submit(page, '10');
  await page.clock.runFor(3999);
  expect((await api.probe()).requests.some(entry => entry.aborted)).toBe(false);
  await expect(page.locator('#results-status')).toContainText('4 loading');
  await page.clock.runFor(1);
  await expect(page.locator('#results-status')).toContainText('4 missing evolution data');
  await expect(page.getByRole('button', { name: 'Retry evolution', exact: true })).toHaveCount(4);
  await expect(page.locator('.evolution .card-error')).toHaveText(Array(4).fill('PokéAPI took too long to respond. Please retry.'));
  expect(api.calls).toHaveLength(12);
  await expect.poll(async () => (await api.probe()).requests.filter(entry => entry.aborted).length).toBe(4);
});

test('shows a non-blocking message when both clipboard methods fail', async ({ page, api }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
    document.execCommand = () => false;
  });
  const copy = page.getByRole('button', { name: 'Copy summary for Bulbasaur', exact: true });
  await copy.click();
  await expect(page.getByText('Copy was blocked. Please select and copy the card text.')).toBeVisible();
  await expect(copy).toBeEnabled();
  await page.clock.runFor(2400);
  await expect(page.getByText('Copy was blocked. Please select and copy the card text.')).toHaveCount(0);
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  expect(api.count('pokemon/1/')).toBe(1);
});
