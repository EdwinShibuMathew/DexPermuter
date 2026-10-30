import { permuteDexNumber } from './permute.js';
import { createApiClient, displayName } from './api.js';
import { createTeamWorkspace } from './team-ui.js';

const TYPE_COLORS = {
  normal: '#A8A77A', fire: '#EE8130', water: '#6390F0', electric: '#F7D02C',
  grass: '#7AC74C', ice: '#96D9D6', fighting: '#C22E28', poison: '#A33EA1',
  ground: '#E2BF65', flying: '#A98FF3', psychic: '#F95587', bug: '#A6B91A',
  rock: '#B6A136', ghost: '#735797', dragon: '#6F35FC', dark: '#705746',
  steel: '#B7B7CE', fairy: '#D685AD',
};
const FALLBACK_TYPE_COLOR = '#a8b3c3';
const TYPE_TEXT_COLORS = new Map(
  [...Object.values(TYPE_COLORS), FALLBACK_TYPE_COLOR].map(color => [color, readableTextColor(color)]),
);
const STAT_META = {
  hp: ['HP', '#f17478'], attack: ['Atk', '#f4ad65'], defense: ['Def', '#f1d563'],
  'special-attack': ['SpA', '#75b5f2'], 'special-defense': ['SpD', '#9edb7b'], speed: ['Spe', '#d69ce9'],
};
const client = createApiClient();
const form = document.querySelector('#dex-form');
const input = document.querySelector('#dex-input');
const inputError = document.querySelector('#input-error');
const grid = document.querySelector('#results-grid');
const badge = document.querySelector('#result-badge');
const status = document.querySelector('#results-status');
const empty = document.querySelector('#empty-state');
const cardContents = new WeakMap();
let debounceTimer;
let revision = 0;
let currentSearch = null;
let teamWorkspace = null;
teamWorkspace = createTeamWorkspace({
  root: document.querySelector('#team-workspace'),
  onSelectionChange: updateMembership,
  inspectMember: loadMemberDetails,
});

function updateMembership() {
  if (!teamWorkspace || !currentSearch) return;
  for (const [number, card] of currentSearch.cards) {
    const position = teamWorkspace.position(number);
    card.dataset.member = String(position > 0);
    const control = card.querySelector('.team-member-button');
    if (control) {
      control.setAttribute('aria-pressed', String(position > 0));
      control.setAttribute('aria-label', `${position ? 'Remove' : 'Add'} ${numberLabel(number)} ${position ? 'from' : 'to'} team`);
      control.textContent = position ? 'Remove from team' : '+ Add to team';
      card.querySelector('.member-badge').textContent = position ? `Member ${position}` : '';
    }
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function numberLabel(number) {
  return `#${String(number).padStart(4, '0')}`;
}

function cardTop(number, original) {
  const top = element('div', 'card-top');
  top.append(element('span', 'dex-number', numberLabel(number)));
  if (number === original) top.append(element('span', 'original-badge', 'STARTING NUMBER'));
  if (teamWorkspace) {
    const control = element('button', 'team-member-button', '+ Add to team');
    control.type = 'button';
    control.dataset.number = String(number);
    control.addEventListener('click', () => {
      if (currentSearch?.revision === revision && currentSearch.original === original) teamWorkspace.toggle(number);
    });
    top.append(element('span', 'member-badge'), control);
  }
  return top;
}

function renderCardContent(card, number, original, ...children) {
  let content = cardContents.get(card);
  if (!content) {
    content = element('div', 'card-content');
    // Keep the header and its keyboard-focused membership control mounted across
    // loading, success, failure, and retry. Only the details below it change.
    card.append(cardTop(number, original), content);
    cardContents.set(card, content);
  }
  content.replaceChildren(...children);
}

function renderLoading(card, number, original) {
  const decoration = element('div');
  decoration.setAttribute('aria-hidden', 'true');
  decoration.append(element('div', 'loading-bar'), element('div', 'loading-bar short'));
  renderCardContent(card, number, original, element('h3', '', 'Loading Pokémon…'), decoration, element('p', 'loading-copy', 'Finding your next possibility.'));
  card.setAttribute('aria-label', `${numberLabel(number)} loading`);
  card.setAttribute('aria-busy', 'true');
}

function readableTextColor(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

function plainTextSummary(data) {
  return [
    `${numberLabel(data.number)} ${data.name}`,
    `Types: ${data.types.map(displayName).join(' / ')}`,
    `Abilities: ${data.abilities.join(', ') || 'None'}`,
    `Hidden ability: ${data.hiddenAbilities.join(', ') || 'None'}`,
    `BST: ${data.bst} (${data.stats.map(stat => `${STAT_META[stat.key][0]} ${stat.value}`).join(' / ')})`,
    `Evolution: ${data.evolution}${data.evolutionError ? ` ${data.evolutionError}` : ''}`,
    'Evolution requirements can vary by game.',
  ].join('\n');
}

async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const previousFocus = document.activeElement;
    const selectionStart = previousFocus?.selectionStart;
    const selectionEnd = previousFocus?.selectionEnd;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('aria-label', 'Pokémon summary to copy');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px;';
    document.body.append(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('Copy failed');
    } finally {
      textarea.remove();
      previousFocus?.focus({ preventScroll: true });
      if (typeof selectionStart === 'number' && typeof previousFocus?.setSelectionRange === 'function' && previousFocus.type !== 'number') {
        previousFocus.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
}

function renderTypes(values) {
  const types = element('div', 'types');
  for (const type of values) {
    const pill = element('span', 'type-badge', displayName(type));
    const color = TYPE_COLORS[type] || FALLBACK_TYPE_COLOR;
    pill.style.setProperty('--type-color', color);
    pill.style.color = TYPE_TEXT_COLORS.get(color) ?? readableTextColor(color);
    types.append(pill);
  }
  return types;
}

function renderAbilities(data) {
  const abilities = element('dl', 'abilities');
  for (const [label, values] of [['Abilities', data.abilities], ['Hidden ability', data.hiddenAbilities]]) {
    const group = element('div');
    group.append(element('dt', '', label), element('dd', '', values.join(' / ') || 'None'));
    abilities.append(group);
  }
  return abilities;
}

function renderStats(data) {
  const stats = element('div', 'stats');
  const statsHeader = element('div', 'stats-header');
  statsHeader.append(element('span', 'section-label', 'Base stat total'), element('span', 'bst', String(data.bst)));
  stats.append(statsHeader);
  for (const stat of data.stats) {
    const [label, color] = STAT_META[stat.key];
    const row = element('div', 'stat-row');
    const track = element('div', 'stat-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = element('span', 'stat-fill');
    fill.style.setProperty('--stat-color', color);
    fill.style.setProperty('--stat-width', `${Math.min(100, stat.value / 255 * 100)}%`);
    track.append(fill);
    row.append(element('span', 'stat-label', label), track, element('span', 'stat-value', String(stat.value)));
    stats.append(row);
  }
  return stats;
}

function renderEvolution(data, retry) {
  const evolution = element('div', 'evolution');
  evolution.append(element('h4', 'section-label', 'Evolution family'), element('p', '', data.evolution));
  if (data.evolutionError) {
    const button = element('button', 'retry-button', 'Retry evolution');
    button.type = 'button';
    button.addEventListener('click', retry);
    evolution.append(element('p', 'card-error', data.evolutionError), button);
  }
  return evolution;
}

function renderCopyControls(data) {
  const copy = element('button', 'copy-button', '⧉  Copy to clipboard');
  copy.type = 'button';
  copy.setAttribute('aria-label', `Copy summary for ${data.name}`);
  const copyStatus = element('p', 'copy-status');
  copyStatus.setAttribute('role', 'status');
  let resetTimer;
  copy.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    copy.disabled = true;
    copyStatus.textContent = '';
    try {
      await copyText(plainTextSummary(data));
      copy.textContent = '✓  Copied!';
      copy.dataset.copied = 'true';
      copyStatus.textContent = 'Summary copied to clipboard.';
      copyStatus.style.color = 'var(--accent)';
    } catch {
      copyStatus.textContent = 'Copy was blocked. Please select and copy the card text.';
      copyStatus.style.color = 'var(--danger)';
    } finally {
      copy.disabled = false;
      resetTimer = setTimeout(() => {
        copy.textContent = '⧉  Copy to clipboard';
        delete copy.dataset.copied;
        copyStatus.textContent = '';
      }, 2400);
    }
  });
  return [copy, copyStatus];
}

function renderCard(card, data, search, retry) {
  card.removeAttribute('aria-busy');
  card.setAttribute('aria-label', `${numberLabel(data.number)} ${data.name}`);
  card.style.setProperty('--card-accent', TYPE_COLORS[data.types[0]] || FALLBACK_TYPE_COLOR);
  renderCardContent(card, data.number, search.original, ...pokemonDetails(data, retry));
  teamWorkspace?.rememberPokemon(data);
  updateMembership();
}

function pokemonDetails(data, retry) {
  return [element('h3', '', data.name), renderTypes(data.types), renderAbilities(data),
    renderStats(data), renderEvolution(data, retry), ...renderCopyControls(data)];
}

async function loadMemberDetails(container, number, signal) {
  container.textContent = 'Loading Pokémon…';
  const retry = () => loadMemberDetails(container, number, signal);
  try {
    const data = await client.getPokemon(number, { signal });
    if (signal.aborted || !container.isConnected) return;
    container.replaceChildren(...pokemonDetails(data, retry));
    teamWorkspace?.rememberPokemon(data);
  } catch (error) {
    if (signal.aborted || !container.isConnected || error.name === 'AbortError') return;
    const control = element('button', 'retry-button', 'Retry Pokémon');
    control.type = 'button';
    control.addEventListener('click', retry);
    container.replaceChildren(element('p', 'card-error', error.message || 'Could not load this Pokémon.'), control);
  }
}

function announce(search) {
  if (search.revision !== revision) return;
  const states = [...search.states.values()];
  const loaded = states.filter(state => state === 'ready' || state === 'partial').length;
  const errors = states.filter(state => state === 'error').length;
  const partial = states.filter(state => state === 'partial').length;
  const loading = states.length - loaded - errors;
  status.textContent = `${states.length} possibilities · ${loaded} loaded${loading ? ` · ${loading} loading` : ''}${errors ? ` · ${errors} failed` : ''}${partial ? ` · ${partial} missing evolution data` : ''}`;
}

async function loadCard(card, number, search) {
  if (search.revision !== revision || !card.isConnected) return;
  search.states.set(number, 'loading');
  announce(search);
  renderLoading(card, number, search.original);
  updateMembership();
  const retry = () => loadCard(card, number, search);
  try {
    const data = await client.getPokemon(number, { signal: search.controller.signal });
    if (search.revision !== revision || !card.isConnected) return;
    renderCard(card, data, search, retry);
    search.states.set(number, data.evolutionError ? 'partial' : 'ready');
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (search.revision !== revision || !card.isConnected) return;
    card.removeAttribute('aria-busy');
    card.setAttribute('aria-label', `${numberLabel(number)} could not load`);
    const button = element('button', 'retry-button', 'Retry Pokémon');
    button.type = 'button';
    button.addEventListener('click', retry);
    renderCardContent(card, number, search.original, element('h3', '', 'Connection missed.'), element('p', 'card-error', error.message || 'Could not load this Pokémon.'), button);
    search.states.set(number, 'error');
  }
  updateMembership();
  announce(search);
}

function runSearch() {
  clearTimeout(debounceTimer);
  const raw = input.value.trim();
  const badInput = input.validity.badInput;
  inputError.textContent = '';
  input.removeAttribute('aria-invalid');
  if (!raw && !badInput) {
    currentSearch?.controller.abort();
    currentSearch = null;
    grid.replaceChildren();
    badge.textContent = '0';
    empty.hidden = false;
    status.textContent = 'Enter a number to get started.';
    return;
  }
  let numbers;
  const number = Number(raw);
  try {
    if (badInput || !/^\d+$/.test(raw)) throw new Error('Enter a whole number from 1 to 1025.');
    numbers = permuteDexNumber(number);
  } catch (error) {
    currentSearch?.controller.abort();
    currentSearch = null;
    input.setAttribute('aria-invalid', 'true');
    inputError.textContent = error.message;
    grid.replaceChildren();
    badge.textContent = '0';
    empty.hidden = true;
    status.textContent = 'No results. Check your starting number.';
    return;
  }
  if (currentSearch?.original === number) {
    currentSearch.revision = revision;
    // Restart pending cards so responses from an interrupted input cannot strand them.
    for (const [dex, state] of currentSearch.states) {
      if (state === 'loading') loadCard(currentSearch.cards.get(dex), dex, currentSearch);
    }
    announce(currentSearch);
    return;
  }
  const previousSearch = currentSearch;
  const search = { original: number, revision, controller: new AbortController(), states: new Map(numbers.map(dex => [dex, 'loading'])), cards: new Map() };
  currentSearch = search;
  grid.replaceChildren();
  badge.textContent = String(numbers.length);
  empty.hidden = true;
  for (const dex of numbers) {
    const card = element('article', 'pokemon-card');
    search.cards.set(dex, card);
    grid.append(card);
    loadCard(card, dex, search);
  }
  // Subscribe the new cards first so overlapping requests keep their consumers.
  previousSearch?.controller.abort();
}

input.addEventListener('input', () => {
  revision += 1;
  // Stop pending updates immediately, including during the debounce interval.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 250);
});
form.addEventListener('submit', event => {
  event.preventDefault();
  revision += 1;
  runSearch();
});
runSearch();
