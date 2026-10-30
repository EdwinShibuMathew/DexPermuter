import { readFile } from 'node:fs/promises';
import { test, expect, apiData, freezeTime, submit } from './fixtures.js';
import { CHALLENGE_PREFIX } from '../../js/challenges.js';

async function saveSearch(page, name) {
  await page.locator('#save-challenge').click();
  await page.getByLabel('Challenge name', { exact: true }).fill(name);
  await page.locator('#challenge-name-submit').click();
}

async function openLibrary(page) {
  if (!await page.locator('.challenge-library').evaluate(node => node.open)) {
    await page.getByText('View saved challenges', { exact: true }).click();
  }
}

async function records(page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key))), CHALLENGE_PREFIX);
}

function backupRecord(id, name) {
  return { version: 1, id, name, startingNumber: 1, selectedNumbers: [100], note: 'Episode note', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' };
}

async function restore(page, value) {
  await page.locator('#challenge-backup-file').setInputFiles({ name: 'challenges.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
}

async function downloadBackup(page, control = '#export-challenges') {
  const pending = page.waitForEvent('download');
  await page.locator(control).click();
  const download = await pending;
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

test('saves, autosaves, and resumes a shortlist after returning without eager API traffic', async ({ page, api }, testInfo) => {
  await freezeTime(page);
  await page.goto('./');
  await expect(page.locator('#save-challenge')).toBeDisabled();
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await saveSearch(page, 'Episode one');
  await expect(page.locator('#challenge-status')).toHaveText('Saved on this device.');
  await page.getByRole('button', { name: 'Shortlist #0100', exact: true }).click();
  await page.getByLabel('Episode note', { exact: true }).fill('Compare Voltorb before recording.');
  await expect(page.locator('#challenge-status')).toHaveText('Saving…');
  await page.clock.runFor(299);
  expect((await records(page))[0].note).toBe('');
  await page.clock.runFor(1);
  await expect(page.locator('#challenge-status')).toHaveText('Saved on this device.');
  const count = api.calls.length;
  await page.reload();
  await expect(page.locator('.pokemon-card')).toHaveCount(0);
  expect(api.calls).toHaveLength(count);
  await page.getByRole('button', { name: 'Continue challenge', exact: true }).click();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toHaveValue('1');
  await expect(page.getByLabel('Episode note', { exact: true })).toHaveValue('Compare Voltorb before recording.');
  await expect(page.getByRole('button', { name: 'Shortlist #0100', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(api.calls).toHaveLength(count);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Episode note', { exact: true }).focus();
  await expect(page.getByLabel('Episode note', { exact: true })).toHaveCSS('outline-style', 'solid');
  await page.screenshot({ path: testInfo.outputPath('challenge-preview.png'), fullPage: true });
});

test('shortlisting first names a challenge and survives loading, card failures, and retries', async ({ page, api }) => {
  api.hold(() => true);
  api.respondOnce('pokemon/1/', { ...apiData('pokemon/1/'), stats: [] });
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.length).toBe(4);
  await page.getByRole('button', { name: 'Shortlist #0001', exact: true }).click();
  await expect(page.getByLabel('Challenge name', { exact: true })).toBeFocused();
  await page.getByLabel('Challenge name', { exact: true }).fill('Held search');
  await page.locator('#challenge-name-submit').click();
  await expect(page.getByRole('button', { name: 'Shortlist #0001', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await api.release();
  await expect(page.locator('#results-status')).toContainText('3 loaded · 1 failed');
  await expect(page.getByRole('button', { name: 'Shortlist #0001', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Retry Pokémon', exact: true }).click();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expect(page.getByRole('button', { name: 'Shortlist #0001', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await records(page))[0].selectedNumbers).toEqual([1]);
});

test('search switches flush notes without overwriting saves; rename and delete remain explicit', async ({ page, api }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await saveSearch(page, 'First');
  await page.getByRole('button', { name: 'Shortlist #0010', exact: true }).click();
  await page.getByLabel('Episode note', { exact: true }).fill('Pending note');
  await submit(page, '12');
  await expect(page.locator('#challenge-editor')).toBeHidden();
  expect((await records(page))[0].note).toBe('Pending note');
  await saveSearch(page, 'Second');
  expect((await records(page))).toHaveLength(2);
  await openLibrary(page);
  const first = page.locator('#challenge-list li').filter({ has: page.getByText('First', { exact: true }) });
  await first.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Challenge name', { exact: true }).fill('First renamed');
  await page.locator('#challenge-name-submit').click();
  await expect(page.getByRole('button', { name: 'Shortlist #0010', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const renamed = page.locator('#challenge-list li').filter({ has: page.getByText('First renamed', { exact: true }) });
  page.once('dialog', dialog => dialog.dismiss());
  await renamed.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await records(page))).toHaveLength(2);
  page.once('dialog', dialog => dialog.accept());
  await renamed.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await records(page)).map(record => record.name)).toEqual(['Second']);
  await expect(page.locator('#save-challenge')).toBeFocused();
  expect(api.calls.length).toBeGreaterThan(0);
});

test('backups flush pending notes, round trip, skip duplicates, and preserve conflicting saves', async ({ page, api }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await saveSearch(page, 'Portable run');
  await page.getByRole('button', { name: 'Shortlist #1000', exact: true }).click();
  await page.getByLabel('Episode note', { exact: true }).fill('Export before debounce');
  const backup = await downloadBackup(page);
  expect(backup.challenges[0].note).toBe('Export before debounce');
  await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).forEach(key => localStorage.removeItem(key)), CHALLENGE_PREFIX);
  await page.reload();
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 0 failed.');
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('0 imported · 1 skipped · 0 failed.');
  await page.getByRole('button', { name: 'Continue challenge', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Shortlist #1000', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Episode note', { exact: true }).fill('Changed on this device');
  await page.clock.runFor(300);
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 0 failed.');
  expect((await records(page)).map(record => record.note).sort()).toEqual(['Changed on this device', 'Export before debounce']);
  expect(api.calls.length).toBeGreaterThan(0);
});

test('save failures retain exportable edits, protect navigation, and recover on retry', async ({ page, api }) => {
  await freezeTime(page);
  await page.addInitScript(prefix => {
    const set = Storage.prototype.setItem;
    window.__allowChallengeWrites = false;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix) && !window.__allowChallengeWrites) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, CHALLENGE_PREFIX);
  await page.goto('./');
  await submit(page, '1');
  await saveSearch(page, 'Recover me');
  await expect(page.locator('#challenge-status')).toContainText('not saved');
  expect(await records(page)).toEqual([]);
  await page.getByLabel('Episode note', { exact: true }).fill('Keep this even without storage');
  await page.clock.runFor(300);
  const backup = await downloadBackup(page, '#backup-current');
  expect(backup.challenges[0].note).toBe('Keep this even without storage');
  page.once('dialog', dialog => dialog.dismiss());
  await submit(page, '12');
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toHaveValue('1');
  await page.evaluate(() => { window.__allowChallengeWrites = true; });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('#challenge-status')).toHaveText('Saved on this device.');
  expect((await records(page))[0].note).toBe(backup.challenges[0].note);
  expect(api.calls.length).toBeGreaterThan(0);
});

test('another tab pauses autosave and allows a copy after updates or deletion', async ({ page, context, api }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await saveSearch(page, 'Shared tabs');
  const other = await context.newPage();
  await other.goto('./');
  await other.getByRole('button', { name: 'Continue challenge', exact: true }).click();
  await page.getByLabel('Episode note', { exact: true }).fill('Local edit');
  await other.getByLabel('Episode note', { exact: true }).fill('Other tab edit');
  // The clock belongs to the shared context. An immediate shortlist save flushes
  // the other note without advancing the first tab's pending autosave timer.
  await other.getByRole('button', { name: 'Shortlist #0100', exact: true }).click();
  await expect(other.locator('#challenge-status')).toHaveText('Saved on this device.');
  await expect(page.locator('#challenge-conflict')).toBeVisible();
  await expect(page.getByLabel('Episode note', { exact: true })).toHaveValue('Local edit');
  await page.getByRole('button', { name: 'Save edits as a copy', exact: true }).click();
  await expect(page.locator('#challenge-status')).toHaveText('Saved on this device.');
  expect((await records(page)).map(record => record.note).sort()).toEqual(['Local edit', 'Other tab edit']);
  const copy = (await records(page)).find(record => record.note === 'Local edit');
  await other.evaluate(({ prefix, id }) => localStorage.removeItem(prefix + id), { prefix: CHALLENGE_PREFIX, id: copy.id });
  await expect(page.locator('#challenge-conflict')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved challenge', exact: true }).click();
  await expect(page.locator('#challenge-error')).toContainText('Could not resume');
  await page.getByRole('button', { name: 'Save edits as a copy', exact: true }).click();
  await expect(page.locator('#challenge-status')).toHaveText('Saved on this device.');
  expect((await records(page))).toHaveLength(2);
  await other.close();
  expect(api.calls.length).toBeGreaterThan(0);
});

test('restore validates before writes and reports partial imports without deleting unreadable records', async ({ page, api }) => {
  await page.addInitScript(prefix => {
    localStorage.setItem(prefix + 'unreadable', '{');
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === prefix + 'partial-2') throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, CHALLENGE_PREFIX);
  await page.goto('./');
  await expect(page.locator('#challenge-recovery')).toContainText('1 saved record');
  const first = backupRecord('partial-1', '<img src=x onerror=alert(1)>');
  await restore(page, { version: 1, challenges: [first, { ...backupRecord('invalid', 'Invalid'), selectedNumbers: [2] }] });
  await expect(page.locator('#challenge-error')).toContainText('valid permutations');
  expect(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, CHALLENGE_PREFIX)).toBe(1);
  await restore(page, { version: 1, challenges: [first, backupRecord('partial-2', 'Will not fit')] });
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 1 failed.');
  await openLibrary(page);
  await expect(page.locator('#challenge-list strong')).toHaveText(first.name);
  expect(await page.locator('#challenge-list img').count()).toBe(0);
  expect(await page.evaluate(prefix => localStorage.getItem(prefix + 'unreadable'), CHALLENGE_PREFIX)).toBe('{');
  expect(api.calls).toHaveLength(0);
});
