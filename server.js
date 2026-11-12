// ─────────────────────────────────────────────────────────────
//  BALLROOM — serveur temps réel
//  Le serveur est le "chef d'orchestre" : c'est lui qui garde
//  l'état officiel de la lecture (quel morceau, en pause ou pas,
//  à quelle seconde). Les navigateurs ne font qu'obéir.
// ─────────────────────────────────────────────────────────────
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { db } = require('./db');                       // la base de données (peut être vide si pas de clé)
const { FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { profileRoutes, roomIdentity, cleanAlbum } = require('./profiles');
const songs = require('./songs');                     // reconnaître une musique (clip, audio, SoundCloud…)

// Une erreur imprévue ne doit jamais faire tomber le serveur (et couper toutes les soirées)
process.on('unhandledRejection', (e) => console.warn('Erreur :', e && e.message));

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));
app.get('/r/:code', (req, res) => res.sendFile(path.join(PUBLIC, 'room.html')));
app.get('/overlay/:code', (req, res) => res.sendFile(path.join(PUBLIC, 'overlay.html')));
app.get('/u/:uid', (req, res) => res.sendFile(path.join(PUBLIC, 'profile.html')));
app.use(profileRoutes(db));
profileRoutes.onChange = (uid) => userNotes.delete(uid); // note modifiée depuis le profil → on relira

// Petit proxy pour les pochettes (YouTube / SoundCloud) : ça permet au
// navigateur de lire leurs couleurs (sinon bloqué par sécurité).
const ART_HOST = /^https:\/\/(i\.ytimg\.com|i\d*\.sndcdn\.com|is\d+-ssl\.mzstatic\.com|(cdn-images|e-cdns-images)\.dzcdn\.net)\//;
app.get('/api/art', async (req, res) => {
  const u = String(req.query.u || '');
  if (!ART_HOST.test(u)) return res.sendStatus(400);
  try {
    const r = await fetch(u);
    if (!r.ok) return res.sendStatus(404);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.sendStatus(502); }
});

// ── Salles ───────────────────────────────────────────────────
const rooms = new Map(); // code -> room
const ROLES = ['chef', 'modo', 'auditeur'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // pas de O/0, I/1

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const shortId = () => crypto.randomBytes(4).toString('hex');
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── Réglages d'une salle (choisis à la création, modifiables par le chef) ──
const DEFAULT_SETTINGS = {
  name: '',            // nom affiché ("Écoute Utopia chez Milo")
  album: null,         // listening party : l'album prévu { title, artist, artwork }
  mode: 'party',       // 'party' (listening party) | 'jukebox'
  continuous: false,   // enchaîner les titres sans pause de notation
  countdown: 10,       // secondes de décompte quand tout le monde a noté (0 = le chef lance à la main)
  control: 'modos',    // qui contrôle la lecture : 'chef' | 'modos' (chef + modos) | 'all'
  maxPeople: 0,        // nombre max de personnes (0 = pas de limite)
  private: false,      // salle sur invitation : le chef accepte chaque nouvel arrivant
};
function cleanSettings(x, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (!x || typeof x !== 'object') return out;
  if (x.name !== undefined) out.name = clean(x.name, 40);
  if (x.album !== undefined) out.album = cleanAlbum(x.album);
  if (['party', 'jukebox'].includes(x.mode)) out.mode = x.mode;
  if (typeof x.continuous === 'boolean') out.continuous = x.continuous;
  if ([0, 5, 10, 20].includes(Number(x.countdown))) out.countdown = Number(x.countdown);
  if (['chef', 'modos', 'all'].includes(x.control)) out.control = x.control;
  const m = Number(x.maxPeople);
  if (Number.isInteger(m) && m >= 0 && m <= 100) out.maxPeople = m === 1 ? 2 : m;
  if (typeof x.private === 'boolean') out.private = x.private;
  return out;
}

function createRoom(hostToken, settings) {
  const room = {
    code: newCode(),
    hostToken,
    people: new Map(),     // token -> { id, name, role }
    online: new Map(),     // socket.id -> token
    queue: [],             // [{ source: 'yt'|'sc', id, title, author, artwork, duration }]
    index: 0,
    playing: false,
    position: 0,           // secondes, au moment "updatedAt"
    updatedAt: Date.now(),
    emptySince: Date.now(),
    session: crypto.randomBytes(4).toString('hex'), // identifie cette soirée dans la base
    ratings: new Map(),    // clé du titre -> Map(token -> note de 1 à 5)
    // ── Type d'écoute ──
    // party   : listening party, on note chaque titre (pause après chaque titre, sauf si "enchaîner")
    // jukebox : chacun ajoute ses sons, ça tourne en fond, pas de notes
    settings: cleanSettings(settings),
    pending: new Map(),    // salle sur invitation : token -> { id, name, sid } en attente d'accord
    admitted: new Set(),   // tokens acceptés par le chef
    phase: 'play',         // 'play' (écoute) | 'break' (pause pour noter) | 'end' (fin de la file)
    rateable: new Set(),   // titres écoutés (ou passés) : on peut les noter
    countdown: null,       // { endsAt } ou { remaining, paused: true } pendant une pause
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

// Position actuelle "officielle" de la lecture
function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}
function setPlayback(room, { playing = room.playing, position = currentPosition(room), index = room.index }) {
  room.index = index;
  room.playing = playing;
  room.position = Math.max(0, position);
  room.updatedAt = Date.now();
}

// ── Notes par titre ──────────────────────────────────────────
const trackKey = (it) => `${it.source}:${it.id}`;
const sha = (str) => crypto.createHash('sha1').update(str).digest('hex');

// Moyenne + nombre de notes pour chaque titre de la file (sans dire qui a noté quoi)
function ratingStats(room) {
  const out = {};
  for (const it of room.queue) {
    const k = trackKey(it);
    if (out[k] || !room.rateable.has(k)) continue;
    const votes = [...(room.ratings.get(k)?.values() || [])];
    if (votes.length) out[k] = { avg: Math.round((votes.reduce((a, b) => a + b, 0) / votes.length) * 10) / 10, count: votes.length };
  }
  return out;
}
// Les notes de CETTE personne (envoyées rien qu'à elle)
function myRatings(room, token) {
  const out = {};
  for (const [k, votes] of room.ratings) if (votes.has(token)) out[k] = votes.get(token);
  return out;
}
// ── Reconnaître la musique derrière chaque lien ──
// La note va à la MUSIQUE (artiste + titre), pas au clip : réécoutée en audio ou sur SoundCloud, c'est la même note.
// Album retenu pour le classement : celui de la listening party si le son en fait partie, sinon celui trouvé sur Deezer.
function pickAlbum(room, found) {
  const party = room.settings.mode === 'party' && room.settings.album;
  const partyAlb = party ? { key: songs.albumKeyOf(party.artist, party.title), title: party.title, author: party.artist, artwork: party.artwork || null, type: 'album' } : null;
  const fa = found.album;
  if (fa && partyAlb && fa.key === partyAlb.key) return { ...partyAlb, artwork: partyAlb.artwork || fa.artwork, type: fa.type };
  // Single sorti avant l'album : s'il est du même artiste, on le range dans l'album écouté
  const sameArtist = (x, y) => { x = songs.norm(x); y = songs.norm(y); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
  if (partyAlb && (!fa || fa.type === 'single') && sameArtist(found.song.artist, party.artist)) return partyAlb;
  if (fa) return fa;
  if (partyAlb && !found.matched) return partyAlb;
  return null;
}
async function identifyItem(room, item) {
  if (item.songKey) return item;
  try {
    const found = await songs.identify(item);
    item.songKey = found.songKey;
    item.song = found.song;
    const alb = pickAlbum(room, found) || (item.album ? { ...item.album, type: 'album' } : null);
    item.release = alb ? { key: alb.key, title: alb.title, author: alb.author || '', artwork: alb.artwork || null, type: alb.type || 'album' } : null;
  } catch {
    const p = songs.parse(item);
    item.songKey = songs.keyOf(p.artist, p.title);
    item.song = p;
    item.release = item.album ? { ...item.album, type: 'album' } : null;
  }
  return item;
}

// Notes déjà données sur le compte (clé de la musique → note), gardées un moment en mémoire
const userNotes = new Map(); // uid -> { at, map }
async function notesOf(uid) {
  const c = userNotes.get(uid);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.map;
  const map = new Map();
  if (db) {
    try {
      const snap = await db.collection('ratings').where('uid', '==', uid).limit(3000).get();
      const docs = snap.docs.map((d) => d.data()).filter((r) => r.value > 0)
        .sort((a, b) => (tsMs(a.updatedAt) || 0) - (tsMs(b.updatedAt) || 0));
      // Anciennes notes (avant la reconnaissance) : on retrouve la musique depuis le titre enregistré
      const keyOf = (r) => { if (r.songKey) return r.songKey; const p = songs.parse({ title: r.title, author: r.author }); return songs.keyOf(p.artist, p.title); };
      for (const r of docs) map.set(keyOf(r), r.value); // la plus récente gagne
    } catch (e) { console.warn('Lecture des notes impossible :', e.message); }
  }
  userNotes.set(uid, { at: Date.now(), map });
  return map;
}
const tsMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : t && t._seconds ? t._seconds * 1000 : 0);

// Un son déjà noté (même via un autre lien, une autre soirée) : on reprend ta note
async function prefill(room, item) {
  if (room.settings.mode !== 'party' || !room.rateable.has(trackKey(item))) return;
  await identifyItem(room, item);
  const k = trackKey(item);
  let changed = false;
  for (const [sid, token] of room.online) {
    const uid = io.sockets.sockets.get(sid)?.data.uid;
    if (!uid) continue;
    const v = (await notesOf(uid)).get(item.songKey);
    if (!v) continue;
    if (!room.ratings.has(k)) room.ratings.set(k, new Map());
    const votes = room.ratings.get(k);
    if (votes.has(token)) continue;
    votes.set(token, v);
    changed = true;
    io.to(sid).emit('mine', myRatings(room, token));
  }
  if (changed) { checkCountdown(room); broadcast(room); }
}

// Sauvegarde dans Firestore : UNE note par personne et par musique. Si ça rate, la soirée continue.
async function saveRating(room, token, item, value, uid) {
  if (!db) return;
  try {
    await identifyItem(room, item);
    const owner = uid || `t:${token}`;
    const ref = db.collection('ratings').doc(sha(`${owner}|${item.songKey}`));
    if (uid) {
      const c = userNotes.get(uid);
      if (c) { if (value === 0) c.map.delete(item.songKey); else c.map.set(item.songKey, value); }
    }
    if (value === 0) {
      // Retirer sa note : aussi les anciennes versions de cette musique
      await ref.delete();
      if (uid) {
        const old = await db.collection('ratings').where('uid', '==', uid).where('songKey', '==', item.songKey).get();
        await Promise.all(old.docs.map((d) => d.ref.delete()));
      }
      return;
    }
    const rel = item.release;
    await ref.set({
      token, uid: uid || null, room: room.code, session: room.session,
      songKey: item.songKey,
      trackKey: trackKey(item), source: item.source, trackId: item.id,
      title: item.song?.title || item.title, author: item.song?.artist || item.author || '',
      artwork: rel?.artwork || item.artwork || null,
      albumKey: rel?.key || null, albumTitle: rel?.title || null,
      albumAuthor: rel?.author || null, albumArtwork: rel?.artwork || null, albumType: rel?.type || null,
      value, updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('Sauvegarde de la note impossible :', e.message); }
}

function publicState(room) {
  const onlineTokens = new Set(room.online.values());
  const members = [...room.people.entries()]
    .filter(([t]) => onlineTokens.has(t))
    .map(([, p]) => p);
  return {
    code: room.code,
    queue: room.queue,
    index: room.index,
    playing: room.playing,
    position: room.position,
    updatedAt: room.updatedAt,
    members,
    stats: ratingStats(room),
    settings: room.settings,
    phase: room.phase,
    rateable: [...room.rateable],
    countdown: room.countdown,
    pending: [...room.pending.values()].map(({ id, name }) => ({ id, name })),
  };
}
const broadcast = (room) => io.to(room.code).emit('state', publicState(room));

function can(room, socket, action) {
  const token = room.online.get(socket.id);
  const me = token && room.people.get(token);
  if (!me) return false;
  if (me.role === 'chef') return true;
  if (action === 'add' && room.settings.mode === 'jukebox') return true; // en Jukebox, tout le monde ajoute
  if (action === 'control') {
    // Réglage "qui contrôle la lecture"
    if (room.settings.control === 'all') return true;
    if (room.settings.control === 'modos') return me.role === 'modo';
    return false;
  }
  if (me.role === 'modo') return action === 'add';
  return false;
}
const personOf = (room, socket) => room && room.people.get(room.online.get(socket.id));

// Métadonnées YouTube sans clé API (oEmbed)
async function fetchMeta(videoId) {
  const artwork = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error();
    const j = await r.json();
    const rawAuthor = String(j.author_name || '');
    // Pas de vrai clip ? (chaînes "Artiste - Topic" de YouTube Music, ou vidéos "audio") → on affiche la pochette
    const audioOnly = /\s-\sTopic$/i.test(rawAuthor) || /official audio|audio officiel|[\(\[]audio[\)\]]|\bvisuali[sz]er\b|lyrics?\s+video|[\(\[]lyrics?[\)\]]|paroles/i.test(j.title || '');
    return {
      source: 'yt', id: videoId, artwork,
      title: clean(j.title, 140),
      author: clean(rawAuthor.replace(/\s*-\s*Topic$/i, ''), 80),
      duration: null,
      visual: audioOnly ? 'cover' : 'video',
    };
  } catch {
    return { source: 'yt', id: videoId, artwork, title: 'Vidéo YouTube', author: '', duration: null, partial: true, visual: 'video' };
  }
}

// Un titre SoundCloud arrive déjà décrit par le navigateur du chef : on nettoie
const SC_URL = /^https:\/\/(soundcloud\.com|api\.soundcloud\.com)\/[^\s"'<>]{1,300}$/;
function scItem(x) {
  if (!x || !SC_URL.test(String(x.id))) return null;
  const d = Number(x.duration);
  return {
    source: 'sc',
    id: String(x.id),
    title: clean(x.title, 140) || 'Titre SoundCloud',
    author: clean(x.author, 80),
    artwork: ART_HOST.test(String(x.artwork)) ? String(x.artwork) : null,
    duration: Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    partial: !x.title,
    visual: 'cover',
  };
}

// Infos d'un album / d'une playlist (titre, artiste, pochette) — sans clé API, via oEmbed
const albumCache = new Map();
async function fetchAlbum(ref) {
  if (!ref) return null;
  let key, url;
  if (ref.source === 'yt' && /^[\w-]{10,64}$/.test(String(ref.list))) {
    key = `yt:list:${ref.list}`;
    url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/playlist?list=' + ref.list)}`;
  } else if (ref.source === 'sc' && SC_URL.test(String(ref.url)) && /\/sets\//.test(ref.url)) {
    key = `sc:set:${ref.url}`;
    url = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`;
  } else return null;
  if (albumCache.has(key)) return albumCache.get(key);
  let album = { key, title: 'Album', author: '', artwork: null };
  try {
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      let title = clean(j.title, 140), author = clean(String(j.author_name || '').replace(/\s*-\s*Topic$/i, ''), 80);
      // SoundCloud renvoie "Titre by Artiste"
      const by = title.match(/^(.*) by (.+)$/);
      if (ref.source === 'sc' && by) { title = by[1]; author = author || by[2]; }
      title = title.replace(/^Album\s*-\s*/i, '');
      album = { key, title: title || 'Album', author, artwork: ART_HOST.test(String(j.thumbnail_url)) ? String(j.thumbnail_url).replace('-large.', '-t500x500.') : null };
    }
  } catch {}
  albumCache.set(key, album);
  return album;
}

// ── Déroulé de la soirée ─────────────────────────────────────

function clearCountdown(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.countdown = null;
}
function startTrack(room, index) {
  clearCountdown(room);
  room.phase = 'play';
  setPlayback(room, { index, position: 0, playing: true });
}
// Titre suivant, ou fin de la file
function advance(room) {
  clearCountdown(room);
  if (room.index < room.queue.length - 1) startTrack(room, room.index + 1);
  else { room.phase = 'end'; setPlayback(room, { playing: false, position: 0 }); }
}
// Le titre en cours est fini (ou passé) : en listening party il devient notable
function finishTrack(room) {
  const item = room.queue[room.index];
  if (!item) return;
  const party = room.settings.mode === 'party';
  if (party) { room.rateable.add(trackKey(item)); prefill(room, item); }
  if (party && !room.settings.continuous) {
    clearCountdown(room);
    room.phase = 'break';
    setPlayback(room, { playing: false, position: 0 });
    checkCountdown(room);
  } else advance(room);
}
function armTimer(room, ms) {
  if (room.timer) clearTimeout(room.timer);
  const index = room.index;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.phase === 'break' && room.index === index) { advance(room); broadcast(room); }
  }, ms);
}
// Pendant la pause : dès que tous ceux présents ont noté, décompte puis on enchaîne
function checkCountdown(room) {
  if (room.phase !== 'break') return;
  const item = room.queue[room.index];
  if (!item) return;
  const votes = room.ratings.get(trackKey(item));
  const online = new Set(room.online.values());
  const allRated = online.size > 0 && [...online].every((t) => votes && votes.has(t));
  const secs = room.settings.countdown;
  if (!secs) return; // décompte désactivé : le chef lance la suite lui-même
  if (allRated && !room.countdown) {
    room.countdown = { endsAt: Date.now() + secs * 1000, total: secs * 1000 };
    armTimer(room, secs * 1000);
  } else if (!allRated && room.countdown && !room.countdown.paused) {
    clearCountdown(room);
  }
}

function admit(room, token, p, ok) {
  room.pending.delete(token);
  if (ok) room.admitted.add(token);
  io.to(p.sid).emit(ok ? 'admitted' : 'denied');
}

// ── Temps réel ───────────────────────────────────────────────
io.on('connection', (socket) => {
  let room = null;

  // Synchro d'horloge : le client mesure le décalage entre son heure et celle du serveur
  socket.on('time:ping', (_, ack) => typeof ack === 'function' && ack(Date.now()));

  socket.on('room:create', ({ token, settings } = {}, ack) => {
    if (typeof ack !== 'function' || !token) return;
    const r = createRoom(clean(token, 64), settings);
    ack({ code: r.code });
  });

  socket.on('room:join', ({ code, name, token } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(clean(code, 5).toUpperCase());
    if (!r) return ack({ error: "Cette salle n'existe pas (ou plus)." });
    token = clean(token, 64);
    name = clean(name, 24) || 'Anonyme';
    if (!token) return ack({ error: 'Session invalide.' });

    let person = r.people.get(token);
    const isHost = token === r.hostToken;
    if (person && person.kicked) return ack({ error: 'Le chef t’a retiré de cette salle.' });
    // Salle pleine ?
    const onlineTokens = new Set(r.online.values());
    if (!isHost && !onlineTokens.has(token) && r.settings.maxPeople && onlineTokens.size >= r.settings.maxPeople) {
      return ack({ error: `La salle est pleine (${r.settings.maxPeople} personnes max).` });
    }
    // Salle sur invitation : les nouveaux attendent l'accord du chef
    if (!person && !isHost && r.settings.private && !r.admitted.has(token)) {
      const prev = r.pending.get(token);
      r.pending.set(token, { id: prev ? prev.id : shortId(), name, sid: socket.id });
      socket.data.pendingRoom = r.code;
      socket.data.pendingToken = token;
      ack({ pending: true });
      broadcast(r);
      return;
    }
    if (!person) {
      person = { id: shortId(), name, role: token === r.hostToken ? 'chef' : 'auditeur' };
      r.people.set(token, person);
    } else if (!person.uid) {
      person.name = name; // un compte connecté garde son pseudo de compte
    }
    person.issue = null;

    room = r;
    r.online.set(socket.id, token);
    r.emptySince = null;
    socket.join(r.code);
    ack({ you: person.id, state: publicState(r), mine: myRatings(r, token) });
    broadcast(r);
  });

  // Aperçu avant d'entrer : nom, album, qui est là (rien de privé)
  socket.on('room:peek', ({ code } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const r = rooms.get(clean(code, 5).toUpperCase());
    if (!r) return ack({ error: "Cette salle n'existe pas (ou plus)." });
    const st = publicState(r);
    const chef = st.members.find((m) => m.role === 'chef') || r.people.get(r.hostToken);
    ack({
      name: r.settings.name || (chef ? `Salle de ${chef.name}` : 'Salle'),
      album: r.settings.mode === 'party' ? r.settings.album : null,
      mode: r.settings.mode,
      private: r.settings.private,
      maxPeople: r.settings.maxPeople,
      count: st.members.length,
      members: st.members.slice(0, 6).map((m) => ({ name: m.name, avatar: m.avatar || null })),
    });
  });

  // L'overlay OBS regarde sans être membre
  socket.on('room:watch', ({ code } = {}, ack) => {
    const r = rooms.get(clean(code, 5).toUpperCase());
    if (!r) return typeof ack === 'function' && ack({ error: 'Salle introuvable' });
    socket.join(r.code);
    if (typeof ack === 'function') ack({ state: publicState(r) });
  });

  // ── Contrôles de lecture (chef + modos) ──
  const control = (fn) => (data = {}) => {
    if (!room || !can(room, socket, 'control')) return;
    fn(data);
    broadcast(room);
  };

  socket.on('player:play', control(() => {
    if (!room.queue.length) return;
    if (room.phase === 'play') setPlayback(room, { playing: true });
    else if (room.index < room.queue.length - 1) advance(room); // pendant la pause : "lecture" = on lance la suite
  }));
  socket.on('player:pause', control(() => { if (room.phase === 'play') setPlayback(room, { playing: false }); }));
  socket.on('player:seek', control(({ position }) => {
    const p = Number(position);
    if (!Number.isFinite(p) || room.phase !== 'play') return;
    setPlayback(room, { position: p });
  }));
  socket.on('player:jump', control(({ index }) => {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= room.queue.length) return;
    startTrack(room, i);
  }));
  // "Suivant" : pendant l'écoute = passer le titre (en listening party, il devient notable)
  //             pendant la pause = lancer le titre suivant
  socket.on('player:next', control(() => {
    if (!room.queue.length) return;
    if (room.phase === 'play') finishTrack(room);
    else advance(room);
  }));
  socket.on('player:prev', control(() => {
    if (room.phase !== 'play') return startTrack(room, room.index); // réécouter le titre qu'on vient de finir
    // Comme sur Spotify : si on est à plus de 3 s, on revient au début du morceau
    if (currentPosition(room) > 3 || room.index === 0) setPlayback(room, { position: 0 });
    else startTrack(room, room.index - 1);
  }));
  // Mettre en pause / relancer le décompte de fin de pause (pour discuter)
  socket.on('break:hold', control(() => {
    const c = room.countdown;
    if (room.phase !== 'break' || !c) return;
    if (c.paused) { room.countdown = { endsAt: Date.now() + c.remaining, total: c.total }; armTimer(room, c.remaining); }
    else {
      if (room.timer) clearTimeout(room.timer);
      room.timer = null;
      room.countdown = { paused: true, remaining: Math.max(1000, c.endsAt - Date.now()), total: c.total };
    }
  }));

  // Fin de morceau : n'importe quel client peut le signaler, on n'avance qu'une fois
  socket.on('track:ended', ({ index } = {}) => {
    if (!room || index !== room.index || !room.playing || room.phase !== 'play') return;
    const item = room.queue[room.index];
    if (item?.duration && currentPosition(room) < item.duration - 4) return; // signal trop tôt (pub, bug)
    if (!item?.duration && currentPosition(room) < 5) return;
    finishTrack(room);
    broadcast(room);
  });

  // ── Réglages de la salle (chef) ──
  socket.on('settings:set', (data = {}) => {
    if (!room || !can(room, socket, 'manage')) return;
    const before = room.settings;
    room.settings = cleanSettings(data, before);
    // Salle repassée en publique : tous ceux qui attendaient entrent
    if (before.private && !room.settings.private) for (const [t, p] of room.pending) admit(room, t, p, true);
    if (before.countdown !== room.settings.countdown && room.countdown) { clearCountdown(room); checkCountdown(room); }
    // Si on était en pause de notation et qu'elle n'a plus lieu d'être : on enchaîne
    if (room.phase === 'break' && (room.settings.mode === 'jukebox' || room.settings.continuous)) advance(room);
    broadcast(room);
  });

  // Infos découvertes pendant la lecture (durée, titre d'un morceau d'album SoundCloud…)
  socket.on('track:meta', ({ index, duration, title, author, artwork } = {}) => {
    const item = room?.queue[index];
    if (!item) return;
    let changed = false;
    const d = Number(duration);
    if (!item.duration && Number.isFinite(d) && d > 0) { item.duration = Math.round(d); changed = true; }
    if (item.partial && title) {
      item.title = clean(title, 140);
      item.author = clean(author, 80) || item.author;
      if (ART_HOST.test(String(artwork))) item.artwork = String(artwork);
      item.partial = false;
      changed = true;
    }
    if (changed) broadcast(room);
  });

  // Un membre signale qu'il n'arrive pas à lire (YouTube bloqué, son bloqué…)
  socket.on('member:issue', ({ issue } = {}) => {
    const person = room && room.people.get(room.online.get(socket.id));
    if (!person) return;
    const v = ['blocked', 'autoplay'].includes(issue) ? issue : null;
    if (person.issue === v) return;
    person.issue = v;
    broadcast(room);
  });

  // ── File d'attente ──
  // Listening party : chef (et modos) ajoutent. Jukebox : tout le monde.
  socket.on('queue:add', async ({ items } = {}, ack) => {
    const done = (x) => typeof ack === 'function' && ack(x);
    if (!room || !can(room, socket, 'add')) return done({ error: 'Seul le chef peut ajouter des titres ici.' });
    const r = room;
    const me = personOf(r, socket);
    let list = (Array.isArray(items) ? items : []).slice(0, 200);
    // En Jukebox, chacun a au plus 10 titres en attente (sinon une seule personne prend toute la soirée)
    if (r.settings.mode === 'jukebox' && me.role !== 'chef') {
      const waiting = r.queue.filter((q, i) => i > r.index && q.addedBy?.id === me.id).length;
      list = list.slice(0, Math.max(0, 10 - waiting));
      if (!list.length) return done({ error: 'Tu as déjà 10 titres en attente, laisse les autres jouer 😉' });
    }
    // Infos des albums (une seule requête par album)
    const refs = new Map();
    for (const x of list) if (x?.album) refs.set(JSON.stringify(x.album), x.album);
    const albums = new Map();
    await Promise.all([...refs].map(async ([k, ref]) => albums.set(k, await fetchAlbum(ref))));
    const built = await Promise.all(list.map(async (x) => {
      let it = null;
      if (x?.source === 'yt' && /^[\w-]{11}$/.test(x.id)) it = await fetchMeta(x.id);
      else if (x?.source === 'sc') it = scItem(x);
      if (!it) return null;
      const album = x.album ? albums.get(JSON.stringify(x.album)) : null;
      if (album) {
        it.album = album;
        if (!album.artwork && it.source === 'sc' && it.artwork) album.artwork = it.artwork;
      }
      it.addedBy = { id: me.id, name: me.name };
      return it;
    }));
    const added = built.filter(Boolean);
    if (!added.length) return done({ error: 'Aucun lien valide.' });
    const wasEmpty = r.queue.length === 0;
    const wasOver = r.phase === 'end';
    r.queue.push(...added);
    // En fond : on reconnaît chaque musique (titre propre, album) puis on prévient tout le monde
    Promise.all(added.map((it) => identifyItem(r, it))).then(() => broadcast(r)).catch(() => {});
    if (wasEmpty) { r.phase = 'play'; setPlayback(r, { index: 0, position: 0, playing: false }); }
    else if (wasOver && r.settings.mode === 'jukebox') advance(r); // la file était finie : ça repart tout seul
    done({ added: added.length });
    broadcast(r);
  });
  socket.on('queue:remove', ({ index } = {}) => {
    if (!room) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= room.queue.length) return;
    const me = personOf(room, socket);
    const mine = me && room.queue[i].addedBy?.id === me.id && i > room.index; // on peut retirer ses propres titres à venir
    if (!can(room, socket, 'manage') && !mine) return;
    room.queue.splice(i, 1);
    if (i < room.index) room.index--;
    else if (i === room.index) {
      clearCountdown(room);
      room.phase = 'play';
      if (room.index >= room.queue.length) setPlayback(room, { index: Math.max(0, room.queue.length - 1), position: 0, playing: false });
      else setPlayback(room, { position: 0 });
    }
    if (!room.queue.length) { room.phase = 'play'; setPlayback(room, { index: 0, position: 0, playing: false }); }
    broadcast(room);
  });
  socket.on('queue:clear', () => {
    if (!room || !can(room, socket, 'manage')) return;
    clearCountdown(room);
    room.phase = 'play';
    room.queue = [];
    setPlayback(room, { index: 0, position: 0, playing: false });
    broadcast(room);
  });

  // ── Salle sur invitation : le chef accepte / refuse ──
  socket.on('member:admit', ({ id, ok } = {}) => {
    if (!room || !can(room, socket, 'manage')) return;
    const found = [...room.pending.entries()].find(([, p]) => p.id === id);
    if (found) admit(room, found[0], found[1], !!ok);
    broadcast(room);
  });

  // ── Gestion des membres (chef) ──
  const findByID = (id) => [...room.people.entries()].find(([, p]) => p.id === id);
  socket.on('member:role', ({ id, role } = {}) => {
    if (!room || !can(room, socket, 'manage') || !['modo', 'auditeur'].includes(role)) return;
    const found = findByID(id);
    if (!found || found[1].role === 'chef') return;
    found[1].role = role;
    broadcast(room);
  });
  socket.on('member:kick', ({ id } = {}) => {
    if (!room || !can(room, socket, 'manage')) return;
    const found = findByID(id);
    if (!found || found[1].role === 'chef') return;
    const [token, person] = found;
    person.kicked = true;
    for (const [sid, t] of room.online) {
      if (t === token) {
        io.to(sid).emit('kicked');
        io.sockets.sockets.get(sid)?.leave(room.code);
        room.online.delete(sid);
      }
    }
    broadcast(room);
  });

  // ── Réactions ──
  const lastReact = { t: 0 };
  socket.on('react', ({ emoji } = {}) => {
    if (!room || !room.online.has(socket.id)) return;
    if (!['🔥', '❤️', '😮', '🎧'].includes(emoji)) return;
    if (Date.now() - lastReact.t < 400) return; // anti-spam
    lastReact.t = Date.now();
    const person = room.people.get(room.online.get(socket.id));
    io.to(room.code).emit('react', { emoji, name: person?.name });
  });

  // ── Notes (tout le monde peut noter, de 1 à 5 ; 0 = retirer sa note) ──
  const lastRate = { t: 0 };
  socket.on('rating:set', ({ index, value } = {}) => {
    if (!room || !room.online.has(socket.id)) return;
    const item = room.queue[Number(index)];
    const v = Number(value);
    if (!item || !Number.isInteger(v * 2) || v < 0 || v > 5) return; // demi-étoiles : 0,5 / 1 / 1,5 … 5
    if (room.settings.mode !== 'party' || !room.rateable.has(trackKey(item))) return; // pas de note avant d'avoir écouté
    if (Date.now() - lastRate.t < 250) return; // anti-spam
    lastRate.t = Date.now();
    const token = room.online.get(socket.id);
    const k = trackKey(item);
    if (!room.ratings.has(k)) room.ratings.set(k, new Map());
    if (v === 0) room.ratings.get(k).delete(token); else room.ratings.get(k).set(token, v);
    socket.emit('mine', myRatings(room, token));
    checkCountdown(room);
    broadcast(room);
    saveRating(room, token, item, v, socket.data.uid);
  });

  // ── Compte : rattacher ce navigateur (invité) à un compte Google ──
  // Le serveur vérifie lui-même que le jeton vient bien de Google : on ne fait jamais confiance au navigateur.
  socket.on('account:link', async ({ idToken } = {}, ack) => {
    const done = (x) => typeof ack === 'function' && ack(x);
    const token = room && room.online.get(socket.id);
    if (!token || !db) return done({ error: 'indisponible' });
    try {
      const decoded = await getAuth().verifyIdToken(String(idToken || ''));
      const { uid } = decoded;
      socket.data.uid = uid;
      const userRef = db.collection('users').doc(uid);
      const existing = (await userRef.get()).data() || {};
      await userRef.set({
        tokens: FieldValue.arrayUnion(token),
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.name ? {} : { name: clean(decoded.name || 'Anonyme', 24) }),
        ...(decoded.picture ? { googlePhoto: decoded.picture } : {}),
        ...(existing.createdAt ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
      // Dans la salle, on affiche le pseudo et la photo du compte
      const who = await roomIdentity(db, uid);
      const person = room && room.people.get(token);
      if (person && who) {
        person.uid = uid;
        person.name = who.name;
        person.avatar = who.avatar;
        person.color = who.color || null;
        broadcast(room);
      }
      // Les notes déjà données en invité (sans propriétaire) deviennent celles du compte
      const snap = await db.collection('ratings').where('token', '==', token).get();
      const free = snap.docs.filter((d) => !d.data().uid);
      for (let i = 0; i < free.length; i += 400) {
        const batch = db.batch();
        free.slice(i, i + 400).forEach((d) => batch.update(d.ref, { uid }));
        await batch.commit();
      }
      done({ ok: true, linked: free.length });
      userNotes.delete(uid);
      if (room) for (const it of room.queue) if (room.rateable.has(trackKey(it))) await prefill(room, it);
    } catch (e) {
      console.warn('Liaison du compte impossible :', e.message);
      done({ error: 'Connexion au compte impossible' });
    }
  });
  socket.on('account:out', () => {
    socket.data.uid = null;
    const person = personOf(room, socket);
    if (person) { delete person.uid; delete person.avatar; delete person.color; broadcast(room); }
  });
  // Après une modif de profil (pseudo / photo) : mettre à jour la salle
  socket.on('account:refresh', async () => {
    const person = personOf(room, socket);
    if (!person || !socket.data.uid) return;
    const who = await roomIdentity(db, socket.data.uid);
    if (who) { person.name = who.name; person.avatar = who.avatar; person.color = who.color || null; broadcast(room); }
  });

  socket.on('disconnect', () => {
    const pr = socket.data.pendingRoom && rooms.get(socket.data.pendingRoom);
    if (pr && pr.pending.get(socket.data.pendingToken)?.sid === socket.id) { pr.pending.delete(socket.data.pendingToken); broadcast(pr); }
    if (!room) return;
    room.online.delete(socket.id);
    if (room.online.size === 0) room.emptySince = Date.now();
    checkCountdown(room);
    broadcast(room);
  });
});

// Ménage : une salle vide depuis 2 h est supprimée
setInterval(() => {
  for (const [code, r] of rooms) {
    if (r.emptySince && Date.now() - r.emptySince > 2 * 60 * 60 * 1000) { clearCountdown(r); rooms.delete(code); }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Ballroom tourne sur http://localhost:${PORT}`));
