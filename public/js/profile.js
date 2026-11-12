// ─────────────────────────────────────────────────────────────
//  Page profil : /u/<id du compte>
//  Tout le monde peut la voir. Si c'est la tienne, tu peux la modifier.
// ─────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const UID = decodeURIComponent(location.pathname.split('/')[2] || '');
const ball = createBall($('#mini-ball'), { rows: 8, cols: 14, speed: 0.4, glints: false });

let profile = null;
let draft = null;      // copie modifiable pendant l'édition
let pendingPhoto;      // undefined = pas de changement, null = reprendre Google, "data:..." = nouvelle photo

const STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';
// Icônes des réseaux (traits simples, dans le style du site)
const ICON = {
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.8 2.3 4.6 5 5"/></svg>',
  soundcloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17V8.5a5 5 0 0 1 9.4 2.4A3 3 0 0 1 20 17z"/><path d="M8 17v-6M5 17v-4M2.5 17v-2"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10.5 9.5l4 2.5-4 2.5z" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 4.5l15 15M19.5 4.5l-15 15"/></svg>',
};
const LINKS = [
  ['instagram', 'Instagram', (h) => `https://instagram.com/${h}`],
  ['tiktok', 'TikTok', (h) => `https://www.tiktok.com/@${h}`],
  ['soundcloud', 'SoundCloud', (h) => `https://soundcloud.com/${h}`],
  ['youtube', 'YouTube', (h) => `https://www.youtube.com/@${h}`],
  ['x', 'X', (h) => `https://x.com/${h}`],
];
const fmtAvg = (x) => (x == null ? '–' : String(x).replace('.', ','));
const since = (ms) => ms ? new Date(ms).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : null;
const avatar = (p, cls = '') => p.photo
  ? `<span class="avatar ${cls}"><img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${esc(initials(p.name))}'"></span>`
  : `<span class="avatar ${cls}">${esc(initials(p.name))}</span>`;
const cover = (a) => a && a.artwork ? `<img src="${esc(a.artwork)}" alt="" loading="lazy" onerror="this.remove()">` : '';

const authHeader = async () => (window.ballroomAuth && window.ballroomAuth.user ? { Authorization: `Bearer ${await window.ballroomAuth.getIdToken()}` } : {});
async function load() {
  // Connecté : on s'identifie, pour voir ses propres notes même quand elles sont privées
  const r = await fetch(`/api/users/${encodeURIComponent(UID)}`, { headers: await authHeader() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    $('#profile').innerHTML = `<p class="profile-loading">${esc(data.error || 'Profil introuvable')}</p>`;
    return;
  }
  profile = data;
  render();
}

function render() {
  const p = profile;
  const hidden = !p.stats; // notes privées
  const s = p.stats || { count: 0, avg: null, dist: [0, 0, 0, 0, 0], albums: [], top: [], sessions: 0, taste: null };
  document.title = `${p.name} · Ballroom`;
  const mine = isMine();
  const maxDist = Math.max(1, ...s.dist);
  const links = LINKS.filter(([k]) => p.links && p.links[k]);
  const top4 = p.top4 || [];
  const showTop = p.showTop4 !== false;
  const hasTop = showTop && top4.some(Boolean);

  // La page prend la couleur choisie, sinon celle de l'album du moment
  (p.color ? Promise.resolve(p.color) : coverColor(p.nowAlbum && p.nowAlbum.artwork)).then((c) => {
    document.documentElement.style.setProperty('--accent', c || '#e9e6df');
    ball.refreshColor();
  });

  $('#profile').innerHTML = `
    <section class="p-head">
      ${avatar(p, 'xl')}
      <h1>${esc(p.name)}</h1>
      ${p.bio ? `<p class="p-bio">${esc(p.bio)}</p>` : ''}
      ${links.length ? `<div class="p-links">${links.map(([k, label, url]) =>
        `<a href="${esc(url(p.links[k]))}" target="_blank" rel="noopener nofollow" title="${label} · @${esc(p.links[k])}" aria-label="${label}">${ICON[k]}</a>`).join('')}</div>` : ''}
      <p class="p-meta">${[since(p.since) && `Depuis ${since(p.since)}`, s.taste].filter(Boolean).map(esc).join(' · ')}</p>
      ${mine ? `<div class="p-actions"><button class="btn ghost small" id="edit-btn">Modifier</button><button class="link-btn" id="logout-btn">Se déconnecter</button></div>` : ''}
    </section>

    ${p.nowAlbum ? `
    <section class="p-now">
      <span class="p-now-cover">${cover(p.nowAlbum)}</span>
      <div><small>En boucle</small><b>${esc(p.nowAlbum.title)}</b><span>${esc(p.nowAlbum.artist)}${p.nowAlbum.year ? ` · ${p.nowAlbum.year}` : ''}</span></div>
    </section>` : mine ? `<button class="p-now p-now-empty" id="now-add"><span class="p-now-cover">${PLUS}</span><div><small>En boucle</small><b>Ajouter</b></div></button>` : ''}

    ${hasTop || (mine && showTop) ? `
    <section class="p-block">
      <h2>Top 4</h2>
      <div class="p-top4">
        ${[0, 1, 2, 3].map((i) => top4[i]
          ? `<div class="p-top4-item"><span class="p-cover">${cover(top4[i])}</span><b>${esc(top4[i].title)}</b><small>${esc(top4[i].artist)}</small></div>`
          : mine ? `<button class="p-top4-item empty" data-top="${i}"><span class="p-cover">${PLUS}</span><small>Ajouter</small></button>` : '<div class="p-top4-item"><span class="p-cover"></span></div>').join('')}
      </div>
    </section>` : ''}

    ${hidden ? `<p class="p-empty">Notes privées</p>` : `
    <section class="p-stats">
      <div><strong>${s.count}</strong><small>note${s.count > 1 ? 's' : ''}</small></div>
      <div><strong>${fmtAvg(s.avg)}</strong><small>moyenne</small></div>
      <div><strong>${s.releases ?? s.albums.length}</strong><small>sortie${(s.releases ?? s.albums.length) > 1 ? 's' : ''}</small></div>
      <div><strong>${s.sessions}</strong><small>soirée${s.sessions > 1 ? 's' : ''}</small></div>
    </section>

    ${s.count ? `
    <section class="p-block">
      <h2 class="p-h2-row">Notes${mine ? '<button class="link-btn" id="manage-btn">Gérer</button>' : ''}${mine && !p.showRatings ? '<small>privées</small>' : ''}</h2>
      <div class="p-dist">
        ${[5, 4, 3, 2, 1].map((v) => `
          <div class="p-dist-row"><span>${v} ${STAR}</span>
            <div class="p-dist-bar"><i style="width:${(s.dist[v - 1] / maxDist) * 100}%"></i></div>
            <b>${s.dist[v - 1]}</b></div>`).join('')}
      </div>
    </section>` : ''}

    ${(s.recent || []).length ? `
    <section class="p-block">
      <h2>Activité récente</h2>
      <div class="p-recent">${s.recent.map((a) => poster(a, true)).join('')}</div>
    </section>` : ''}

    ${s.albums.length > (s.recent || []).length ? `
    <section class="p-block">
      <h2>Albums, EP, singles</h2>
      <div class="p-albums">${s.albums.map((a) => poster(a)).join('')}</div>
    </section>` : ''}

    ${s.top.length ? `
    <section class="p-block">
      <h2>Coups de cœur</h2>
      <ol class="p-top">
        ${s.top.map((t) => `<li><span class="q-art">${cover(t)}</span>
          <div class="q-text"><div class="q-title">${esc(t.title)}</div><div class="q-author">${esc(t.author)}</div></div><span class="p-five">${fmtAvg(t.value)} ${STAR}</span></li>`).join('')}
      </ol>
    </section>` : ''}

    ${!s.count ? `<p class="p-empty">Aucune note pour l’instant.</p>` : ''}
    `}
  `;
  document.querySelectorAll('[data-rel]').forEach((b) => b.addEventListener('click', () => openRelease(b.dataset.rel)));
  if (mine) {
    $('#edit-btn').addEventListener('click', openEdit);
    const mb = $('#manage-btn');
    if (mb) mb.addEventListener('click', openRatings);
    $('#logout-btn').addEventListener('click', async () => { await window.ballroomAuth.signOut(); render(); });
    // Raccourcis : cliquer sur une case vide ouvre directement la recherche, puis enregistre
    const quick = (apply) => pickAlbum(async (album) => { apply(album); await save({ nowAlbum: profile.nowAlbum, top4: profile.top4 }); });
    const nowAdd = $('#now-add');
    if (nowAdd) nowAdd.addEventListener('click', () => quick((a) => { profile.nowAlbum = a; }));
    document.querySelectorAll('[data-top]').forEach((b) => b.addEventListener('click', () => quick((a) => {
      profile.top4 = [0, 1, 2, 3].map((i) => (i === +b.dataset.top ? a : (profile.top4 || [])[i] || null));
    })));
  }
}

const isMine = () => !!(window.ballroomAuth && window.ballroomAuth.user && window.ballroomAuth.user.uid === UID);
window.addEventListener('ballroom:account', () => {
  if (profile && isMine() && !profile.owner) return load(); // on recharge en tant que propriétaire
  if (profile) return render();
  if (isMine()) load(); // mon profil vient d'être créé
});

// ══════════ Édition ══════════
function openEdit() {
  pendingPhoto = undefined;
  draft = { nowAlbum: profile.nowAlbum || null, top4: [0, 1, 2, 3].map((i) => (profile.top4 || [])[i] || null) };
  $('#edit-avatar').outerHTML = avatar(profile, 'xl').replace('class="avatar xl"', 'class="avatar xl" id="edit-avatar"');
  $('#name-input').value = profile.name;
  $('#bio-input').value = profile.bio || '';
  updateBioCount();
  $('#edit-links').innerHTML = LINKS.map(([k, label]) => `
    <label class="link-row"><span>${ICON[k]}${label}</span><input class="field" data-link="${k}" placeholder="pseudo" value="${esc((profile.links || {})[k] || '')}" maxlength="80"></label>`).join('');
  renderEditAlbums();
  $('#top4-on').checked = profile.showTop4 !== false;
  $('#ratings-on').checked = profile.showRatings !== false;
  editColor = profile.color || null;
  paintColors();
  $('#edit-top4').classList.toggle('off', !$('#top4-on').checked);
  $('#edit-error').textContent = '';
  $('#google-photo').classList.toggle('hidden', !profile.customPhoto);
  openSheet('#edit-sheet');
}
function openSheet(id) {
  document.querySelectorAll('.sheet').forEach((x) => x.classList.add('hidden'));
  $(id).classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
}
function closeAll() {
  document.querySelectorAll('.sheet').forEach((x) => x.classList.add('hidden'));
  $('#scrim').classList.add('hidden');
  if (ratingsChanged) { ratingsChanged = false; load(); } // stats à jour après modif des notes
}
$('#scrim').addEventListener('click', closeAll);
$('#edit-cancel').addEventListener('click', closeAll);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());

$('#top4-on').addEventListener('change', (e) => $('#edit-top4').classList.toggle('off', !e.target.checked));
const updateBioCount = () => { $('#bio-count').textContent = `${$('#bio-input').value.length}/160`; };
$('#bio-input').addEventListener('input', updateBioCount);

function slotHTML(a, attr) {
  return `<button type="button" class="edit-slot ${a ? '' : 'empty'}" ${attr}>
    <span class="p-cover">${a ? cover(a) : PLUS}</span>
    ${a ? `<b>${esc(a.title)}</b><small>${esc(a.artist)}</small>` : '<small>Choisir</small>'}
  </button>`;
}
function renderEditAlbums() {
  $('#edit-now').innerHTML = slotHTML(draft.nowAlbum, 'data-slot="now"');
  $('#edit-top4').innerHTML = draft.top4.map((a, i) => slotHTML(a, `data-slot="${i}"`)).join('');
}
$('#edit-sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b) return;
  const slot = b.dataset.slot;
  pickAlbum((album) => {
    if (slot === 'now') draft.nowAlbum = album; else draft.top4[+slot] = album;
    renderEditAlbums();
    openSheet('#edit-sheet');
  }, () => openSheet('#edit-sheet'));
});

// ── Recherche d'album (catalogue Apple Music, via notre serveur) ──
let pickCb = null, pickBack = null, searchTimer, lastResults = [];
function pickAlbum(cb, back) {
  pickCb = cb;
  pickBack = back || closeAll;
  $('#picker-input').value = '';
  $('#picker-results').innerHTML = '';
  openSheet('#picker');
  setTimeout(() => $('#picker-input').focus(), 50);
}
$('#picker-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return;
  searchTimer = setTimeout(async () => {
    $('#picker-results').innerHTML = '<p class="picker-hint">…</p>';
    try {
      const r = await fetch(`/api/albums?q=${encodeURIComponent(q)}`);
      lastResults = r.ok ? await r.json() : [];
    } catch { lastResults = []; }
    if (e.target.value.trim() !== q) return; // une recherche plus récente est en cours
    $('#picker-results').innerHTML = lastResults.length
      ? lastResults.map((a, i) => `<button type="button" class="picker-item" data-i="${i}"><span class="p-cover">${cover(a)}</span><b>${esc(a.title)}</b><small>${esc(a.artist)}${a.year ? ` · ${a.year}` : ''}</small></button>`).join('')
      : '<p class="picker-hint">Rien trouvé</p>';
  }, 300);
});
$('#picker-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b && pickCb) pickCb(lastResults[+b.dataset.i]);
  if (b && pickBack === closeAll) closeAll();
});
$('#picker-clear').addEventListener('click', () => { if (pickCb) pickCb(null); if (pickBack === closeAll) closeAll(); });
$('#picker-close').addEventListener('click', () => pickBack && pickBack());

// ── Photo : recadrée en carré et réduite à 192 px avant l'envoi ──
$('#photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const size = 192, c = document.createElement('canvas');
    c.width = c.height = size;
    const side = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    pendingPhoto = c.toDataURL('image/jpeg', 0.85);
    $('#edit-avatar').innerHTML = `<img src="${pendingPhoto}" alt="">`;
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => { $('#edit-error').textContent = 'Image illisible'; };
  img.src = URL.createObjectURL(file);
});
$('#google-photo').addEventListener('click', () => {
  pendingPhoto = null;
  $('#edit-avatar').innerHTML = esc(initials(profile.name));
  $('#google-photo').classList.add('hidden');
});

async function save(body) {
  const r = await fetch('/api/me', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await window.ballroomAuth.getIdToken()}` },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Enregistrement impossible');
  store.set('ballroom:name', data.name);
  profile = { ...profile, ...data };
  render();
  toast('Enregistré');
}

$('#edit-save').addEventListener('click', async () => {
  const body = {
    name: $('#name-input').value.trim(),
    bio: $('#bio-input').value,
    nowAlbum: draft.nowAlbum,
    top4: draft.top4,
    showTop4: $('#top4-on').checked,
    showRatings: $('#ratings-on').checked,
    color: editColor,
    links: Object.fromEntries([...document.querySelectorAll('[data-link]')].map((i) => [i.dataset.link, i.value])),
  };
  if (pendingPhoto !== undefined) body.photo = pendingPhoto;
  $('#edit-save').disabled = true;
  try { await save(body); closeAll(); }
  catch (e) { $('#edit-error').textContent = e.message; }
  finally { $('#edit-save').disabled = false; }
});

load();


// ══════════ Couleur de profil ══════════
const COLORS = ['#e9e6df', '#e2b070', '#d9604c', '#e58fb0', '#9b8cff', '#5fa8e8', '#5cc9a7', '#c6d65a'];
let editColor = null;
$('#edit-colors').innerHTML = `<button type="button" class="swatch auto" data-c="" title="Auto (album du moment)">A</button>`
  + COLORS.map((c) => `<button type="button" class="swatch" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('');
function paintColors() {
  document.querySelectorAll('#edit-colors .swatch').forEach((b) => b.classList.toggle('on', (b.dataset.c || null) === editColor));
}
$('#edit-colors').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (!b) return;
  editColor = b.dataset.c || null;
  paintColors();
});

// ══════════ Gérer mes notes (modifier / supprimer) ══════════
const STAR_PATH = 'M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8z';
const STAR2 = `<svg class="s-empty" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg><svg class="s-fill" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const starClass = (v, val) => (val >= v ? 'full' : val >= v - 0.5 ? 'half' : '');
const starsRow = (id, val) => `<span class="stars small"><span class="stars-in" data-id="${id}" data-value="${val}">${[1, 2, 3, 4, 5].map((v) =>
  `<button type="button" data-v="${v}" class="${starClass(v, val)}" aria-label="${v} sur 5">${STAR2}</button>`).join('')}</span></span>`;
let myRatings = [];

async function openRatings() {
  openSheet('#ratings-sheet');
  $('#ratings-list').innerHTML = '<p class="picker-hint">…</p>';
  try {
    const r = await fetch('/api/me/ratings', { headers: await authHeader() });
    myRatings = r.ok ? await r.json() : [];
  } catch { myRatings = []; }
  renderRatings();
}
function renderRatings() {
  if (!myRatings.length) { $('#ratings-list').innerHTML = '<p class="picker-hint">Aucune note</p>'; return; }
  // Groupées par album (les titres seuls à la fin)
  const groups = new Map();
  for (const r of myRatings) {
    const k = r.albumKey || '_';
    if (!groups.has(k)) groups.set(k, { title: r.albumTitle, author: r.albumAuthor, artwork: r.albumArtwork || r.artwork, items: [] });
    groups.get(k).items.push(r);
  }
  const list = [...groups.entries()].sort(([a], [b]) => (a === '_') - (b === '_'));
  $('#ratings-list').innerHTML = list.map(([k, g]) => `
    <div class="rt-group">
      <div class="rt-head"><span class="alb-cover">${cover(g)}</span><div><b>${k === '_' ? 'Titres' : esc(g.title || 'Album')}</b><small>${k === '_' ? '' : esc(g.author || '')}</small></div></div>
      ${g.items.map((r) => `<div class="rt-row" data-id="${esc(r.id)}">
        <span class="rt-title">${esc(r.title)}</span>
        ${starsRow(esc(r.id), r.value)}
        <button type="button" class="rt-del" data-del="${esc(r.id)}" aria-label="Supprimer">×</button>
      </div>`).join('')}
    </div>`).join('');
}
const starValue = (b, clientX) => {
  const r = b.getBoundingClientRect();
  return +b.dataset.v - (clientX - r.left < r.width / 2 ? 0.5 : 0);
};
$('#ratings-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const star = e.target.closest('.stars-in button');
  const id = del ? del.dataset.del : star ? star.parentNode.dataset.id : null;
  if (!id) return;
  const r = myRatings.find((x) => x.id === id);
  if (!r) return;
  try {
    if (del) {
      if (!confirm(`Supprimer ta note pour « ${r.title} » ?`)) return;
      const res = await fetch(`/api/me/ratings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await authHeader() });
      if (!res.ok) throw new Error();
      myRatings = myRatings.filter((x) => x !== r);
    } else {
      const v = starValue(star, e.clientX);
      const res = await fetch(`/api/me/ratings/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ value: v }) });
      if (!res.ok) throw new Error();
      r.value = v;
    }
    renderRatings();
    ratingsChanged = true;
  } catch { toast('Impossible pour le moment'); }
});
// Aperçu au survol
$('#ratings-list').addEventListener('mousemove', (e) => {
  document.querySelectorAll('#ratings-list .stars-in').forEach((g) => g.querySelectorAll('button').forEach((x) => (x.className = starClass(+x.dataset.v, +g.dataset.value))));
  const b = e.target.closest('.stars-in button');
  if (!b) return;
  const val = starValue(b, e.clientX);
  b.parentNode.querySelectorAll('button').forEach((x) => (x.className = starClass(+x.dataset.v, val)));
});
let ratingsChanged = false;
$('#ratings-close').addEventListener('click', closeAll);


// ══════════ Albums façon Letterboxd ══════════
// ★★★½ : la note en étoiles, comme sous une affiche
const starText = (v) => (v == null ? '' : '★'.repeat(Math.floor(v)) + (v % 1 >= 0.5 ? '½' : ''));
function poster(a, big) {
  return `<button type="button" class="p-poster${big ? ' big' : ''}" data-rel="${esc(a.key)}" title="${esc(a.title)} · ${esc(a.author)}">
    <span class="p-cover">${cover(a)}</span>
    <span class="p-poster-meta"><span class="p-poster-stars">${starText(a.avg)}</span><small>${esc(a.label || 'Album')}</small></span>
    ${big ? `<b>${esc(a.title)}</b><small class="p-poster-by">${esc(a.author)}</small>` : ''}
  </button>`;
}
const releaseAvg = new Map();
async function openRelease(key) {
  const a = profile && profile.stats && profile.stats.albums.find((x) => x.key === key);
  if (!a) return;
  const paint = () => {
    const all = releaseAvg.get(key);
    $('#release-body').innerHTML = `
      <div class="rel-head">
        <span class="p-cover">${cover(a)}</span>
        <div>
          <small>${esc(a.label || 'Album')}</small>
          <h3>${esc(a.title)}</h3>
          <span class="rel-by">${esc(a.author)}</span>
          <div class="rel-avgs">
            <div><small>${isMine() ? 'Toi' : esc(profile.name)}</small><b>${fmtAvg(a.avg)}</b><span class="p-poster-stars">${starText(a.avg)}</span></div>
            ${all && all.avg != null ? `<div title="${all.people} personne${all.people > 1 ? 's' : ''}"><small>Ballroom</small><b>${fmtAvg(all.avg)}</b><span class="rel-n">${all.people} pers.</span></div>` : ''}
          </div>
        </div>
      </div>
      <ol class="rel-tracks">${a.tracks.map((t) => `<li><span>${esc(t.title)}</span><span class="p-poster-stars">${starText(t.value)}</span></li>`).join('')}</ol>
      ${isMine() ? '<button class="link-btn" id="rel-manage">Modifier mes notes</button>' : ''}`;
    const m = $('#rel-manage');
    if (m) m.addEventListener('click', openRatings);
  };
  paint();
  openSheet('#release-sheet');
  if (!key.startsWith('song:') && !releaseAvg.has(key)) {
    releaseAvg.set(key, null);
    try {
      const r = await fetch(`/api/release?key=${encodeURIComponent(key)}`);
      if (r.ok) { releaseAvg.set(key, await r.json()); paint(); }
    } catch {}
  }
}
$('#release-close').addEventListener('click', closeAll);
