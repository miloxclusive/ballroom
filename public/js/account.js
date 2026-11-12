// ─────────────────────────────────────────────────────────────
//  Compte Ballroom (partagé par toutes les pages)
//  - se connecte avec Google (via auth.js)
//  - à la création du compte : on demande le pseudo UNE seule fois
//  - ensuite le pseudo et la photo suivent partout
//  Les pages écoutent l'événement "ballroom:account" et lisent window.ballroomAccount.profile
// ─────────────────────────────────────────────────────────────
(function () {
  const acc = (window.ballroomAccount = { ready: false, profile: null });
  const user = () => window.ballroomAuth && window.ballroomAuth.user;

  async function api(method, body) {
    const t = await window.ballroomAuth.getIdToken();
    const r = await fetch('/api/me', {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Erreur'); e.status = r.status; throw e; }
    return j;
  }

  function emit() {
    acc.ready = true;
    window.dispatchEvent(new Event('ballroom:account'));
  }

  async function refresh() {
    const u = user();
    if (!u) { acc.profile = null; return emit(); }
    try {
      let p = await api('GET');
      if (p.needsName) {
        p = await askName(p);
        if (!p) return; // annulé : on s'est déconnecté, refresh() repassera tout seul
      }
      acc.profile = { ...p, uid: p.uid || u.uid }; // l'id du compte vient toujours de Google en dernier recours
    } catch {
      // Base de données indisponible : on garde au moins le prénom Google
      acc.profile = { uid: u.uid, name: (u.name || 'Moi').split(' ')[0].slice(0, 24), photo: null, offline: true };
    }
    store.set('ballroom:name', acc.profile.name);
    emit();
  }

  window.addEventListener('ballroom:auth', refresh);
  setTimeout(() => { if (!acc.ready) emit(); }, 2000); // si Google ne répond pas, la page marche quand même en invité

  acc.signIn = async () => {
    if (!window.ballroomAuth) return toast('Un instant…');
    try { await window.ballroomAuth.signIn(); }
    catch (e) {
      const code = (e && e.code) || '';
      if (/popup-closed|cancelled-popup/.test(code)) return;
      toast(code === 'auth/popup-blocked' ? 'Fenêtre Google bloquée'
        : code === 'auth/unauthorized-domain' ? 'Domaine non autorisé dans Firebase'
        : 'Connexion impossible');
    }
  };
  acc.signOut = async () => { await window.ballroomAuth.signOut(); toast('Déconnecté'); };
  acc.update = async (body) => {
    const p = await api('POST', body);
    acc.profile = { ...acc.profile, ...p };
    store.set('ballroom:name', acc.profile.name);
    emit();
    return acc.profile;
  };

  // ── Fenêtre "Choisis ton pseudo" (première connexion) ──
  function askName(p) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'onboard';
      const first = (p.name || '').split(' ')[0].slice(0, 24);
      wrap.innerHTML = `
        <form class="onboard-card" autocomplete="off">
          ${p.photo ? `<span class="avatar onboard-avatar"><img src="${esc(p.photo)}" alt="" referrerpolicy="no-referrer"></span>` : ''}
          <h2>Ton pseudo</h2>
          <input class="field" maxlength="24" placeholder="Pseudo" value="${esc(first)}" required>
          <p class="error"></p>
          <button class="btn" type="submit">OK</button>
          <button class="link-btn" type="button">Annuler</button>
        </form>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('input'), err = wrap.querySelector('.error'), btn = wrap.querySelector('.btn');
      input.focus();
      input.select();
      wrap.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const saved = await api('POST', { name: input.value.trim() });
          wrap.remove();
          resolve(saved);
        } catch (e2) {
          err.textContent = e2.message;
          btn.disabled = false;
        }
      });
      wrap.querySelector('.link-btn').addEventListener('click', async () => {
        wrap.remove();
        resolve(null);
        await window.ballroomAuth.signOut();
      });
    });
  }
})();
