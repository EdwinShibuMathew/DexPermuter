import { randomUUID } from 'node:crypto';
import { test, expect, API_ROOT, STREAM_PATH, submit, withApiFixture } from './fixtures.js';

function streamUrls(baseURL, count) {
  return Array.from({ length: count }, () => new URL(`${STREAM_PATH}${randomUUID()}`, baseURL).href);
}

async function startStreams(page, urls) {
  return page.evaluate(async urls => {
    const controllers = urls.map(() => new AbortController());
    const responses = await Promise.all(urls.map((url, index) => fetch(url, { signal: controllers[index].signal })));
    window.__streams = { controllers, responses };
    return responses.map(response => ({
      native: response instanceof Response,
      status: response.status,
      ok: response.ok,
      type: response.headers.get('content-type'),
      bodyUsed: response.bodyUsed,
    }));
  }, urls);
}

async function completeStreams(request, urls) {
  for (const url of urls) {
    const response = await request.post(`${url}/complete`);
    expect(response.status()).toBe(200);
  }
}

test('a failing fixture keeps its offline guard through late work and context closure', async ({ page, context, baseURL }) => {
  const escaped = [];
  // Independent last resort: a broken fixture fails this assertion without ever
  // making a live request. Context routes execute in reverse registration order.
  await context.route(`${API_ROOT}**`, async route => {
    escaped.push(route.request().url());
    await route.abort();
  });
  const sentinel = new Error('Deliberate failure while requests are held');
  let api;
  await expect(withApiFixture({ page, context, baseURL }, async fixture => {
    api = fixture;
    api.hold(() => true);
    await page.goto('./');
    await submit(page, '12');
    await expect.poll(() => api.calls.length).toBe(4);
    throw sentinel;
  })).rejects.toBe(sentinel);
  expect(page.isClosed()).toBe(false);
  expect(api.calls).toHaveLength(4);
  expect((await api.probe()).active).toBe(4);
  // Resuming is explicit test work, never a side effect of fixture teardown.
  await api.release();
  await expect(page.locator('#results-status')).toContainText('8 loaded');
  await expect.poll(async () => (await api.probe()).active).toBe(0);
  expect(api.calls).toHaveLength(24);
  api.assertClean();
  expect(escaped).toEqual([]);
  api.hold(() => true);
  await submit(page, '34');
  await expect.poll(async () => (await api.probe()).active).toBe(4);
  await context.close();
  expect((await api.probe()).active).toBe(0);
  expect(escaped).toEqual([]);
  api.assertClean();
});

test('the probe includes five pending bodies and preserves native response readers', async ({ page, api, request, baseURL }) => {
  await page.goto('./');
  const urls = streamUrls(baseURL, 5);
  const metadata = await startStreams(page, urls);
  expect(metadata).toEqual(Array(5).fill({ native: true, status: 200, ok: true, type: 'application/json; charset=utf-8', bodyUsed: false }));
  await expect.poll(async () => (await api.probe()).active).toBe(5);
  expect((await api.probe()).maximum).toBe(5);
  await page.evaluate(() => {
    const { responses } = window.__streams;
    const clone = responses[0].clone();
    const reader = responses[2].body.getReader();
    const readDirectly = async () => {
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    };
    window.__streams.reads = Promise.all([
      responses[0].json(), responses[1].text(), readDirectly(),
      responses[3].json(), responses[4].json(), clone.text(),
    ]);
  });
  expect(await page.evaluate(() => window.__streams.responses.map(response => response.bodyUsed))).toEqual(Array(5).fill(true));
  // Reading a body must not finish its probe entry while HTTP is still pending.
  expect((await api.probe()).active).toBe(5);
  await completeStreams(request, urls);
  const values = await page.evaluate(() => window.__streams.reads);
  const data = urls.map(url => ({ id: url.split('/').pop() }));
  expect(values).toEqual([data[0], JSON.stringify(data[1]), JSON.stringify(data[2]), data[3], data[4], JSON.stringify(data[0])]);
  await expect.poll(async () => (await api.probe()).active).toBe(0);
  const probe = await api.probe();
  expect(probe.maximum).toBe(5);
  expect(probe.requests).toHaveLength(5);
  expect(probe.requests).toEqual(expect.arrayContaining(urls.map(url => ({ url, done: true, aborted: false }))));
});

test('aborting after headers records every cancellation and retains native body errors', async ({ page, api, baseURL }) => {
  await page.goto('./');
  await startStreams(page, streamUrls(baseURL, 5));
  await page.evaluate(() => {
    window.__streams.reads = Promise.all(window.__streams.responses.map(response => response.json().then(
      () => 'unexpected success', error => error.name,
    )));
  });
  await expect.poll(async () => (await api.probe()).active).toBe(5);
  await page.evaluate(() => window.__streams.controllers.forEach(controller => controller.abort()));
  expect(await page.evaluate(() => window.__streams.reads)).toEqual(Array(5).fill('AbortError'));
  await expect.poll(async () => (await api.probe()).requests.filter(entry => entry.aborted).length).toBe(5);
  const probe = await api.probe();
  expect(probe.active).toBe(0);
  expect(probe.maximum).toBe(5);
  expect(probe.requests).toHaveLength(5);
  expect(probe.requests.every(entry => entry.done)).toBe(true);
});

test('the probe distinguishes consecutive requests to the same URL', async ({ page, api, request, baseURL }) => {
  await page.goto('./');
  const urls = streamUrls(baseURL, 1);
  for (let index = 0; index < 2; index += 1) {
    await startStreams(page, urls);
    await expect.poll(async () => (await api.probe()).active).toBe(1);
    await completeStreams(request, urls);
    await page.evaluate(() => window.__streams.responses[0].json());
    await expect.poll(async () => (await api.probe()).active).toBe(0);
  }
  const probe = await api.probe();
  expect(probe.requests).toHaveLength(2);
  expect(probe.requests.map(entry => entry.url)).toEqual([urls[0], urls[0]]);
  expect(probe.requests.every(entry => entry.done && !entry.aborted)).toBe(true);
  expect(probe.maximum).toBe(1);
});
