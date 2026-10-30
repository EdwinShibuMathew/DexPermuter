import { CHALLENGE_PREFIX, MAX_BACKUP_BYTES, createChallengeStore, validateChallenge } from './challenges.js';

function button(text, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  node.addEventListener('click', action);
  return node;
}

/** Owns user edits independently of asynchronous Pokémon card rendering. */
export function createChallengeWorkspace({ root, onResume, onSelectionChange, store = createChallengeStore() }) {
  if (!root) return null;
  const find = selector => root.querySelector(selector);
  const saveButton = find('#save-challenge');
  const naming = find('#challenge-naming');
  const nameInput = find('#challenge-name');
  const editor = find('#challenge-editor');
  const noteInput = find('#challenge-note');
  const notice = find('#challenge-status');
  const errorMessage = find('#challenge-error');
  const conflictControls = find('#challenge-conflict');
  const retryButton = find('#retry-challenge-save');
  const currentBackup = find('#backup-current');
  const latest = find('#latest-challenge');
  const library = find('#challenge-list');
  const fileInput = find('#challenge-backup-file');
  let startingNumber = null;
  let ready = false;
  let active = null;
  let baseline = null;
  let dirty = false;
  let conflicted = false;
  let noteTimer;
  let namingMode = 'create';
  let pendingSelection = null;

  function showError(message) {
    errorMessage.textContent = message;
  }

  function renderEditor() {
    editor.hidden = !active;
    if (active) {
      find('#active-challenge-name').textContent = active.name;
      find('#shortlist-count').textContent = `${active.selectedNumbers.length} shortlisted · #${String(active.startingNumber).padStart(4, '0')}`;
      if (noteInput.value !== active.note) noteInput.value = active.note;
    }
    conflictControls.hidden = !conflicted;
    retryButton.hidden = !dirty || conflicted;
    currentBackup.hidden = !dirty && !conflicted;
    saveButton.disabled = !ready;
    saveButton.textContent = active ? 'Save as new challenge' : 'Save challenge';
    onSelectionChange();
  }

  function renderLibrary() {
    const result = store.list();
    const recovery = find('#challenge-recovery');
    recovery.textContent = result.unavailable
      ? 'Browser storage is unavailable. Use backups to keep your work.'
      : result.unreadable ? `${result.unreadable} saved record(s) could not be read. They were left unchanged and are not included in backups.` : '';
    latest.replaceChildren();
    library.replaceChildren();
    if (!result.challenges.length) {
      latest.textContent = 'Save a search to pick up where you left off next time.';
      return;
    }
    const recent = result.challenges[0];
    const label = document.createElement('p');
    label.textContent = `Continue your challenge: ${recent.name}`;
    latest.append(label, button('Continue challenge', () => resume(recent.id)));
    for (const record of result.challenges) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = record.name;
      const detail = document.createElement('span');
      detail.textContent = `#${String(record.startingNumber).padStart(4, '0')} · ${record.selectedNumbers.length} shortlisted`;
      const actions = document.createElement('div');
      actions.className = 'challenge-actions';
      actions.append(
        button('Resume', () => resume(record.id)),
        button('Rename', () => { if (resume(record.id)) beginNaming('rename'); }),
        button('Delete', () => remove(record)),
      );
      item.append(title, detail, actions);
      library.append(item);
    }
  }

  function persist() {
    clearTimeout(noteTimer);
    if (!active || !dirty || conflicted) return !dirty && !conflicted;
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

  function beginNaming(mode = 'create', number = null) {
    if (!ready) return;
    namingMode = mode;
    pendingSelection = number;
    nameInput.value = active?.name || `Challenge #${String(startingNumber).padStart(4, '0')}`;
    find('#challenge-name-submit').textContent = mode === 'rename' ? 'Save name' : 'Save challenge';
    naming.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function resume(id) {
    if (!canLeave()) return false;
    try {
      const raw = store.readRaw(id);
      const record = validateChallenge(JSON.parse(raw));
      active = record;
      baseline = raw;
      startingNumber = record.startingNumber;
      ready = true;
      dirty = true;
      conflicted = false;
      naming.hidden = true;
      persist();
      onResume(record.startingNumber);
      renderEditor();
      return true;
    } catch (error) {
      showError(`Could not resume this challenge. ${error.message}`);
      renderLibrary();
      return false;
    }
  }

  function remove(record) {
    if (!window.confirm(`Delete “${record.name}” and discard any unsaved edits to it? This cannot be undone without a backup.`)) return;
    try {
      const raw = store.readRaw(record.id);
      if (active?.id === record.id && raw !== baseline) throw Object.assign(new Error('This challenge changed in another tab. Reload before deleting it.'), { name: 'ConflictError' });
      store.remove(record.id, { expectedRaw: raw });
      if (active?.id === record.id) {
        clearTimeout(noteTimer);
        active = null;
        baseline = null;
        dirty = false;
        conflicted = false;
        naming.hidden = true;
      }
      notice.textContent = 'Challenge deleted.';
      showError('');
      renderLibrary();
      renderEditor();
      saveButton.focus();
    } catch (error) { showError(`Could not delete the challenge. ${error.message}`); }
  }

  function download(onlyCurrent = false) {
    clearTimeout(noteTimer);
    if (active) active.note = noteInput.value;
    persist();
    try {
      const text = store.exportBackup(active, { onlyCurrent, asCopy: conflicted });
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = onlyCurrent ? 'dexpermuter-current-challenge.json' : 'dexpermuter-challenges.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      find('#backup-status').textContent = 'Backup downloaded. Keep this file to restore your challenges in another browser.';
    } catch (error) { showError(error.message); }
  }

  saveButton.addEventListener('click', () => beginNaming());
  find('#cancel-challenge-name').addEventListener('click', () => {
    naming.hidden = true;
    pendingSelection = null;
    saveButton.focus();
  });
  naming.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const name = nameInput.value.trim();
      if (!name || name.length > 80) throw new Error('Use a challenge name of 1–80 characters.');
      if (namingMode === 'rename' && active) {
        active.name = name;
      } else {
        if (!canLeave()) return;
        const draft = store.create(startingNumber, name);
        if (active) { draft.note = active.note; draft.selectedNumbers = [...active.selectedNumbers]; }
        if (pendingSelection !== null) draft.selectedNumbers = [pendingSelection];
        active = draft;
        baseline = null;
        conflicted = false;
      }
      dirty = true;
      naming.hidden = true;
      pendingSelection = null;
      persist();
      noteInput.focus();
    } catch (error) { showError(error.message); }
  });
  noteInput.addEventListener('input', () => {
    if (!active) return;
    active.note = noteInput.value;
    dirty = true;
    notice.textContent = conflicted ? 'Autosave paused. Reload or save as a copy.' : 'Saving…';
    clearTimeout(noteTimer);
    if (!conflicted) noteTimer = setTimeout(persist, 300);
    renderEditor();
  });
  retryButton.addEventListener('click', persist);
  find('#reload-challenge').addEventListener('click', () => { if (active) resume(active.id); });
  find('#copy-challenge').addEventListener('click', () => {
    if (!active) return;
    const draft = store.create(active.startingNumber, active.name);
    active = { ...draft, selectedNumbers: [...active.selectedNumbers], note: active.note };
    baseline = null;
    conflicted = false;
    dirty = true;
    persist();
  });
  find('#export-challenges').addEventListener('click', () => download());
  currentBackup.addEventListener('click', () => download(true));
  find('#import-challenges').addEventListener('click', () => fileInput.click());
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
    if (event.key !== null && !event.key.startsWith(CHALLENGE_PREFIX)) return;
    renderLibrary();
    if (active) {
      try {
        if (store.readRaw(active.id) === baseline) return;
        clearTimeout(noteTimer);
        conflicted = true;
        notice.textContent = 'Autosave paused. This challenge changed in another tab.';
        showError('Reload the saved challenge or save your current edits as a copy.');
        renderEditor();
      } catch (error) { showError(error.message); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
  window.addEventListener('beforeunload', event => {
    persist();
    if (dirty || conflicted) { event.preventDefault(); event.returnValue = ''; }
  });
  renderLibrary();
  renderEditor();

  return {
    inputChanged() { ready = false; saveButton.disabled = true; },
    prepareSearch(number) {
      if (number !== startingNumber) {
        if (!canLeave()) return false;
        active = null;
        baseline = null;
        dirty = false;
        conflicted = false;
        naming.hidden = true;
        notice.textContent = '';
        showError('');
      }
      startingNumber = number;
      ready = number !== null;
      renderEditor();
      return true;
    },
    isSelected(original, number) { return active?.startingNumber === original && active.selectedNumbers.includes(number); },
    shortlist(original, number) {
      if (!ready || startingNumber !== original) return;
      if (!active) { beginNaming('create', number); return; }
      const selected = new Set(active.selectedNumbers);
      if (selected.has(number)) selected.delete(number);
      else selected.add(number);
      active.selectedNumbers = [...selected].sort((a, b) => a - b);
      dirty = true;
      persist();
      renderEditor();
    },
  };
}
