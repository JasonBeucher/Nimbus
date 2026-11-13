import { randomUUID } from 'node:crypto';
import { downloadStatus } from './downloads.js';

const MAX_FILES = 100; // a season pack, with room to spare; keeps the import request small

// Same "S2:É6" form as the rest of Nimbus.
export function episodeLabel(episodes = []) {
  const sorted = [...episodes].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  if (!sorted.length) return '';
  const [first, last] = [sorted[0], sorted.at(-1)];
  const code = `S${first.seasonNumber}:É${first.episodeNumber}${sorted.length === 1 ? ''
    : first.seasonNumber === last.seasonNumber ? `-${last.episodeNumber}` : ` à S${last.seasonNumber}:É${last.episodeNumber}`}`;
  return sorted.length === 1 && first.title ? `${code} ${first.title}` : code;
}

// A scanned file must sit in the transfer it was found for. Sonarr, for instance, answers a scan that names
// the series with the files already in the library, which must never be offered for import again.
function inside(path, folder) {
  const base = String(folder || '').replace(/[\\/]+$/, '');
  return !!base && typeof path === 'string' && !/(^|[\\/])\.\.([\\/]|$)/.test(path)
    && (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`));
}

const KINDS = {
  movie: {
    service: 'Radarr',
    text: {
      invalid: 'Film invalide.', gone: 'Ce film n’est plus dans Radarr.', busy: 'Un import est déjà en cours pour ce film.',
      changed: 'Le statut du film a changé. Actualise le suivi avant de réessayer.',
      check: 'Vérifie que le fichier correspond bien à ce film avant de l’importer.',
    },
    find: async (arr, app, id) => (await arr(app, `/movie?tmdbId=${id}`)).find((m) => Number(m.tmdbId) === id),
    queue: (title) => `/queue/details?movieId=${title.id}`,
    owns: (record, title) => record.movieId === title.id,
    scan: (title) => ({ movieId: String(title.id) }),
    // Replacing an existing version is a different decision, made from Radarr's activity.
    occupied: (title) => title.hasFile && 'Ce film possède déjà un fichier dans Radarr. Vérifie son activité avant de remplacer une version.',
    reasons: (file, title) => (file.movie?.id !== title.id ? ['Ce fichier n’a pas été associé à ce film par Radarr.'] : []),
    single: true,
    payload: (file, title, transfer) => ({ path: file.path, movieId: title.id, downloadId: transfer.downloadId, folderName: file.folderName,
      quality: file.quality, languages: file.languages, releaseGroup: file.releaseGroup, indexerFlags: file.indexerFlags || 0 }),
  },
  tv: {
    service: 'Sonarr',
    text: {
      invalid: 'Série invalide.', gone: 'Cette série n’est plus dans Sonarr.', busy: 'Un import est déjà en cours pour cette série.',
      changed: 'Le statut de la série a changé. Actualise le suivi avant de réessayer.',
      check: 'Vérifie que chaque fichier correspond bien à l’épisode indiqué avant de l’importer.',
    },
    // Sonarr can't filter series by TMDB id.
    find: async (arr, app, id) => (await arr(app, '/series')).find((s) => Number(s.tmdbId) === id),
    queue: (title) => `/queue/details?seriesId=${title.id}`,
    owns: (record, title) => record.seriesId === title.id,
    // No seriesId here: with one, Sonarr lists the series' library files instead of the download.
    scan: () => ({}),
    occupied: () => false,
    reasons(file, title) {
      const result = [];
      if (file.series?.id !== title.id) result.push('Ce fichier n’a pas été associé à cette série par Sonarr.');
      if (!file.episodes?.length || file.episodes.some((e) => e.seriesId !== title.id)) result.push('Sonarr n’a pas reconnu les épisodes de ce fichier.');
      if (file.episodeFileId > 0) result.push('Ce fichier est déjà dans la médiathèque.');
      return result;
    },
    single: false,
    payload: (file, title, transfer) => ({ path: file.path, seriesId: title.id, episodeIds: file.episodes.map((e) => e.id),
      downloadId: transfer.downloadId, folderName: file.folderName, quality: file.quality, languages: file.languages,
      releaseGroup: file.releaseGroup, indexerFlags: file.indexerFlags || 0, releaseType: file.releaseType }),
  },
};

// Paths and import metadata always come from Radarr/Sonarr, never from the browser.
export function createDownloadRepair({ arr, app, kind, now = Date.now }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Type inconnu : ${kind}`);
  const selections = new Map();
  const commands = new Map();
  const locks = new Map();
  const validId = (id) => Number.isInteger(id) && id > 0 && id < 1e9;
  function validate(id) {
    if (!validId(id)) throw new Error(k.text.invalid);
    if (!app?.url || !app.key) throw new Error(`${k.service} n’est pas configuré.`);
    for (const [token, item] of selections) if (item.expires <= now()) selections.delete(token);
  }
  async function context(id) {
    validate(id);
    const title = await k.find(arr, app, id);
    if (!title) throw new Error(k.text.gone);
    const queue = (await arr(app, k.queue(title))).filter((r) => k.owns(r, title));
    return { title, queue, status: downloadStatus(kind, title, queue) };
  }
  const eligibleTransfers = (queue) => {
    const seen = new Set(); // a season pack appears once per episode
    return queue.filter((r) => r.status?.toLowerCase() === 'completed' && r.trackedDownloadState !== 'imported'
      && r.downloadId && r.outputPath && !seen.has(r.downloadId) && seen.add(r.downloadId));
  };
  const scan = (title, transfer) => arr(app, `/manualimport?${new URLSearchParams({
    folder: transfer.outputPath, downloadId: transfer.downloadId, ...k.scan(title), filterExistingFiles: 'true',
  })}`, 'GET', undefined, { timeoutMs: 120_000 });
  function reasons(file, title, transfer) {
    const result = (file.rejections || []).map((r) => r.reason).filter(Boolean);
    if (!inside(file.path, transfer.outputPath)) result.push('Ce fichier n’est pas dans le dossier du téléchargement.');
    result.push(...k.reasons(file, title));
    if (!file.path || !file.quality?.quality?.id || !file.languages?.length) result.push('Les informations du fichier sont incomplètes.');
    return result;
  }
  async function commandStatus(id) {
    validate(id);
    const saved = commands.get(id);
    if (!saved) return null;
    const command = await arr(app, `/command/${saved.id}`);
    const pending = ['queued', 'started'].includes(command.status);
    // A completed command does not guarantee an imported file. The queue remains authoritative.
    const result = { pending, failed: ['failed', 'aborted', 'cancelled', 'orphaned'].includes(command.status) };
    if (!pending) commands.delete(id);
    return result;
  }
  async function inspect(id) {
    const { title, queue, status } = await context(id);
    if ((await commandStatus(id))?.pending) throw new Error(k.text.busy);
    const occupied = k.occupied(title);
    if (occupied) throw new Error(occupied);
    const files = [];
    const seen = new Set();
    for (const transfer of eligibleTransfers(queue)) {
      for (const file of await scan(title, transfer)) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        const rejections = reasons(file, title, transfer);
        const token = randomUUID();
        if (!rejections.length) selections.set(token, {
          tmdbId: id, titleId: title.id, downloadId: transfer.downloadId, path: file.path, expires: now() + 10 * 60_000,
        });
        files.push({ selection: rejections.length ? null : token, name: file.path?.split(/[\\/]/).pop() || file.name,
          ...(kind === 'tv' && { episode: episodeLabel(file.episodes), order: file.episodes?.length
            ? Math.min(...file.episodes.map((e) => e.seasonNumber * 1e4 + e.episodeNumber)) : Infinity }),
          size: file.size, quality: file.quality?.quality?.name || '', languages: (file.languages || []).map((l) => l.name), rejections });
      }
    }
    if (kind === 'tv') files.sort((a, b) => a.order - b.order).forEach((f) => delete f.order);
    return { title: title.title, year: title.year, issues: status.issues || [], files, single: k.single,
      message: files.length ? k.text.check
        : `Aucun fichier importable trouvé. Vérifie dans ${k.service} que le téléchargement est terminé et que son dossier est accessible.` };
  }
  async function start(id, selection) {
    validate(id);
    const tokens = typeof selection === 'string' ? [selection] : Array.isArray(selection) ? selection : [];
    const items = tokens.map((t) => (typeof t === 'string' ? selections.get(t) : null));
    if (!tokens.length || tokens.length > (k.single ? 1 : MAX_FILES) || new Set(tokens).size !== tokens.length
      || items.some((item) => !item || item.tmdbId !== id)) throw new Error('La sélection a expiré ou est invalide. Relance la résolution du blocage.');
    if ((await commandStatus(id))?.pending) throw new Error(k.text.busy);
    const { title, queue, status } = await context(id);
    if (items.some((item) => item.titleId !== title.id) || k.occupied(title) || status.state !== 'blocked') throw new Error(k.text.changed);
    const transfers = eligibleTransfers(queue);
    const scans = new Map();
    const picked = [];
    for (const item of items) {
      const transfer = transfers.find((r) => r.downloadId === item.downloadId);
      if (!transfer) throw new Error('Ce téléchargement n’est plus disponible pour l’import.');
      if (!scans.has(transfer.downloadId)) scans.set(transfer.downloadId, await scan(title, transfer));
      const file = scans.get(transfer.downloadId).find((f) => f.path === item.path);
      if (!file || reasons(file, title, transfer).length) throw new Error(`${k.service} ne permet plus d’importer ce fichier. Relance la résolution du blocage.`);
      picked.push({ file, transfer });
    }
    const episodes = picked.flatMap(({ file }) => (file.episodes || []).map((e) => e.id));
    if (new Set(episodes).size !== episodes.length) throw new Error('Plusieurs fichiers choisis correspondent au même épisode. Garde un seul fichier par épisode.');
    const command = await arr(app, '/command', 'POST', { name: 'ManualImport', importMode: 'auto',
      files: picked.map(({ file, transfer }) => k.payload(file, title, transfer)) });
    commands.set(id, { id: command.id });
    for (const [token, saved] of selections) if (saved.tmdbId === id) selections.delete(token);
    return { pending: true, failed: false };
  }
  return { inspect, commandStatus, async importFile(id, selection) {
    if (locks.has(id)) throw new Error(k.text.busy);
    const task = start(id, selection);
    locks.set(id, task);
    try { return await task; } finally { locks.delete(id); }
  } };
}
