// Synthetic user records only. Never replace these with exported user data.
export const DATE = '2026-01-01T00:00:00.000Z';
export const legacyTeam = {
  version: 1, id: 'legacy-contract', name: 'Legacy fixture', startingNumber: 1,
  selectedNumbers: [100, 1, 10], note: 'Synthetic note', createdAt: DATE, updatedAt: DATE,
};
export const orderedTeam = {
  version: 2, id: 'ordered-contract', name: 'Ordered fixture',
  members: [{ number: 1025, name: 'Pecharunt' }, { number: 1, name: null }],
  note: 'Synthetic note', searchContext: 25, createdAt: DATE, updatedAt: DATE,
};
export const backups = [
  { version: 1, challenges: [legacyTeam] },
  { version: 2, teams: [orderedTeam] },
];
export const ownership = [
  ['dexpermuter:v1:https://pokeapi.co/api/v2/pokemon/1/', true],
  ['dexpermuter:v1:https://pokeapi.co/api/v2/generation/1/', true],
  ['dexpermuter:v1:https://pokeapi.co/api/v2/pokemon?limit=20', true],
  ['dexpermuter:challenges:v1:legacy-contract', false],
  ['dexpermuter:v2:https://pokeapi.co/api/v2/pokemon/1/', false],
  ['dexpermuter:v1:future-metadata', false],
  ['dexpermuter:v1:pokemon/1/', false],
  ['dexpermuter:v1:http://pokeapi.co/api/v2/pokemon/1/', false],
  ['dexpermuter:v1:https://example.com/api/v2/pokemon/1/', false],
  ['dexpermuter:v1:https://pokeapi.co.evil.test/api/v2/pokemon/1/', false],
  ['dexpermuter:v1:https://user@pokeapi.co/api/v2/pokemon/1/', false],
  ['dexpermuter:v1:https://pokeapi.co/api/v2/pokemon/1/#fragment', false],
  ['dexpermuter:v1:https://pokeapi.co/api/v2/../pokemon/1/', false],
  ['dexpermuter:v1:https://pokeapi.co:443/api/v2/pokemon/1/', false],
  ['unrelated', false],
];
export const warmCore = {
  number: 1,
  pokemon: {
    name: 'bulbasaur', types: [{ slot: 1, type: { name: 'grass' } }], abilities: [],
    stats: ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed']
      .map(name => ({ stat: { name }, base_stat: 45 })),
  },
  species: { name: 'bulbasaur', names: [], evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/1/' } },
  chain: { chain: { species: { name: 'bulbasaur' }, evolves_to: [] } },
};
