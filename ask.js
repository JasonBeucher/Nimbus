// Keep selection independent of the services so the same rules apply to owned titles and discoveries.
const LIMIT = 8;
const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const kindOf = (i) => i.type === 'movie' ? 'movie' : 'tv';

export function createAsk({ library, ai, tmdb, discoverList, discovery }) {
  return async function ask(q, before = []) {
    const libraryItems = await library();
    const catalog = libraryItems.map((i, n) => `${n}|${i.title}|${i.year ?? ''}|${i.type === 'movie' ? 'film' : 'série'}|${i.genres.join(', ')}${i.watched ? '|vu' : ''}`).join('\n');
    const context = before.length ? `Demandes précédentes de la même session : ${before.map((b) => `« ${b} »`).join(', ')}. La dernière demande précise ou remplace les précédentes.\n` : '';
    const instructions = 'Tu es Nimbus et tu aides à choisir quoi regarder. '
      + 'Respecte précisément le format, les thèmes, le public et les ressemblances demandés. Un anime est une œuvre d’animation, jamais une série en prises de vues réelles. '
      + 'Ne remplis jamais la sélection avec des titres hors sujet pour atteindre un quota. Mieux vaut 2 bonnes pistes que 8 approximations. '
      + 'Pour une demande de ressemblance, évite de recommander le titre cité lui-même. '
      + `Propose jusqu’à ${LIMIT} titres au total, classés du plus pertinent au moins pertinent. `
      + 'N’invente aucun titre, numéro ni année. Réponds uniquement en JSON. '
      + 'intro est une courte phrase en tutoyant, sans citer de titres ni promettre leur disponibilité. '
      + 'animationOnly vaut true si la demande exige de l’animation, false sinon. unseenOnly vaut true si elle demande des titres pas encore vus, false sinon. kind vaut "movie" si uniquement des films, "tv" si uniquement des séries, null sinon.\n';
    const localPrompt = instructions
      + `Médiathèque (numéro|titre|année|type|genres|vu) :\n${catalog}\n\n`
      + 'La sélection doit se limiter à cette médiathèque. Format : {"intro":"…","animationOnly":false,"unseenOnly":false,"kind":null,"selection":[{"id":0}]}. '
      + 'Chaque id est un numéro de cette liste. Renvoie une sélection vide si rien ne correspond.';
    // Don't send the library to the general recommender: even an explicit discovery instruction
    // leaves smaller models anchored to that list. Availability is resolved afterwards.
    let out = await ai('ask', discovery ? instructions
      + 'Cherche dans l’ensemble des films et séries que tu connais. Leur disponibilité dans la médiathèque sera vérifiée ensuite. '
      + 'Format : {"intro":"…","animationOnly":false,"unseenOnly":false,"kind":null,"libraryOnly":false,"selection":[{"title":"titre français ou anglais officiel","year":2000,"type":"série"}]}. '
      + 'Chaque titre doit avoir son année de première sortie et un type "film" ou "série". '
      + 'libraryOnly vaut true uniquement si la personne demande explicitement des titres de sa médiathèque ; dans ce cas, laisse selection vide, une recherche locale suivra.'
      : localPrompt + ' La découverte externe est indisponible.', context + q, 90_000);
    const localOnly = !discovery || out.libraryOnly === true;
    if (discovery && localOnly) out = await ai('ask', localPrompt, context + q, 90_000);
    const animationOnly = out.animationOnly === true;
    const kind = ['movie', 'tv'].includes(out.kind) ? out.kind : null;
    const matches = (i) => (!kind || kindOf(i) === kind)
      && (out.unseenOnly !== true || !i.watched)
      && (!animationOnly || i.genres.some((g) => normalize(g) === 'animation'));
    let lookupFailed = false;
    const selection = await Promise.all((Array.isArray(out.selection) ? out.selection : []).slice(0, LIMIT).map(async (s) => {
      if (!s || typeof s !== 'object') return null;
      if (Number.isInteger(s.id) && s.id >= 0) {
        const i = libraryItems[s.id];
        return i && matches(i) ? { item: i } : null;
      }
      if (localOnly || typeof s.title !== 'string' || !s.title.trim() || !['film', 'série'].includes(s.type)
        || !Number.isInteger(s.year) || s.year < 1870 || s.year > 2100) return null;
      const k = s.type === 'film' ? 'movie' : 'tv';
      if (kind && k !== kind) return null;
      try {
        const params = { query: s.title.trim().slice(0, 100), include_adult: 'false' };
        const { results = [] } = await tmdb(`/search/${k}`, params);
        // A matching year alone is not enough: search can return unrelated or live-action adaptations.
        const match = (r) => [r.title, r.name, r.original_title, r.original_name].some((t) => t && normalize(t) === normalize(s.title))
          && Number((r.release_date || r.first_air_date || '').slice(0, 4)) === s.year
          && !r.adult && (!animationOnly || r.genre_ids?.includes(16));
        let r = results.find(match);
        if (!r) {
          // English names (common for anime) aren't always in the French search response.
          const english = await tmdb(`/search/${k}`, { ...params, language: 'en-US' });
          const verified = (english.results || []).find(match);
          if (verified) r = results.find((r) => r.id === verified.id) || verified;
        }
        if (!r) return null;
        const owned = libraryItems.find((i) => String(i.tmdb) === String(r.id) && kindOf(i) === k);
        if (owned) return matches(owned) ? { item: owned } : null;
        return { result: { ...r, media_type: k } };
      } catch {
        lookupFailed = true;
        return null;
      }
    }));
    const discoveries = selection.filter((s) => s?.result).map((s) => s.result);
    const resolved = new Map();
    if (discoveries.length) {
      try {
        for (const i of await discoverList(discoveries)) resolved.set(i.key, i);
      } catch {
        lookupFailed = true;
      }
    }
    const seen = new Set();
    const items = selection.map((s) => s?.item || (s?.result && resolved.get(`${s.result.media_type}:${s.result.id}`)))
      .filter((i) => {
        if (!i) return false;
        const key = i.discover ? i.key : i.tmdb ? `${kindOf(i)}:${i.tmdb}` : i.key;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      intro: items.length ? (typeof out.intro === 'string' ? out.intro.slice(0, 300) : '') : 'Je n’ai pas trouvé de titre qui corresponde assez bien à ta demande. Essaie de préciser ce qui te plaît ou ce que tu cherches.',
      items,
      notice: !discovery ? 'La recherche est limitée à ta médiathèque : ajoute la clé TMDB dans la configuration de Nimbus pour découvrir d’autres titres.'
        : lookupFailed ? 'La recherche de certains titres à découvrir a échoué. Tu peux réessayer dans un instant.' : '',
    };
  };
}
