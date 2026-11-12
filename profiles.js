// ─────────────────────────────────────────────────────────────
//  Comptes & profils
//  - GET  /api/users/:uid        → profil public (pseudo, photo, stats de notes)
//  - GET  /api/users/:uid/photo  → la photo de profil (image)
//  - GET  /api/me                → mon profil (connecté)
//  - POST /api/me                → changer mon pseudo / ma photo (connecté)
//  Tout passe par le serveur : le navigateur ne touche jamais la base directement.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');
const songs = require('./songs');

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// Pochettes acceptées : Deezer (recherche d'albums) et Apple (anciens profils)
const COVER = /^https:\/\/(cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net|is\d+-ssl\.mzstatic\.com)\/[^\s"'<>]{1,400}$/;
const LINKS = ['instagram', 'tiktok', 'x', 'soundcloud', 'youtube'];
// Couleurs de profil au choix (sinon : la couleur de l'album du moment)
const COLORS = ['#e9e6df', '#e2b070', '#d9604c', '#e58fb0', '#9b8cff', '#5fa8e8', '#5cc9a7', '#c6d65a'];

// Un album choisi dans la recherche (on garde juste l'essentiel, nettoyé)
function cleanAlbum(a) {
  if (!a || typeof a !== 'object') return null;
  const title = clean(a.title, 120);
  if (!title) return null;
  return { title, artist: clean(a.artist, 80), artwork: COVER.test(String(a.artwork)) ? String(a.artwork) : null, year: /^\d{4}$/.test(String(a.year)) ? String(a.year) : null };
}
// Pseudo d'un réseau : "@milo.wav", "milo.wav" ou un lien collé → "milo.wav"
function cleanHandle(h) {
  let v = String(h || '').trim();
  v = v.replace(/^https?:\/\/(www\.)?[^/]+\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : '';
}
const MAX_PHOTO = 90 * 1024; // ~65 Ko d'image une fois décodée

// Vérifie le jeton Google envoyé par le navigateur (header "Authorization: Bearer …")
async function whoIs(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  try { return await getAuth().verifyIdToken(m[1]); } catch { return null; }
}

const ts = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : null);

// Fabrique la version publique d'un compte
function publicUser(uid, u) {
  const photoAt = ts(u.photoAt) || 0;
  return {
    uid,
    name: u.name || 'Anonyme',
    photo: u.photo ? `/api/users/${uid}/photo?v=${photoAt}` : u.googlePhoto || null,
    customPhoto: !!u.photo,
    since: ts(u.createdAt),
    bio: u.bio || '',
    nowAlbum: u.nowAlbum || null,
    top4: Array.isArray(u.top4) ? [0, 1, 2, 3].map((i) => u.top4[i] || null) : [null, null, null, null],
    links: u.links || {},
    showTop4: u.showTop4 !== false,
    color: COLORS.includes(u.color) ? u.color : null,
    showRatings: u.showRatings !== false,
  };
}

// Calcule les stats d'un profil à partir de toutes ses notes
// Une seule note par musique : si la même musique a été notée plusieurs fois
// (clip puis audio, deux soirées…), on garde la plus récente.
const songKeyOf = (r) => r.songKey || songs.keyOf(songs.parse({ title: r.title, author: r.author }).artist, songs.parse({ title: r.title, author: r.author }).title);
function dedupe(docs) {
  const best = new Map();
  for (const d of docs) {
    const r = d.data ? { ...d.data(), id: d.id } : d;
    if (!(r.value >= 0.5 && r.value <= 5)) continue;
    const k = `${r.uid || r.token}|${songKeyOf(r)}`;
    const prev = best.get(k);
    if (!prev || (ts(r.updatedAt) || 0) >= (ts(prev.updatedAt) || 0)) best.set(k, r);
  }
  return [...best.values()];
}

const round = (x) => Math.round(x * 10) / 10;
const TYPES = { album: 'Album', ep: 'EP', single: 'Single' };

function computeStats(ratings) {
  const dist = [0, 0, 0, 0, 0];
  let sum = 0;
  const albums = new Map(), sessions = new Set();
  for (const r of ratings) {
    dist[Math.max(0, Math.ceil(r.value) - 1)]++; // 3,5 compte dans la barre "4", 0,5 dans "1"
    sum += r.value;
    if (r.session) sessions.add(r.session);
    // Sans album connu, le son compte comme un single
    const key = r.albumKey || `song:${songKeyOf(r)}`;
    const a = albums.get(key) || {
      key,
      title: r.albumKey ? (r.albumTitle || 'Album') : r.title,
      author: (r.albumKey ? r.albumAuthor : r.author) || r.author || '',
      artwork: r.albumArtwork || r.artwork || null,
      type: r.albumKey ? (r.albumType || 'album') : 'single',
      sum: 0, count: 0, lastAt: 0, tracks: [],
    };
    a.sum += r.value; a.count++;
    a.lastAt = Math.max(a.lastAt, ts(r.updatedAt) || 0);
    a.tracks.push({ title: r.title, value: r.value, at: ts(r.updatedAt) || 0 });
    albums.set(key, a);
  }
  const n = dist.reduce((a, b) => a + b, 0);
  const avg = n ? round(sum / n) : null;
  // Petit "profil de goût" selon la note moyenne donnée
  const taste = n < 5 ? null : avg >= 4.2 ? 'Bon public' : avg >= 3.4 ? 'Équilibré' : avg >= 2.6 ? 'Exigeant' : 'Critique impitoyable';
  const list = [...albums.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(({ sum: s, tracks, ...a }) => ({ ...a, label: TYPES[a.type] || 'Album', avg: round(s / a.count), tracks: tracks.sort((x, y) => x.at - y.at).map(({ title, value }) => ({ title, value })) }));
  return {
    count: n,
    avg,
    dist,
    taste,
    sessions: sessions.size,
    releases: list.length,
    recent: list.slice(0, 4),          // activité récente : les 4 derniers albums / EP / singles
    albums: list.slice(0, 60),
    top: ratings
      .filter((r) => r.value >= 4.5)
      .sort((a, b) => (ts(b.updatedAt) || 0) - (ts(a.updatedAt) || 0))
      .slice(0, 8)
      .map((r) => ({ title: r.title, author: r.author, artwork: r.albumArtwork || r.artwork || null, value: r.value })),
  };
}

function profileRoutes(db) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));
  const off = (res) => res.status(503).json({ error: 'Profils indisponibles : base de données non connectée.' });

  // Mon profil (le crée au premier passage avec les infos Google)
  router.get('/api/me', async (req, res) => {
    if (!db) return off(res);
    const me = await whoIs(req);
    if (!me) return res.status(401).json({ error: 'Pas connecté' });
    const ref = db.collection('users').doc(me.uid);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const patch = {};
    if (!data.name) patch.name = clean(me.name || 'Anonyme', 24);
    if (me.picture && data.googlePhoto !== me.picture) patch.googlePhoto = me.picture;
    if (!data.createdAt) patch.createdAt = FieldValue.serverTimestamp();
    if (Object.keys(patch).length) await ref.set(patch, { merge: true });
    // needsName : le compte vient d'être créé, il faut encore choisir son pseudo (une seule fois)
    res.json({ ...publicUser(me.uid, { ...data, ...patch, createdAt: data.createdAt || Date.now() }), needsName: !data.nameSet, syncOffset: typeof data.syncOffset === 'number' ? data.syncOffset : null });
  });

  // Modifier mon pseudo et/ou ma photo
  router.post('/api/me', async (req, res) => {
    if (!db) return off(res);
    const me = await whoIs(req);
    if (!me) return res.status(401).json({ error: 'Pas connecté' });
    const patch = {};
    if (req.body.name !== undefined) {
      const name = clean(req.body.name, 24);
      if (name.length < 2) return res.status(400).json({ error: 'Pseudo trop court' });
      patch.name = name;
      patch.nameSet = true;
    }
    if (req.body.bio !== undefined) patch.bio = String(req.body.bio || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 160);
    if (req.body.nowAlbum !== undefined) patch.nowAlbum = cleanAlbum(req.body.nowAlbum);
    if (req.body.top4 !== undefined) {
      if (!Array.isArray(req.body.top4)) return res.status(400).json({ error: 'Top 4 invalide' });
      patch.top4 = [0, 1, 2, 3].map((i) => cleanAlbum(req.body.top4[i]));
    }
    if (typeof req.body.showTop4 === 'boolean') patch.showTop4 = req.body.showTop4;
    if (typeof req.body.showRatings === 'boolean') patch.showRatings = req.body.showRatings;
    if (req.body.color !== undefined) patch.color = COLORS.includes(req.body.color) ? req.body.color : FieldValue.delete();
    if (req.body.syncOffset !== undefined) {
      const o = Number(req.body.syncOffset);
      if (Number.isFinite(o) && o >= -0.5 && o <= 0.5) patch.syncOffset = Math.round(o * 100) / 100;
    }
    if (req.body.links !== undefined) {
      const l = req.body.links && typeof req.body.links === 'object' ? req.body.links : {};
      patch.links = Object.fromEntries(LINKS.map((k) => [k, cleanHandle(l[k])]).filter(([, v]) => v));
    }
    if (req.body.photo === null) { patch.photo = FieldValue.delete(); patch.photoAt = FieldValue.delete(); }
    else if (req.body.photo !== undefined) {
      const p = String(req.body.photo);
      if (!PHOTO.test(p) || p.length > MAX_PHOTO) return res.status(400).json({ error: 'Image invalide ou trop lourde' });
      patch.photo = p;
      patch.photoAt = Date.now();
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Rien à changer' });
    const ref = db.collection('users').doc(me.uid);
    await ref.set(patch, { merge: true });
    const snap = await ref.get();
    res.json(publicUser(me.uid, snap.data()));
  });

  // Recherche d'albums : catalogue Deezer (public, gratuit, sans clé, classé par popularité)
  const searchCache = new Map();
  router.get('/api/albums', async (req, res) => {
    const q = clean(req.query.q, 80);
    if (q.length < 2) return res.json([]);
    const key = q.toLowerCase();
    if (searchCache.has(key)) return res.json(searchCache.get(key));
    try {
      const r = await fetch(`https://api.deezer.com/search/album?limit=25&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const seen = new Set();
      const rank = { album: 0, ep: 1, compile: 2, single: 3 };
      const out = (j.data || [])
        .map((a, i) => ({ a, i }))
        // Albums d'abord, puis EP, puis singles (à popularité égale, Deezer garde son ordre)
        .sort((x, y) => (rank[x.a.record_type] ?? 2) - (rank[y.a.record_type] ?? 2) || x.i - y.i)
        .map(({ a }) => cleanAlbum({ title: a.title, artist: a.artist && a.artist.name, artwork: a.cover_xl || a.cover_big }))
        .filter((a) => {
          if (!a) return false;
          const k = (a.title + '|' + a.artist).toLowerCase(); // pas de doublons (versions explicit / clean)
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 12);
      searchCache.set(key, out);
      if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
      res.json(out);
    } catch (e) {
      console.warn('Recherche d’albums impossible :', e.message);
      res.status(502).json({ error: 'Recherche indisponible' });
    }
  });

  // ── Mes notes : lister, modifier, supprimer ──
  router.get('/api/me/ratings', async (req, res) => {
    if (!db) return off(res);
    const me = await whoIs(req);
    if (!me) return res.status(401).json({ error: 'Pas connecté' });
    const rs = await db.collection('ratings').where('uid', '==', me.uid).limit(3000).get();
    const list = dedupe(rs.docs).map((r) => {
      return { id: r.id, songKey: songKeyOf(r), albumType: r.albumType || null, title: r.title, author: r.author || '', artwork: r.artwork || null, value: r.value,
        albumKey: r.albumKey || null, albumTitle: r.albumTitle || null, albumAuthor: r.albumAuthor || null,
        albumArtwork: r.albumArtwork || null, at: ts(r.updatedAt) || 0 };
    }).sort((a, b) => b.at - a.at);
    res.json(list);
  });
  async function myRating(req, res) {
    if (!db) { off(res); return null; }
    const me = await whoIs(req);
    if (!me) { res.status(401).json({ error: 'Pas connecté' }); return null; }
    const ref = db.collection('ratings').doc(String(req.params.id).slice(0, 80));
    const snap = await ref.get();
    if (!snap.exists || snap.data().uid !== me.uid) { res.status(404).json({ error: 'Note introuvable' }); return null; }
    return ref;
  }
  router.put('/api/me/ratings/:id', async (req, res) => {
    const ref = await myRating(req, res);
    if (!ref) return;
    const v = Number(req.body.value);
    if (!Number.isInteger(v * 2) || v < 0.5 || v > 5) return res.status(400).json({ error: 'Note invalide' });
    await ref.set({ value: v, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (typeof profileRoutes.onChange === 'function') profileRoutes.onChange((await ref.get()).data().uid);
    res.json({ ok: true, value: v });
  });
  router.delete('/api/me/ratings/:id', async (req, res) => {
    const ref = await myRating(req, res);
    if (!ref) return;
    // On supprime la note de cette musique, y compris d'anciennes versions (autre lien, autre soirée)
    const r = (await ref.get()).data();
    const k = songKeyOf(r);
    const all = await db.collection('ratings').where('uid', '==', r.uid).limit(3000).get();
    await Promise.all(all.docs.filter((d) => songKeyOf(d.data()) === k).map((d) => d.ref.delete()));
    if (typeof profileRoutes.onChange === 'function') profileRoutes.onChange(r.uid);
    res.json({ ok: true });
  });

  // Note moyenne d'un album sur tout Ballroom (tout le monde réuni)
  router.get('/api/release', async (req, res) => {
    if (!db) return off(res);
    const key = String(req.query.key || '').slice(0, 300);
    if (!key) return res.status(400).json({ error: 'Album manquant' });
    try {
      const rs = await db.collection('ratings').where('albumKey', '==', key).limit(5000).get();
      const list = dedupe(rs.docs);
      // Moyenne de chaque personne sur l'album, puis moyenne de tout le monde
      const per = new Map();
      for (const r of list) {
        const who = r.uid || r.token;
        const p = per.get(who) || { s: 0, n: 0 };
        p.s += r.value; p.n++;
        per.set(who, p);
      }
      const avgs = [...per.values()].map((p) => p.s / p.n);
      res.json({ avg: avgs.length ? round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null, people: avgs.length });
    } catch (e) { res.status(500).json({ error: 'Erreur' }); }
  });

  // Profil public + stats
  router.get('/api/users/:uid', async (req, res) => {
    if (!db) return off(res);
    const uid = String(req.params.uid).slice(0, 128);
    try {
      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) return res.status(404).json({ error: 'Profil introuvable' });
      const u = publicUser(uid, snap.data());
      const viewer = await whoIs(req);
      const owner = !!viewer && viewer.uid === uid;
      // Notes privées : seul le propriétaire voit ses stats
      if (!u.showRatings && !owner) return res.json({ ...u, stats: null, owner });
      const rs = await db.collection('ratings').where('uid', '==', uid).limit(3000).get();
      res.json({ ...u, owner, stats: computeStats(dedupe(rs.docs)) });
    } catch (e) {
      console.warn('Profil illisible :', e.message);
      res.status(500).json({ error: 'Erreur de lecture du profil' });
    }
  });

  // Photo de profil (stockée dans la base, servie comme une vraie image)
  router.get('/api/users/:uid/photo', async (req, res) => {
    if (!db) return res.sendStatus(404);
    try {
      const snap = await db.collection('users').doc(String(req.params.uid).slice(0, 128)).get();
      const u = snap.exists ? snap.data() : null;
      if (u && u.photo && PHOTO.test(u.photo)) {
        const [, type, b64] = u.photo.match(/^data:image\/(\w+);base64,(.+)$/);
        res.set('Content-Type', `image/${type}`);
        res.set('Cache-Control', 'public, max-age=604800, immutable');
        return res.send(Buffer.from(b64, 'base64'));
      }
      if (u && u.googlePhoto) return res.redirect(u.googlePhoto);
      res.sendStatus(404);
    } catch { res.sendStatus(500); }
  });

  return router;
}

// Récupère le compte d'un joueur pour l'afficher dans une salle
async function roomIdentity(db, uid) {
  if (!db) return null;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const u = publicUser(uid, snap.data());
  return { name: u.name, avatar: u.photo, color: u.color };
}

module.exports = { profileRoutes, roomIdentity, computeStats, publicUser, cleanAlbum, dedupe };
