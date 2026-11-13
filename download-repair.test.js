import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadRepair, episodeLabel } from './download-repair.js';

function fixture() {
  let at = 1000;
  const movie = { id: 10, tmdbId: 42, title: 'Film test', year: 2026, hasFile: false };
  const queue = [{ id: 1, movieId: 10, status: 'completed', trackedDownloadState: 'importBlocked',
    downloadId: 'download-1', outputPath: '/downloads/movie', statusMessages: [{ messages: ['Manual import required'] }] }];
  const files = [{ id: 99, path: '/downloads/movie/Film.mkv', folderName: 'movie', size: 1000, movie: { id: 10 },
    quality: { quality: { id: 18, name: 'WEBDL-2160p' } }, languages: [{ id: 1, name: 'English' }],
    releaseGroup: 'Group', indexerFlags: 2, rejections: [] }];
  const calls = [];
  const command = { id: 100, status: 'queued' };
  const f = { movie, queue, files, command, calls, fail: null, tick: (ms) => { at += ms; } };
  Object.assign(f, createDownloadRepair({ kind: 'movie', app: { url: 'radarr', key: 'secret' }, now: () => at,
    arr: async (_, path, method = 'GET', payload) => {
      calls.push({ path, method, payload });
      if (f.fail?.(path, method)) throw new Error('Radarr inaccessible');
      if (path === '/movie?tmdbId=42') return [structuredClone(movie), { id: 11, tmdbId: 43 }];
      if (path === '/queue/details?movieId=10') return structuredClone(queue);
      if (path.startsWith('/manualimport?')) return structuredClone(files);
      if (path === '/command' && method === 'POST') return structuredClone(command);
      if (path === '/command/100') return structuredClone(command);
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  }));
  return f;
}

test('inspection returns file details and reasons without writing or exposing paths or credentials', async () => {
  const f = fixture();
  const result = await f.inspect(42);
  assert.equal(result.title, 'Film test');
  assert.deepEqual(result.issues, ['Manual import required']);
  assert.equal(result.files[0].name, 'Film.mkv');
  assert.equal(result.files[0].quality, 'WEBDL-2160p');
  assert.deepEqual(result.files[0].languages, ['English']);
  assert.ok(result.files[0].selection);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes('/downloads'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('manual import uses revalidated server metadata, auto mode and the matching movie only', async () => {
  const f = fixture();
  const { files } = await f.inspect(42);
  const result = await f.importFile(42, files[0].selection);
  assert.equal(result.pending, true);
  assert.equal(f.calls.filter((c) => c.path.startsWith('/manualimport?')).length, 2);
  assert.deepEqual(f.calls.find((c) => c.method === 'POST').payload, {
    name: 'ManualImport', importMode: 'auto', files: [{ path: '/downloads/movie/Film.mkv', folderName: 'movie', movieId: 10,
      downloadId: 'download-1', quality: f.files[0].quality, languages: f.files[0].languages, releaseGroup: 'Group', indexerFlags: 2 }],
  });
  await assert.rejects(f.importFile(42, files[0].selection), /expiré|invalide/);
});

test('rejected, unassociated and incomplete files cannot be selected', async () => {
  for (const update of [{ rejections: [{ reason: 'Sample file' }] }, { movie: { id: 99 } }, { movie: null }, { quality: null }, { languages: [] },
    { path: '/movies/Film (2026)/Film.mkv' }, { path: '/downloads/movie/../../movies/Film.mkv' }, { path: '/downloads/movie-other/Film.mkv' }]) {
    const f = fixture();
    Object.assign(f.files[0], update);
    const { files } = await f.inspect(42);
    assert.equal(files[0].selection, null);
    assert.ok(files[0].rejections.length);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
  }
});

test('incomplete, imported and other movies’ transfers are never scanned', async () => {
  const f = fixture();
  const transfer = f.queue[0];
  f.queue.splice(0, 1, { ...transfer, status: 'downloading' }, { ...transfer, trackedDownloadState: 'imported' },
    { ...transfer, movieId: 99 }, { ...transfer, downloadId: null }, { ...transfer, outputPath: null });
  assert.deepEqual((await f.inspect(42)).files, []);
  assert.ok(!f.calls.some((c) => c.path.startsWith('/manualimport')));
});

test('stale selections never import missing, rejected, reassociated or replaced files', async () => {
  for (const change of [f => f.files.splice(0), f => f.files[0].rejections.push({ reason: 'Already exists' }),
    f => { f.files[0].movie.id = 99; }, f => { f.movie.hasFile = true; }, f => f.queue.splice(0),
    f => { f.queue[0].status = 'downloading'; }]) {
    const f = fixture();
    const { files } = await f.inspect(42);
    change(f);
    await assert.rejects(f.importFile(42, files[0].selection));
    assert.ok(f.calls.every((c) => c.method === 'GET'));
  }
});

test('expired and forged selections never submit an import', async () => {
  const f = fixture();
  const { files } = await f.inspect(42);
  for (const selection of [undefined, '/etc/passwd', {}, 'forged']) await assert.rejects(f.importFile(42, selection), /invalide/);
  await assert.rejects(f.importFile(43, files[0].selection), /invalide/);
  f.tick(600_001);
  await assert.rejects(f.importFile(42, files[0].selection), /expiré/);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});

test('concurrent submissions and later inspections cannot duplicate a running import', async () => {
  const f = fixture();
  const a = (await f.inspect(42)).files[0].selection;
  const b = (await f.inspect(42)).files[0].selection;
  const results = await Promise.allSettled([f.importFile(42, a), f.importFile(42, b)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.inspect(42), /déjà en cours/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
});

test('commands are tracked until completion; completion alone never claims the film is ready', async () => {
  const f = fixture();
  await f.importFile(42, (await f.inspect(42)).files[0].selection);
  assert.deepEqual(await f.commandStatus(42), { pending: true, failed: false });
  f.command.status = 'started';
  assert.equal((await f.commandStatus(42)).pending, true);
  f.command.status = 'completed';
  const done = await f.commandStatus(42);
  assert.deepEqual(done, { pending: false, failed: false });
  assert.equal(done.state, undefined);
  assert.equal(await f.commandStatus(42), null);
});

test('failed commands and network errors allow retry without inventing success', async () => {
  const f = fixture();
  const selection = (await f.inspect(42)).files[0].selection;
  f.fail = (path, method) => path === '/command' && method === 'POST';
  await assert.rejects(f.importFile(42, selection), /inaccessible/);
  f.fail = null;
  await f.importFile(42, selection);
  f.fail = path => path === '/command/100';
  await assert.rejects(f.commandStatus(42), /inaccessible/);
  f.fail = null;
  f.command.status = 'failed';
  assert.deepEqual(await f.commandStatus(42), { pending: false, failed: true });
  assert.ok((await f.inspect(42)).files[0].selection);
});

test('invalid IDs, existing files and missing configuration are rejected before importing', async () => {
  const f = fixture();
  for (const id of [0, -1, '42', NaN, 1.5, 1e9]) await assert.rejects(f.inspect(id), /Film invalide/);
  assert.equal(f.calls.length, 0);
  f.movie.hasFile = true;
  await assert.rejects(f.inspect(42), /déjà un fichier/);
  const unavailable = createDownloadRepair({ kind: 'movie', app: {}, arr: () => assert.fail('No request expected') });
  await assert.rejects(unavailable.inspect(42), /pas configuré/);
});

function seriesFixture() {
  const series = { id: 20, tmdbId: 77, title: 'Série test', year: 2024, statistics: { episodeFileCount: 3 } };
  const episode = (id, episodeNumber, title) => ({ id, seriesId: 20, seasonNumber: 2, episodeNumber, title });
  // A season pack: Sonarr repeats the transfer once per episode.
  const transfer = { seriesId: 20, status: 'completed', trackedDownloadStatus: 'warning', trackedDownloadState: 'importBlocked',
    downloadId: 'pack-1', outputPath: '/data/downloads/Serie.S02/', statusMessages: [{ messages: ['Found matching series via grab history, but release was matched to series by ID.'] }] };
  const queue = [{ ...transfer, id: 1, episodeId: 202 }, { ...transfer, id: 2, episodeId: 201 }];
  const file = (n, episodes) => ({ path: `/data/downloads/Serie.S02/Serie.S02E0${n}.mkv`, folderName: 'Serie.S02', size: 2000,
    seasonNumber: 2, series: { id: 20 }, episodes, quality: { quality: { id: 3, name: 'WEBDL-1080p' } },
    languages: [{ id: 2, name: 'French' }], releaseGroup: 'Group', releaseType: 'singleEpisode', indexerFlags: 0, rejections: [] });
  const files = [file(2, [episode(202, 2, 'Deux')]), file(1, [episode(201, 1, 'Un')])];
  // What Sonarr answers when the scan names the series: its library, not the download.
  const library = [{ ...file(1, [episode(201, 1, 'Un')]), path: '/data/media/Série test/Season 2/S02E01.mkv', episodeFileId: 9 }];
  const calls = [];
  const command = { id: 300, status: 'queued' };
  const f = { series, queue, files, command, calls, episode, file };
  Object.assign(f, createDownloadRepair({ kind: 'tv', app: { url: 'sonarr', key: 'secret' },
    arr: async (_, path, method = 'GET', payload) => {
      calls.push({ path, method, payload });
      if (path === '/series') return [{ id: 21, tmdbId: 78 }, structuredClone(series)];
      if (path === '/queue/details?seriesId=20') return structuredClone(queue);
      if (path.startsWith('/manualimport?')) return structuredClone(new URLSearchParams(path.split('?')[1]).has('seriesId') ? library : files);
      if (path === '/command' && method === 'POST') return structuredClone(command);
      if (path === '/command/300') return structuredClone(command);
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  }));
  return f;
}

test('episode labels follow the Nimbus format', () => {
  assert.equal(episodeLabel([{ seasonNumber: 2, episodeNumber: 6, title: 'Titre' }]), 'S2:É6 Titre');
  assert.equal(episodeLabel([{ seasonNumber: 1, episodeNumber: 4 }, { seasonNumber: 1, episodeNumber: 3 }]), 'S1:É3-4');
  assert.equal(episodeLabel([{ seasonNumber: 1, episodeNumber: 10 }, { seasonNumber: 2, episodeNumber: 1 }]), 'S1:É10 à S2:É1');
  assert.equal(episodeLabel([]), '');
});

test('series inspection scans each download once, by folder only, and lists episodes in order', async () => {
  const f = seriesFixture();
  const result = await f.inspect(77);
  const scans = f.calls.filter((c) => c.path.startsWith('/manualimport?'));
  assert.equal(scans.length, 1);
  assert.ok(!new URLSearchParams(scans[0].path.split('?')[1]).has('seriesId'));
  assert.equal(result.single, false);
  assert.deepEqual(result.files.map((x) => x.episode), ['S2:É1 Un', 'S2:É2 Deux']);
  assert.ok(result.files.every((x) => x.selection && !('order' in x)));
  assert.ok(f.calls.every((c) => c.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes('/data/'));
});

test('library files, other series, unrecognised episodes and incomplete files are never selectable', async () => {
  const outside = { path: '/data/media/Série test/Season 2/S02E01.mkv' };
  for (const update of [outside, { episodeFileId: 9 }, { series: { id: 21 } }, { series: null }, { episodes: [] },
    { episodes: [{ id: 1, seriesId: 21, seasonNumber: 2, episodeNumber: 1 }] }, { quality: null }, { languages: [] }]) {
    const f = seriesFixture();
    Object.assign(f.files[1], update);
    const { files } = await f.inspect(77);
    assert.equal(files.find((x) => x.name === f.files[1].path.split('/').pop()).selection, null);
    assert.equal(files.filter((x) => x.selection).length, 1);
  }
});

test('several episodes go to Sonarr in one revalidated import, with their episode ids', async () => {
  const f = seriesFixture();
  const { files } = await f.inspect(77);
  assert.deepEqual(await f.importFile(77, files.map((x) => x.selection)), { pending: true, failed: false });
  assert.equal(f.calls.filter((c) => c.path.startsWith('/manualimport?')).length, 2);
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].payload, { name: 'ManualImport', importMode: 'auto', files: [1, 0].map((n) => ({
    path: f.files[n].path, seriesId: 20, episodeIds: f.files[n].episodes.map((e) => e.id), downloadId: 'pack-1', folderName: 'Serie.S02',
    quality: f.files[n].quality, languages: f.files[n].languages, releaseGroup: 'Group', indexerFlags: 0, releaseType: 'singleEpisode' })) });
  assert.deepEqual(await f.commandStatus(77), { pending: true, failed: false });
  await assert.rejects(f.inspect(77), /déjà en cours pour cette série/);
});

test('series selections are validated as a whole before anything is imported', async () => {
  for (const pick of [[], (s) => [s[0], s[0]], (s) => [s[0], 'forged'], (s) => [s[0], 42], () => Array(101).fill('x')]) {
    const f = seriesFixture();
    const { files } = await f.inspect(77);
    await assert.rejects(f.importFile(77, typeof pick === 'function' ? pick(files.map((x) => x.selection)) : pick), /invalide/);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
  }
  const f = seriesFixture();
  f.files[0].episodes = structuredClone(f.files[1].episodes); // two files for the same episode
  const { files } = await f.inspect(77);
  await assert.rejects(f.importFile(77, files.map((x) => x.selection)), /même épisode/);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
  const movie = fixture();
  const { files: movieFiles } = await movie.inspect(42);
  await assert.rejects(movie.importFile(42, [movieFiles[0].selection, movieFiles[0].selection]), /invalide/);
});

test('a single episode file can still be imported on its own; stale ones are refused', async () => {
  const f = seriesFixture();
  const { files } = await f.inspect(77);
  f.files[0].rejections.push({ reason: 'Not an upgrade' }); // S2:É2, listed second
  await assert.rejects(f.importFile(77, [files[1].selection]), /Sonarr ne permet plus/);
  await assert.rejects(f.importFile(77, files[1].selection), /Sonarr ne permet plus/);
  await assert.rejects(f.importFile(77, [files[0].selection, files[1].selection]), /Sonarr ne permet plus/);
  assert.ok(f.calls.every((c) => c.method === 'GET'));
  const g = seriesFixture();
  const picked = (await g.inspect(77)).files[0].selection;
  await g.importFile(77, picked);
  assert.equal(g.calls.find((c) => c.method === 'POST').payload.files.length, 1);
});

test('invalid series ids and missing Sonarr configuration are rejected', async () => {
  const f = seriesFixture();
  for (const id of [0, '77', 1.5]) await assert.rejects(f.inspect(id), /Série invalide/);
  await assert.rejects(f.inspect(99), /n’est plus dans Sonarr/);
  const unavailable = createDownloadRepair({ kind: 'tv', app: {}, arr: () => assert.fail('No request expected') });
  await assert.rejects(unavailable.inspect(77), /Sonarr n’est pas configuré/);
});
