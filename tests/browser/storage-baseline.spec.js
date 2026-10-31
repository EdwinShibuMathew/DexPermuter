import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';

const sizes = JSON.parse(await readFile(new URL('../fixtures/storage-sizes.json', import.meta.url), 'utf8'));

// An isolated synthetic prototype, not the production migration implementation.
test('measure synthetic storage startup and migration primitives', async ({ page, api }, testInfo) => {
  await page.goto('./');
  const measurement = await page.evaluate(async payloadBytes => {
    const prefix = 'dexpermuter:v1:https://pokeapi.co/api/v2/generation/';
    const databaseName = 'dexpermuter-storage-baseline-prototype';
    const savedAt = Date.now();
    const records = payloadBytes.map((size, index) => {
      const url = `https://pokeapi.co/api/v2/generation/${index + 1}/`;
      const data = { padding: 'x'.repeat(size - 14) };
      return { url, data, schemaVersion: 1, revision: `synthetic-${index}`,
        savedAt, expiresAt: savedAt + 604800000, lastAccessed: savedAt };
    });
    const keys = records.map((_, index) => `${prefix}${index + 1}/`);
    const seed = () => records.forEach((record, index) => {
      localStorage.setItem(keys[index], JSON.stringify({ savedAt, data: record.data }));
    });
    const read = () => keys.map((key, index) => ({ ...records[index], ...JSON.parse(localStorage.getItem(key)) }));
    const remove = () => keys.forEach(key => localStorage.removeItem(key));
    const elapsed = start => Number((performance.now() - start).toFixed(3));
    let db;
    try {
      const openStart = performance.now();
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const responses = request.result.createObjectStore('responses', { keyPath: 'url' });
          responses.createIndex('expiresAt', 'expiresAt');
          responses.createIndex('lastAccessedUrl', ['lastAccessed', 'url']);
          request.result.createObjectStore('metadata');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Synthetic prototype open failed.'));
      });
      const openMs = elapsed(openStart);
      const samples = [];
      for (let run = 0; run < 3; run += 1) {
        seed();
        const startupStart = performance.now();
        const snapshot = read();
        const startupMs = elapsed(startupStart);
        const memoryStart = performance.now();
        const memory = new Map(read().map(record => [record.url, record]));
        remove();
        const memoryMigrationMs = elapsed(memoryStart);
        if (memory.size !== records.length) throw new Error('Synthetic memory transfer failed.');
        seed();
        const persistentStart = performance.now();
        const staged = read();
        staged.forEach(record => {
          record.estimatedBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 128;
        });
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(['responses', 'metadata'], 'readwrite');
          const store = transaction.objectStore('responses');
          staged.forEach(record => store.put(record));
          transaction.objectStore('metadata').put({ entries: staged.length,
            estimatedBytes: staged.reduce((sum, record) => sum + record.estimatedBytes, 0) }, 'totals');
          transaction.oncomplete = resolve;
          transaction.onerror = transaction.onabort = () => reject(new Error('Synthetic prototype commit failed.'));
        });
        remove();
        samples.push({ startupMs, memoryMigrationMs, persistentMigrationMs: elapsed(persistentStart), entries: snapshot.length });
      }
      return { prototype: true, records: records.length, payloadBytes: payloadBytes.reduce((a, b) => a + b, 0), openMs, samples };
    } finally {
      remove();
      db?.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = resolve;
        request.onerror = () => reject(new Error('Synthetic prototype cleanup failed.'));
      });
    }
  }, sizes.samples.map(sample => sample.payloadBytes));
  expect(measurement.records).toBe(8);
  expect(measurement.samples).toHaveLength(3);
  expect(measurement.samples.every(sample => sample.entries === 8)).toBe(true);
  expect(api.calls).toHaveLength(0);
  await testInfo.attach('storage-baseline.json', { body: JSON.stringify({
    project: testInfo.project.name, browser: page.context().browser().version(), ...measurement,
  }, null, 2), contentType: 'application/json' });
  console.log('STORAGE_BASELINE ' + JSON.stringify({ project: testInfo.project.name, ...measurement }));
});
