// Queue entries for a season pack can repeat for each episode: count the transfer once.
function uniqueTransfers(records) {
  const transfers = new Map();
  for (const record of records) {
    if (record.trackedDownloadState === 'imported') continue; // completed torrents may keep seeding
    const key = record.downloadId || record.id;
    if (!transfers.has(key)) transfers.set(key, record);
  }
  return [...transfers.values()];
}

function estimatedSpeed(record) {
  // Arr's queue is cached: unchanged byte counters do not mean the client stopped.
  // Its timeleft comes from the client's own rate and remains useful between refreshes.
  const duration = String(record.timeleft ?? record.timeLeft ?? '').match(/^(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d)(?:\.\d+)?$/);
  if (!duration) return null;
  const seconds = Number(duration[1] || 0) * 86400 + Number(duration[2]) * 3600 + Number(duration[3]) * 60 + Number(duration[4]);
  const remaining = record.sizeleft ?? record.sizeLeft;
  // Ignore unknown/infinite ETA sentinels and completed transfers.
  if (!(seconds > 0 && seconds < 365 * 86400) || !Number.isFinite(remaining) || remaining <= 0) return null;
  return remaining / seconds;
}

export function downloadStatus(kind, title, records) {
  const queue = uniqueTransfers(records);
  const files = kind === 'movie' ? Number(!!title?.hasFile) : title?.statistics?.episodeFileCount || 0;
  const base = { count: queue.length, files, progress: null, size: 0, remaining: 0, eta: null, speed: null, speedSource: null };
  if (!queue.length) return { ...base, state: files ? 'ready' : 'waiting' };

  let knownSize = true;
  for (const record of queue) {
    const size = Number(record.size);
    const remaining = record.sizeleft ?? record.sizeLeft;
    if (!(size > 0) || remaining == null || !Number.isFinite(Number(remaining))) {
      knownSize = false;
      continue;
    }
    base.size += size;
    base.remaining += Math.max(0, Math.min(size, Number(remaining)));
  }
  if (knownSize && base.size) base.progress = (base.size - base.remaining) / base.size;
  const is = (record, ...states) => states.includes(record.status?.toLowerCase());
  const blocked = queue.some((r) => ['warning', 'error'].includes(r.trackedDownloadStatus)
    || ['importBlocked', 'failed', 'failedPending'].includes(r.trackedDownloadState)
    || is(r, 'failed', 'warning', 'downloadclientunavailable'));
  const importing = queue.every((r) => is(r, 'completed') || ['importPending', 'importing'].includes(r.trackedDownloadState));
  const state = blocked ? 'blocked' : importing ? 'importing'
    : queue.some((r) => is(r, 'downloading')) ? 'downloading'
    : queue.some((r) => is(r, 'paused')) ? 'paused' : 'queued';
  if (state === 'downloading' && queue.every((r) => is(r, 'downloading', 'completed'))) {
    const times = queue.filter((r) => is(r, 'downloading')).map((r) => Date.parse(r.estimatedCompletionTime));
    if (times.length && times.every((t) => Number.isFinite(t) && t > Date.now())) base.eta = Math.max(...times);
  }
  const issues = [...new Set(queue.flatMap((r) => (r.statusMessages || []).flatMap((s) => s.messages || [])))];
  return { ...base, state, issues, canRepair: state === 'blocked' };
}

export function createDownloadTracker({ arr, apps, now = Date.now }) {
  const identities = new Map();
  const samples = new Map();
  return async (kind, tmdbId) => {
    const app = apps[kind];
    if (!app?.url || !app.key) throw new Error(`${kind === 'movie' ? 'Radarr' : 'Sonarr'} n’est pas configuré.`);
    const resource = kind === 'movie' ? 'movie' : 'series';
    const key = `${kind}:${tmdbId}`;
    let id = identities.get(key);
    let title;
    if (id) title = await arr(app, `/${resource}/${id}`);
    else {
      const titles = await arr(app, `/${resource}${kind === 'movie' ? `?tmdbId=${tmdbId}` : ''}`);
      title = titles.find((t) => Number(t.tmdbId) === Number(tmdbId));
      id = title?.id;
      if (id) identities.set(key, id);
    }
    if (!id) {
      samples.delete(key);
      return downloadStatus(kind, null, []);
    }
    let queue;
    try {
      queue = await arr(app, `/queue/details?${kind === 'movie' ? 'movieId' : 'seriesId'}=${id}`);
    } catch (error) {
      samples.delete(key);
      throw error;
    }
    // Filter defensively in case an older service ignores the query parameter.
    const transfers = uniqueTransfers(queue.filter((r) => r[kind === 'movie' ? 'movieId' : 'seriesId'] === id));
    const status = downloadStatus(kind, title, transfers);
    const at = now();
    const previous = samples.get(key);
    const elapsed = previous ? at - previous.at : 0;
    const active = transfers.filter((r) => r.status?.toLowerCase() === 'downloading');
    const transferKey = (r) => r.downloadId || r.id;
    const remaining = (r) => r.sizeleft ?? r.sizeLeft;
    // Measure only the same active transfers. Queue changes, pauses and stale samples
    // must not turn into spikes or negative rates. A season pack contributes only once.
    if (active.length && elapsed >= 1000 && elapsed <= 30_000 && active.every((r) => {
      const before = previous.transfers.get(transferKey(r));
      return before?.status?.toLowerCase() === 'downloading'
        && Number.isFinite(r.size) && r.size > 0 && before.size === r.size
        && Number.isFinite(remaining(r)) && Number.isFinite(remaining(before))
        && remaining(r) >= 0 && remaining(before) <= r.size && remaining(r) <= remaining(before);
    })) {
      const downloaded = active.reduce((total, r) => total + remaining(previous.transfers.get(transferKey(r))) - remaining(r), 0);
      if (downloaded > 0) {
        status.speed = downloaded / (elapsed / 1000);
        status.speedSource = 'measured';
      } else status.speedSource = 'unavailable';
    }
    const estimates = active.map(estimatedSpeed);
    if (active.length && estimates.every((rate) => rate != null)) {
      status.speed = estimates.reduce((total, rate) => total + rate, 0);
      status.speedSource = 'estimated';
    }
    samples.set(key, { at, transfers: new Map(transfers.map((r) => [transferKey(r), r])) });
    return status;
  };
}
