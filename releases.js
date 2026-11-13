import { randomUUID } from 'node:crypto';

// Interactive searches need a Radarr movie ID. New entries stay unmonitored until requested.
export function createMovieReleases({ arr, app, now = Date.now }) {
  const additions = new Map();
  const searches = new Map();
  const choices = new Map();
  const grabs = new Map();
  const sends = new Map();
  const accepted = (r) => r.approved === true && !r.rejected && !r.temporarilyRejected && r.downloadAllowed !== false;
  // A blocked import must not prevent choosing another release just because the
  // queued version meets the cutoff. Other quality/language/size refusals still apply.
  const queueAlternative = (r) => r.downloadAllowed === true && r.rejected === true && r.rejections?.length > 0
    && r.rejections.every((reason) => typeof reason === 'string' && reason.startsWith('Quality for release in queue already meets cutoff:'));
  const releaseKey = (id, r) => `${id}:${r.indexerId}:${r.guid}`;
  const movieState = (m) => JSON.stringify([m.qualityProfileId, !!m.hasFile, m.movieFile?.id || m.movieFileId || null, [...(m.tags || [])].sort()]);
  const prune = () => {
    for (const map of [choices, grabs]) for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  };
  const validate = (tmdbId) => {
    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || tmdbId > 999999999) throw new Error('Film invalide.');
    if (!app.url || !app.key) throw new Error('Radarr n’est pas configuré.');
  };

  async function ensureMovie(tmdbId) {
    if (additions.has(tmdbId)) return additions.get(tmdbId);
    const pending = (async () => {
      const movies = await arr(app, `/movie?tmdbId=${tmdbId}`);
      const existing = movies.find((m) => Number(m.tmdbId) === tmdbId);
      if (existing) return existing;
      const [profiles, roots, movie] = await Promise.all([
        arr(app, '/qualityprofile'), arr(app, '/rootfolder'), arr(app, `/movie/lookup/tmdb?tmdbId=${tmdbId}`),
      ]);
      const profile = profiles.find((p) => p.name === app.profile) || profiles[0];
      if (!profile || !roots[0]) throw new Error('Radarr n’a pas de profil de qualité ou de dossier racine.');
      try {
        return await arr(app, '/movie', 'POST', {
          ...movie, qualityProfileId: profile.id, rootFolderPath: roots[0].path,
          monitored: false, minimumAvailability: 'released', addOptions: { searchForMovie: false },
        });
      } catch (error) {
        // Another browser or Radarr itself may have added it during the lookup.
        const current = await arr(app, `/movie?tmdbId=${tmdbId}`);
        const added = current.find((m) => Number(m.tmdbId) === tmdbId);
        if (added) return added;
        throw error;
      }
    })();
    additions.set(tmdbId, pending);
    try { return await pending; } finally { additions.delete(tmdbId); }
  }

  async function check(tmdbId) {
    validate(tmdbId);
    prune();
    if (searches.has(tmdbId)) return searches.get(tmdbId);
    const pending = (async () => {
      const indexers = (await arr(app, '/indexer')).filter((i) => i.enableInteractiveSearch);
      if (!indexers.length) throw new Error('Aucun indexeur activé pour la recherche interactive dans Radarr.');
      const movie = await ensureMovie(tmdbId);
      if (!indexers.some((i) => !i.tags?.length || i.tags.some((tag) => movie.tags?.includes(tag)))) {
        throw new Error('Aucun indexeur ne correspond aux tags de ce film dans Radarr.');
      }
      const releases = await arr(app, `/release?movieId=${movie.id}`, 'GET', undefined, { timeoutMs: 120_000 });
      const [health, profiles] = await Promise.all([arr(app, '/health'), arr(app, '/qualityprofile')]);
      const expires = now() + 10 * 60_000;
      const items = releases.map((r) => {
        const sent = grabs.has(releaseKey(tmdbId, r));
        const selection = (accepted(r) || queueAlternative(r)) && typeof r.guid === 'string' && r.guid && Number.isInteger(r.indexerId) && r.indexerId > 0 && !sent
          ? randomUUID() : null;
        if (selection) choices.set(selection, { tmdbId, movieId: movie.id, movieState: movieState(movie),
          guid: r.guid, indexerId: r.indexerId, title: r.title || 'Version sans nom', expires });
        return {
          selection, sent,
          title: r.title || 'Version sans nom', indexer: r.indexer || 'Indexeur inconnu',
          quality: r.quality?.quality?.name || 'Qualité inconnue',
          languages: (r.languages || []).map((l) => l.name).filter(Boolean),
          size: Number.isFinite(r.size) && r.size > 0 ? r.size : null,
          seeders: Number.isInteger(r.seeders) && r.seeders >= 0 ? r.seeders : null,
          accepted: accepted(r), queueAlternative: queueAlternative(r) === true,
          rejections: (r.rejections || []).filter((s) => typeof s === 'string'),
        };
      });
      // Keep Radarr's ranking within each group; never expose download URLs or indexer credentials.
      items.sort((a, b) => Number(b.accepted) - Number(a.accepted) || Number(b.queueAlternative) - Number(a.queueAlternative));
      return {
        checkedAt: now(), profile: profiles.find((p) => p.id === movie.qualityProfileId)?.name || null,
        unmonitored: movie.monitored === false, total: items.length, accepted: items.filter((r) => r.accepted).length,
        alternatives: items.filter((r) => r.queueAlternative).length,
        warnings: health.filter((h) => /indexer/i.test(h.source || '')).map((h) => h.message), items,
      };
    })();
    searches.set(tmdbId, pending);
    try { return await pending; } finally { searches.delete(tmdbId); }
  }

  async function request(tmdbId) {
    validate(tmdbId);
    const movie = await ensureMovie(tmdbId);
    if (!movie.monitored) await arr(app, `/movie/${movie.id}`, 'PUT', { ...movie, monitored: true });
    await arr(app, '/command', 'POST', { name: 'MoviesSearch', movieIds: [movie.id] });
  }

  async function download(tmdbId, selection) {
    validate(tmdbId);
    prune();
    const choice = choices.get(selection);
    if (!choice || choice.tmdbId !== tmdbId) throw new Error('Cette sélection a expiré ou est invalide. Revérifie les versions disponibles.');
    const key = releaseKey(tmdbId, choice);
    if (grabs.has(key)) return grabs.get(key).result;
    if (sends.has(key)) return sends.get(key);
    const pending = (async () => {
      // No URL, indexer, quality or movie identity supplied by the browser is trusted.
      const movies = await arr(app, `/movie?tmdbId=${tmdbId}`);
      const movie = movies.find((m) => Number(m.tmdbId) === tmdbId && m.id === choice.movieId);
      if (!movie || movieState(movie) !== choice.movieState) throw new Error('Le film ou ses règles ont changé. Revérifie les versions avant de choisir.');
      const [indexers, queue] = await Promise.all([
        arr(app, '/indexer'), arr(app, `/queue/details?movieId=${movie.id}`),
      ]);
      const indexer = indexers.find((i) => i.id === choice.indexerId);
      if (!indexer?.enableInteractiveSearch || (indexer.tags?.length && !indexer.tags.some((tag) => movie.tags?.includes(tag)))) {
        throw new Error('Cet indexeur n’est plus disponible pour ce film. Revérifie les versions.');
      }
      if (queue.some((r) => r.movieId === movie.id && r.title === choice.title && r.trackedDownloadState !== 'imported')) {
        throw new Error('Cette version est déjà dans la file Radarr. Choisis-en une autre.');
      }
      await arr(app, '/release', 'POST', { guid: choice.guid, indexerId: choice.indexerId, movieId: movie.id }, { timeoutMs: 120_000 });
      const result = { title: choice.title, message: 'Version envoyée à Radarr.' };
      grabs.set(key, { result, expires: now() + 10 * 60_000 });
      // Start only the chosen release. Monitoring records the request without launching an automatic search.
      if (!movie.monitored) {
        try { await arr(app, `/movie/${movie.id}`, 'PUT', { ...movie, monitored: true }); }
        catch { result.warning = 'Le téléchargement est lancé, mais la surveillance du film n’a pas pu être activée dans Radarr.'; }
      }
      return result;
    })();
    sends.set(key, pending);
    try { return await pending; } finally { sends.delete(key); }
  }

  return { check, request, download };
}
