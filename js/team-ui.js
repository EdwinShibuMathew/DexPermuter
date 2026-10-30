import { TEAM_PREFIX, MAX_BACKUP_BYTES, createTeamStore, validateTeam } from './teams.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action) {
  const node = element('button', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

/** Team edits belong to the roster, independently of searches and API responses. */
export function createTeamWorkspace({ root, onSelectionChange, inspectMember, store = createTeamStore() }) {
  if (!root) return null;
  const find = selector => root.querySelector(selector);
  const naming = find('#team-naming');
  const nameInput = find('#team-name');
  const editor = find('#team-editor');
  const noteInput = find('#team-note');
  const notice = find('#team-status');
  const errorMessage = find('#team-error');
  const library = find('#team-list');
  const roster = find('#team-roster');
  const fileInput = find('#team-backup-file');
  const rows = new Map();
  const names = new Map();
  let active = null;
  let baseline = null;
  let dirty = false;
  let conflicted = false;
  let noteTimer;

  const showError = message => { errorMessage.textContent = message; };
  const memberIndex = number => active?.members.findIndex(member => member.number === number) ?? -1;

  function resetRoster() {
    for (const row of rows.values()) row.controller?.abort();
    rows.clear();
    roster.replaceChildren();
  }

  function changeMember(number, action) {
    if (!active) return;
    const index = memberIndex(number);
    if (index < 0) return;
    if (action === 'remove') active.members.splice(index, 1);
    else {
      const target = index + (action === 'up' ? -1 : 1);
      if (target < 0 || target >= active.members.length) return;
      [active.members[index], active.members[target]] = [active.members[target], active.members[index]];
    }
    dirty = true;
    persist();
    if (action === 'remove') {
      const next = active.members[Math.min(index, active.members.length - 1)];
      if (next) rows.get(next.number).remove.focus({ preventScroll: true });
      else find('#active-team-name').focus({ preventScroll: true });
    }
  }

  function makeRow(number) {
    const node = element('li');
    node.dataset.number = String(number);
    const title = element('strong');
    const name = element('span', '', 'member-name');
    const actions = element('div', undefined, 'team-actions');
    const detail = element('div', undefined, 'member-details pokemon-card');
    detail.hidden = true;
    const row = { node, title, name, detail, controller: null };
    row.inspect = button('Inspect', () => {
      const expanded = detail.hidden;
      detail.hidden = !expanded;
      renderRoster();
      if (!expanded) { row.controller?.abort(); return; }
      row.controller = new AbortController();
      inspectMember(detail, number, row.controller.signal);
    });
    row.up = button('Move up', () => changeMember(number, 'up'));
    row.down = button('Move down', () => changeMember(number, 'down'));
    row.remove = button('Remove', () => changeMember(number, 'remove'));
    actions.append(row.inspect, row.up, row.down, row.remove);
    node.append(title, name, actions, detail);
    return row;
  }

  function renderRoster() {
    const focus = document.activeElement;
    const hadFocus = roster.contains(focus);
    const members = active?.members || [];
    for (const [number, row] of rows) {
      if (members.some(member => member.number === number)) continue;
      row.controller?.abort();
      row.node.remove();
      rows.delete(number);
    }
    members.forEach((member, index) => {
      let row = rows.get(member.number);
      if (!row) { row = makeRow(member.number); rows.set(member.number, row); }
      row.title.textContent = `Member ${index + 1}`;
      const name = names.get(member.number) || member.name;
      row.name.textContent = `${name || 'Pokémon'} · #${String(member.number).padStart(4, '0')}`;
      const expanded = !row.detail.hidden;
      const inspectionAction = expanded ? 'Hide details' : 'Inspect';
      row.inspect.textContent = inspectionAction;
      row.inspect.setAttribute('aria-expanded', String(expanded));
      for (const [control, verb] of [[row.inspect, inspectionAction], [row.up, 'Move up'], [row.down, 'Move down'], [row.remove, 'Remove']]) {
        control.setAttribute('aria-label', `${verb} Member ${index + 1}, ${name || 'Pokémon'} #${String(member.number).padStart(4, '0')}`);
      }
      // Keep boundary controls focusable after a move, while making them inert.
      row.up.setAttribute('aria-disabled', String(index === 0));
      row.down.setAttribute('aria-disabled', String(index === members.length - 1));
      if (roster.children[index] !== row.node) roster.insertBefore(row.node, roster.children[index] || null);
    });
    if (hadFocus && focus.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
    find('#team-empty').hidden = members.length > 0;
  }

  function renderEditor() {
    editor.hidden = !active;
    find('#latest-team').hidden = Boolean(active);
    if (active) {
      find('#active-team-name').textContent = active.name;
      find('#member-count').textContent = `${active.members.length} ${active.members.length === 1 ? 'member' : 'members'}`;
      const context = find('#team-search-context');
      context.textContent = active.searchContext == null ? '' : `Original search: #${String(active.searchContext).padStart(4, '0')}`;
      if (noteInput.value !== active.note) noteInput.value = active.note;
    }
    find('#team-conflict').hidden = !conflicted;
    find('#retry-team-save').hidden = !dirty || conflicted;
    find('#backup-current').hidden = !active;
    renderRoster();
    onSelectionChange();
  }

  function renderLibrary() {
    const result = store.list();
    const focus = document.activeElement;
    const focusId = focus?.dataset.teamId;
    const focusAction = focus?.dataset.teamAction;
    find('#team-recovery').textContent = result.unavailable
      ? 'Browser storage is unavailable. Use backups to keep your work.'
      : result.unreadable ? `${result.unreadable} saved record(s) could not be read. They were left unchanged and are not included in backups.` : '';
    const latest = find('#latest-team');
    latest.replaceChildren();
    library.replaceChildren();
    if (!result.teams.length) latest.textContent = 'Add a Pokémon to start your first team.';
    else {
      const recent = result.teams[0];
      const control = button('Continue team', () => open(recent.id));
      control.dataset.teamId = recent.id;
      control.dataset.teamAction = 'Continue team';
      latest.append(element('p', `Continue your team: ${recent.name}`), control);
    }
    for (const record of result.teams) {
      const item = element('li');
      const actions = element('div', undefined, 'team-actions');
      for (const [text, action] of [['Open team', () => open(record.id)], ['Rename', () => { if (open(record.id)) beginNaming(); }], ['Delete', () => remove(record)]]) {
        const control = button(text, action);
        control.dataset.teamId = record.id;
        control.dataset.teamAction = text;
        actions.append(control);
      }
      item.append(element('strong', record.name), element('span', `${record.members.length} members`), actions);
      library.append(item);
    }
    if (focusId && focusAction) {
      [...root.querySelectorAll('button')].find(node => node.dataset.teamId === focusId && node.dataset.teamAction === focusAction)?.focus({ preventScroll: true });
    }
  }

  function persist() {
    clearTimeout(noteTimer);
    if (!active || !dirty) return !dirty && !conflicted;
    if (conflicted) {
      // Pause writes, not local edits: reconcile rows before removal moves focus
      // and abort inspections for members that no longer belong to this team.
      renderEditor();
      return false;
    }
    notice.textContent = 'Saving…';
    try {
      active = store.save(active, { expectedRaw: baseline });
      baseline = JSON.stringify(active);
      dirty = false;
      showError('');
      notice.textContent = 'Saved on this device.';
      renderLibrary();
    } catch (error) {
      conflicted = error.name === 'ConflictError';
      notice.textContent = 'Changes are not saved on this device.';
      showError(error.message);
    }
    renderEditor();
    return !dirty && !conflicted;
  }

  function canLeave() {
    persist();
    if ((dirty || conflicted) && !window.confirm('Some edits are not saved. Download a backup before leaving, or select OK to discard these edits.')) return false;
    clearTimeout(noteTimer);
    return true;
  }

  function open(id) {
    if (!canLeave()) return false;
    try {
      const raw = store.readRaw(id);
      const record = validateTeam(JSON.parse(raw));
      resetRoster();
      active = record;
      baseline = raw;
      dirty = false;
      conflicted = false;
      naming.hidden = true;
      notice.textContent = 'Team opened. Search for more members or inspect your roster.';
      showError('');
      renderEditor();
      find('#active-team-name').focus();
      return true;
    } catch (error) { showError(`Could not open this team. ${error.message}`); renderLibrary(); return false; }
  }

  function beginNaming() {
    if (!active) return;
    nameInput.value = active.name;
    naming.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function remove(record) {
    if (!window.confirm(`Delete “${record.name}” and discard any unsaved edits to it? This cannot be undone without a backup.`)) return;
    try {
      const raw = store.readRaw(record.id);
      if (active?.id === record.id && raw !== baseline) throw new Error('This team changed in another tab. Reload before deleting it.');
      store.remove(record.id, { expectedRaw: raw });
      if (active?.id === record.id) {
        clearTimeout(noteTimer);
        resetRoster();
        active = null; baseline = null; dirty = false; conflicted = false;
        naming.hidden = true;
      }
      notice.textContent = 'Team deleted.';
      showError(''); renderLibrary(); renderEditor();
      find('#new-team').focus();
    } catch (error) { showError(`Could not delete the team. ${error.message}`); }
  }

  function download(onlyCurrent = false) {
    persist();
    try {
      const text = store.exportBackup(active, { onlyCurrent, asCopy: conflicted });
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = element('a');
      link.href = url;
      link.download = onlyCurrent ? 'dexpermuter-current-team.json' : 'dexpermuter-teams.json';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      find('#backup-status').textContent = 'Backup downloaded. Keep this file to restore your teams in another browser.';
    } catch (error) { showError(error.message); }
  }

  find('#new-team').addEventListener('click', () => {
    if (!canLeave()) return;
    try {
      const draft = store.create();
      resetRoster(); active = draft; baseline = null; dirty = true; conflicted = false;
      naming.hidden = true;
      persist();
      find('#active-team-name').focus();
    } catch (error) { showError(error.message); }
  });
  find('#rename-team').addEventListener('click', beginNaming);
  find('#cancel-team-name').addEventListener('click', () => { naming.hidden = true; find('#rename-team').focus(); });
  naming.addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name || name.length > 80) { showError('Use a team name of 1–80 characters.'); return; }
    if (!active) return;
    active.name = name; dirty = true; naming.hidden = true;
    persist();
    find('#rename-team').focus();
  });
  noteInput.addEventListener('input', () => {
    if (!active) return;
    active.note = noteInput.value; dirty = true;
    notice.textContent = conflicted ? 'Autosave paused. Reload or save as a copy.' : 'Saving…';
    clearTimeout(noteTimer);
    if (!conflicted) noteTimer = setTimeout(persist, 300);
    renderEditor();
  });
  find('#retry-team-save').addEventListener('click', persist);
  find('#reload-team').addEventListener('click', () => { if (active) open(active.id); });
  find('#copy-team').addEventListener('click', () => {
    if (!active) return;
    try {
      active = { ...store.create(active.name), members: active.members, note: active.note, searchContext: active.searchContext };
      baseline = null; conflicted = false; dirty = true;
      persist();
    } catch (error) { showError(error.message); }
  });
  find('#export-teams').addEventListener('click', () => download());
  find('#backup-current').addEventListener('click', () => download(true));
  find('#import-teams').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    persist();
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Choose a JSON backup no larger than 1 MiB.');
      const report = store.importBackup(await file.text());
      find('#backup-status').textContent = `${report.imported} imported · ${report.skipped} skipped · ${report.failed} failed.`;
      if (report.failed) showError(report.errors.join('\n'));
      else if (!dirty && !conflicted) showError('');
      renderLibrary();
    } catch (error) { showError(error.message); }
    finally { fileInput.value = ''; }
  });
  window.addEventListener('storage', event => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && !event.key.startsWith(TEAM_PREFIX)) return;
    renderLibrary();
    if (active) {
      try {
        if (store.readRaw(active.id) === baseline) return;
        clearTimeout(noteTimer); conflicted = true;
        notice.textContent = 'Autosave paused. This team changed in another tab.';
        showError('Reload the saved team or save your current edits as a copy.');
        renderEditor();
      } catch (error) { showError(error.message); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
  window.addEventListener('beforeunload', event => { persist(); if (dirty || conflicted) { event.preventDefault(); event.returnValue = ''; } });
  renderLibrary(); renderEditor();

  return {
    position(number) { return memberIndex(number) + 1; },
    rememberPokemon(data) { names.set(data.number, data.name); renderRoster(); },
    toggle(number) {
      try {
        if (!active) { active = store.create(); baseline = null; }
        const index = memberIndex(number);
        if (index >= 0) active.members.splice(index, 1);
        else active.members.push({ number, name: names.get(number)?.slice(0, 200) || null });
        dirty = true;
        persist();
      } catch (error) { showError(error.message); }
    },
  };
}
