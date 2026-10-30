import test from 'node:test';
import assert from 'node:assert/strict';
import { STAT_KEYS } from '../js/api.js';

// A minimal DOM harness exercises the real controller without a browser dependency.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.value = '';
    this.validity = { badInput: false };
    this.parent = null;
    this.content = '';
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(' '); }
  set textContent(value) { this.content = String(value); this.replaceChildren(); }
  get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  addEventListener(event, callback) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), callback]);
  }
  async trigger(event) { await Promise.all((this.listeners.get(event) || []).map(callback => callback({ preventDefault() {} }))); }
  focus() { document.activeElement = this; }
  select() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

test('search handoffs retain stalled evolution requests and cancel only abandoned chains', async () => {
  const original = Object.fromEntries(['document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = Object.fromEntries(['dex-form', 'dex-input', 'input-error', 'results-grid', 'result-badge', 'results-status', 'empty-state'].map(id => [id, new Element()]));
  const body = new Element('body');
  body.append(...Object.values(nodes));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body, querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag),
  } });
  const chains = [];
  const starts = [];
  let active = 0;
  let maximum = 0;
  globalThis.fetch = (url, { signal }) => {
    starts.push(url);
    const number = Number(url.match(/\/(\d+)\/$/)[1]);
    active += 1;
    maximum = Math.max(maximum, active);
    const response = data => ({ ok: true, json: async () => data });
    if (url.includes('/pokemon/')) {
      active -= 1;
      return Promise.resolve(response({
        name: `pokemon-${number}`, stats: STAT_KEYS.map(name => ({ stat: { name }, base_stat: 50 })),
        types: [{ slot: 1, type: { name: 'normal' } }], abilities: [],
      }));
    }
    if (url.includes('/pokemon-species/')) {
      active -= 1;
      return Promise.resolve(response({ name: `pokemon-${number}`, names: [], evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${number}/` } }));
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = canceled => {
        if (finished) return;
        finished = true;
        active -= 1;
        signal.removeEventListener('abort', cancel);
        if (canceled) reject(signal.reason);
        else resolve(response({ chain: { species: { name: `pokemon-${number}` }, evolves_to: [] } }));
      };
      const cancel = () => finish(true);
      signal.addEventListener('abort', cancel, { once: true });
      chains.push({ signal, release: () => finish(false) });
    });
  };
  const settle = () => new Promise(setImmediate);
  const submit = async value => {
    nodes['dex-input'].value = value;
    await nodes['dex-form'].trigger('submit');
    await settle();
  };
  try {
    await import('../js/app.js?evolution-handoff');
    await submit('1');
    assert.equal(chains.length, 4);
    assert.equal(starts.length, 12);
    const shared = [...chains];
    for (const value of ['10', '100']) {
      await submit(value);
      assert.equal(chains.length, 4);
      assert.equal(starts.length, 12);
      assert.ok(shared.every(request => !request.signal.aborted));
      assert.match(nodes['results-status'].textContent, /4 loading/);
    }

    // Unrelated results must start without waiting for the original chain timeouts.
    await submit('2');
    assert.ok(shared.every(request => request.signal.aborted));
    assert.equal(chains.length, 7);
    const abandoned = chains.slice(4);
    await submit('');
    assert.ok(abandoned.every(request => request.signal.aborted));
    assert.equal(active, 0);
    assert.equal(nodes['results-grid'].children.length, 0);

    // The cached core resources can start a fresh chain and transfer it again.
    await submit('1000');
    assert.equal(chains.length, 11);
    const retained = chains.slice(7);
    await submit('1');
    assert.equal(chains.length, 11);
    assert.ok(retained.every(request => !request.signal.aborted));
    for (const request of chains) request.release();
    await settle();
    assert.match(nodes['results-status'].textContent, /4 loaded/);
    assert.doesNotMatch(nodes['results-grid'].textContent, /Connection missed/);
    const starting = descendants(nodes['results-grid']).find(node => node.className === 'original-badge');
    assert.equal(starting.parent.children[0].textContent, '#0001');
    assert.equal(maximum, 4);
    assert.equal(active, 0);
  } finally {
    await submit('');
    for (const request of chains) request.release();
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('UI handles debounce, Enter, stale responses, independent retries, validation, and clipboard fallback', async t => {
  const original = Object.fromEntries(['document', 'navigator', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const timers = new Map();
  const nodes = Object.fromEntries(['dex-form', 'dex-input', 'input-error', 'results-grid', 'result-badge', 'results-status', 'empty-state'].map(id => [id, new Element()]));
  const body = new Element('body');
  body.append(...Object.values(nodes));
  let copied = '';
  const mockDocument = {
    body, activeElement: body,
    querySelector: selector => nodes[selector.slice(1)],
    createElement: tag => new Element(tag),
    execCommand: command => { assert.equal(command, 'copy'); copied = mockDocument.activeElement.value; return true; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: mockDocument });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('Denied'); } } } });
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 250 && delay !== 2400) return original.setTimeout.value(callback, delay, ...args);
    const id = Symbol();
    timers.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = id => { if (!timers.delete(id)) original.clearTimeout.value(id); };
  let releaseOld;
  let pauseOne = true;
  let failOne = false;
  let calls = 0;
  globalThis.fetch = async url => {
    calls += 1;
    const number = Number(url.match(/\/(\d+)\/$/)[1]);
    if (url.includes('/pokemon/')) {
      if (number === 1 && pauseOne) await new Promise(resolve => { releaseOld = resolve; });
      if (number === 1 && failOne) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({
        name: `pokemon-${number}`,
        types: [{ slot: 1, type: { name: 'electric' } }],
        abilities: [{ slot: 1, ability: { name: 'static' }, is_hidden: false }],
        stats: STAT_KEYS.map(name => ({ stat: { name }, base_stat: 50 })),
      }) };
    }
    if (url.includes('/pokemon-species/')) return { ok: true, json: async () => ({
      name: `pokemon-${number}`,
      names: [{ language: { name: 'en' }, name: `Pokémon ${number}` }],
      evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${number}/` },
    }) };
    return { ok: true, json: async () => ({ chain: { species: { name: `pokemon-${number}` }, evolves_to: [] } }) };
  };
  const settle = () => new Promise(setImmediate);
  const flush = async delay => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    }
    await settle();
  };
  const input = nodes['dex-input'];
  const grid = nodes['results-grid'];
  const submit = async value => {
    input.value = value;
    await nodes['dex-form'].trigger('submit');
    await settle();
  };
  try {
    await import('../js/app.js');
    assert.equal(calls, 0);
    assert.equal(nodes['empty-state'].hidden, false);

    await t.test('debounces input and ignores an older result after Enter submits a new number', async () => {
      input.value = '1';
      await input.trigger('input');
      assert.equal(calls, 0);
      await flush(250);
      assert.equal(grid.children.length, 4);
      await submit('2');
      assert.equal(grid.children.length, 3);
      const before = grid.textContent;
      pauseOne = false;
      failOne = true;
      releaseOld();
      await settle();
      assert.equal(grid.textContent, before);
      assert.match(nodes['results-status'].textContent, /3 loaded/);
    });

    await t.test('one failed card leaves others usable and retry recovers it', async () => {
      await submit('1');
      assert.match(nodes['results-status'].textContent, /3 loaded.*1 failed/);
      const retry = descendants(grid).find(node => node.textContent === 'Retry Pokémon');
      assert.ok(retry);
      failOne = false;
      await retry.trigger('click');
      await settle();
      assert.match(nodes['results-status'].textContent, /4 loaded/);
      assert.equal(grid.children.length, 4);
    });

    await t.test('clipboard fallback copies the normalized summary and confirms briefly', async () => {
      const copy = descendants(grid).find(node => node.className === 'copy-button');
      copy.focus();
      await copy.trigger('click');
      assert.equal(copied, [
        '#0001 Pokémon 1',
        'Types: Electric',
        'Abilities: Static',
        'Hidden ability: None',
        'BST: 300 (HP 50 / Atk 50 / Def 50 / SpA 50 / SpD 50 / Spe 50)',
        'Evolution: Pokemon 1 does not evolve.',
        'Evolution requirements can vary by game.',
      ].join('\n'));
      assert.equal(mockDocument.activeElement, copy);
      assert.equal(copy.dataset.copied, 'true');
      await flush(2400);
      assert.equal(copy.dataset.copied, undefined);
    });

    await t.test('native clipboard success and total clipboard failure give useful feedback', async () => {
      const copy = descendants(grid).find(node => node.className === 'copy-button');
      navigator.clipboard.writeText = async text => { copied = text; };
      await copy.trigger('click');
      assert.match(copied, /^#0001/);
      assert.equal(copy.dataset.copied, 'true');
      await flush(2400);
      navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
      mockDocument.execCommand = () => false;
      await copy.trigger('click');
      assert.match(grid.textContent, /Copy was blocked/);
      assert.equal(copy.disabled, false);
      await flush(2400);
    });

    await t.test('invalid input clears results and clearing input restores the empty state', async () => {
      for (const value of ['0', '1026', '1.5', '1e2']) {
        await submit(value);
        assert.equal(input.attributes.get('aria-invalid'), 'true');
        assert.equal(grid.children.length, 0);
        assert.match(nodes['input-error'].textContent, /1 to 1025/);
      }
      await submit('');
      assert.equal(input.attributes.has('aria-invalid'), false);
      assert.equal(nodes['empty-state'].hidden, false);
    });

    // Stall actual fetches so these cases exercise the controller and shared API queue together.
    const stalled = new Set();
    const starts = [];
    const waiting = [];
    let active = 0;
    let maximum = 0;
    const apiResponse = (url, number) => {
      let data;
      if (url.includes('/pokemon/')) data = {
        name: `pokemon-${number}`,
        types: [{ slot: 1, type: { name: 'normal' } }],
        abilities: [{ slot: 1, ability: { name: 'static' }, is_hidden: false }],
        stats: STAT_KEYS.map(name => ({ stat: { name }, base_stat: 50 })),
      };
      else if (url.includes('/pokemon-species/')) data = {
        name: `pokemon-${number}`, names: [],
        evolution_chain: { url: `https://pokeapi.co/api/v2/evolution-chain/${number}/` },
      };
      else data = { chain: { species: { name: `pokemon-${number}` }, evolves_to: [] } };
      return { ok: true, json: async () => data };
    };
    globalThis.fetch = (url, { signal }) => {
      const number = Number(url.match(/\/(\d+)\/$/)[1]);
      starts.push({ number, signal });
      active += 1;
      maximum = Math.max(maximum, active);
      if (!stalled.has(number)) { active -= 1; return Promise.resolve(apiResponse(url, number)); }
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = canceled => {
          if (finished) return;
          finished = true;
          active -= 1;
          signal.removeEventListener('abort', cancel);
          if (canceled) reject(signal.reason);
          else resolve(apiResponse(url, number));
        };
        const cancel = () => finish(true);
        signal.addEventListener('abort', cancel, { once: true });
        waiting.push(() => finish(false));
      });
    };
    const pauseSearch = async value => {
      starts.length = 0;
      // Stalling every possible number keeps the test independent of permutation ordering.
      for (let number = 1; number <= 1025; number += 1) stalled.add(number);
      await submit(value);
      assert.equal(starts.length, 4);
    };
    const releaseSearch = async () => {
      stalled.clear();
      for (const release of waiting.splice(0)) release();
      await settle();
    };

    await t.test('new searches load promptly without starting queued obsolete requests', async () => {
      await pauseSearch('12');
      const old = [...starts];
      stalled.clear();
      await submit('34');
      assert.ok(old.every(request => request.signal.aborted));
      assert.equal(starts.slice(4).some(request => [12, 21, 102, 120, 201, 210, 1002, 1020].includes(request.number)), false);
      assert.equal(grid.children.length, 6);
      assert.match(nodes['results-status'].textContent, /6 loaded/);
      assert.equal(maximum, 4);
      assert.equal(active, 0);
    });

    await t.test('clearing or invalidating input aborts stalled work after debounce', async () => {
      for (const [search, value] of [['56', ''], ['78', '0']]) {
        await pauseSearch(search);
        const old = [...starts];
        input.value = value;
        await input.trigger('input');
        assert.ok(old.every(request => !request.signal.aborted));
        await flush(250);
        assert.ok(old.every(request => request.signal.aborted));
        assert.equal(starts.length, 4);
        assert.equal(active, 0);
        assert.equal(grid.children.length, 0);
        assert.equal(nodes['empty-state'].hidden, value !== '');
        assert.doesNotMatch(nodes['results-status'].textContent, /failed/);
      }
    });

    await t.test('submitting an unchanged number retains active requests', async () => {
      await pauseSearch('89');
      const old = [...starts];
      await submit('089');
      assert.equal(starts.length, 4);
      assert.ok(old.every(request => !request.signal.aborted));
      await releaseSearch();
      assert.match(nodes['results-status'].textContent, /6 loaded/);
    });

    await t.test('overlapping searches retain shared active requests', async () => {
      await pauseSearch('12');
      const old = [...starts];
      await submit('21');
      assert.equal(starts.length, 4);
      assert.ok(old.every(request => !request.signal.aborted));
      await releaseSearch();
      assert.match(nodes['results-status'].textContent, /8 loaded/);
      assert.equal(grid.children.length, 8);
      assert.equal(active, 0);
      assert.equal(maximum, 4);
    });

    await t.test('responses withheld during debounce recover when input returns to the same number', async () => {
      await pauseSearch('67');
      input.value = '067';
      await input.trigger('input');
      await releaseSearch();
      assert.match(grid.textContent, /Loading Pokémon/);
      const callsBeforeCommit = starts.length;
      await flush(250);
      assert.match(nodes['results-status'].textContent, /6 loaded/);
      assert.equal(starts.length, callsBeforeCommit);
      assert.doesNotMatch(grid.textContent, /Connection missed/);
    });
  } finally {
    await submit('');
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
