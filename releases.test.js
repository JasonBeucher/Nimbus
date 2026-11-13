import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovieReleases } from './releases.js';

function fixture({ existing = false, releases = [], health = [], indexers = [{ id: 1, enableInteractiveSearch: true }], failure, queue = [] } = {}) {
  let at = 123456;
  let movie = existing ? { id: 10, tmdbId: 42, qualityProfileId: 2, monitored: false, tags: [], path: '/films/test' } : null;
  const calls = [];
  const service = createMovieReleases({
    app: { url: 'radarr', key: 'secret', profile: 'HD' }, now: () => at,
    arr: async (_, path, method = 'GET', payload, options) => {
      calls.push({ path, method, payload, options });
      if (failure?.(path)) throw new Error('Radarr inaccessible');
      if (path === '/indexer') return indexers;
      if (path === '/health') return health;
      if (path === '/qualityprofile') return [{ id: 1, name: 'SD' }, { id: 2, name: 'HD' }];
      if (path === '/rootfolder') return [{ path: '/films' }];
      if (path === '/movie/lookup/tmdb?tmdbId=42') return { tmdbId: 42, title: 'Test' };
      if (path === '/movie?tmdbId=42') return movie ? [structuredClone(movie)] : [];
      if (path === '/movie' && method === 'POST') return (movie = { ...payload, id: 10, path: '/films/test' });
      if (path === '/movie/10' && method === 'PUT') return (movie = payload);
      if (path === '/release?movieId=10') return releases;
      if (path === '/queue/details?movieId=10') return queue;
      if (path === '/release' && method === 'POST') return payload;
      if (path === '/command') return { id: 99 };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  });
  return { ...service, calls, movie: () => movie, tick: (ms) => { at += ms; } };
}

const release = (extra = {}) => ({
  guid: 'release-guid', indexerId: 1,
  title: 'Test.1080p.MULTI', quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'French' }],
  size: 1024 ** 3, indexer: 'Indexeur', approved: true, rejected: false, downloadAllowed: true,
  rejections: [], seeders: 0, downloadUrl: 'https://private/?apikey=secret', magnetUrl: 'magnet:private', ...extra,
});

test('checking an unknown film creates only an unmonitored entry without starting a download', async () => {
  const f = fixture({ releases: [release()] });
  const result = await f.check(42);
  assert.equal(result.unmonitored, true);
  assert.equal(result.profile, 'HD');
  assert.equal(f.movie().qualityProfileId, 2);
  assert.equal(f.movie().monitored, false);
  assert.deepEqual(f.movie().addOptions, { searchForMovie: false });
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 1);
  assert.equal(f.calls.find((c) => c.path.startsWith('/release?')).options.timeoutMs, 120_000);
});

test('checking an existing film preserves its monitoring and settings', async () => {
  const f = fixture({ existing: true });
  f.movie().monitored = true;
  f.movie().qualityProfileId = 1;
  const result = await f.check(42);
  assert.equal(result.unmonitored, false);
  assert.equal(result.profile, 'SD');
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('releases show Radarr acceptance and reasons; private URLs are never returned', async () => {
  const f = fixture({ releases: [
    release({ title: 'rejected', approved: false, rejected: true, rejections: ['Quality not wanted'] }),
    release({ title: 'accepted' }),
    release({ title: 'wrong movie', downloadAllowed: false }),
    release({ title: 'temporarily rejected', temporarilyRejected: true }),
    release({ title: 'unknown approval', approved: undefined, size: -1, seeders: -1 }),
  ] });
  const result = await f.check(42);
  assert.equal(result.total, 5);
  assert.equal(result.accepted, 1);
  assert.equal(result.items[0].title, 'accepted');
  assert.equal(result.items[0].seeders, 0);
  assert.deepEqual(result.items[1].rejections, ['Quality not wanted']);
  assert.equal(result.items.at(-1).size, null);
  assert.equal(result.items.at(-1).seeders, null);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('magnet'));
});

test('empty results retain indexer health warnings instead of claiming absence', async () => {
  const result = await fixture({ health: [
    { source: 'IndexerStatusCheck', message: 'All indexers are unavailable' },
    { source: 'DownloadClientCheck', message: 'Download client unavailable' },
  ] }).check(42);
  assert.equal(result.total, 0);
  assert.deepEqual(result.warnings, ['All indexers are unavailable']);
  assert.equal(result.checkedAt, 123456);
});

test('failed searches propagate, then a later check can retry', async () => {
  let fail = true;
  const f = fixture({ existing: true, failure: (p) => fail && p.startsWith('/release?') });
  await assert.rejects(f.check(42), /inaccessible/);
  fail = false;
  assert.equal((await f.check(42)).total, 0);
});

test('no interactive indexer fails before adding a movie; indexer tags are respected', async () => {
  const f = fixture({ indexers: [{ enableInteractiveSearch: false }] });
  await assert.rejects(f.check(42), /Aucun indexeur/);
  assert.equal(f.movie(), null);
  const tagged = fixture({ existing: true, indexers: [{ enableInteractiveSearch: true, tags: [7] }] });
  await assert.rejects(tagged.check(42), /tags/);
  assert.ok(!tagged.calls.some((c) => c.path.startsWith('/release?')));
});

test('concurrent checks share one addition and one indexer search', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.check(42), f.check(42)]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.path === '/movie').length, 1);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/release?')).length, 1);
});

test('requesting a previously checked movie enables monitoring and starts one automatic search', async () => {
  const f = fixture();
  await f.check(42);
  await f.request(42);
  assert.equal(f.movie().monitored, true);
  assert.equal(f.calls.filter((c) => c.path === '/movie' && c.method === 'POST').length, 1);
  assert.deepEqual(f.calls.find((c) => c.path === '/command').payload, { name: 'MoviesSearch', movieIds: [10] });
});

test('requesting during the first check never creates a duplicate or leaves monitoring disabled', async () => {
  const f = fixture();
  await Promise.all([f.check(42), f.request(42)]);
  assert.equal(f.movie().monitored, true);
  assert.equal(f.calls.filter((c) => c.path === '/movie' && c.method === 'POST').length, 1);
  assert.equal(f.calls.filter((c) => c.path === '/command').length, 1);
});

test('invalid IDs and missing configuration never contact Radarr', async () => {
  const f = fixture();
  for (const id of [0, -1, '42', NaN, 1.5, 1000000000]) await assert.rejects(f.check(id), /Film invalide/);
  assert.equal(f.calls.length, 0);
  const service = createMovieReleases({ app: {}, arr: () => { throw new Error('Unexpected call'); } });
  await assert.rejects(service.check(42), /pas configuré/);
});

test('rejected versions and versions without valid Radarr identities cannot be downloaded', async () => {
  const f = fixture({ existing: true, releases: [
    release(), release({ rejected: true }), release({ temporarilyRejected: true }), release({ downloadAllowed: false }),
    release({ approved: undefined }), release({ guid: null }), release({ indexerId: 0 }),
  ] });
  const result = await f.check(42);
  assert.equal(result.items.filter((r) => r.selection).length, 1);
  assert.ok(!JSON.stringify(result).includes('release-guid'));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('an alternative can be chosen when its only refusal concerns the version already queued', async () => {
  const cutoff = 'Quality for release in queue already meets cutoff: WEBDL-2160p v1';
  const f = fixture({ existing: true, releases: [
    release({ approved: false, rejected: true, rejections: [cutoff], guid: 'alternative', title: 'Film.VF.1080p' }),
    release({ approved: false, rejected: true, rejections: [cutoff, 'Hardcode subs found: DKsubs'] }),
    release({ approved: false, rejected: true, rejections: [cutoff, 'Too large'] }),
    release({ approved: false, rejected: true, rejections: [cutoff], downloadAllowed: false }),
  ], queue: [{ movieId: 10, title: 'Film.TR-EN.2160p' }] });
  const result = await f.check(42);
  assert.equal(result.accepted, 0);
  assert.equal(result.alternatives, 1);
  assert.equal(result.items.filter((r) => r.selection).length, 1);
  assert.equal(result.items[0].queueAlternative, true);
  await f.download(42, result.items[0].selection);
  assert.deepEqual(f.calls.find((c) => c.path === '/release').payload, { guid: 'alternative', indexerId: 1, movieId: 10 });
  assert.ok(!f.calls.some((c) => c.method === 'DELETE'));
});

test('choosing a version sends its server-held identity and enables monitoring without automatic search or removal', async () => {
  const f = fixture({ existing: true, releases: [release(), release({ guid: 'other', title: 'Other version' })] });
  const result = await f.check(42);
  const selected = result.items.find((r) => r.title === 'Other version');
  const sent = await f.download(42, selected.selection);
  assert.equal(sent.title, 'Other version');
  assert.equal(f.movie().monitored, true);
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/release');
  assert.deepEqual(posts[0].payload, { guid: 'other', indexerId: 1, movieId: 10 });
  assert.ok(!f.calls.some((c) => c.method === 'DELETE' || c.path === '/command'));
});

test('forged, cross-movie and expired selections cannot start downloads', async () => {
  const f = fixture({ existing: true, releases: [release()] });
  const selection = (await f.check(42)).items[0].selection;
  for (const token of [undefined, {}, 'https://example.org/file']) await assert.rejects(f.download(42, token), /invalide/);
  await assert.rejects(f.download(43, selection), /invalide/);
  f.tick(600_001);
  await assert.rejects(f.download(42, selection), /expiré/);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('concurrent clicks, retries and repeated searches do not duplicate the same release', async () => {
  const f = fixture({ existing: true, releases: [release()] });
  const first = (await f.check(42)).items[0].selection;
  const second = (await f.check(42)).items[0].selection;
  const [a, b] = await Promise.all([f.download(42, first), f.download(42, second)]);
  assert.deepEqual(a, b);
  assert.deepEqual(await f.download(42, first), a);
  assert.equal(f.calls.filter((c) => c.path === '/release' && c.method === 'POST').length, 1);
  const checked = (await f.check(42)).items[0];
  assert.equal(checked.sent, true);
  assert.equal(checked.selection, null);
});

test('changed movie rules and disabled indexers require a new choice', async () => {
  for (const mutate of [m => { m.qualityProfileId = 99; }, m => { m.hasFile = true; }, m => { m.tags = [7]; }]) {
    const f = fixture({ existing: true, releases: [release()] });
    const selection = (await f.check(42)).items[0].selection;
    mutate(f.movie());
    await assert.rejects(f.download(42, selection), /changé/);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
  }
  const indexers = [{ id: 1, enableInteractiveSearch: true }];
  const f = fixture({ existing: true, releases: [release()], indexers });
  const selection = (await f.check(42)).items[0].selection;
  indexers[0].enableInteractiveSearch = false;
  await assert.rejects(f.download(42, selection), /indexeur/);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('an already queued version is not downloaded again; other movies are excluded from the check', async () => {
  const queue = [{ movieId: 10, title: 'Test.1080p.MULTI' }];
  const f = fixture({ existing: true, releases: [release()], queue });
  const selection = (await f.check(42)).items[0].selection;
  await assert.rejects(f.download(42, selection), /déjà dans la file/);
  queue[0].movieId = 99;
  await f.download(42, selection);
  assert.equal(f.calls.filter((c) => c.path === '/release' && c.method === 'POST').length, 1);
});

test('failed download submissions retain the selection for retry', async () => {
  let failed = true;
  const f = fixture({ existing: true, releases: [release()], failure: path => failed && path === '/release' });
  const selection = (await f.check(42)).items[0].selection;
  await assert.rejects(f.download(42, selection), /inaccessible/);
  failed = false;
  assert.equal((await f.download(42, selection)).title, 'Test.1080p.MULTI');
});

test('a monitoring failure after a successful download is reported without submitting the release again', async () => {
  const f = fixture({ existing: true, releases: [release()], failure: path => path === '/movie/10' });
  const selection = (await f.check(42)).items[0].selection;
  assert.match((await f.download(42, selection)).warning, /surveillance/);
  await f.download(42, selection);
  assert.equal(f.calls.filter((c) => c.path === '/release' && c.method === 'POST').length, 1);
});
