// Outils partagés par toutes les pages
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// "token" = identifiant secret de ce navigateur. Permet de garder
// ton rôle (chef...) si tu rafraîchis la page.
function getToken() {
  let t = store.get('ballroom:token');
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('ballroom:token', t);
  }
  return t;
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (name || '?').trim().slice(0, 1).toUpperCase();
// Pochette d'un titre (YouTube ou SoundCloud), avec un fond neutre si absente
const art = (item) => item?.artwork || (item?.source === 'yt' ? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg` : '');

// ── Horloge partagée ──
// Chaque ordi a une heure un peu différente. On mesure l'écart avec
// le serveur pour que tout le monde calcule la même position.
const clock = {
  offset: 0,
  now() { return Date.now() + this.offset; },
  async sync(socket, samples = 6) {
    const results = [];
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const server = await new Promise((res) => socket.timeout(3000).emit('time:ping', null, (err, t) => res(err ? null : t)));
      const t1 = Date.now();
      if (server) results.push({ rtt: t1 - t0, offset: server - (t0 + (t1 - t0) / 2) });
    }
    if (results.length) {
      results.sort((a, b) => a.rtt - b.rtt); // le ping le plus rapide est le plus fiable
      this.offset = results[0].offset;
    }
  },
};

// Position "officielle" de la lecture, calculée à partir de l'état serveur
function targetPosition(state) {
  if (!state) return 0;
  if (!state.playing) return state.position;
  return state.position + (clock.now() - state.updatedAt) / 1000;
}

// Récupère les IDs YouTube dans un texte (un ou plusieurs liens)
function parseLinks(text) {
  const videoIds = [], playlists = [], soundcloud = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    let url;
    try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); } catch {
      if (/^[\w-]{11}$/.test(raw)) videoIds.push(raw);
      continue;
    }
    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
      url.search = ''; url.hash = '';
      soundcloud.push(url.toString());
      continue;
    }
    const list = url.searchParams.get('list');
    let v = null;
    if (host === 'youtu.be') v = url.pathname.slice(1, 12);
    else if (host.endsWith('youtube.com')) {
      v = url.searchParams.get('v');
      const m = url.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) v = m[2];
    }
    // Lien d'album / playlist sans vidéo précise -> on importe toute la playlist
    if (list && !v) playlists.push(list);
    else if (list && v && url.pathname === '/playlist') playlists.push(list);
    else if (v && /^[\w-]{11}$/.test(v)) {
      if (list && /^(OLAK5uy_|PL|RDCLAK)/.test(list)) playlists.push(list); // album YT Music
      else videoIds.push(v);
    }
  }
  return { videoIds, playlists, soundcloud };
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// Copier du texte, même hors HTTPS (ex : site ouvert via l'adresse IP du Mac sur un téléphone),
// où navigator.clipboard n'existe pas : on passe alors par un champ caché.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
async function copy(text, msg = 'Copié') {
  if (await copyText(text)) toast(msg);
  else toast(text);
}

// Couleur dominante d'une pochette (pour le halo / l'accent)
function coverColor(artUrl) {
  if (!artUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 14;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 14);
        const d = ctx.getImageData(0, 0, 24, 14).data;
        let best = null, bestScore = -1, sum = [0, 0, 0], n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max ? (max - min) / max : 0;
          const score = sat * (max / 255);
          sum[0] += r; sum[1] += g; sum[2] += b; n++;
          if (score > bestScore) { bestScore = score; best = [r, g, b]; }
        }
        // Si la pochette est presque grise, on reste neutre
        if (bestScore < 0.25) best = sum.map((x) => x / n);
        // On éclaircit pour que ça reste lisible sur fond sombre
        const lift = (x) => Math.round(x + (255 - x) * 0.35);
        resolve(`rgb(${best.map(lift).join(',')})`);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = `/api/art?u=${encodeURIComponent(artUrl)}`;
  });
}
