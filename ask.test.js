import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsk } from './ask.js';

const owned = [
  { key: 'demon', title: 'Demon Slayer', year: 2019, type: 'show', genres: ['Animation', 'Action & Adventure'], tmdb: '1', href: '#/titre/demon' },
  { key: 'dexter', title: 'Dexter: Resurrection', year: 2025, type: 'show', genres: ['Crime', 'Drame'], tmdb: '2', href: '#/titre/dexter' },
  { key: 'degaulle', title: 'La Bataille de Gaulle', year: 2026, type: 'movie', genres: ['Histoire', 'Drame'], tmdb: '3', href: '#/titre/degaulle' },
];
const anime = { id: 4, name: 'Yu Yu Hakusho', original_name: '幽☆遊☆白書', first_air_date: '1992-10-10', genre_ids: [16, 10759], poster_path: '/anime.jpg' };
const external = (title = 'Yu Yu Hakusho', year = 1992, type = 'série') => ({ title, year, type });

function setup(out, overrides = {}) {
  const calls = [];
  const dependencies = {
    library: async () => owned,
    discovery: true,
    ai: async (...args) => { calls.push({ ai: args }); return out; },
    tmdb: async (path, params) => { calls.push({ path, params }); return { results: [anime] }; },
    discoverList: async (results) => results.map((r) => ({ key: `${r.media_type}:${r.id}`, title: r.name || r.title, discover: true, kind: r.media_type, tmdbId: r.id, genres: ['Animation'], href: `#/decouvrir/${r.media_type}/${r.id}` })),
    ...overrides,
  };
  return { ask: createAsk(dependencies), calls };
}

test('Hunter x Hunter: mix discoveries and library titles, discard live action and duplicates', async () => {
  const { ask, calls } = setup({
    intro: 'Quelques aventures qui pourraient te plaire.', animationOnly: true, kind: 'tv',
    selection: [external(), { id: 0 }, { id: 1 }, { id: 2 }, external(), { id: 0 }],
  });
  const result = await ask('un anime qui ressemble à hunter x hunter');
  assert.deepEqual(result.items.map((i) => i.key), ['tv:4', 'demon']);
  assert.equal(result.items[0].href, '#/decouvrir/tv/4');
  assert.equal(result.items[1].href, '#/titre/demon');
  assert.equal(result.notice, '');
  assert.match(calls[0].ai[1], /l’ensemble des films et séries/);
  assert.doesNotMatch(calls[0].ai[1], /Dexter/);
});

test('resolve a discovery already owned to its playable library card', async () => {
  const { ask } = setup({ selection: [external('Demon Slayer', 2019), { id: 0 }] }, {
    tmdb: async () => ({ results: [{ ...anime, id: 1, name: 'Demon Slayer', first_air_date: '2019-04-06' }] }),
    discoverList: async () => { assert.fail('Owned titles must not be converted to discoveries'); },
  });
  const result = await ask('des aventures');
  assert.deepEqual(result.items, [owned[0]]);
});

test('do not replace a title with an unrelated first search result or the wrong adaptation', async () => {
  const { ask } = setup({ animationOnly: true, selection: [external()] }, {
    tmdb: async () => ({ results: [
      { ...anime, id: 30, name: 'Autre anime' },
      { ...anime, id: 31, first_air_date: '2023-12-14', genre_ids: [18] },
      { ...anime, id: 32, genre_ids: [18] },
    ] }),
  });
  const result = await ask('un anime');
  assert.deepEqual(result.items, []);
  assert.match(result.intro, /pas trouvé/);
});

test('match the original title, release year and movie/show identity', async () => {
  const { ask } = setup({ kind: 'movie', selection: [external('Kimi no Na wa.', 2016, 'film'), external()] }, {
    tmdb: async (path) => {
      assert.equal(path, '/search/movie');
      return { results: [{ id: 4, title: 'Your Name', original_title: 'Kimi no Na wa.', release_date: '2016-08-26', genre_ids: [16] }] };
    },
  });
  const result = await ask('plutôt un film', ['un anime comme Hunter x Hunter']);
  assert.deepEqual(result.items.map((i) => i.key), ['movie:4']);
});

test('verify an English anime title while displaying its French title', async () => {
  const { ask } = setup({ animationOnly: true, selection: [external('Case Closed', 1996)] }, {
    tmdb: async (path, params) => ({ results: [{ ...anime, id: 5, name: params.language === 'en-US' ? 'Case Closed' : 'Détective Conan', original_name: '名探偵コナン', first_air_date: '1996-01-08' }] }),
  });
  const result = await ask('un anime avec une enquête');
  assert.equal(result.items[0].title, 'Détective Conan');
});

test('TMDB disabled: keep useful library matches and explain the limited search', async () => {
  const { ask, calls } = setup({ selection: [{ id: 0 }, external()] }, {
    discovery: false,
    tmdb: async () => { assert.fail('TMDB must not be called without configuration'); },
  });
  const result = await ask('un anime');
  assert.deepEqual(result.items, [owned[0]]);
  assert.match(result.notice, /limitée à ta médiathèque/);
  assert.match(calls[0].ai[1], /découverte externe est indisponible/);
});

test('TMDB failure preserves library matches and reports incomplete discoveries', async () => {
  const { ask } = setup({ selection: [external(), { id: 0 }] }, {
    tmdb: async () => { throw new Error('Service unavailable'); },
  });
  const result = await ask('un anime');
  assert.deepEqual(result.items, [owned[0]]);
  assert.match(result.notice, /échoué/);
});

test('failure while preparing discoveries also preserves library matches', async () => {
  const { ask } = setup({ selection: [external(), { id: 0 }] }, {
    discoverList: async () => { throw new Error('Service unavailable'); },
  });
  const result = await ask('un anime');
  assert.deepEqual(result.items, [owned[0]]);
  assert.match(result.notice, /échoué/);
});

test('malformed selections cannot turn booleans, strings or invalid ids into library recommendations', async () => {
  const { ask, calls } = setup({ selection: [null, false, { id: false }, { id: '' }, { id: -1 }, { id: 0.5 }, { id: 9000 }, external('') ] });
  const result = await ask('un anime');
  assert.deepEqual(result.items, []);
  assert.equal(calls.filter((c) => c.path).length, 0);
});

test('keep session context and cap external requests even when the model ignores the limit', async () => {
  const { ask, calls } = setup({ selection: Array.from({ length: 30 }, () => external()) });
  await ask('plus ancien', ['un anime comme Hunter x Hunter', 'plutôt une série']);
  assert.match(calls[0].ai[2], /Hunter x Hunter.*plutôt une série.*\nplus ancien/s);
  assert.equal(calls.filter((c) => c.path).length, 8);
});

test('empty or missing selections get an honest empty-state response', async () => {
  const { ask } = setup({ intro: 'Voici huit choix parfaits !' });
  const result = await ask('une demande sans résultat');
  assert.deepEqual(result.items, []);
  assert.match(result.intro, /pas trouvé/);
});

test('explicit library-only requests use the catalog without leaking external results', async () => {
  let count = 0;
  const { ask } = setup({}, {
    ai: async (task, system) => {
      if (++count === 1) {
        assert.doesNotMatch(system, /Dexter/);
        return { libraryOnly: true, selection: [] };
      }
      assert.match(system, /Dexter/);
      return { animationOnly: true, kind: 'tv', selection: [{ id: 0 }, { id: 1 }, external()] };
    },
  });
  const result = await ask('un anime dans ma médiathèque');
  assert.deepEqual(result.items, [owned[0]]);
  assert.equal(count, 2);
});

test('an unseen request filters watched library titles even when chosen through the general catalog', async () => {
  const { ask } = setup({ unseenOnly: true, selection: [external('Demon Slayer', 2019), external()] }, {
    library: async () => [{ ...owned[0], watched: true }],
    tmdb: async (path, params) => ({ results: params.query === 'Demon Slayer'
      ? [{ ...anime, id: 1, name: 'Demon Slayer', first_air_date: '2019-04-06' }] : [anime] }),
  });
  const result = await ask('un anime que je n’ai pas vu');
  assert.deepEqual(result.items.map((i) => i.key), ['tv:4']);
});
