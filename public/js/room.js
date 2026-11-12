// ─────────────────────────────────────────────────────────────
//  Page salle : affiche l'état envoyé par le serveur et garde
//  le lecteur (YouTube ou SoundCloud) calé sur la position officielle.
// ─────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const CODE = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
const socket = io({ autoConnect: false });

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';

let state = null;        // état reçu du serveur
let meId = null;         // mon id public
let joined = false;
let loadedKey = null;    // "yt:abc" / "sc:url" du titre chargé
let active = null;       // lecteur actif (YTP ou SCP)
let lastSeekAt = 0;      // évite de corriger en boucle juste après un saut
let seekLead = 0.15;     // petite avance pour compenser le temps de chargement après un saut
let playTries = 0;       // tentatives de lancement automatique sur ce titre
let lastPlayTry = 0;
let loadAt = 0;
let needsGesture = false; // le navigateur exige un clic sur le lecteur avant de jouer du son
let blockedKey = null;   // titre que ce navigateur n'arrive pas à lire
let myIssue = null;
let lastColor = null;
let mine = {};           // mes notes : { "yt:abc": 4, ... }
let syncOffset = Math.max(-0.5, Math.min(0.5, parseFloat(store.get('ballroom:offset')) || 0)); // décalage perso (s)
let forceSync = false;   // recalage immédiat demandé (après un changement de décalage)
let trayIndex = null;    // titre affiché dans la carte "note ce titre"
const dismissed = new Set(); // titres qu'on a choisi de noter plus tard

const miniBall = createBall($('#mini-ball'), { rows: 8, cols: 14, speed: 0.9, glints: false });
const gateBall = createBall($('#gate-ball'), { rows: 16, cols: 32, speed: 0.3 });
miniBall.spin(false);

// ══════════════ Lecteurs ══════════════
let ytLoaded = false, scLoaded = false;
window.onYouTubeIframeAPIReady = () => { if (!ytLoaded) { ytLoaded = true; YTP.init(); } };
if (window.YT && YT.loaded) window.onYouTubeIframeAPIReady();
if (window.SC && SC.Widget) { scLoaded = true; SCP.init(); }

playerEvents.ready = () => sync();
playerEvents.playing = ({ duration }) => {
  if (needsGesture) { setGesture(false); lastSeekAt = 0; }
  setIssue(null);
  const item = current();
  if (item && !item.duration && duration > 0) socket.emit('track:meta', { index: state.index, duration });
};
playerEvents.meta = (m) => {
  const item = current();
  if (item && (item.partial || !item.duration)) socket.emit('track:meta', { index: state.index, ...m });
};
playerEvents.ended = () => { if (state?.playing) socket.emit('track:ended', { index: state.index }); };
playerEvents.error = ({ source, code }) => {
  if (source === 'yt' && code === 100) {
    // Vidéo supprimée : c'est pareil pour tout le monde, le chef/modo passe à la suite
    toast('Vidéo supprimée');
    if (canControl()) setTimeout(() => socket.emit('player:next'), 1200);
    return;
  }
  // Sinon on NE saute PAS le titre : le problème vient souvent de ce navigateur seulement
  blockedKey = loadedKey;
  setIssue('blocked');
  renderBlocked();
};

const current = () => state && state.queue[state.index];
const keyOf = (item) => item && `${item.source}:${item.id}`;
const me = () => state?.members.find((m) => m.id === meId);
const canControl = () => ['chef', 'modo'].includes(me()?.role);
const isChef = () => me()?.role === 'chef';
const isParty = () => state?.settings?.mode !== 'jukebox';
const canAdd = () => isChef() || me()?.role === 'modo' || (state?.settings?.mode === 'jukebox' && !!me());
const isRateable = (item) => isParty() && !!item && (state.rateable || []).includes(keyOf(item));

function setIssue(issue) {
  if (issue === myIssue) return;
  myIssue = issue;
  if (joined) socket.emit('member:issue', { issue });
}

function duration() {
  const item = current();
  if (item?.duration) return item.duration;
  if (active && loadedKey === keyOf(item)) return active.duration() || 0;
  return 0;
}

// Le cœur de la synchro : on compare le lecteur à la position officielle.
// Règle d'or : si le lecteur ne joue pas, on ne le "recharge" jamais en boucle.
// On essaie 2 fois de lancer le son, puis on demande un clic à la personne.
function sync() {
  if (!joined || !state) return;
  const item = current();

  if (!item) {
    if (active) { active.stop(); active = null; loadedKey = null; }
    showLayer(null);
    setGesture(false);
    return;
  }

  const be = BACKENDS[item.source];
  if (!be || !be.ready) return;
  // Position visée par MON lecteur = position de la salle + mon décalage perso (Bluetooth…)
  const target = Math.max(0, targetPosition(state) + (state.playing ? syncOffset : 0));

  // Nouveau titre (ou changement de plateforme)
  if (keyOf(item) !== loadedKey) {
    if (active && active !== be) active.stop();
    active = be;
    loadedKey = keyOf(item);
    blockedKey = null;
    playTries = 0;
    loadAt = Date.now();
    setIssue(null);
    renderBlocked();
    showLayer(item.source);
    be.load(item, target, state.playing);
    lastSeekAt = Date.now();
    lastPlayTry = Date.now();
    return;
  }
  if (blockedKey === loadedKey) return;

  be.poll();
  const st = be.status();

  if (state.playing) {
    if (st === 'playing') {
      if (needsGesture) { setGesture(false); lastSeekAt = 0; } // la personne a lancé : on se recale tout de suite
      playTries = 0;
      correctDrift(be, target);
      return;
    }
    if (st === 'ended' && target >= (be.duration() || 0) - 1.5) return; // on attend le titre suivant
    if (st === 'buffering' && Date.now() - loadAt < 8000) return;      // ça charge, on laisse faire
    if (needsGesture) return;                                            // on attend le clic, on ne touche à rien
    if (Date.now() - lastPlayTry < 1500) return;
    if (playTries >= 2) { setGesture(true); return; }
    playTries++;
    lastPlayTry = Date.now();
    be.play();
  } else {
    setGesture(false);
    playTries = 0;
    if (st === 'playing' || st === 'buffering') be.pause();
    const pausedAt = Math.max(0, state.position + syncOffset);
    if (Math.abs(be.time() - pausedAt) > 0.5 && Date.now() - lastSeekAt > 1000) {
      be.seek(pausedAt);
      lastSeekAt = Date.now();
    }
  }
}

let learnNext = false;   // le prochain écart mesuré sert à calibrer le temps de chargement après un saut
function correctDrift(be, target) {
  if (!forceSync && Date.now() - lastSeekAt < 2500) return;
  const drift = be.time() - target; // >0 : en avance, <0 : en retard
  // On apprend uniquement de l'écart juste après NOTRE saut : c'est lui qui dit si on a visé trop tôt ou trop tard
  if (learnNext && Date.now() - lastSeekAt >= 2000) {
    seekLead = Math.max(0, Math.min(1, seekLead + Math.max(-0.3, Math.min(0.3, -drift * 0.7))));
    learnNext = false;
  }
  const limit = forceSync ? 0.05 : 0.3; // après un réglage du décalage, on se recale même pour un petit écart
  forceSync = false;
  if (Math.abs(drift) > limit) {
    be.seek(target + seekLead);
    lastSeekAt = Date.now();
    learnNext = true;
  }
}

function showLayer(source) {
  $('#yt-layer').classList.toggle('hidden', source !== 'yt');
  $('#sc-layer').classList.toggle('hidden', source !== 'sc');
}

// Le navigateur bloque le son tant qu'on n'a pas cliqué DANS le lecteur (Safari, iPhone…).
// On enlève alors la protection anti-clic pour que le clic atteigne le bouton ▶ du lecteur.
function setGesture(on) {
  if (needsGesture === on) return;
  needsGesture = on;
  $('#tap-sync').classList.toggle('hidden', !on);
  $('#shield').classList.toggle('hidden', on);
  renderCover();
  setIssue(on ? 'autoplay' : null);
}
$('#tap-play').addEventListener('click', () => { if (active) active.play(); });

function renderBlocked() {
  const item = current();
  const on = !!blockedKey && blockedKey === keyOf(item);
  $('#blocked').classList.toggle('hidden', !on);
  if (!on) return;
  const sc = item.source === 'sc';
  $('#blocked strong').textContent = sc ? 'Titre indisponible' : 'YouTube bloque la lecture';
  $('#blocked-text').textContent = sc ? 'Privé ou retiré.' : 'Coupe ton VPN ou ton bloqueur, ou connecte-toi à YouTube.';
  $('#blocked .btn.ghost').classList.toggle('hidden', sc);
}
$('#retry-btn').addEventListener('click', () => { blockedKey = null; loadedKey = null; renderBlocked(); sync(); });

setInterval(sync, 1000);

// Panneau de diagnostic : ajoute ?debug à l'adresse de la salle
if (new URLSearchParams(location.search).has('debug')) {
  const box = document.createElement('pre');
  box.className = 'debug';
  document.body.appendChild(box);
  setInterval(() => {
    const item = current();
    const t = state ? targetPosition(state) : 0;
    const lt = active ? active.time() : 0;
    box.textContent = [
      `salle   : ${state?.playing ? 'lecture' : 'pause'} ${fmt(t)} (${t.toFixed(1)}s)`,
      `lecteur : ${item?.source || '-'} ${active ? active.status() : '-'} ${lt.toFixed(1)}s`,
      `écart   : ${active ? (lt - t).toFixed(2) : '-'}s · avance ${seekLead.toFixed(2)}s`,
      `essais  : ${playTries} · clic requis : ${needsGesture ? 'oui' : 'non'}`,
      `horloge : ${clock.offset}ms`,
    ].join('\n');
  }, 300);
}

// ══════════════ Connexion à la salle ══════════════
// Connecté avec un compte → on entre directement (pas de pseudo à retaper).
// Invité → on demande juste un pseudo. Salle sur invitation → on attend l'accord du chef.
$('#gate-name').value = store.get('ballroom:name') || '';
$('#gate-room').textContent = CODE;

// Aperçu de la salle (nom, album, qui est là) avant d'entrer
let peekedAt = 0, roomMissing = false;
function renderPeek(p) {
  $('#gate-room').textContent = p.name;
  $('#gate-album').innerHTML = p.album ? `${esc(p.album.title)} <span>· ${esc(p.album.artist)}</span>` : (p.mode === 'jukebox' ? 'Jukebox' : '');
  if (p.album && p.album.artwork) {
    $('#gate-art').innerHTML = `<img src="${esc(p.album.artwork)}" alt="">`;
    gateBall.stop();
  }
  const faces = p.members.map((m) => avatarHTML(m)).join('');
  const more = p.count > p.members.length ? `<span class="avatar">+${p.count - p.members.length}</span>` : '';
  $('#gate-people').innerHTML = p.count
    ? `<span class="faces">${faces}${more}</span><span>${p.maxPeople ? `${p.count}/${p.maxPeople}` : p.count} ${p.count > 1 ? 'personnes' : 'personne'}</span>`
    : '<span>Personne pour l’instant</span>';
}
(async function peek() {
  const s2 = io({ forceNew: true });
  s2.emit('room:peek', { code: CODE }, (p) => {
    s2.disconnect();
    peekedAt = Date.now();
    if (p.error) { roomMissing = true; return gateError(p.error); }
    renderPeek(p);
    decideEntry();
  });
})();
const account = () => window.ballroomAccount && window.ballroomAccount.profile;
let joining = false;

function gateView(view, text = '') {
  $('#gate').classList.toggle('hidden', view === 'in');
  $('#gate-guest').classList.toggle('hidden', view !== 'guest');
  $('#gate-wait').classList.toggle('hidden', view !== 'wait');
  $('#gate-wait').textContent = text;
  $('#gate-home').classList.toggle('hidden', view !== 'error');
  if (view !== 'error') $('#gate-error').textContent = '';
  if (view === 'guest') setTimeout(() => $('#gate-name').focus(), 50);
}
function gateError(msg, allowGuest = false) {
  gateView(allowGuest && !account() ? 'guest' : 'error');
  $('#gate-error').textContent = msg;
  $('#gate-btn').disabled = false;
}

function join(name) {
  if (joining || joined) return;
  joining = true;
  store.set('ballroom:name', name);
  gateView('wait', '');
  // On laisse l'aperçu visible un instant avant d'entrer (le temps de voir où on arrive)
  const delay = Math.max(0, 1100 - (Date.now() - peekedAt));
  setTimeout(() => { if (socket.connected) emitJoin(); else socket.connect(); }, delay);
}
// Dès qu'on sait si la personne est connectée : entrée directe ou formulaire invité
function decideEntry() {
  if (joined || joining || !peekedAt || !window.ballroomAccount || !window.ballroomAccount.ready) return;
  if (roomMissing) return;
  if (account()) join(account().name);
  else gateView('guest');
}

$('#gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#gate-name').value.trim();
  if (!name) { $('#gate-name').focus(); $('#gate-error').textContent = 'Un pseudo d’abord'; return; }
  join(name);
});

function emitJoin() {
  socket.emit('room:join', { code: CODE, name: store.get('ballroom:name'), token: getToken() }, (res) => {
    joining = false;
    if (res.pending) {
      joining = true; // on reste en attente
      gateView('wait', 'En attente du chef…');
      return;
    }
    if (res.error) {
      socket.disconnect();
      return gateError(res.error);
    }
    joined = true;
    meId = res.you;
    myIssue = null;
    mine = res.mine || {};
    linkAccount();
    gateView('in');
    gateBall.stop();
    onState(res.state);
    if (new URLSearchParams(location.search).get('new')) {
      history.replaceState(null, '', `/r/${CODE}`);
      if (!isNarrow() && !document.body.classList.contains('queue-hidden')) $('#add-input').focus();
    }
  });
}
socket.on('connect', async () => {
  await clock.sync(socket);
  if (joined || joining) { joined = false; joining = true; emitJoin(); } // reconnexion après une coupure
});
socket.on('admitted', () => { joining = true; emitJoin(); });
socket.on('denied', () => { joining = false; socket.disconnect(); gateError('Demande refusée.'); });

setInterval(() => socket.connected && clock.sync(socket, 3), 30000);

socket.on('state', onState);
socket.on('mine', (m) => { mine = m || {}; render(); });
socket.on('kicked', () => {
  joined = false;
  socket.disconnect();
  if (active) active.stop();
  gateError('Tu as été retiré de la salle.');
});

let lastPending = 0;
function onState(s) {
  // Nouvelle demande d'entrée : on prévient le chef
  const pc = (s.pending || []).length;
  if (pc > lastPending && joined && s.members.find((m) => m.id === meId)?.role === 'chef') toast(`${s.pending[pc - 1].name} veut entrer`);
  lastPending = pc;
  s.settings = s.settings || { mode: 'party', continuous: false };
  // La salle vient de (re)démarrer : on tente de lancer le son tout de suite, sans attendre
  if (s.playing && (!state || !state.playing || s.index !== state.index)) { lastPlayTry = 0; playTries = 0; }
  state = s;
  render();
  sync();
}

// ══════════════ Affichage ══════════════
function render() {
  if (!state) return;
  const item = current();
  const control = canControl();
  const phase = state.phase || 'play';
  const party = isParty();

  $('#code').textContent = CODE;
  $('#banner-code').textContent = CODE;
  $('#banner-url').textContent = location.host;

  const empty = $('#empty');
  empty.classList.toggle('hidden', !!item);
  const plan = party ? state.settings.album : null;
  $('#empty-text').innerHTML = canAdd()
    ? (plan ? `Colle le lien de <b>${esc(plan.title)}</b>` : party ? 'Colle le lien d’un album' : 'Ajoute un son')
    : (party ? 'Le chef prépare l’album' : 'En attente du premier son');
  // Raccourcis pour trouver le lien de l'album prévu
  const q = plan ? encodeURIComponent(`${plan.title} ${plan.artist}`) : '';
  $('#empty-links').classList.toggle('hidden', !canAdd());
  $('#empty-links').innerHTML = `<button type="button" class="empty-add" id="empty-add">+ Ajouter</button>` + (plan ? `
    <a href="https://music.youtube.com/search?q=${q}" target="_blank" rel="noopener">YouTube Music ↗</a>
    <a href="https://soundcloud.com/search/albums?q=${q}" target="_blank" rel="noopener">SoundCloud ↗</a>` : '');

  // Titre affiché : en fin d'écoute, l'album ; sinon le titre en cours
  const album = item?.album;
  const label = $('#now-label');
  label.classList.toggle('hidden', phase === 'play' || !item);
  label.textContent = phase === 'break' ? 'Fin du titre' : phase === 'end' ? (party ? 'Fin' : 'Fin') : '';
  $('#title').textContent = !item ? '' : phase === 'end' && album && party ? album.title : item.title;
  $('#author').textContent = !item ? '' : phase === 'end' && album && party ? album.author : item.author;
  document.title = item ? `${item.title} · Ballroom` : 'Ballroom';
  miniBall.spin(!!item && state.playing);

  // Couleur d'accent = pochette (elle se reflète aussi dans la boule)
  const artUrl = art(item);
  if (artUrl !== lastColor) {
    lastColor = artUrl;
    coverColor(artUrl).then((c) => {
      document.documentElement.style.setProperty('--accent', c || '#e9e6df');
      miniBall.refreshColor();
    });
  }

  const listening = phase === 'play';
  $('#controls').classList.toggle('hidden', !control || !item || !listening);
  $('#play').innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
  $('#progress').classList.toggle('can-seek', control);
  $('#progress').classList.toggle('hidden', !item || !listening);
  const chef = state.members.find((m) => m.role === 'chef');
  const hint = $('#listener-hint');
  hint.classList.toggle('hidden', control || !item || !listening);
  hint.textContent = chef ? `${chef.name} aux commandes` : '';

  $('#add-form').classList.toggle('hidden', !canAdd());
  $('#add-input').placeholder = party ? 'Lien d’album, playlist ou titre' : 'Ajoute un son (SoundCloud, YouTube)';
  $('#reactions').classList.toggle('hidden', !item || !joined);
  $('#queue').classList.toggle('is-playing', !!state.playing);
  $('#clear-btn').classList.toggle('hidden', !isChef() || !state.queue.length);
  $('.queue').classList.toggle('hidden', !state.queue.length && !canAdd());
  renderTopbar();

  // Phase sur <body> : la mise en page réserve plus de place au panneau de notes / au récap
  document.body.classList.toggle('phase-break', phase === 'break' && party);
  document.body.classList.toggle('phase-end', phase === 'end' && party && !!item);

  // Ensuite : le prochain titre
  const next = phase !== 'end' ? state.queue[state.index + 1] : null;
  upNext = next;
  $('#up-next-title').textContent = next ? `${next.title}${next.author ? ' · ' + next.author : ''}` : '';
  paintUpNext();
  const upcoming = Math.max(0, state.queue.length - state.index - (phase === 'end' ? 1 : 1));
  $('#q-count').textContent = state.queue.length ? upcoming : '';
  $('#queue-btn-count').textContent = state.queue.length ? upcoming : '';

  renderBlocked();
  renderCover();
  renderQueue();
  renderMembers();
  renderRating();
  renderRecap();
  renderTray();
  renderAccount();
}

// Pochette carrée à la place de la vidéo quand il n'y a pas de clip (et pendant les pauses)
const coverFallbacks = (item) => item.source === 'yt'
  ? [`https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${item.id}/sddefault.jpg|lb`, `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg|lb`, `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`]
  : [item.artwork || item.album?.artwork].filter(Boolean);
let coverFor = null;
function renderCover() {
  const item = current();
  const img = $('#cover');
  const phase = state?.phase || 'play';
  const wantCover = !!item && ((item.visual || (item.source === 'sc' ? 'cover' : 'video')) === 'cover' || phase !== 'play');
  const urls = item ? coverFallbacks(item) : [];
  const show = wantCover && urls.length > 0 && !needsGesture;
  $('#screen').classList.toggle('square', show);
  img.classList.toggle('hidden', !show);
  if (!show || coverFor === keyOf(item)) return;
  coverFor = keyOf(item);
  let i = 0;
  const tryNext = () => {
    if (i >= urls.length) { img.classList.add('hidden'); $('#screen').classList.remove('square'); return; }
    const [u, flag] = urls[i++].split('|');
    img.classList.toggle('letterbox', flag === 'lb'); // vieilles miniatures YouTube avec bandes noires : on zoome
    img.src = u;
  };
  // YouTube renvoie une petite image grise de 120 px quand la grande n'existe pas
  img.onload = () => { if (img.naturalWidth <= 120) tryNext(); };
  img.onerror = tryNext;
  tryNext();
}

function renderQueue() {
  const control = canControl(), party = isParty();
  const meNow = me();
  $('#queue').innerHTML = state.queue.map((q, i) => {
    const k = keyOf(q), st = state.stats && state.stats[k], my = mine[k];
    const canRemove = isChef() || (meNow && q.addedBy?.id === meNow.id && i > state.index);
    let right = q.duration ? fmt(q.duration) : '';
    if (party && isRateable(q) && !(i === state.index && state.phase === 'break')) {
      right = my
        ? `<span class="q-score" title="Ta note : ${fmtNote(my)}/5">★ ${st ? fmtAvg(st.avg.toFixed(1)) : fmtNote(my)}</span>`
        : `<button class="q-rate" data-rate="${i}">Noter</button>`;
    }
    const sub = !party && q.addedBy ? `${esc(q.author)}${q.author ? ' · ' : ''}<span class="q-by">ajouté par ${esc(q.addedBy.name)}</span>` : esc(q.author);
    return `
    <li class="${i === state.index ? 'current' : ''} ${i < state.index ? 'played' : ''} ${control ? 'clickable' : ''}" data-i="${i}">
      <span class="q-art">${art(q) ? `<img src="${esc(art(q))}" alt="" loading="lazy" onerror="this.remove()">` : ''}${i === state.index && state.phase === 'play' ? '<i class="eq" aria-hidden="true"><b></b><b></b><b></b></i>' : ''}</span>
      <div class="q-text">
        <div class="q-title">${esc(q.title || '…')}</div>
        <div class="q-author">${sub}</div>
      </div>
      <span class="q-dur">${right}</span>
      ${canRemove ? `<button class="icon-btn q-remove" data-remove="${i}" title="Retirer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ''}
    </li>`;
  }).join('');
}

// Couleur choisie sur le compte → petit anneau autour de la photo
const ring = (m) => (m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? ` style="--ring:${m.color}" data-ring` : '');
const avatarHTML = (m) => m.avatar
  ? `<span class="avatar"${ring(m)} title="${esc(m.name)}"><img src="${esc(m.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()"></span>`
  : `<span class="avatar"${ring(m)} title="${esc(m.name)}">${esc(initials(m.name))}</span>`;

function renderMembers() {
  const list = state.members;
  const max = innerWidth < 480 ? 1 : 4;
  const shown = list.slice(0, max);
  $('#avatars').innerHTML = shown.map((m) => avatarHTML(m)).join('')
    + (list.length > max ? `<span class="avatar">+${list.length - max}</span>` : '');
  const issues = list.filter((m) => m.issue).length;
  $('#avatars').classList.toggle('has-issue', isChef() && issues > 0);
  $('#members-title').textContent = `${list.length} dans la salle`;
  // Salle sur invitation : demandes d'entrée (visibles par le chef)
  const pend = isChef() ? (state.pending || []) : [];
  $('#avatars').dataset.badge = pend.length || '';
  $('#pending').innerHTML = pend.length ? `
    <h3>Veulent entrer</h3>
    ${pend.map((p) => `<div class="member"><span class="avatar">${esc(initials(p.name))}</span><span class="m-name">${esc(p.name)}</span>
      <span class="m-actions"><button data-admit="${p.id}" data-ok="0">Refuser</button><button class="accept" data-admit="${p.id}" data-ok="1">Accepter</button></span></div>`).join('')}` : '';
  const order = { chef: 0, modo: 1, auditeur: 2 };
  const chef = isChef();
  const issueText = { blocked: 'n’arrive pas à lire ce titre', autoplay: 'doit toucher le lecteur' };
  $('#members').innerHTML = [...list].sort((a, b) => order[a.role] - order[b.role]).map((m) => `
    <div class="member">
      ${m.uid ? `<a href="/u/${encodeURIComponent(m.uid)}" target="_blank" rel="noopener" class="m-link" title="Voir le profil">${avatarHTML(m)}</a>` : avatarHTML(m)}
      <span class="m-name">${m.uid ? `<a href="/u/${encodeURIComponent(m.uid)}" target="_blank" rel="noopener" class="m-link">${esc(m.name)}</a>` : esc(m.name)}${m.id === meId ? ' <span class="muted">(toi)</span>' : ''}
        ${m.issue ? `<small class="m-issue">${issueText[m.issue]}</small>` : ''}</span>
      ${m.role !== 'auditeur' ? `<span class="badge ${m.role}">${m.role}</span>` : ''}
      ${chef && m.role !== 'chef' ? `
        <span class="m-actions">
          <button data-role="${m.role === 'modo' ? 'auditeur' : 'modo'}" data-id="${m.id}">${m.role === 'modo' ? 'Retirer modo' : 'Passer modo'}</button>
          <button data-kick="${m.id}">Exclure</button>
        </span>` : ''}
    </div>`).join('');
}

// Barre de progression fluide
let dragging = false, dragRatio = 0;
// « Ensuite » n'apparaît que dans les 10 dernières secondes du titre (et pendant la pause de notation)
let upNext = null;
function paintUpNext() {
  if (!state) return;
  let show = false;
  if (upNext) {
    if (state.phase === 'break') show = true;
    else if (state.phase === 'play') {
      const d = duration();
      show = d > 0 && d - targetPosition(state) <= 10;
    }
  }
  $('#up-next').classList.toggle('show', show);
}
function renderProgress() {
  paintUpNext();
  if (state && current()) {
    const d = duration();
    const pos = dragging ? dragRatio * d : Math.min(targetPosition(state), d || Infinity);
    const r = d ? Math.max(0, Math.min(1, pos / d)) : 0;
    $('#fill').style.width = `${r * 100}%`;
    $('#knob').style.left = `${r * 100}%`;
    $('#t-cur').textContent = fmt(pos);
    $('#t-dur').textContent = d ? fmt(d) : '–:––';
  }
  requestAnimationFrame(renderProgress);
}
requestAnimationFrame(renderProgress);

// ══════════════ Actions ══════════════
$('#play').addEventListener('click', () => {
  // On lance aussi son propre lecteur directement pendant le clic : certains navigateurs l'exigent
  if (!state.playing && active && loadedKey === keyOf(current())) { try { active.play(); } catch {} }
  socket.emit(state.playing ? 'player:pause' : 'player:play');
});
$('#prev').addEventListener('click', () => socket.emit('player:prev'));
$('#next').addEventListener('click', () => socket.emit('player:next'));

document.addEventListener('keydown', (e) => {
  if (!joined || !canControl() || e.target.closest('input')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  if (e.code === 'ArrowRight') socket.emit('player:seek', { position: targetPosition(state) + 10 });
  if (e.code === 'ArrowLeft') socket.emit('player:seek', { position: Math.max(0, targetPosition(state) - 10) });
});

const bar = $('#bar');
const ratioFrom = (e) => {
  const r = bar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};
bar.addEventListener('pointerdown', (e) => {
  if (!canControl() || !duration()) return;
  dragging = true;
  dragRatio = ratioFrom(e);
  $('#progress').classList.add('dragging');
  bar.setPointerCapture(e.pointerId);
});
bar.addEventListener('pointermove', (e) => { if (dragging) dragRatio = ratioFrom(e); });
bar.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  $('#progress').classList.remove('dragging');
  socket.emit('player:seek', { position: dragRatio * duration() });
});

$('#queue').addEventListener('click', (e) => {
  const rt = e.target.closest('[data-rate]');
  if (rt) { e.stopPropagation(); trayIndex = +rt.dataset.rate; dismissed.delete(keyOf(state.queue[trayIndex])); renderTray(); return; }
  const rm = e.target.closest('[data-remove]');
  if (rm) { e.stopPropagation(); socket.emit('queue:remove', { index: +rm.dataset.remove }); return; }
  const li = e.target.closest('li');
  if (li && canControl()) socket.emit('player:jump', { index: +li.dataset.i });
});
$('#clear-btn').addEventListener('click', () => {
  if (confirm('Vider toute la file ?')) socket.emit('queue:clear');
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-input'), btn = $('#add-btn');
  const { videoIds, playlists, soundcloud } = parseLinks(input.value);
  if (!videoIds.length && !playlists.length && !soundcloud.length) return toast('Lien SoundCloud ou YouTube');
  btn.disabled = true; btn.textContent = '…';
  try {
    const items = videoIds.map((id) => ({ source: 'yt', id }));
    for (const list of playlists) items.push(...(await readYouTubePlaylist(list)));
    for (const url of soundcloud) items.push(...(await readSoundCloud(url)));
    if (!items.length) { toast('Lien introuvable'); return; }
    const res = await new Promise((r) => socket.emit('queue:add', { items }, r));
    if (res.error) toast(res.error);
    else { toast(`+${res.added}`); input.value = ''; }
  } finally {
    btn.disabled = false; btn.textContent = 'Ajouter';
  }
});

// Réactions
$('#reactions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-e]');
  if (b && joined) socket.emit('react', { emoji: b.dataset.e });
});
socket.on('react', ({ emoji, name }) => {
  const el = document.createElement('div');
  el.className = 'floater';
  el.style.left = `${10 + Math.random() * 80}%`;
  el.innerHTML = `<span>${esc(emoji)}</span><small>${esc(name)}</small>`;
  $('#floaters').appendChild(el);
  setTimeout(() => el.remove(), 2700);
});

// Panneaux
function openSheet(id) {
  closeSheets();
  $(id).classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
}
function closeSheets() {
  document.body.classList.remove('queue-open');
  paintQueueBtn();
  document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden'));
  $('#scrim').classList.add('hidden');
}
$('#scrim').addEventListener('click', closeSheets);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets());
$('#avatars').addEventListener('click', () => openSheet('#members-sheet'));
$('#me-btn').addEventListener('click', () => openSheet('#menu-sheet'));

$('#pending').addEventListener('click', (e) => {
  const b = e.target.closest('[data-admit]');
  if (b) socket.emit('member:admit', { id: b.dataset.admit, ok: b.dataset.ok === '1' });
});
$('#members').addEventListener('click', (e) => {
  const r = e.target.closest('[data-role]');
  if (r) socket.emit('member:role', { id: r.dataset.id, role: r.dataset.role });
  const k = e.target.closest('[data-kick]');
  if (k && confirm('Exclure cette personne de la salle ?')) socket.emit('member:kick', { id: k.dataset.kick });
});

const inviteLink = () => `${location.origin}/r/${CODE}`;
$('#code-pill').addEventListener('click', async () => {
  const ok = await copyText(inviteLink());
  const pill = $('#code-pill');
  pill.classList.add(ok ? 'is-copied' : 'is-failed');
  pill.querySelector('.copied').textContent = ok ? 'Copié' : 'Lien : ' + inviteLink();
  clearTimeout(pill._t);
  pill._t = setTimeout(() => pill.classList.remove('is-copied', 'is-failed'), ok ? 1400 : 4000);
});
$('#m-overlay').addEventListener('click', () => { copy(`${location.origin}/overlay/${CODE}`, 'Lien overlay copié'); closeSheets(); });
$('#m-streamer').addEventListener('click', () => {
  const on = document.body.classList.toggle('streamer');
  $('#m-streamer span').textContent = on ? 'Quitter le mode streamer' : 'Mode streamer';
  closeSheets();
});
$('#m-leave').addEventListener('click', () => { socket.disconnect(); location.href = '/'; });


// ══════════════ Notes (listening party) ══════════════
// Règle : on ne peut noter un titre qu'après l'avoir écouté (ou passé).
// La moyenne du groupe n'apparaît qu'après sa propre note, pour ne pas être influencé.
// Demi-étoiles : clic sur la moitié gauche d'une étoile = ,5 (ex : 3,5)
const STAR_PATH = 'M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8z';
const STAR = `<svg class="s-empty" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg><svg class="s-fill" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const starClass = (v, val) => (val >= v ? 'full' : val >= v - 0.5 ? 'half' : '');
const starsHTML = (index, my) => `<span class="stars-in" data-index="${index}" data-value="${my}">${[1, 2, 3, 4, 5].map((v) =>
  `<button type="button" data-index="${index}" data-v="${v}" class="${starClass(v, my)}" aria-label="${v} sur 5">${STAR}</button>`).join('')}</span>`;
const fmtAvg = (x) => String(x).replace('.', ',');
const fmtNote = (x) => fmtAvg(Number.isInteger(x) ? x : x.toFixed(1));
// Valeur selon où on clique / survole dans l'étoile
const starValue = (b, clientX) => {
  const r = b.getBoundingClientRect();
  return +b.dataset.v - (clientX - r.left < r.width / 2 ? 0.5 : 0);
};

function rate(index, v) {
  const item = state.queue[index];
  if (!item || !isRateable(item)) return;
  const k = keyOf(item);
  if (v === mine[k]) v = 0; // re-cliquer sur la même note = la retirer
  if (v) mine[k] = v; else delete mine[k];
  render(); // réaction immédiate, le serveur confirme juste après
  socket.emit('rating:set', { index, value: v });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.stars button[data-v]');
  if (b && joined) rate(+b.dataset.index, starValue(b, e.clientX));
});
// Aperçu au survol (souris) : on voit la note avant de cliquer
document.addEventListener('mousemove', (e) => {
  const b = e.target.closest('.stars button[data-v]');
  document.querySelectorAll('.stars-in.preview').forEach((g) => {
    if (b && g.contains(b)) return;
    g.classList.remove('preview');
    g.querySelectorAll('button').forEach((x) => (x.className = starClass(+x.dataset.v, +g.dataset.value)));
  });
  if (!b) return;
  const g = b.parentNode, val = starValue(b, e.clientX);
  g.classList.add('preview');
  g.querySelectorAll('button').forEach((x) => (x.className = starClass(+x.dataset.v, val)));
  g.title = `${fmtNote(val)} / 5`;
});

// Panneau de la pause de notation
function renderRating() {
  const item = state && current();
  const inBreak = !!item && joined && isParty() && state.phase === 'break';
  $('#break-panel').classList.toggle('hidden', !inBreak);
  if (!inBreak) return;
  const k = keyOf(item), my = mine[k] || 0;
  $('#stars').innerHTML = starsHTML(state.index, my);
  const st = state.stats && state.stats[k];
  const total = state.members.length, count = st ? st.count : 0;
  $('#rating-avg').innerHTML = !my ? 'Ta note ?' : `<b>${fmtNote(my)}</b>${st ? ` · groupe ${fmtAvg(st.avg.toFixed(1))} (${st.count})` : ''}`;
  const c = state.countdown;
  const last = state.index >= state.queue.length - 1;
  $('#break-status').textContent = c
    ? (c.paused ? 'En pause' : `${last ? 'Récap' : 'Suite'} dans ${Math.max(0, Math.ceil((c.endsAt - clock.now()) / 1000))} s`)
    : `${count}/${total} ${count > 1 ? 'ont' : 'a'} noté`;
  $('#countdown').classList.toggle('hidden', !c);
  $('#countdown').classList.toggle('paused', !!c?.paused);
  $('#break-actions').classList.toggle('hidden', !canControl());
  $('#hold-btn').classList.toggle('hidden', !c);
  $('#hold-btn').textContent = c?.paused ? 'Reprendre' : 'Pause';
  $('#continue-btn').textContent = last ? 'Récap' : 'Suite';
}
// Barre + secondes du décompte (animées en continu)
(function tickCountdown() {
  const c = state?.countdown;
  if (c && state.phase === 'break') {
    const left = c.paused ? c.remaining : Math.max(0, c.endsAt - clock.now());
    $('#countdown-fill').style.width = `${(left / (c.total || 10000)) * 100}%`;
    if (!c.paused) {
      const last = state.index >= state.queue.length - 1;
      $('#break-status').textContent = `${last ? 'Récap' : 'Suite'} dans ${Math.ceil(left / 1000)} s`;
    }
  }
  requestAnimationFrame(tickCountdown);
})();
$('#hold-btn').addEventListener('click', () => socket.emit('break:hold'));
$('#continue-btn').addEventListener('click', () => socket.emit('player:next'));

// Récap de fin d'écoute : moyenne de l'album, meilleur titre, et ses notes (modifiables)
const songTitle = (q) => (q.song && q.song.title) || q.title;
const globalAvg = new Map(); // album → note moyenne sur tout Ballroom
function renderRecap() {
  const show = !!state && joined && isParty() && state.phase === 'end' && state.queue.length > 0;
  $('#recap').classList.toggle('hidden', !show);
  if (!show) return;
  const rows = state.queue.map((q, i) => ({ q, i, k: keyOf(q) })).filter((r) => isRateable(r.q));
  const scored = rows.filter((r) => state.stats[r.k]);
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  // Moyenne de l'album = moyenne des notes des titres
  const room = mean(scored.map((r) => state.stats[r.k].avg));
  const me = mean(rows.filter((r) => mine[r.k]).map((r) => mine[r.k]));
  const best = scored.slice().sort((a, b) => state.stats[b.k].avg - state.stats[a.k].avg)[0];
  const unrated = rows.filter((r) => !mine[r.k]).length;
  // L'album écouté : le plus présent dans la file
  const count = new Map();
  rows.forEach((r) => r.q.release && count.set(r.q.release.key, (count.get(r.q.release.key) || 0) + 1));
  const relKey = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rel = relKey ? rows.find((r) => r.q.release && r.q.release.key === relKey).q.release : (state.settings.album ? { title: state.settings.album.title, author: state.settings.album.artist, artwork: state.settings.album.artwork } : null);
  if (relKey && !globalAvg.has(relKey)) {
    globalAvg.set(relKey, null);
    fetch(`/api/release?key=${encodeURIComponent(relKey)}`).then((r) => r.json()).then((j) => { globalAvg.set(relKey, j); renderRecap(); }).catch(() => {});
  }
  const all = relKey && globalAvg.get(relKey);
  const num = (v) => (v != null ? `${fmtAvg(v)}<span>/5</span>` : '–');
  $('#recap').innerHTML = `
    ${rel ? `<div class="recap-album">${rel.artwork ? `<img src="${esc(rel.artwork)}" alt="" onerror="this.remove()">` : ''}<div><b>${esc(rel.title)}</b><small>${esc(rel.author || '')}</small></div></div>` : ''}
    <div class="recap-head">
      <div><small>Toi</small><strong>${num(me)}</strong></div>
      <div><small>Salle</small><strong>${num(room)}</strong></div>
      ${all && all.avg != null ? `<div title="${all.people} personne${all.people > 1 ? 's' : ''}"><small>Ballroom</small><strong>${num(all.avg)}</strong></div>` : ''}
    </div>
    ${best ? `<p class="recap-best"><small>Préféré</small> ${esc(songTitle(best.q))}</p>` : ''}
    ${unrated ? `<p class="recap-hint">${unrated} à noter</p>` : ''}
    ${rows.some((r) => mine[r.k]) ? `<button class="ratings-export" id="ratings-export" type="button">
      <span><b>Reporter sur Ratings</b><small>Tes notes sur 10</small></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></button>` : ''}
    <ol class="recap-list">
      ${rows.map((r) => {
        const st = state.stats[r.k], my = mine[r.k] || 0;
        return `<li><span class="recap-n">${r.i + 1}</span><span class="recap-t">${esc(songTitle(r.q))}</span>
          <span class="recap-g">${my && st ? '★ ' + fmtAvg(st.avg.toFixed(1)) : ''}</span>
          <span class="stars small">${starsHTML(r.i, my)}</span></li>`;
      }).join('')}
    </ol>`;
}

// Ratings (ratingsmusic.com) n'a pas d'API publique : impossible de noter à ta place.
// On prépare donc tes notes au format Ratings (sur 10) et on ouvre le site, tu n'as plus qu'à les reporter.
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#ratings-export')) return;
  const rows = state.queue.map((q, i) => ({ q, i, my: mine[keyOf(q)] })).filter((r) => r.my);
  const album = current()?.album;
  const head = album ? `${album.title}${album.author ? ' — ' + album.author : ''}` : 'Mes notes Ballroom';
  const notes = rows.map((r) => r.my * 2);
  const avg = Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 10) / 10;
  const text = `${head}\nNote de l'album : ${fmtAvg(avg)}/10\n\n${rows.map((r) => `${r.i + 1}. ${songTitle(r.q)} : ${fmtAvg(r.my * 2)}/10`).join('\n')}`;
  await copy(text, 'Notes copiées');
  window.open('https://ratingsmusic.com', '_blank', 'noopener');
});

// Carte "note ce titre" : titres passés, mode enchaîné, ou bouton "Noter" de la file
function renderTray() {
  const tray = $('#tray');
  if (!state || !joined || !isParty() || state.phase === 'end') return tray.classList.add('hidden');
  const ok = (i) => i != null && state.queue[i] && isRateable(state.queue[i]) && !(i === state.index && state.phase === 'break');
  let idx = ok(trayIndex) ? trayIndex : null;
  // Si rien n'est demandé : le dernier titre écouté pas encore noté (utile en mode enchaîné)
  if (idx == null) {
    for (let i = state.queue.length - 1; i >= 0; i--) {
      const q = state.queue[i];
      if (ok(i) && !mine[keyOf(q)] && !dismissed.has(keyOf(q))) { idx = i; break; }
    }
  }
  if (idx == null) return tray.classList.add('hidden');
  const q = state.queue[idx];
  tray.dataset.index = idx;
  $('#tray-art').innerHTML = art(q) ? `<img src="${esc(art(q))}" alt="">` : '';
  $('#tray-title').textContent = q.title;
  $('#tray-stars').innerHTML = starsHTML(idx, mine[keyOf(q)] || 0);
  tray.classList.remove('hidden');
  // Une fois noté, la carte disparaît toute seule
  if (mine[keyOf(q)]) setTimeout(() => { if (trayIndex === idx) trayIndex = null; renderTray(); }, 900);
}
$('#tray-close').addEventListener('click', () => {
  const idx = +$('#tray').dataset.index;
  if (state.queue[idx]) dismissed.add(keyOf(state.queue[idx]));
  trayIndex = null;
  renderTray();
});

// ══════════════ Barre du haut + réglages de la salle ══════════════
const MODE_LABEL = { party: 'Listening party', jukebox: 'Jukebox' };
let roomForm = null;
function renderTopbar() {
  const st = state.settings;
  const chef = state.members.find((m) => m.role === 'chef');
  $('#room-name').textContent = st.name || (chef ? `Salle de ${chef.name}` : 'Salle');
  const al = st.mode === 'party' ? st.album : null;
  $('#room-art').classList.toggle('hidden', !(al && al.artwork));
  $('#room-art').innerHTML = al && al.artwork ? `<img src="${esc(al.artwork)}" alt="">` : '';
  const bits = [al ? `${al.title} · ${al.artist}` : MODE_LABEL[st.mode]];
  if (st.maxPeople) bits.push(`${state.members.length}/${st.maxPeople}`);
  if (st.private) bits.push('privée');
  $('#room-sub').textContent = bits.join(' · ');
  $('#room-title').disabled = !isChef();
  $('#room-title').title = isChef() ? 'Réglages de la salle' : '';
  $('#settings-btn').classList.toggle('hidden', !isChef());
  if (!current()) document.title = `${$('#room-name').textContent} · Ballroom`;
  if (roomForm) roomForm.set(st);
}
function openSettings() {
  if (!isChef()) return;
  if (!roomForm) {
    roomForm = settingsForm($('#settings-form'), state.settings, {
      onChange: (patch) => socket.emit('settings:set', patch),
      namePlaceholder: $('#room-name').textContent,
    });
  }
  roomForm.set(state.settings);
  openSheet('#settings-sheet');
}
$('#settings-btn').addEventListener('click', openSettings);
$('#room-title').addEventListener('click', openSettings);

// ══════════════ Décalage de synchro (perso) ══════════════
function renderSync() {
  const v = syncOffset;
  const txt = `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtAvg(Math.abs(v).toFixed(2))} s`;
  $('#sync-value').textContent = txt;
  $('#m-sync-sub').textContent = v ? txt : '';
}
function setOffset(v) {
  syncOffset = Math.round(Math.max(-0.5, Math.min(0.5, v)) * 100) / 100;
  store.set('ballroom:offset', String(syncOffset));
  forceSync = true; // on se recale tout de suite avec le nouveau réglage
  renderSync();
  sync();
  saveOffset();
}
// Connecté : le réglage suit le compte (même sur un autre appareil)
let offsetTimer = null;
function saveOffset() {
  if (!account() || account().offline) return;
  clearTimeout(offsetTimer);
  offsetTimer = setTimeout(async () => {
    try { // appel direct (sans relancer tout l'événement compte)
      const t = await window.ballroomAuth.getIdToken();
      await fetch('/api/me', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ syncOffset }) });
      account().syncOffset = syncOffset;
    } catch {}
  }, 800);
}
let offsetLoaded = false;
function loadOffsetFromAccount() {
  const a = account();
  if (offsetLoaded || !a) return;
  offsetLoaded = true;
  // Pas de réglage sur cet appareil → on prend celui du compte
  if (store.get('ballroom:offset') == null && typeof a.syncOffset === 'number' && a.syncOffset) {
    syncOffset = a.syncOffset;
    store.set('ballroom:offset', String(syncOffset));
    forceSync = true;
    renderSync();
  }
}
$('#sync-minus').addEventListener('click', () => setOffset(syncOffset - 0.05));
$('#sync-plus').addEventListener('click', () => setOffset(syncOffset + 0.05));
$('#sync-reset').addEventListener('click', () => setOffset(0));
$('#m-sync').addEventListener('click', () => openSheet('#sync-sheet'));
renderSync();


// ══════════════ Compte (Google) ══════════════
// Connecté : le pseudo et la photo du compte suivent partout, on ne redemande rien.
const auth = () => window.ballroomAuth;

function renderAccount() {
  const p = account();
  // Bouton photo en haut à droite
  $('#me-avatar').innerHTML = p && p.photo
    ? `<img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith('${esc(initials(p.name))}')">`
    : p ? esc(initials(p.name)) : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
  // En-tête du menu perso : son compte + accès au profil, ou connexion
  const guestName = me()?.name || store.get('ballroom:name') || 'Invité';
  $('#me-head').innerHTML = p ? `
      <span class="avatar">${$('#me-avatar').innerHTML}</span>
      <div><b>${esc(p.name)}</b>${p.offline ? '' : `<a href="/u/${encodeURIComponent(p.uid)}" target="_blank" rel="noopener">Voir mon profil</a>`}</div>`
    : `
      <span class="avatar">${esc(initials(guestName))}</span>
      <div><b>${esc(guestName)}</b><small>Invité</small></div>
      <button class="btn small" id="me-login">Se connecter</button>`;
  const login = $('#me-login');
  if (login) login.addEventListener('click', () => { closeSheets(); window.ballroomAccount.signIn(); });
  $('#m-logout').classList.toggle('hidden', !p);
}

// Dit au serveur "ce navigateur, c'est ce compte" (il vérifie le jeton lui-même)
async function linkAccount() {
  if (!joined || !account() || !(auth() && auth().user)) return;
  try {
    const idToken = await auth().getIdToken();
    socket.emit('account:link', { idToken }, (res) => { if (res && res.error) console.warn(res.error); });
  } catch {}
}

$('#gate-google').addEventListener('click', () => window.ballroomAccount.signIn());
$('#m-logout').addEventListener('click', () => { closeSheets(); window.ballroomAccount.signOut(); });

window.addEventListener('ballroom:account', () => {
  loadOffsetFromAccount();
  renderAccount();
  decideEntry();
  if (account()) linkAccount(); else if (joined) socket.emit('account:out');
});
renderAccount();
decideEntry();

// Revenir sur l'onglet après avoir modifié son profil : la salle se met à jour
window.addEventListener('focus', () => { if (joined && account()) socket.emit('account:refresh'); });

// Barre du haut : un fond apparaît dès qu'on fait défiler, pour que le texte ne passe pas dessous
const topbar = document.querySelector('.topbar');
const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ── File d'écoute : panneau masquable (ordi) / tiroir du bas (téléphone) ──
const isNarrow = () => window.matchMedia('(max-width: 1023px)').matches;
if (store.get('ballroom:queueHidden') === '1') document.body.classList.add('queue-hidden');
function paintQueueBtn() {
  const shown = isNarrow() ? document.body.classList.contains('queue-open') : !document.body.classList.contains('queue-hidden');
  const btn = $('#queue-btn');
  btn.setAttribute('aria-pressed', String(shown));
  btn.title = shown ? 'Masquer la file' : 'Afficher la file';
  $('#queue-btn-label').textContent = shown && !isNarrow() ? 'Masquer la file' : 'File';
}
$('#queue-btn').addEventListener('click', () => {
  if (isNarrow()) {
    const open = !document.body.classList.contains('queue-open');
    closeSheets();
    document.body.classList.toggle('queue-open', open);
    $('#scrim').classList.toggle('hidden', !open);
  } else {
    const hidden = document.body.classList.toggle('queue-hidden');
    store.set('ballroom:queueHidden', hidden ? '1' : '0');
  }
  paintQueueBtn();
});
$('#queue-close').addEventListener('click', () => {
  if (isNarrow()) closeSheets();
  else { document.body.classList.add('queue-hidden'); store.set('ballroom:queueHidden', '1'); }
  paintQueueBtn();
});
window.addEventListener('resize', paintQueueBtn);
paintQueueBtn();

// "+ Ajouter" dans la salle vide : ouvre la file et place le curseur dans le champ
document.addEventListener('click', (e) => {
  if (!e.target.closest('#empty-add')) return;
  if (isNarrow()) { document.body.classList.add('queue-open'); $('#scrim').classList.remove('hidden'); }
  else { document.body.classList.remove('queue-hidden'); store.set('ballroom:queueHidden', '0'); }
  paintQueueBtn();
  setTimeout(() => $('#add-input').focus(), 320);
});
