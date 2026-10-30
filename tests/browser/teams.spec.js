import { readFile } from 'node:fs/promises';
import { test, expect, apiData, freezeTime, submit } from './fixtures.js';
import { TEAM_PREFIX } from '../../js/teams.js';

const memberButton = (page, number) => page.locator(`#results-grid .team-member-button[data-number="${number}"]`);
const row = (page, number) => page.locator(`#team-roster > li[data-number="${number}"]`);

async function renameTeam(page, name) {
  await page.getByRole('button', { name: 'Rename team', exact: true }).click();
  await page.getByLabel('Team name', { exact: true }).fill(name);
  await page.locator('#team-name-submit').click();
}

async function newTeam(page, name) {
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  if (name) await renameTeam(page, name);
}

async function openLibrary(page) {
  if (!await page.locator('.team-library').evaluate(node => node.open)) await page.getByText('Saved teams', { exact: true }).click();
}

async function records(page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key))), TEAM_PREFIX);
}

function backupRecord(id, name = 'A team') {
  return { version: 2, id, name, members: [{ number: 1, name: 'Bulbasaur' }], searchContext: null, note: 'Team note', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' };
}

function legacyRecord(id = 'legacy') {
  return { version: 1, id, name: 'Challenge from last week', startingNumber: 1, selectedNumbers: [1000, 1], note: 'Keep the whole team.', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
}

async function restore(page, value) {
  await page.locator('#team-backup-file').setInputFiles({ name: 'teams.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
}

async function downloadBackup(page, control = '#export-teams') {
  const pending = page.waitForEvent('download');
  await page.locator(control).click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

async function tabToMember(page, number = 1) {
  const control = memberButton(page, number);
  await page.getByLabel('YOUR STARTING POKÉDEX NUMBER').focus();
  for (let step = 0; step < 25; step += 1) {
    if (await control.evaluate(node => document.activeElement === node)) break;
    await page.keyboard.press('Tab');
  }
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS('outline-style', 'solid');
  return control.elementHandle();
}

async function expectRetainedFocus(control) {
  expect(await control.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true);
}

test('keyboard member button focus survives loading to success and Space still saves the selection', async ({ page, api }) => {
  api.hold(() => true);
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.length).toBe(4);
  await newTeam(page, 'Keyboard success');
  const control = await tabToMember(page);
  await api.release();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expectRetainedFocus(control);
  await expect(memberButton(page, 1)).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Space');
  await expect(memberButton(page, 1)).toHaveAttribute('aria-pressed', 'true');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([1]);
  await expectRetainedFocus(control);
});

test('keyboard member button focus survives failure and retry without duplicating toggle handlers', async ({ page, api }) => {
  api.hold(() => true);
  api.respondOnce('pokemon/1/', { ...apiData('pokemon/1/'), stats: [] });
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.length).toBe(4);
  await newTeam(page, 'Keyboard recovery');
  const control = await tabToMember(page);
  await api.release();
  await expect(page.locator('#results-status')).toContainText('3 loaded · 1 failed');
  await expectRetainedFocus(control);
  await page.keyboard.press('Enter');
  await expect(memberButton(page, 1)).toHaveAttribute('aria-pressed', 'true');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([1]);

  api.hold(resource => resource === 'pokemon/1/');
  await page.getByRole('button', { name: 'Retry Pokémon', exact: true }).click();
  await expect.poll(() => api.count('pokemon/1/')).toBe(2);
  expect(await control.evaluate(node => node.isConnected)).toBe(true);
  await tabToMember(page);
  await expectRetainedFocus(control);
  await api.release();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expectRetainedFocus(control);
  await expect(memberButton(page, 1)).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Space');
  await expect(memberButton(page, 1)).toHaveAttribute('aria-pressed', 'false');
  expect((await records(page))[0].members).toEqual([]);
  await expectRetainedFocus(control);
});

test('finishing held cards does not reclaim focus after the user returns to the input', async ({ page, api }) => {
  api.hold(() => true);
  await page.goto('./');
  await submit(page, '1');
  await expect.poll(() => api.calls.length).toBe(4);
  const control = await tabToMember(page);
  const input = page.getByLabel('YOUR STARTING POKÉDEX NUMBER');
  await input.focus();
  await api.release();
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await expect(input).toBeFocused();
  expect(await control.evaluate(node => document.activeElement === node)).toBe(false);
});

test('first add creates a team immediately and searches never discard it', async ({ page, api }, testInfo) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await expect(page.locator('#results-status')).toContainText('4 loaded');
  await memberButton(page, 1).click();
  await expect(page.locator('#active-team-name')).toHaveText('My team');
  await expect(page.locator('#team-naming')).toBeHidden();
  await expect(memberButton(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await renameTeam(page, 'My next lineup');
  await page.getByLabel('Team notes', { exact: true }).fill('Compare abilities before choosing.');
  await page.clock.runFor(299);
  expect((await records(page))[0].note).toBe('');
  await page.clock.runFor(1);
  expect((await records(page))[0].note).toBe('Compare abilities before choosing.');
  await submit(page, '4');
  await expect(page.locator('#results-status')).toContainText('3 loaded');
  await memberButton(page, 4).click();
  expect((await records(page))[0].members.map(member => member.number)).toEqual([1, 4]);
  await submit(page, '0');
  await expect(page.locator('#input-error')).not.toBeEmpty();
  await expect(page.locator('#member-count')).toHaveText('2 members');
  await submit(page, '');
  await expect(page.locator('#results-grid .pokemon-card')).toHaveCount(0);
  await expect(page.locator('#team-roster > li')).toHaveCount(2);
  const calls = api.calls.length;
  await page.reload();
  await expect(page.locator('#results-grid .pokemon-card')).toHaveCount(0);
  expect(api.calls).toHaveLength(calls);
  await page.getByRole('button', { name: 'Continue team', exact: true }).click();
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toHaveValue('');
  await expect(page.locator('#team-roster > li')).toHaveCount(2);
  await expect(page.getByLabel('Team notes', { exact: true })).toHaveValue('Compare abilities before choosing.');
  expect(api.calls).toHaveLength(calls);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('team-preview.png'), fullPage: true });
});

test('members from separate searches exceed six and preserve selection order', async ({ page }) => {
  await page.goto('./');
  for (const number of [1, 2, 3, 4, 5, 6, 7]) {
    await submit(page, String(number));
    await memberButton(page, number).click();
  }
  await expect(page.locator('#member-count')).toHaveText('7 members');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await submit(page, '1');
  await expect(memberButton(page, 1)).toHaveText('Remove from team');
  await expect(page.locator('#results-grid .member-badge').first()).toHaveText('Member 1');
  await memberButton(page, 1).click();
  await memberButton(page, 1).click();
  await expect(page.locator('#member-count')).toHaveText('7 members');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([2, 3, 4, 5, 6, 7, 1]);
  await expect(page.locator('#results-grid .member-badge').first()).toHaveText('Member 7');
});

test('keyboard reorder and removal preserve focus and renumber positions', async ({ page }) => {
  await page.goto('./');
  await submit(page, '1');
  for (const number of [1000, 10, 1]) await memberButton(page, number).click();
  const down = row(page, 1000).getByRole('button', { name: /^Move down Member/ });
  await down.focus();
  await page.keyboard.press('Enter');
  await expect(down).toBeFocused();
  expect((await records(page))[0].members.map(member => member.number)).toEqual([10, 1000, 1]);
  await expect(page.locator('#results-grid .team-member-button[data-number="1000"]').locator('..').locator('.member-badge')).toHaveText('Member 2');
  await row(page, 1000).getByRole('button', { name: /^Remove Member/ }).click();
  await expect(row(page, 1).getByRole('button', { name: /^Remove Member 2,/ })).toBeFocused();
  await expect(page.locator('#team-roster > li > strong')).toHaveText(['Member 1', 'Member 2']);
  const up = row(page, 10).getByRole('button', { name: /^Move up Member/ });
  await up.focus();
  await page.keyboard.press('Enter');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([10, 1]);
  await row(page, 10).getByRole('button', { name: /^Remove Member/ }).click();
  await row(page, 1).getByRole('button', { name: /^Remove Member/ }).click();
  await expect(page.locator('#active-team-name')).toBeFocused();
  await expect(page.locator('#team-empty')).toBeVisible();
});

test('inspection failures are independent, retry works, and searches stay unchanged', async ({ page, api }) => {
  await page.addInitScript(({ prefix, record }) => localStorage.setItem(prefix + record.id, JSON.stringify(record)), {
    prefix: TEAM_PREFIX, record: { ...backupRecord('inspect'), members: [{ number: 1, name: 'Bulbasaur' }, { number: 4, name: null }] },
  });
  api.respondOnce('pokemon/1/', { ...apiData('pokemon/1/'), stats: [] });
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue team', exact: true }).click();
  await submit(page, '12');
  await row(page, 1).getByRole('button', { name: /^Inspect Member/ }).click();
  await expect(row(page, 1).locator('.card-error')).toBeVisible();
  await row(page, 4).getByRole('button', { name: /^Inspect Member/ }).click();
  await expect(row(page, 4).locator('h3')).toHaveText('Pokémon 4');
  await row(page, 1).getByRole('button', { name: 'Retry Pokémon', exact: true }).click();
  await expect(row(page, 1).locator('h3')).toHaveText('Bulbasaur');
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toHaveValue('12');
  await row(page, 1).getByRole('button', { name: /^Remove Member/ }).click();
  await expect(row(page, 4).locator('h3')).toHaveText('Pokémon 4');
  expect((await records(page))[0].members.map(member => member.number)).toEqual([4]);
});

test('removing an inspected member cancels held requests and prevents stale details', async ({ page, api }) => {
  await page.addInitScript(({ prefix, record }) => localStorage.setItem(prefix + record.id, JSON.stringify(record)), {
    prefix: TEAM_PREFIX, record: backupRecord('cancel-inspection'),
  });
  api.hold(() => true);
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue team', exact: true }).click();
  await row(page, 1).getByRole('button', { name: /^Inspect Member/ }).click();
  await expect.poll(() => api.calls.length).toBe(2);
  await row(page, 1).getByRole('button', { name: /^Remove Member/ }).click();
  await expect.poll(async () => (await api.probe()).requests.filter(request => request.done && request.aborted).length).toBe(2);
  await api.release();
  await expect(page.locator('#team-roster > li')).toHaveCount(0);
  await expect(page.locator('#team-empty')).toBeVisible();
  expect((await records(page))[0].members).toEqual([]);
});

test('note autosave retains focused roster controls and search input', async ({ page }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await memberButton(page, 1).click();
  await page.getByLabel('Team notes', { exact: true }).fill('Pending note');
  const inspect = row(page, 1).getByRole('button', { name: /^Inspect Member/ });
  await inspect.focus();
  await page.clock.runFor(300);
  await expect(inspect).toBeFocused();
  await page.getByLabel('Team notes', { exact: true }).fill('Another pending note');
  const input = page.getByLabel('YOUR STARTING POKÉDEX NUMBER');
  await input.focus();
  await page.clock.runFor(300);
  await expect(input).toBeFocused();
  expect((await records(page))[0].note).toBe('Another pending note');
});

test('legacy saves and backups become editable teams without eager writes or traffic', async ({ page, api }) => {
  const legacy = legacyRecord();
  await page.addInitScript(({ prefix, record }) => localStorage.setItem(prefix + record.id, JSON.stringify(record)), { prefix: TEAM_PREFIX, record: legacy });
  await page.goto('./');
  await page.getByRole('button', { name: 'Continue team', exact: true }).click();
  await expect(page.locator('#active-team-name')).toHaveText(legacy.name);
  await expect(page.locator('#team-search-context')).toHaveText('Original search: #0001');
  expect((await records(page))[0]).toEqual(legacy);
  expect(api.calls).toHaveLength(0);
  await expect(page.locator('#backup-current')).toBeVisible();
  const current = await downloadBackup(page, '#backup-current');
  expect(current.teams).toHaveLength(1);
  const exported = await downloadBackup(page);
  expect(exported.version).toBe(2);
  expect(exported.teams[0].members.map(member => member.number)).toEqual([1, 1000]);
  expect((await records(page))[0]).toEqual(legacy);
  await restore(page, { version: 1, challenges: [legacy] });
  await expect(page.locator('#backup-status')).toHaveText('0 imported · 1 skipped · 0 failed.');
  await submit(page, '4');
  await memberButton(page, 4).click();
  const saved = (await records(page))[0];
  expect(saved.version).toBe(2);
  expect(saved.members.map(member => member.number)).toEqual([1, 1000, 4]);
  expect(saved.createdAt).toBe(legacy.createdAt);
  expect(saved.note).toBe(legacy.note);
  await restore(page, { version: 1, challenges: [legacy] });
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 0 failed.');
});

test('backups include pending notes, round trip, skip identical teams and preserve conflicts', async ({ page }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await memberButton(page, 1000).click();
  await page.getByLabel('Team notes', { exact: true }).fill('Export before debounce');
  const backup = await downloadBackup(page);
  expect(backup.teams[0].note).toBe('Export before debounce');
  await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).forEach(key => localStorage.removeItem(key)), TEAM_PREFIX);
  await page.reload();
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 0 failed.');
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('0 imported · 1 skipped · 0 failed.');
  await page.getByRole('button', { name: 'Continue team', exact: true }).click();
  await page.getByLabel('Team notes', { exact: true }).fill('Changed on this device');
  await page.clock.runFor(300);
  await restore(page, backup);
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 0 failed.');
  expect((await records(page)).map(record => record.note).sort()).toEqual(['Changed on this device', 'Export before debounce']);
});

test('failed saves allow searching but protect team switches and recover on retry', async ({ page }) => {
  await freezeTime(page);
  await page.addInitScript(prefix => {
    const set = Storage.prototype.setItem;
    window.__allowTeamWrites = false;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix) && !window.__allowTeamWrites) throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, TEAM_PREFIX);
  await page.goto('./');
  await submit(page, '1');
  await memberButton(page, 1).click();
  await expect(page.locator('#team-status')).toContainText('not saved');
  await page.getByLabel('Team notes', { exact: true }).fill('Keep these edits');
  await page.clock.runFor(300);
  await submit(page, '4');
  await memberButton(page, 4).click();
  const backup = await downloadBackup(page, '#backup-current');
  expect(backup.teams[0].members.map(member => member.number)).toEqual([1, 4]);
  expect(backup.teams[0].note).toBe('Keep these edits');
  page.once('dialog', dialog => dialog.dismiss());
  await newTeam(page);
  await expect(page.locator('#member-count')).toHaveText('2 members');
  await page.evaluate(() => { window.__allowTeamWrites = true; });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  expect((await records(page))[0].note).toBe('Keep these edits');
  await expect(page.locator('#team-status')).toHaveText('Saved on this device.');
});

test('other-tab changes pause autosave and preserve both versions through copy and backup', async ({ page, context }) => {
  await freezeTime(page);
  await page.goto('./');
  await submit(page, '1');
  await memberButton(page, 1).click();
  const other = await context.newPage();
  await other.goto('./');
  await other.getByRole('button', { name: 'Continue team', exact: true }).click();
  await page.getByLabel('Team notes', { exact: true }).fill('Local edit');
  await other.getByLabel('Team notes', { exact: true }).fill('Other tab edit');
  // Flush through a membership action without advancing the shared test clock.
  await submit(other, '1');
  await memberButton(other, 100).click();
  await expect(page.locator('#team-conflict')).toBeVisible();
  await expect(page.getByLabel('Team notes', { exact: true })).toHaveValue('Local edit');
  const backup = await downloadBackup(page);
  expect(backup.teams.map(team => team.note).sort()).toEqual(['Local edit', 'Other tab edit']);
  await page.getByRole('button', { name: 'Save edits as a copy', exact: true }).click();
  expect((await records(page)).map(record => record.note).sort()).toEqual(['Local edit', 'Other tab edit']);
  const copy = (await records(page)).find(record => record.note === 'Local edit');
  await other.evaluate(({ prefix, id }) => localStorage.removeItem(prefix + id), { prefix: TEAM_PREFIX, id: copy.id });
  await expect(page.locator('#team-conflict')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved team', exact: true }).click();
  await expect(page.locator('#team-error')).toContainText('Could not open');
  await page.getByRole('button', { name: 'Save edits as a copy', exact: true }).click();
  expect((await records(page))).toHaveLength(2);
  await other.close();
});

test('new, rename, open and delete keep separate teams and preserve the search', async ({ page }) => {
  await page.goto('./');
  await submit(page, '1');
  await memberButton(page, 1).click();
  await renameTeam(page, 'First team');
  await newTeam(page, 'Second team');
  await memberButton(page, 10).click();
  await openLibrary(page);
  const first = page.locator('#team-list li').filter({ has: page.getByText('First team', { exact: true }) });
  await first.getByRole('button', { name: 'Open team', exact: true }).click();
  await expect(page.locator('#member-count')).toHaveText('1 member');
  await expect(memberButton(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await expect(memberButton(page, 10)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('YOUR STARTING POKÉDEX NUMBER')).toHaveValue('1');
  page.once('dialog', dialog => dialog.dismiss());
  await first.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await records(page))).toHaveLength(2);
  page.once('dialog', dialog => dialog.accept());
  await first.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await records(page)).map(record => record.name)).toEqual(['Second team']);
  await expect(page.getByRole('button', { name: 'New team', exact: true })).toBeFocused();
});

test('restore validates all records, reports partial failures and preserves unreadable data', async ({ page, api }) => {
  await page.addInitScript(prefix => {
    localStorage.setItem(prefix + 'unreadable', '{');
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === prefix + 'partial-2') throw new DOMException('Full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  }, TEAM_PREFIX);
  await page.goto('./');
  await expect(page.locator('#team-recovery')).toContainText('1 saved record');
  const first = backupRecord('partial-1', '<img src=x onerror=alert(1)>');
  await restore(page, { version: 2, teams: [first, { ...backupRecord('invalid'), members: [{ number: 1026 }] }] });
  await expect(page.locator('#team-error')).toContainText('1 to 1025');
  expect(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, TEAM_PREFIX)).toBe(1);
  await restore(page, { version: 2, teams: [first, backupRecord('partial-2')] });
  await expect(page.locator('#backup-status')).toHaveText('1 imported · 0 skipped · 1 failed.');
  await openLibrary(page);
  await expect(page.locator('#team-list strong')).toHaveText(first.name);
  expect(await page.locator('#team-list img').count()).toBe(0);
  expect(await page.evaluate(prefix => localStorage.getItem(prefix + 'unreadable'), TEAM_PREFIX)).toBe('{');
  expect(api.calls).toHaveLength(0);
});

