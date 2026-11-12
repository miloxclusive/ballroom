// ─────────────────────────────────────────────────────────────
//  Reconnaître une musique, peu importe d'où elle vient
//  (clip YouTube, YouTube Music, SoundCloud…)
//  → on nettoie le titre ("(Official Video)", "[Clip]"…), on cherche le son sur Deezer
//    et on garde une clé unique "artiste|titre" : la note va à la MUSIQUE, pas au lien.
//  Deezer donne aussi l'album du son (album, EP ou single) et sa pochette.
// ─────────────────────────────────────────────────────────────

// "Feel Like Uzi (Official Video)" → "feel like uzi" ; "Beyoncé" → "beyonce"
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\$/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Tout ce qu'on enlève des titres de vidéos
const JUNK = /\s*[\(\[\{][^\)\]\}]*(official|officiel|clip|video|vid[eé]o|audio|lyrics?|paroles|visuali[sz]er|prod\.?|hd|4k|explicit|music video|mv)[^\)\]\}]*[\)\]\}]/gi;
const TAIL = /\s*[|•].*$|\s+-\s+(official|clip|video|audio|lyrics?)\b.*$/i;

function cleanTitle(t) {
  return String(t || '')
    .replace(JUNK, '')
    .replace(TAIL, '')
    .replace(/\s*(ft\.?|feat\.?|featuring)\s.*$/i, '') // les feats changent d'un lien à l'autre
    .replace(/["“”]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function cleanArtist(a) {
  return String(a || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*(VEVO|Official|Officiel|Music|TV)$/i, '')
    .replace(/\s*(,|&|x|feat\.?|ft\.?)\s.*$/i, '') // artiste principal seulement
    .trim();
}

// "Prettifun - Feel Like Uzi (Official Video)" → { artist: 'Prettifun', title: 'Feel Like Uzi' }
function parse(item) {
  let title = String(item.title || ''), artist = String(item.author || '');
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { artist = m[1]; title = m[2]; }
  return { artist: cleanArtist(artist), title: cleanTitle(title) };
}

const keyOf = (artist, title) => `${norm(artist)}|${norm(title)}`;
// "Le Projet (Deluxe)" et "Le Projet" = le même album
const EDITION = /\s*[\(\[][^\)\]]*(deluxe|edition|édition|expanded|remaster|bonus|version|anniversary|complete)[^\)\]]*[\)\]]|\s+-\s+(deluxe|.*edition).*$/gi;
const albumKeyOf = (artist, title) => `alb:${norm(artist)}|${norm(cleanTitle(String(title || '').replace(EDITION, '')))}`;

// ── Deezer (API publique, sans clé) ──
const cache = new Map(), albumTypes = new Map();
async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}
// Quel type de sortie ? (album / EP / single) — une requête par album, gardée en mémoire
async function albumType(id) {
  if (albumTypes.has(id)) return albumTypes.get(id);
  const j = await getJSON(`https://api.deezer.com/album/${id}`);
  const type = j && ['album', 'ep', 'single'].includes(j.record_type) ? j.record_type : j && j.record_type === 'compile' ? 'album' : null;
  albumTypes.set(id, type);
  return type;
}

// Est-ce bien le même son ? (titre qui correspond + même artiste, à peu près)
function score(hit, want) {
  const t = norm(cleanTitle(hit.title_short || hit.title)), wt = norm(want.title);
  const a = norm(hit.artist && hit.artist.name), wa = norm(want.artist);
  let s = 0;
  if (t === wt) s += 3; else if (t && wt && (t.includes(wt) || wt.includes(t))) s += 1.5; else return 0;
  if (a && wa && (a === wa || a.includes(wa) || wa.includes(a))) s += 2;
  else if (!wa) s += 0.5;
  else return 0; // autre artiste : on préfère ne rien trouver que se tromper
  return s;
}

async function lookup(want) {
  if (!want.title) return null;
  const qs = [
    want.artist ? `artist:"${want.artist}" track:"${want.title}"` : null,
    `${want.artist} ${want.title}`.trim(),
  ].filter(Boolean);
  for (const q of qs) {
    const j = await getJSON(`https://api.deezer.com/search/track?limit=10&q=${encodeURIComponent(q)}`);
    const hits = (j && Array.isArray(j.data) ? j.data : []).map((h) => ({ h, s: score(h, want) })).filter((x) => x.s > 0);
    if (!hits.length) continue;
    hits.sort((a, b) => b.s - a.s);
    return hits[0].h;
  }
  return null;
}

// Résultat : { songKey, song: { title, artist }, album: { key, title, artist, artwork, type } | null }
async function identify(item) {
  const id = `${item.source}:${item.id}`;
  if (cache.has(id)) return cache.get(id);
  const p = (async () => {
    const want = parse(item);
    const hit = await lookup(want);
    if (!hit) {
      return { songKey: keyOf(want.artist, want.title), song: want, album: null, matched: false };
    }
    const artist = hit.artist.name, title = cleanTitle(hit.title_short || hit.title);
    const al = hit.album || {};
    const type = al.id ? await albumType(al.id) : null;
    return {
      songKey: keyOf(artist, title),
      song: { title, artist },
      album: al.title ? {
        key: albumKeyOf(artist, al.title),
        title: cleanTitle(al.title) || al.title,
        author: artist,
        artwork: al.cover_xl || al.cover_big || al.cover_medium || null,
        type: type || 'album',
      } : null,
      matched: true,
    };
  })();
  cache.set(id, p);
  p.catch(() => cache.delete(id));
  return p;
}

module.exports = { identify, norm, parse, cleanTitle, keyOf, albumKeyOf };
