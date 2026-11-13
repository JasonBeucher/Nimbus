// Nimbus: tiny proxy in front of Jellyfin so the API key never reaches the browser.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createAsk } from './ask.js';
import { openWatchedStore } from './watched.js';
import { createDownloadTracker } from './downloads.js';
import { createMovieReleases } from './releases.js';
import { createDownloadRepair } from './download-repair.js';

const watchedTitles = await openWatchedStore(new URL('./.watched.json', import.meta.url));

const JF_URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const JF_KEY = process.env.JELLYFIN_API_KEY || '';
const JF_USER = process.env.JELLYFIN_USER || '';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEVICE_ID = 'nimbus-web';
const AUTH = { Authorization: `MediaBrowser Client="Nimbus", Device="Nimbus", DeviceId="${DEVICE_ID}", Version="1.0", Token="${JF_KEY}"` };

const service = (name, prefix) => ({
  name, url: (process.env[`${prefix}_URL`] || '').replace(/\/$/, ''), key: process.env[`${prefix}_API_KEY`] || '', profile: process.env[`${prefix}_PROFILE`] || '',
});
const RADARR = service('Radarr', 'RADARR');
const SONARR = service('Sonarr', 'SONARR');
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const AI_URL = (process.env.AI_URL || '').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || '';

if (!JF_URL || !JF_KEY) {
  console.error('JELLYFIN_URL et JELLYFIN_API_KEY sont requis (voir .env.example)');
  process.exit(1);
}

async function jf(path, method = 'GET', body) {
  const res = await fetch(`${JF_URL}${path}`, {
    method,
    headers: { ...AUTH, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jellyfin ${res.status} sur ${path.split('?')[0]}`);
  return res.status === 204 ? null : res.json();
}

let server; // { userId }
async function session() {
  if (server) return server;
  const users = await jf('/Users');
  const user = users.find((u) => u.Name === JF_USER) || users.find((u) => u.Policy?.IsAdministrator) || users[0];
  if (!user) throw new Error('Aucun utilisateur Jellyfin trouvé');
  return (server = { userId: user.Id });
}

const FIELDS = 'Genres,Overview,DateCreated,OfficialRating,ProductionYear,ProviderIds';

// ponytail: whole-library cache refreshed every 5 min; fine for a home server, use Jellyfin's ?MinDateLastSaved if libraries get huge.
let cache = { at: 0, items: null };
async function library() {
  if (cache.items && Date.now() - cache.at < 5 * 60_000) return cache.items;
  const { userId } = await session();
  const res = await jf(`/Items?userId=${userId}&IncludeItemTypes=Movie,Series&Recursive=true&Fields=${FIELDS}`);
  cache = { at: Date.now(), items: res.Items.map((m) => item(m)) };
  scanPosters(res.Items).catch((e) => console.error('Analyse des affiches :', e.message));
  return cache.items;
}

// Posters without a title on them get the logo laid over. TMDB gives each poster a language and
// none means textless; Jellyfin doesn't keep it, so the current poster is matched to TMDB's list by size.
// ponytail: cached on disk per poster tag, so only new or changed posters are checked again.
const POSTERS = new URL('./.posters.json', import.meta.url);
let posters = {}; // itemId -> { tag, textless }
try { posters = JSON.parse(await readFile(POSTERS, 'utf8')); } catch {}
let scanning = false;
async function scanPosters(raw) {
  const todo = raw.filter((m) => m.ImageTags?.Primary && posters[m.Id]?.tag !== m.ImageTags.Primary);
  if (scanning || !todo.length) return;
  scanning = true;
  try {
    for (let k = 0; k < todo.length; k += 8) {
      await Promise.all(todo.slice(k, k + 8).map(async (m) => {
        const [imgs, remote] = await Promise.all([
          jf(`/Items/${m.Id}/Images`),
          jf(`/Items/${m.Id}/RemoteImages?type=Primary&IncludeAllLanguages=true`),
        ]);
        const cur = imgs.find((i) => i.ImageType === 'Primary');
        const match = cur && remote.Images.find((r) => r.Width === cur.Width && r.Height === cur.Height);
        posters[m.Id] = { tag: m.ImageTags.Primary, textless: !!match && !match.Language }; // unmatched: assume titled
      }).map((p) => p.catch(() => {})));
    }
    await writeFile(POSTERS, JSON.stringify(posters));
    cache.at = 0; // rebuild items with the new flags
  } finally {
    scanning = false;
  }
}

const img = (id, type, w) => (id ? `/img?id=${id}&t=${type}&w=${w}` : null);
const TICKS_PER_MIN = 600_000_000;

function item(m) {
  const isEp = m.Type === 'Episode';
  const pos = m.UserData?.PlaybackPositionTicks || 0;
  const len = m.RunTimeTicks || 0;
  const watched = !!m.UserData?.Played || (!isEp && watchedTitles.has(server?.userId, m.Type === 'Movie' ? 'movie' : 'tv', m.ProviderIds?.Tmdb));
  return {
    key: m.Id,
    type: { Movie: 'movie', Series: 'show', Episode: 'episode' }[m.Type],
    title: isEp ? m.SeriesName : m.Name,
    subtitle: isEp ? `S${m.ParentIndexNumber ?? '?'}:É${m.IndexNumber ?? '?'} ${m.Name}` : null,
    year: m.ProductionYear,
    genres: m.Genres || [],
    rating: m.OfficialRating || null,
    score: m.CommunityRating || null,
    tmdb: m.ProviderIds?.Tmdb || null,
    summary: m.Overview || '',
    addedAt: Date.parse(m.DateCreated) || 0,
    poster: img(isEp ? m.SeriesId : m.ImageTags?.Primary && m.Id, 'Primary', 600),
    art: img(isEp ? m.ParentBackdropItemId : m.BackdropImageTags?.length && m.Id, 'Backdrop', 1920),
    // Landscape art with the title baked in (Jellyfin "Thumb"); an episode borrows its series'.
    thumb: img(isEp ? m.ParentThumbItemId : m.ImageTags?.Thumb && m.Id, 'Thumb', 1280),
    still: isEp && m.ImageTags?.Primary ? img(m.Id, 'Primary', 1280) : img(isEp ? m.ParentBackdropItemId : m.BackdropImageTags?.length && m.Id, 'Backdrop', 1280),
    logo: img(isEp ? m.ParentLogoItemId : m.ImageTags?.Logo && m.Id, 'Logo', 600),
    textless: !!posters[isEp ? m.SeriesId : m.Id]?.textless,
    progress: pos && len ? pos / len : null,
    remaining: pos && len ? Math.round((len - pos) / TICKS_PER_MIN) : null,
    watched,
    seen: watched ? 1 : (m.UserData?.PlayedPercentage || 0) / 100, // how much of it was watched, 0..1
    fav: !!m.UserData?.IsFavorite,
    href: isEp ? `#/lecture/${m.Id}` : `#/titre/${m.Id}`,
  };
}

// Detail page (Disney+ layout): textless backdrop, logo, facts, suggestions, and seasons for a series.
const minutes = (ticks) => (ticks ? Math.round(ticks / TICKS_PER_MIN) : null);
const isId = (s) => /^[0-9a-f]{32}$/i.test(s || '');

async function detail(id) {
  const { userId } = await session();
  const m = await jf(`/Items/${id}?userId=${userId}`);
  if (!['Movie', 'Series'].includes(m.Type)) throw new Error('Titre introuvable');
  const names = (type) => (m.People || []).filter((p) => p.Type === type).map((p) => p.Name);
  const [similar, art] = await Promise.all([
    jf(`/Items/${id}/Similar?userId=${userId}&Limit=15&Fields=${FIELDS}`).catch(() => ({ Items: [] })),
    backdrop(m),
  ]);
  const trailer = m.RemoteTrailers?.find((t) => /^https:\/\//.test(t.Url))?.Url || null;
  const out = {
    ...item(m), art, trailer, minutes: minutes(m.RunTimeTicks), date: m.PremiereDate || null,
    canCheckReleases: m.Type === 'Movie' && !!m.ProviderIds?.Tmdb && !!RADARR.url && !!RADARR.key,
    directors: names('Director'), writers: names('Writer'), cast: names('Actor').slice(0, 8), studios: (m.Studios || []).map((x) => x.Name),
    suggestions: similar.Items.filter((x) => ['Movie', 'Series'].includes(x.Type) && !x.UserData?.Played).map((x) => item(x)),
  };
  if (m.Type !== 'Series') return out;
  const [seasons, next] = await Promise.all([
    jf(`/Shows/${id}/Seasons?userId=${userId}`),
    jf(`/Shows/NextUp?userId=${userId}&seriesId=${id}&Limit=1`),
  ]);
  out.seasons = seasons.Items.map((x) => ({ id: x.Id, index: x.IndexNumber ?? 0, name: x.IndexNumber ? `Saison ${x.IndexNumber}` : x.IndexNumber === 0 ? 'Épisodes spéciaux' : x.Name }));
  const end = m.EndDate && new Date(m.EndDate).getFullYear();
  out.years = m.ProductionYear ? (end && end !== m.ProductionYear ? `${m.ProductionYear} – ${end}` : String(m.ProductionYear)) : null;
  const n = next.Items[0];
  const pos = n?.UserData?.PlaybackPositionTicks || 0;
  out.next = n && {
    label: `S${n.ParentIndexNumber ?? '?'}:É${n.IndexNumber ?? '?'}`, name: n.Name, seasonId: n.SeasonId,
    progress: pos && n.RunTimeTicks ? pos / n.RunTimeTicks : null, remaining: pos && n.RunTimeTicks ? minutes(n.RunTimeTicks - pos) : null,
  };
  // Open on the next episode's season, else the first real season (specials last).
  out.season = n?.SeasonId || (out.seasons.find((x) => x.index > 0) || out.seasons[0])?.id || null;
  return out;
}

// Jellyfin backdrop, else TMDB's best textless one, else the titled thumb.
async function backdrop(m) {
  if (m.BackdropImageTags?.length) return img(m.Id, 'Backdrop', 1920);
  const tmdbId = m.ProviderIds?.Tmdb;
  if (TMDB_KEY && tmdbId) {
    const kind = m.Type === 'Movie' ? 'movie' : 'tv';
    const pics = await tmdb(`/${kind}/${tmdbId}/images`, { include_image_language: 'null' }).catch(() => null);
    if (pics?.backdrops?.[0]) return `https://image.tmdb.org/t/p/w1280${pics.backdrops[0].file_path}`;
  }
  return m.ImageTags?.Thumb ? img(m.Id, 'Thumb', 1920) : null;
}

async function episodes(seriesId, seasonId) {
  const { userId } = await session();
  const res = await jf(`/Shows/${seriesId}/Episodes?userId=${userId}&seasonId=${seasonId}&Fields=Overview`);
  return res.Items.map((e) => {
    const pos = e.UserData?.PlaybackPositionTicks || 0;
    return {
      id: e.Id, index: e.IndexNumber ?? null, name: e.Name, summary: e.Overview || '', minutes: minutes(e.RunTimeTicks),
      still: e.ImageTags?.Primary ? img(e.Id, 'Primary', 640) : null,
      progress: e.UserData?.Played ? 1 : pos && e.RunTimeTicks ? pos / e.RunTimeTicks : null,
    };
  });
}

// A series plays its next-up episode, or its first one if nothing is in progress.
// choice = { audio, sub, alang, slang, caps }: stream indexes (sub -1 = off), remembered languages,
// and what the browser can decode. Missing indexes fall back to languages, then Jellyfin's per-user defaults.
const LANG_ALIAS = { fra: 'fre', ger: 'deu', deu: 'ger', chi: 'zho', zho: 'chi' };
const sameLang = (a, b) => !!a && !!b && (a === b || LANG_ALIAS[a] === b);

async function play(id, choice) {
  const { userId } = await session();
  let m = await jf(`/Items/${id}?userId=${userId}`);
  if (m.Type === 'Series') {
    const next = await jf(`/Shows/NextUp?userId=${userId}&seriesId=${id}&Limit=1`);
    const first = next.Items[0] || (await jf(`/Shows/${id}/Episodes?userId=${userId}&Limit=1`)).Items[0];
    if (!first) throw new Error('Aucun épisode disponible');
    m = await jf(`/Items/${first.Id}?userId=${userId}`);
  }
  const source = m.MediaSources?.[0];
  if (!source) throw new Error('Aucune source vidéo');
  const streams = source.MediaStreams || [];
  const video = streams.find((s) => s.Type === 'Video');
  const audios = streams.filter((s) => s.Type === 'Audio');
  const subs = streams.filter((s) => s.Type === 'Subtitle');
  const has = (list, i) => list.some((s) => s.Index === i);

  const audio = has(audios, choice.audio) ? choice.audio
    : audios.find((s) => sameLang(s.Language, choice.alang))?.Index ?? source.DefaultAudioStreamIndex ?? audios[0]?.Index;
  const sub = choice.sub === -1 || (choice.sub === undefined && choice.slang === 'none') ? -1
    : has(subs, choice.sub) ? choice.sub
    : subs.find((s) => sameLang(s.Language, choice.slang) && s.IsTextSubtitleStream)?.Index
      ?? subs.find((s) => sameLang(s.Language, choice.slang))?.Index
      ?? source.DefaultSubtitleStreamIndex ?? -1;
  const burn = subs.find((s) => s.Index === sub && !s.IsTextSubtitleStream);

  // What the browser decodes natively; anything else gets converted by Jellyfin.
  const caps = choice.caps;
  const hdrSource = video?.VideoRange && video.VideoRange !== 'SDR';
  const vcodecs = ['h264', ...(!hdrSource || caps.has('hdr') ? ['hevc', 'av1', 'vp9'].filter((c) => caps.has(c)) : [])];
  const acodecs = ['aac', 'mp3', ...['ac3', 'eac3', 'opus', 'flac'].filter((c) => caps.has(c))];
  const chosenAudio = audios.find((s) => s.Index === audio);
  const copyVideo = !burn && vcodecs.includes(video?.Codec);
  const copyAudio = !chosenAudio || acodecs.includes(chosenAudio.Codec);

  const session_ = crypto.randomUUID().replaceAll('-', '');
  const pos = m.UserData?.PlaybackPositionTicks || 0;
  const base = {
    id: m.Id,
    title: m.Type === 'Episode' ? m.SeriesName : m.Name,
    subtitle: m.Type === 'Episode' ? `S${m.ParentIndexNumber ?? '?'}:É${m.IndexNumber ?? '?'} ${m.Name}` : null,
    start: pos / 10_000_000,
    playSession: session_,
    audio,
    sub,
    alang: chosenAudio?.Language || null,
    slang: sub === -1 ? 'none' : subs.find((s) => s.Index === sub)?.Language || null,
    next: m.Type === 'Episode'
      ? (await jf(`/Shows/${m.SeriesId}/Episodes?userId=${userId}&startItemId=${m.Id}&Limit=2`)).Items[1]?.Id || null
      : null,
    audios: audios.map((s) => ({ index: s.Index, label: s.DisplayTitle || s.Language || `Piste ${s.Index}` })),
    subs: subs.map((s) => ({
      index: s.Index,
      label: s.DisplayTitle || s.Language || `Piste ${s.Index}`,
      lang: s.Language || '',
      vtt: s.IsTextSubtitleStream ? `/stream/Videos/${m.Id}/${source.Id}/Subtitles/${s.Index}/0/Stream.vtt` : null,
    })),
  };

  // Direct play: the browser reads the file itself, Jellyfin does nothing. Needs an mp4/webm file,
  // supported codecs, the first audio track (browsers can't switch tracks) and no burned subtitles.
  const container = source.Container || '';
  const playableContainer = /\b(mp4|m4v)\b/.test(container) || (/\bwebm\b/.test(container) && ['vp9', 'av1'].includes(video?.Codec));
  if (playableContainer && copyVideo && copyAudio && audio === audios[0]?.Index) {
    const q = new URLSearchParams({ static: 'true', MediaSourceId: source.Id });
    return { ...base, mode: 'direct', src: `/stream/Videos/${m.Id}/stream?${q}` };
  }

  const q = new URLSearchParams({
    MediaSourceId: source.Id, PlaySessionId: session_, userId,
    VideoCodec: vcodecs.join(','), AudioCodec: acodecs.join(','),
    TranscodingMaxAudioChannels: '6', SegmentContainer: 'mp4',
    // 3 s segments: the first one is ready twice as fast as Jellyfin's default 6 s.
    SegmentLength: '3',
    AudioBitrate: '384000',
    ...(audio != null && { AudioStreamIndex: String(audio) }),
    // Copy: lift the bitrate cap or Jellyfin refuses to copy. Convert: without an explicit VideoBitrate
    // Jellyfin falls back to 256 kb/s. ponytail: 1080p/20 Mb/s conversion cap, raise for 4K on a fast LAN.
    ...(copyVideo
      ? { VideoBitrate: '200000000' }
      : { VideoBitrate: '20000000', MaxWidth: '1920', MaxHeight: '1080' }),
    // Image subtitles (PGS, DVD) can't be sent as text, so Jellyfin burns them into the picture.
    ...(burn && { SubtitleStreamIndex: String(sub), SubtitleMethod: 'Encode' }),
  });
  return { ...base, mode: copyVideo ? 'remux' : 'transcode', src: `/stream/Videos/${m.Id}/master.m3u8?${q}` };
}

async function progress({ id, pos, dur, playSession, done }) {
  if (!/^[0-9a-f]{32}$/i.test(id || '')) throw new Error('bad id');
  const { userId } = await session();
  if (dur && pos / dur > 0.9) await jf(`/UserPlayedItems/${id}?userId=${userId}`, 'POST');
  else await jf(`/UserItems/${id}/UserData?userId=${userId}`, 'POST', { PlaybackPositionTicks: Math.round(pos * 10_000_000) });
  if (done && /^[0-9a-f]{32}$/i.test(playSession || '')) {
    await jf(`/Videos/ActiveEncodings?deviceId=${DEVICE_ID}&playSessionId=${playSession}`, 'DELETE');
  }
  cache.at = 0; // watched/progress changed
}

// Pipe HLS playlists and segments through so the browser never sees the key.
async function stream(req, res, url) {
  const path = url.pathname.slice('/stream'.length);
  if (!/^\/Videos\/[0-9a-f]{32}\/[\w./-]+$/i.test(path) || path.includes('..')) return send(res, 400, 'bad stream path');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const r = await fetch(`${JF_URL}${path}${url.search}`, {
    headers: { ...AUTH, ...(req.headers.range && { Range: req.headers.range }) },
    signal: ac.signal,
  });
  const headers = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) headers[h] = r.headers.get(h);
  res.writeHead(r.status, headers);
  if (r.body) Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  else res.end();
}

function body(req) {
  return new Promise((ok, ko) => {
    let s = '';
    req.on('data', (c) => (s += c).length > 10_000 && req.destroy());
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { ko(e); } });
  });
}

const byAdded = (a, b) => b.addedAt - a.addedAt;
const typeOf = { films: 'movie', series: 'show' };

// Recommendations without the AI: a taste profile from the genres of everything watched (weighted by how much
// of it was seen, favourites count double), then each title not started yet is scored by how well it matches.
// ponytail: genres + rating only; add People/Studios to FIELDS and the profile if the picks feel samey.
function taste(items) {
  const w = {};
  for (const i of items) for (const g of i.genres) w[g] = (w[g] || 0) + i.seen * (i.fav ? 2 : 1);
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return (i) => i.genres.reduce((s, g) => s + (w[g] || 0), 0) / total / Math.sqrt(i.genres.length || 1) + (i.score || 6) / 50;
}
const ranked = (list, score) => list.map((i) => [i, score(i)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
// Same genres as the anchor, the more shared (and the fewer extra) the better.
const overlap = (a) => (i) => i.genres.filter((g) => a.genres.includes(g)).length / new Set([...a.genres, ...i.genres]).size;

async function home(view) {
  const items = await library();
  const pool = typeOf[view] ? items.filter((i) => i.type === typeOf[view]) : items;
  const withPoster = pool.filter((i) => i.poster);
  const unseen = withPoster.filter((i) => !i.watched); // watched to the end: only in « À revoir »
  const fresh = unseen.filter((i) => !i.seen); // not started either (started ones are in « Reprendre »)
  const rows = [];

  // Disney+ order: picks (large), continue watching, then genres with a large row every third shelf.
  // Picks come from the AI's last suggestions when there are some, else from the taste profile.
  const chosen = rec.picks.map((k) => fresh.find((i) => i.key === k)).filter(Boolean);
  const picks = chosen.length >= 4 ? chosen : ranked(fresh, taste(items)).slice(0, 20);
  if (picks.length) rows.push({ title: 'Choisis pour toi', style: 'large', items: picks });

  if (!typeOf[view]) {
    const { userId } = await session();
    const q = `userId=${userId}&Limit=20&Fields=${FIELDS}&EnableImageTypes=Primary,Backdrop,Logo,Thumb`;
    const [resume, next] = await Promise.all([jf(`/UserItems/Resume?${q}&MediaTypes=Video`), jf(`/Shows/NextUp?${q}`)]);
    const seen = new Set();
    const cw = [...resume.Items, ...next.Items]
      .filter((m) => !seen.has(m.SeriesId || m.Id) && seen.add(m.SeriesId || m.Id))
      .map((m) => item(m));
    if (cw.length) rows.push({ title: 'Reprendre la lecture', style: 'continue', items: cw });
  }

  const kind = { films: 'movie', series: 'tv' }[view];
  const more = TMDB_KEY ? await discoverList(rec.discover.filter((r) => !kind || r.media_type === kind)).catch(() => []) : [];
  if (more.length) rows.push({ title: 'À découvrir pour toi', style: 'discover', items: more });

  const counts = {};
  for (const i of pool) for (const g of i.genres) counts[g] = (counts[g] || 0) + 1;
  const genres = Object.entries(counts).filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([g]) => ({ title: g, items: shuffle(unseen.filter((i) => i.genres.includes(g))).slice(0, 24) }))
    .filter((g) => g.items.length);
  const recent = { title: 'Ajouts récents', style: 'large', items: [...unseen].sort(byAdded).slice(0, 20) };
  if (genres.length) rows.push({ ...genres[0], style: 'poster' });
  if (recent.items.length) rows.push(recent);

  // « Parce que tu as regardé X »: a title seen at least halfway, picked at random so the row changes.
  const anchor = shuffle(items.filter((i) => i.seen >= 0.5 && i.genres.length))[0];
  const like = anchor ? ranked(fresh.filter((i) => i.key !== anchor.key), overlap(anchor)).slice(0, 20) : [];
  if (like.length) rows.push({ title: `Parce que tu as regardé ${anchor.title}`, style: 'poster', items: like });

  genres.slice(1).forEach((g, k) => rows.push({ ...g, style: k % 3 === 2 ? 'large' : 'poster' }));

  // Watched to the end: favourites first, then the best rated.
  const again = withPoster.filter((i) => i.watched).sort((a, b) => b.fav - a.fav || (b.score || 0) - (a.score || 0));
  if (again.length) rows.push({ title: 'À revoir', style: 'poster', items: again.slice(0, 24) });

  const hero = shuffle(pool.filter((i) => i.art && !i.watched)).slice(0, 8);
  return { hero, rows };
}

function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
async function search(q) {
  const needle = fold(q);
  const items = await library();
  const byTitle = items.filter((i) => fold(i.title).includes(needle));
  const byGenre = items.filter((i) => !byTitle.includes(i) && i.genres.some((g) => fold(g).includes(needle)));
  return [...byTitle, ...byGenre].slice(0, 60);
}

// What the search page shows before anything is typed, like Disney+: titled landscape rows, then genres.
async function explore() {
  const items = await library();
  const wide = items.filter((i) => i.thumb);
  const counts = {};
  for (const i of items) for (const g of i.genres) counts[g] = (counts[g] || 0) + 1;
  const used = new Set();
  const [trendMovies, trendShows, popMovies, popShows] = TMDB_KEY
    ? await Promise.all([
      ['Films tendance', '/trending/movie/week', 'movie'], ['Séries tendance', '/trending/tv/week', 'tv'],
      ['Films populaires', '/movie/popular', 'movie'], ['Séries populaires', '/tv/popular', 'tv'],
    ].map(async ([title, path, kind]) => ({ title, style: 'discover', items: await discoverList((await tmdb(path)).results, kind) })))
      .catch((e) => (console.error('TMDB :', e.message), []))
    : [];
  return {
    rows: [
      trendMovies, trendShows,
      { title: 'Les mieux notés', style: 'wide', items: wide.filter((i) => i.score && !i.watched).sort((a, b) => b.score - a.score).slice(0, 20) },
      { title: 'Ajouts récents', style: 'wide', items: [...wide].sort(byAdded).slice(0, 20) },
      popMovies, popShows,
    ].filter((r) => r?.items.length),
    genres: Object.entries(counts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
      .map(([name]) => {
        const pick = items.find((i) => i.genres.includes(name) && i.still && !used.has(i.still)); // one picture per genre
        if (pick) used.add(pick.still);
        return { name, art: pick?.still || null };
      }),
  };
}

// Discovery: titles from TMDB that aren't in Jellyfin, sent to Radarr (films) or Sonarr (series) on request.
// ponytail: TMDB answers cached 30 min in memory; plenty for trending lists.
const tmdbCache = new Map();
async function tmdb(path, params = {}) {
  const v4 = TMDB_KEY.length > 40; // v4 read token (Bearer) vs v3 key (query string)
  const q = new URLSearchParams({ language: 'fr-FR', region: 'FR', ...params, ...(!v4 && { api_key: TMDB_KEY }) });
  const hit = tmdbCache.get(path + q);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data;
  const res = await fetch(`https://api.themoviedb.org/3${path}?${q}`, { headers: v4 ? { Authorization: `Bearer ${TMDB_KEY}` } : {} });
  if (!res.ok) throw new Error(`TMDB ${res.status} sur ${path}`);
  const data = await res.json();
  tmdbCache.set(path + q, { at: Date.now(), data });
  return data;
}

async function arr(app, path, method = 'GET', payload, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(`${app.url}/api/v3${path}`, {
    method,
    headers: { 'X-Api-Key': app.key, Accept: 'application/json', ...(payload && { 'Content-Type': 'application/json' }) },
    body: payload && JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    const why = Array.isArray(err) ? err.map((e) => e.errorMessage).join(', ') : err?.message;
    throw new Error(`${app.name} ${res.status}${why ? ` : ${why}` : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

const trackDownload = createDownloadTracker({ arr, apps: { movie: RADARR, tv: SONARR } });
const movieReleases = createMovieReleases({ arr, app: RADARR });
const downloadRepair = {
  movie: createDownloadRepair({ arr, app: RADARR, kind: 'movie' }),
  tv: createDownloadRepair({ arr, app: SONARR, kind: 'tv' }),
};

// What Radarr/Sonarr already track, as "movie:<tmdbId>" / "tv:<tmdbId>"; refreshed every minute.
let wanted = { at: 0, ids: new Set() };
async function requested() {
  if (Date.now() - wanted.at < 60_000) return wanted.ids;
  const [movies, series] = await Promise.all([
    RADARR.key ? arr(RADARR, '/movie').catch(() => []) : [],
    SONARR.key ? arr(SONARR, '/series').catch(() => []) : [],
  ]);
  wanted = { at: Date.now(), ids: new Set([...movies.filter((m) => m.monitored !== false || m.hasFile).map((m) => `movie:${m.tmdbId}`), ...series.filter((s) => s.tmdbId).map((s) => `tv:${s.tmdbId}`)]) };
  return wanted.ids;
}

// TMDB genre ids -> French names, both kinds (ids differ between films and series).
async function genreNames() {
  const lists = await Promise.all(['movie', 'tv'].map((k) => tmdb(`/genre/${k}/list`).catch(() => ({ genres: [] }))));
  return new Map(lists.flatMap((l) => l.genres.map((g) => [g.id, g.name])));
}

async function discoverList(results, kind) {
  const [items, asked, names] = await Promise.all([library(), requested(), genreNames()]);
  const owned = new Set(items.filter((i) => i.tmdb).map((i) => `${i.type === 'movie' ? 'movie' : 'tv'}:${i.tmdb}`));
  return results.map((r) => {
    const k = kind || r.media_type;
    const key = `${k}:${r.id}`;
    if (!['movie', 'tv'].includes(k) || !r.poster_path || owned.has(key)) return null;
    const date = r.release_date || r.first_air_date || '';
    return {
      key, kind: k, tmdbId: r.id, title: r.title || r.name, year: Number(date.slice(0, 4)) || null, summary: r.overview || '',
      discover: true, href: `#/decouvrir/${k}/${r.id}`, genres: (r.genre_ids || []).map((g) => names.get(g)).filter(Boolean),
      poster: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
      art: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
      watched: watchedTitles.has(server.userId, k, r.id),
      requested: asked.has(key), canAdd: !!(k === 'movie' ? RADARR : SONARR).key,
    };
  }).filter(Boolean);
}

// Detail page for a TMDB title, in the same shape as detail() so the page draws both.
async function discoverDetail(kind, id) {
  const tv = kind === 'tv';
  const d = await tmdb(`/${kind}/${id}`, {
    append_to_response: `credits,videos,images,recommendations,${tv ? 'content_ratings' : 'release_dates'}`,
    include_image_language: 'fr,en,null', include_video_language: 'fr,en',
  });
  const items = await library();
  const owned = items.find((i) => i.tmdb === String(id) && (i.type === 'movie') === !tv);
  const asked = await requested();
  const lang = (x) => ({ fr: 0, en: 1 })[x.iso_639_1] ?? 2;
  const logo = [...(d.images?.logos || [])].sort((a, b) => lang(a) - lang(b))[0];
  const art = (d.images?.backdrops || []).find((b) => !b.iso_639_1)?.file_path || d.backdrop_path;
  const video = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const certs = tv
    ? (d.content_ratings?.results || []).map((r) => ({ c: r.iso_3166_1, r: r.rating }))
    : (d.release_dates?.results || []).map((r) => ({ c: r.iso_3166_1, r: r.release_dates.find((x) => x.certification)?.certification }));
  const cert = certs.find((x) => x.c === 'FR' && x.r) || certs.find((x) => x.c === 'US' && x.r);
  const crew = d.credits?.crew || [];
  const date = d.release_date || d.first_air_date || null;
  const start = Number((date || '').slice(0, 4)) || null;
  const end = Number((d.last_air_date || '').slice(0, 4)) || null;
  const uniq = (a) => [...new Set(a)];
  return {
    key: `${kind}:${id}`, discover: true, kind, tmdbId: id, type: tv ? 'show' : 'movie', owned: owned?.key || null,
    watched: watchedTitles.has(server.userId, kind, id),
    title: d.title || d.name, logo: logo ? `https://image.tmdb.org/t/p/w500${logo.file_path}` : null,
    art: art ? `https://image.tmdb.org/t/p/w1280${art}` : null,
    rating: cert ? (cert.c === 'FR' ? `FR-${cert.r === 'U' ? 'TP' : cert.r}` : cert.r) : null,
    year: start, years: start && (['Ended', 'Canceled'].includes(d.status) && end && end !== start ? `${start} – ${end}` : String(start)),
    minutes: d.runtime || null, genres: (d.genres || []).map((g) => g.name), summary: d.overview || '', date,
    trailer: video ? `https://www.youtube.com/watch?v=${encodeURIComponent(video.key)}` : null,
    studios: (d.production_companies || []).map((c) => c.name),
    directors: tv ? (d.created_by || []).map((c) => c.name) : crew.filter((c) => c.job === 'Director').map((c) => c.name),
    writers: uniq(crew.filter((c) => ['Screenplay', 'Writer'].includes(c.job)).map((c) => c.name)),
    cast: (d.credits?.cast || []).slice(0, 8).map((c) => c.name),
    suggestions: await discoverList(d.recommendations?.results || [], kind),
    requested: asked.has(`${kind}:${id}`), canAdd: !!(tv ? SONARR : RADARR).key,
    canCheckReleases: !tv && !!RADARR.url && !!RADARR.key,
    ...(tv && {
      seasons: (d.seasons || []).map((x) => ({ id: String(x.season_number), index: x.season_number, name: x.season_number ? `Saison ${x.season_number}` : 'Épisodes spéciaux' })),
      season: String((d.seasons || []).find((x) => x.season_number > 0)?.season_number ?? d.seasons?.[0]?.season_number ?? ''),
    }),
  };
}

async function discoverSeason(id, n) {
  const d = await tmdb(`/tv/${id}/season/${n}`);
  return (d.episodes || []).map((e) => ({
    id: `${id}-${n}-${e.episode_number}`, index: e.episode_number, name: e.name, summary: e.overview || '', minutes: e.runtime || null,
    still: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : null, progress: null,
  }));
}

// Découvrir page: TMDB lists for films, series or both, with an optional genre, or a search.
const LISTS = ['foryou', 'trending', 'popular', 'top', 'new', 'upcoming'];
async function browse({ kind, list, genre, page, q }) {
  // "Pour toi": the AI's latest discoveries, all on one page.
  if (list === 'foryou' && !q) {
    const raw = rec.discover.filter((r) => (kind === 'all' || r.media_type === kind) && (!genre || r.genre_ids?.includes(Number(genre))));
    return { items: page > 1 ? [] : await discoverList(raw), more: false };
  }
  const today = new Date().toISOString().slice(0, 10);
  const one = async (k) => {
    if (q) return tmdb(`/search/${k}`, { query: q, page, include_adult: 'false' });
    if (list === 'trending' && !genre) return tmdb(`/trending/${k}/week`, { page });
    const date = k === 'movie' ? 'primary_release_date' : 'first_air_date';
    const p = { page, sort_by: 'popularity.desc', 'vote_count.gte': '50', include_adult: 'false', ...(genre && { with_genres: genre }) };
    // "Cultes": best rated among titles many people rated, out for at least 3 years.
    if (list === 'top') {
      Object.assign(p, { sort_by: 'vote_average.desc', 'vote_count.gte': k === 'movie' ? '4000' : '1500', [`${date}.lte`]: `${Number(today.slice(0, 4)) - 3}${today.slice(4)}` });
    }
    if (list === 'new') Object.assign(p, { sort_by: `${date}.desc`, [`${date}.lte`]: today });
    if (list === 'upcoming') Object.assign(p, { [`${date}.gte`]: today, 'vote_count.gte': '0' });
    return tmdb(`/discover/${k}`, p);
  };
  const kinds = kind === 'all' ? ['movie', 'tv'] : [kind];
  const pages = await Promise.all(kinds.map(one));
  const lists = await Promise.all(pages.map((r, n) => discoverList(r.results || [], kinds[n])));
  const items = [];
  for (let n = 0; n < Math.max(0, ...lists.map((l) => l.length)); n++) for (const l of lists) if (l[n]) items.push(l[n]); // films and series alternate
  return { items, more: pages.some((r) => page < Math.min(r.total_pages || 1, 500)) };
}

// Découvrir home, streaming-style: a banner, a top 10, then themed rows; each row links to its full grid.
const GENRE_ROWS = {
  movie: [['movie', 16], ['movie', 878], ['movie', 35], ['movie', 27], ['movie', 99]],
  tv: [['tv', 10759], ['tv', 10765], ['tv', 80], ['tv', 16], ['tv', 35]],
  all: [['movie', 16], ['tv', 10765], ['movie', 27], ['tv', 80], ['movie', 35], ['movie', 99]],
};
async function discoverRows(kind, genre) {
  const names = await genreNames();
  const g = names.get(Number(genre));
  const defs = genre
    ? [['popular', 'Populaires'], ['top', 'Cultes'], ['new', 'Nouveautés'], ['upcoming', 'À venir']].map(([list, t]) => ({ title: `${g} : ${t.toLowerCase()}`, kind, list, genre }))
    : [
      { title: 'Top 10 à découvrir cette semaine', kind, list: 'trending', style: 'top10' },
      ...(kind === 'all'
        ? [
          { title: 'Films populaires', kind: 'movie', list: 'popular' }, { title: 'Séries populaires', kind: 'tv', list: 'popular' },
          { title: 'Nouveaux films', kind: 'movie', list: 'new' }, { title: 'Séries cultes', kind: 'tv', list: 'top' },
          { title: 'Films cultes', kind: 'movie', list: 'top' }, { title: 'Bientôt disponibles', kind: 'all', list: 'upcoming' },
        ]
        : [
          { title: 'Populaires', kind, list: 'popular' }, { title: 'Nouveautés', kind, list: 'new' },
          { title: kind === 'movie' ? 'Films cultes' : 'Séries cultes', kind, list: 'top' }, { title: 'À venir', kind, list: 'upcoming' },
        ]),
      ...GENRE_ROWS[kind].map(([k, id]) => ({ title: kind === 'all' ? `${names.get(id)} (${k === 'movie' ? 'films' : 'séries'})` : names.get(id), kind: k, list: 'popular', genre: String(id) })),
    ];
  const rows = (await Promise.all(defs.map(async (d) => {
    const { items } = await browse({ kind: d.kind, list: d.list, genre: d.genre || '', page: 1, q: '' }).catch(() => ({ items: [] }));
    const more = new URLSearchParams({ ...(d.kind !== 'all' && { kind: d.kind }), list: d.list, ...(d.genre && { genre: d.genre }) });
    return { title: d.title, style: d.style || 'discover', more: `#/decouvrir?${more}`, items: items.slice(0, d.style === 'top10' ? 10 : 20) };
  }))).filter((r) => r.items.length);
  // Banner: the first trending titles that have a backdrop, with their logo (textless art, like Disney+).
  const hero = await Promise.all((rows[0]?.items || []).filter((i) => i.art).slice(0, 6).map(async (i) => {
    const { art, logo } = await titleArt(i.kind, i.tmdbId);
    return { ...i, art: art || i.art, logo };
  }));
  return { hero, rows };
}

// A TMDB title's logo (French, else English, else any) and best textless backdrop: banner and hover panels.
async function titleArt(kind, id) {
  const pics = await tmdb(`/${kind}/${id}/images`, { include_image_language: 'fr,en,null' }).catch(() => ({}));
  const lang = (x) => ({ fr: 0, en: 1 })[x.iso_639_1] ?? 2;
  const logo = [...(pics.logos || [])].sort((a, b) => lang(a) - lang(b))[0];
  const art = (pics.backdrops || []).find((b) => !b.iso_639_1)?.file_path;
  return { art: art ? `https://image.tmdb.org/t/p/w1280${art}` : null, logo: logo ? `https://image.tmdb.org/t/p/w500${logo.file_path}` : null };
}

async function discoverSearch(q) {
  if (!TMDB_KEY) return [];
  return discoverList((await tmdb('/search/multi', { query: q, include_adult: 'false' })).results);
}

async function request({ kind, tmdbId }) {
  const id = Number(tmdbId);
  if (!['movie', 'tv'].includes(kind) || !Number.isInteger(id) || id <= 0) throw new Error('Demande invalide');
  const app = kind === 'movie' ? RADARR : SONARR;
  if (!app.url || !app.key) throw new Error(`${app.name} n'est pas configuré (voir .env)`);
  if (kind === 'movie') {
    await movieReleases.request(id);
    wanted.at = 0;
    return;
  }
  const [profiles, roots] = await Promise.all([arr(app, '/qualityprofile'), arr(app, '/rootfolder')]);
  // ponytail: profile named in *_PROFILE, else the first one, and the first root folder; add a picker if you juggle several.
  const profile = profiles.find((p) => p.name === app.profile) || profiles[0];
  if (!profile || !roots[0]) throw new Error(`${app.name} n'a pas de profil de qualité ou de dossier racine`);
  const common = { qualityProfileId: profile.id, rootFolderPath: roots[0].path, monitored: true };
  const { tvdb_id: tvdb } = await tmdb(`/tv/${id}/external_ids`);
  if (!tvdb) throw new Error("Série absente de TheTVDB : Sonarr ne peut pas l'ajouter");
  const [series] = await arr(app, `/series/lookup?term=tvdb:${tvdb}`);
  if (!series) throw new Error('Série introuvable dans Sonarr');
  const languageProfileId = (await arr(app, '/languageprofile').catch(() => []))[0]?.id; // Sonarr v3 only
  await arr(app, '/series', 'POST', {
    ...series, ...common, languageProfileId, seasonFolder: true,
    addOptions: { monitor: 'all', searchForMissingEpisodes: true },
  });
  wanted.at = 0;
}

// AI: any OpenAI-style server (llama.cpp, Ollama, LM Studio, OpenRouter…), answers in JSON. Each task (ask,
// recommend) has its own route, model, key and reasoning level, set in Réglages; .env gives the defaults.
// ponytail: no queue of our own; the AI server lines requests up itself.
const TASKS = ['ask', 'recommend'];
const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']; // '' = the server's own default (not sent); 'none' = no reasoning
const conf = (task) => {
  const own = rec.tasks?.[task] || {};
  return { url: own.url || AI_URL, model: own.model || AI_MODEL, key: own.key || '', effort: own.effort ?? 'low' };
};
const aiHeaders = (key) => ({ 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) });

async function ai(task, system, user, timeout) {
  const { url, model, key, effort } = conf(task);
  if (!url) throw new Error("Aucun serveur d'IA : renseigne sa route dans Réglages");
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: aiHeaders(key),
    signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({
      ...(model && { model }), ...(effort && { reasoning_effort: effort }), response_format: { type: 'json_object' }, max_tokens: 4000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  }).catch((e) => { throw new Error(e.name === 'TimeoutError' ? "L'IA met trop de temps à répondre" : `Serveur d'IA injoignable (${url})`); });
  if (!res.ok) {
    const why = (await res.json().catch(() => null))?.error?.message;
    throw new Error(`IA ${res.status}${why ? ` : ${why}` : ''}`);
  }
  const text = (await res.json()).choices?.[0]?.message?.content || '';
  try { return JSON.parse(text.replace(/^\s*```(json)?|```\s*$/g, '')); } catch { throw new Error("Réponse de l'IA illisible"); }
}

// Models offered by a route, for the picker in Réglages; the saved key of that task is used if none is typed.
async function aiModels({ task, url, key, model }) {
  const c = conf(TASKS.includes(task) ? task : 'ask');
  const base = cleanUrl(url) || c.url;
  if (!base) throw new Error('Renseigne la route du serveur');
  const res = await fetch(`${base}/models`, { headers: aiHeaders(key || c.key), signal: AbortSignal.timeout(8000) })
    .catch(() => { throw new Error(`Serveur injoignable (${base})`); });
  if (!res.ok) throw new Error(`Le serveur répond ${res.status}`);
  const { data = [], models = [] } = await res.json();
  const all = [...data, ...models].filter((m) => typeof (m.id || m.name || m.model) === 'string');
  const id = (m) => m.id || m.name || m.model;
  // The model the server is running now (llama.cpp-style servers flag it), to pre-fill an empty field.
  const current = all.find((m) => m.selected) || all.find((m) => m.loaded);
  const chosen = all.find((m) => id(m) === model) || current;
  return {
    models: all.map(id), current: current ? id(current) : null,
    efforts: await aiEfforts(base, key || c.key, typeof model === 'string' && model ? model : chosen && id(chosen)),
    defaultEffort: chosen?.parameters?.reasoning_effort || null, // the model's own level, when the server says it
  };
}

// Reasoning levels the server accepts. OpenAI-style APIs have no endpoint for it, but they name the allowed values
// when given a wrong one; the wrong value fails validation before anything is generated.
// ponytail: a server that names nothing (or accepts anything) gets the common none/low/medium/high.
async function aiEfforts(base, key, model) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: aiHeaders(key), signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ ...(model && { model }), reasoning_effort: 'nimbus-probe', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
  }).catch(() => null);
  const why = res && !res.ok ? JSON.stringify(await res.json().catch(() => '')) : '';
  const named = EFFORTS.filter((e) => e && new RegExp(`\\b${e}\\b`).test(why));
  return named.length >= 2 ? named : ['none', 'low', 'medium', 'high'];
}
const cleanUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s]{1,200}$/.test(u.trim()) ? u.trim().replace(/\/$/, '') : '');

// Titles are numbered instead of sent with their ids: far fewer tokens, and the list stays the same between
// questions so the AI server reuses it from its cache.
const catalog = (items) => items.map((i, n) => `${n}|${i.title}|${i.year ?? ''}|${i.type === 'movie' ? 'film' : 'série'}|${i.genres.slice(0, 3).join(', ')}${i.watched ? '|vu' : ''}`).join('\n');
const pickNumbers = (list, items) => [...new Set(Array.isArray(list) ? list : [])].map((n) => items[Number(n)]).filter(Boolean);

// Nimbus mixes library titles and verified discoveries in the AI's relevance order.
const ask = createAsk({ library, ai, tmdb, discoverList, discovery: !!TMDB_KEY });

// Daily suggestions from what was watched: titles from the library, and titles to discover (TMDB → Radarr/Sonarr).
// Settings and the last result live in one file.
const AI_FILE = new URL('./.ai.json', import.meta.url);
let rec = { on: false, time: '04:00', at: 0, error: null, picks: [], discover: [], tasks: {} };
try { rec = { ...rec, ...JSON.parse(await readFile(AI_FILE, 'utf8')) }; } catch {}
// Next daily run at rec.time, strictly after `from`.
const nextRun = (time, from = Date.now()) => {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
};
rec.next ??= nextRun(rec.time, rec.at || Date.now());
let thinking = false;
const saveRec = () => writeFile(AI_FILE, JSON.stringify(rec));

async function recommend() {
  if (thinking) throw new Error("L'IA est déjà en train de chercher");
  thinking = true;
  try {
    const { userId } = await session();
    const [items, played] = await Promise.all([
      library(),
      jf(`/Items?userId=${userId}&IncludeItemTypes=Movie,Episode&Recursive=true&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Descending&Limit=300`),
    ]);
    const watched = [...new Set(played.Items.map((m) => m.SeriesName || m.Name))].slice(0, 30);
    if (!watched.length) throw new Error("Rien de regardé pour l'instant : l'IA n'a rien sur quoi s'appuyer");
    const unseen = items.filter((i) => !i.watched);
    const out = await ai(
      'recommend',
      'Tu recommandes des films et des séries à une personne d\'après ce qu\'elle a regardé. Réponds uniquement en JSON.',
      `Regardés récemment, du plus récent au plus ancien : ${watched.join(' ; ')}.\n\n`
      + `Pas encore vus dans sa médiathèque (numéro|titre|année|type|genres) :\n${catalog(unseen)}\n\n`
      + 'Réponds avec : {"picks":[numéros de 15 titres de cette liste qu\'elle aimerait le plus, du meilleur au moins bon]'
      + (TMDB_KEY ? ',"discover":[20 films ou séries qu\'elle n\'a pas (ni dans la liste, ni déjà regardés), sous la forme {"title":"titre original","year":2020,"type":"film" ou "série"}]' : '')
      + '}',
      300_000,
    );
    // Each discovery is looked up on TMDB; the year picks the right one among remakes.
    const found = await Promise.all((Array.isArray(out.discover) ? out.discover : []).slice(0, 20).map(async (d) => {
      const kind = d?.type === 'film' ? 'movie' : 'tv';
      if (typeof d?.title !== 'string') return null;
      const { results = [] } = await tmdb(`/search/${kind}`, { query: d.title.slice(0, 100), include_adult: 'false' }).catch(() => ({}));
      const r = results.find((x) => (x.release_date || x.first_air_date || '').startsWith(String(d.year))) || results[0];
      return r && { ...r, media_type: kind };
    }));
    const seen = new Set();
    rec = {
      ...rec, at: Date.now(), error: null,
      picks: pickNumbers(out.picks, unseen).map((i) => i.key),
      discover: found.filter((r) => r && !seen.has(`${r.media_type}:${r.id}`) && seen.add(`${r.media_type}:${r.id}`)),
    };
  } catch (e) {
    rec = { ...rec, at: Date.now(), error: e.message };
    throw e;
  } finally {
    thinking = false;
    await saveRec();
  }
}

// ponytail: checked every minute; a run missed while Nimbus was off happens at the next check. The next run is
// planned before starting, so a failure waits for tomorrow instead of retrying every minute.
setInterval(() => {
  if (!rec.on || thinking || !conf('recommend').url || Date.now() < rec.next) return;
  rec.next = nextRun(rec.time);
  recommend().catch((e) => console.error('Suggestions IA :', e.message));
}, 60_000);

const settings = () => ({
  ai: !!conf('ask').url, on: rec.on, time: rec.time, next: rec.next, at: rec.at || null, error: rec.error, thinking,
  picks: rec.picks.length, discover: rec.discover.length, defaults: { url: AI_URL, model: AI_MODEL },
  tasks: Object.fromEntries(TASKS.map((t) => {
    const { url = '', model = '', effort, key } = rec.tasks?.[t] || {};
    return [t, { url, model, effort: effort ?? 'low', hasKey: !!key }]; // the key itself never goes back to the page
  })),
});

// Réglages: { on, time, tasks: { ask: { url, model, key, effort } } }. A key left out or empty is kept, null removes it.
function saveSettings({ on, time, tasks }) {
  if (typeof on === 'boolean') rec.on = on;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) rec.time = time;
  // A new time (or switching on) plans the next run from now: a time already past today means tomorrow.
  if (typeof on === 'boolean' || time) rec.next = nextRun(rec.time);
  for (const t of TASKS) {
    const v = tasks?.[t];
    if (!v || typeof v !== 'object') continue;
    const cur = (rec.tasks ||= {})[t] ||= {};
    if (typeof v.url === 'string') {
      if (v.url.trim() && !cleanUrl(v.url)) throw new Error('Route invalide : elle doit commencer par http:// ou https://');
      cur.url = cleanUrl(v.url);
    }
    if (typeof v.model === 'string') cur.model = v.model.trim().slice(0, 200);
    if (EFFORTS.includes(v.effort)) cur.effort = v.effort;
    if (v.key === null) cur.key = '';
    else if (typeof v.key === 'string' && v.key.trim()) cur.key = v.key.trim().slice(0, 500);
  }
  return saveRec();
}

async function image(res, id, type, w) {
  // Only proxy Jellyfin item images: id must be a hex GUID, type from a fixed list.
  if (!/^[0-9a-f-]{32,36}$/i.test(id || '') || !['Primary', 'Backdrop', 'Logo', 'Thumb'].includes(type)) return send(res, 400, 'bad image');
  const width = Math.min(Math.max(Number(w) || 400, 50), 3840);
  const r = await fetch(`${JF_URL}/Items/${id}/Images/${type}?fillWidth=${width}&quality=90&format=Webp`, { headers: AUTH });
  if (!r.ok) return send(res, r.status, 'image error');
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/home') return send(res, 200, JSON.stringify(await home(url.searchParams.get('view'))), 'application/json');
    const detailId = url.pathname.match(/^\/api\/item\/([0-9a-f]{32})$/i)?.[1];
    if (detailId) return send(res, 200, JSON.stringify(await detail(detailId)), 'application/json');
    const ep = url.pathname.match(/^\/api\/episodes\/([0-9a-f]{32})\/([0-9a-f]{32})$/i);
    if (ep) return send(res, 200, JSON.stringify(await episodes(ep[1], ep[2])), 'application/json');
    if (url.pathname === '/api/watched' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      const { id, kind, tmdbId, watched } = await body(req);
      const discovery = ['movie', 'tv'].includes(kind) && /^[1-9]\d{0,8}$/.test(String(tmdbId));
      if (typeof watched !== 'boolean' || (id != null ? !isId(id) : !discovery)) return send(res, 400, JSON.stringify({ error: 'Titre ou statut invalide.' }), 'application/json');
      const { userId } = await session();
      // Resolve identities on the server; a discovery may since have arrived in Jellyfin.
      const target = id ? item(await jf(`/Items/${id}?userId=${userId}`))
        : (await library()).find((i) => i.tmdb === String(tmdbId) && (i.type === 'movie' ? 'movie' : 'tv') === kind);
      if (target) await jf(`/UserPlayedItems/${target.key}?userId=${userId}`, watched ? 'POST' : 'DELETE');
      const externalId = id ? target.tmdb : tmdbId;
      const externalKind = id ? (target.type === 'movie' ? 'movie' : 'tv') : kind;
      if (externalId && (!target || watchedTitles.has(userId, externalKind, externalId))) {
        await watchedTitles.set(userId, externalKind, externalId, watched);
      }
      cache.at = 0;
      return send(res, 204, '');
    }
    if (url.pathname === '/api/discover/browse') {
      if (!TMDB_KEY) return send(res, 404, JSON.stringify({ error: 'Ajoute TMDB_API_KEY dans .env pour découvrir des titres' }), 'application/json');
      const p = url.searchParams;
      const kind = ['movie', 'tv'].includes(p.get('kind')) ? p.get('kind') : 'all';
      const list = LISTS.includes(p.get('list')) ? p.get('list') : 'trending';
      const genre = kind !== 'all' && /^\d{1,6}$/.test(p.get('genre') || '') ? p.get('genre') : '';
      const page = Math.min(Math.max(parseInt(p.get('page'), 10) || 1, 1), 500);
      const q = (p.get('q') || '').trim().slice(0, 100);
      return send(res, 200, JSON.stringify(await browse({ kind, list, genre, page, q })), 'application/json');
    }
    if (url.pathname === '/api/discover/rows') {
      if (!TMDB_KEY) return send(res, 404, JSON.stringify({ error: 'Ajoute TMDB_API_KEY dans .env pour découvrir des titres' }), 'application/json');
      const kind = ['movie', 'tv'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'all';
      const genre = kind !== 'all' && /^\d{1,6}$/.test(url.searchParams.get('genre') || '') ? url.searchParams.get('genre') : '';
      return send(res, 200, JSON.stringify(await discoverRows(kind, genre)), 'application/json');
    }
    const ta = url.pathname.match(/^\/api\/discover\/art\/(movie|tv)\/(\d{1,9})$/);
    if (ta) return send(res, 200, JSON.stringify(TMDB_KEY ? await titleArt(ta[1], Number(ta[2])) : {}), 'application/json');
    const gk = url.pathname.match(/^\/api\/discover\/genres\/(movie|tv)$/);
    if (gk) return send(res, 200, JSON.stringify(TMDB_KEY ? (await tmdb(`/genre/${gk[1]}/list`)).genres : []), 'application/json');
    const dd = url.pathname.match(/^\/api\/discover\/item\/(movie|tv)\/(\d{1,9})$/);
    if (dd) {
      if (!TMDB_KEY) return send(res, 404, JSON.stringify({ error: 'TMDB non configuré' }), 'application/json');
      return send(res, 200, JSON.stringify(await discoverDetail(dd[1], Number(dd[2]))), 'application/json');
    }
    const ds = url.pathname.match(/^\/api\/discover\/season\/(\d{1,9})\/(\d{1,3})$/);
    if (ds) return send(res, 200, JSON.stringify(await discoverSeason(Number(ds[1]), Number(ds[2]))), 'application/json');
    if (url.pathname === '/api/discover') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      return send(res, 200, JSON.stringify(q ? await discoverSearch(q) : []), 'application/json');
    }
    if (url.pathname === '/api/request' && req.method === 'POST') {
      // JSON only: a page on another site can't send that without a CORS preflight, which we never grant.
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      await request(await body(req));
      return send(res, 204, '');
    }
    const releaseDownload = url.pathname.match(/^\/api\/releases\/movie\/([1-9]\d{0,8})\/download$/);
    if (releaseDownload && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      res.setHeader('Cache-Control', 'no-store');
      const result = await movieReleases.download(Number(releaseDownload[1]), (await body(req))?.selection);
      wanted.at = 0;
      return send(res, 200, JSON.stringify(result), 'application/json');
    }
    const releases = url.pathname.match(/^\/api\/releases\/movie\/([1-9]\d{0,8})$/);
    if (releases && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, JSON.stringify(await movieReleases.check(Number(releases[1]))), 'application/json');
    }
    const repair = url.pathname.match(/^\/api\/downloads\/(movie|tv)\/([1-9]\d{0,8})\/(repair|import)$/);
    if (repair && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      res.setHeader('Cache-Control', 'no-store');
      const fix = downloadRepair[repair[1]];
      const result = repair[3] === 'repair' ? await fix.inspect(Number(repair[2]))
        : await fix.importFile(Number(repair[2]), (await body(req))?.selection);
      return send(res, 200, JSON.stringify(result), 'application/json');
    }
    const download = url.pathname.match(/^\/api\/downloads\/(movie|tv)\/([1-9]\d{0,8})$/);
    if (download && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const status = await trackDownload(download[1], Number(download[2]));
      status.repair = await downloadRepair[download[1]].commandStatus(Number(download[2])).catch(() => ({ pending: true, unavailable: true }));
      if (status.files) cache.at = 0; // newly imported titles should appear on the next library visit
      return send(res, 200, JSON.stringify(status), 'application/json');
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      const b = await body(req);
      const q = String(b.q || '').trim().slice(0, 300);
      const before = (Array.isArray(b.before) ? b.before : []).filter((x) => typeof x === 'string').slice(-4).map((x) => x.slice(0, 300));
      return send(res, 200, JSON.stringify(q ? await ask(q, before) : { intro: '', items: [] }), 'application/json');
    }
    if (url.pathname === '/api/settings') {
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
        await saveSettings(await body(req));
      }
      return send(res, 200, JSON.stringify(settings()), 'application/json');
    }
    if (url.pathname === '/api/ai/models' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      return send(res, 200, JSON.stringify(await aiModels(await body(req))), 'application/json');
    }
    if (url.pathname === '/api/art') { // posters drifting behind the Nimbus page
      const items = await library();
      return send(res, 200, JSON.stringify(shuffle(items.filter((i) => i.poster)).slice(0, 36).map((i) => i.poster)), 'application/json');
    }
    if (url.pathname === '/api/recommend' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, 'JSON attendu');
      await recommend();
      return send(res, 200, JSON.stringify(settings()), 'application/json');
    }
    if (url.pathname === '/api/explore') return send(res, 200, JSON.stringify(await explore()), 'application/json');
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      return send(res, 200, JSON.stringify(q ? await search(q) : []), 'application/json');
    }
    const playId = url.pathname.match(/^\/api\/play\/([0-9a-f]{32})$/i)?.[1];
    if (playId) {
      const p = url.searchParams;
      const int = (k) => (p.has(k) ? parseInt(p.get(k), 10) : undefined);
      const lang = (k) => (/^[a-z]{2,8}$/.test(p.get(k) || '') ? p.get(k) : undefined);
      const caps = new Set((p.get('caps') || '').split(',').filter((c) => /^[a-z0-9]{2,5}$/.test(c)));
      const choice = { audio: int('audio'), sub: int('sub'), alang: lang('alang'), slang: lang('slang'), caps };
      return send(res, 200, JSON.stringify(await play(playId, choice)), 'application/json');
    }
    if (url.pathname === '/api/progress' && req.method === 'POST') {
      await progress(await body(req));
      return send(res, 204, '');
    }
    if (url.pathname.startsWith('/stream/')) return await stream(req, res, url);
    if (url.pathname === '/img') return await image(res, url.searchParams.get('id'), url.searchParams.get('t'), url.searchParams.get('w'));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('Cache-Control', 'no-cache'); // revalidate so a new page shows up without a forced reload
      return send(res, 200, await readFile(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
    }
    send(res, 404, 'not found');
  } catch (e) {
    if (e.name === 'AbortError') return; // viewer seeked or left mid-segment
    console.error(e);
    if (res.headersSent) return res.destroy();
    send(res, 502, JSON.stringify({ error: e.message }), 'application/json');
  }
}).listen(PORT, HOST, () => {
  console.log(`Nimbus → http://${HOST}:${PORT}`);
  library().catch((e) => console.error('Préchargement de la bibliothèque :', e.message));
});
