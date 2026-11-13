import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadTracker, downloadStatus } from './downloads.js';

test('download progress is weighted by bytes and season packs are counted once', () => {
  const pack = { id: 1, downloadId: 'pack', size: 900, sizeleft: 450, status: 'downloading' };
  const result = downloadStatus('tv', {}, [pack, { ...pack, id: 2 }, { id: 3, size: 100, sizeleft: 0, status: 'completed' }]);
  assert.equal(result.count, 2);
  assert.equal(result.progress, 0.55);
  assert.equal(result.state, 'downloading');
});

test('an empty queue means waiting until files have actually been imported', () => {
  assert.equal(downloadStatus('movie', {}, []).state, 'waiting');
  assert.equal(downloadStatus('movie', { hasFile: true }, []).state, 'ready');
  const ready = downloadStatus('tv', { statistics: { episodeFileCount: 3 } }, []);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.files, 3);
});

test('unknown or malformed sizes never invent a percentage', () => {
  for (const record of [{ size: 0, sizeleft: 0 }, { size: 100 }, { size: 100, sizeleft: 'bad' }]) {
    assert.equal(downloadStatus('movie', {}, [{ id: 1, ...record }]).progress, null);
  }
  assert.equal(downloadStatus('movie', {}, [{ id: 1, size: 100, sizeleft: -10 }]).progress, 1);
  assert.equal(downloadStatus('movie', {}, [{ id: 1, size: 100, sizeleft: 110 }]).progress, 0);
});

test('pause, import and failure stay distinct from completion; seeding is excluded', () => {
  const record = { id: 1, size: 100, sizeleft: 0, status: 'completed' };
  assert.equal(downloadStatus('movie', {}, [record]).state, 'importing');
  assert.equal(downloadStatus('movie', {}, [{ ...record, status: 'paused' }]).state, 'paused');
  assert.equal(downloadStatus('movie', {}, [{ ...record, trackedDownloadState: 'importBlocked' }]).state, 'blocked');
  assert.equal(downloadStatus('movie', {}, [{ ...record, trackedDownloadStatus: 'warning' }]).state, 'blocked');
  assert.equal(downloadStatus('movie', { hasFile: true }, [{ ...record, trackedDownloadState: 'imported' }]).state, 'ready');
});

test('blocked movies and series expose the cause and repair action', () => {
  const record = { id: 1, status: 'completed', trackedDownloadState: 'importBlocked',
    statusMessages: [{ messages: ['Manual Import required', 'Permission denied'] }, { messages: ['Permission denied'] }] };
  const result = downloadStatus('movie', {}, [record]);
  assert.equal(result.canRepair, true);
  assert.deepEqual(result.issues, ['Manual Import required', 'Permission denied']);
  assert.equal(downloadStatus('tv', {}, [record]).canRepair, true);
  assert.equal(downloadStatus('movie', {}, [{ ...record, trackedDownloadState: 'importPending' }]).canRepair, false);
});

test('ETA is absent when any transfer is paused or has no valid estimate', () => {
  const record = { id: 1, status: 'downloading', estimatedCompletionTime: new Date(Date.now() + 60_000).toISOString() };
  assert.ok(downloadStatus('movie', {}, [record]).eta);
  assert.equal(downloadStatus('movie', {}, [record, { id: 2, status: 'paused' }]).eta, null);
  assert.equal(downloadStatus('movie', {}, [{ ...record, estimatedCompletionTime: null }]).eta, null);
});

test('tracker resolves TMDB identities separately and filters queue entries by the service ID', async () => {
  const calls = [];
  const apps = { movie: { url: 'radarr', key: 'secret' }, tv: { url: 'sonarr', key: 'secret' } };
  const tracker = createDownloadTracker({ apps, arr: async (app, path) => {
    calls.push([app.url, path]);
    if (path.startsWith('/queue/details')) return [
      { id: 1, movieId: 10, seriesId: 20, status: 'downloading', size: 100, sizeleft: 40 },
      { id: 2, movieId: 99, seriesId: 99, status: 'failed' },
    ];
    if (path.startsWith('/movie')) return path === '/movie/10' ? { id: 10, tmdbId: 42 } : [{ id: 10, tmdbId: 42 }];
    return path === '/series/20' ? { id: 20, tmdbId: 42 } : [{ id: 20, tmdbId: 42 }];
  } });
  assert.equal((await tracker('movie', 42)).progress, 0.6);
  assert.equal((await tracker('tv', 42)).count, 1);
  await tracker('movie', 42);
  assert.deepEqual(calls, [
    ['radarr', '/movie?tmdbId=42'], ['radarr', '/queue/details?movieId=10'],
    ['sonarr', '/series'], ['sonarr', '/queue/details?seriesId=20'],
    ['radarr', '/movie/10'], ['radarr', '/queue/details?movieId=10'],
  ]);
});

test('a queue failure propagates for retry instead of being reported as an empty queue', async () => {
  const tracker = createDownloadTracker({ apps: { movie: { url: 'radarr', key: 'secret' } }, arr: async (_, path) => {
    if (path.startsWith('/movie')) return [{ id: 10, tmdbId: 42 }];
    throw new Error('offline');
  } });
  await assert.rejects(tracker('movie', 42), /offline/);
});

function speedFixture() {
  let at = 0;
  let queue = [];
  const tracker = createDownloadTracker({
    apps: { tv: { url: 'sonarr', key: 'secret' } }, now: () => at,
    arr: async (_, path) => {
      if (path.startsWith('/queue')) {
        if (queue instanceof Error) throw queue;
        return structuredClone(queue);
      }
      return path === '/series/10' ? { id: 10, tmdbId: 42 } : [{ id: 10, tmdbId: 42 }];
    },
  });
  return (records, elapsed = 5000) => {
    queue = records;
    at += elapsed;
    return tracker('tv', 42);
  };
}
const transfer = (remaining, extra = {}) => ({ id: 1, seriesId: 10, downloadId: 'pack', status: 'downloading', size: 1000, sizeleft: remaining, ...extra });

test('speed measures downloaded bytes per second without treating unchanged counters as zero speed', async () => {
  const sample = speedFixture();
  assert.equal((await sample([transfer(800)])).speed, null);
  assert.equal((await sample([transfer(500)])).speed, 60);
  const unchanged = await sample([transfer(500)]);
  assert.equal(unchanged.speed, null);
  assert.equal(unchanged.speedSource, 'unavailable');
});

test('speed sums active transfers and counts season packs only once', async () => {
  const sample = speedFixture();
  const queue = (a, b) => [transfer(a), transfer(a, { id: 2 }), transfer(b, { id: 3, downloadId: 'episode' })];
  await sample(queue(800, 600));
  assert.equal((await sample(queue(500, 500))).speed, 80);
});

test('new transfers, changed sizes and increasing counters require a fresh speed baseline', async () => {
  for (const changed of [
    transfer(500, { downloadId: 'replacement' }), transfer(500, { size: 2000 }),
    transfer(900), transfer(undefined),
  ]) {
    const sample = speedFixture();
    await sample([transfer(800)]);
    assert.equal((await sample([changed])).speed, null);
  }
});

test('speed resets across pauses, completion, empty queues and stale samples', async () => {
  const sample = speedFixture();
  await sample([transfer(800)]);
  assert.equal((await sample([transfer(800, { status: 'paused' })])).speed, null);
  assert.equal((await sample([transfer(700)])).speed, null);
  assert.equal((await sample([transfer(600)], 31_000)).speed, null);
  assert.equal((await sample([transfer(0, { status: 'completed' })])).speed, null);
  assert.equal((await sample([])).speed, null);
  assert.equal((await sample([transfer(300)])).speed, null);
});

test('a failed queue request clears the speed baseline for the next successful response', async () => {
  const sample = speedFixture();
  await sample([transfer(800)]);
  await assert.rejects(sample(new Error('offline')), /offline/);
  assert.equal((await sample([transfer(500)])).speed, null);
  assert.equal((await sample([transfer(400)])).speed, 20);
});

test('cached Arr counters keep the client-based speed estimate instead of displaying zero', async () => {
  const sample = speedFixture();
  const records = [transfer(600, { timeleft: '00:01:00' })];
  for (let n = 0; n < 4; n++) {
    const status = await sample(records);
    assert.equal(status.speed, 10);
    assert.equal(status.speedSource, 'estimated');
  }
});

test('estimated speed sums distinct active downloads and handles day/hour duration formats', async () => {
  const sample = speedFixture();
  const pack = transfer(93600, { size: 100000, timeleft: '1.02:00:00' });
  const status = await sample([pack, { ...pack, id: 2 }, transfer(7200, { id: 3, downloadId: 'episode', size: 10000, timeLeft: '02:00:00' })]);
  assert.equal(status.speed, 2);
  assert.equal(status.speedSource, 'estimated');
});

test('unknown, zero, infinite or paused ETAs do not invent a download rate', async () => {
  for (const timeleft of [undefined, '00:00:00', '-00:00:01', '10675199.02:48:05.4775807', 'bad']) {
    const sample = speedFixture();
    assert.equal((await sample([transfer(600, { timeleft })])).speed, null);
  }
  const sample = speedFixture();
  assert.equal((await sample([transfer(600, { timeleft: '00:01:00', status: 'paused' })])).speed, null);
});

test('an unknown ETA for one active job never produces a partial estimated total', async () => {
  const sample = speedFixture();
  const status = await sample([transfer(600, { timeleft: '00:01:00' }), transfer(300, { id: 2, downloadId: 'episode' })]);
  assert.equal(status.speed, null);
});
