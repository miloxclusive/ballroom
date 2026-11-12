// ─────────────────────────────────────────────────────────────
//  Réglages d'une salle — à la création (accueil) et dans la salle (chef)
//  Peu de mots : chaque réglage tient en un libellé et des choix courts.
// ─────────────────────────────────────────────────────────────
const ROOM_DEFAULTS = { name: '', album: null, mode: 'party', continuous: false, countdown: 10, control: 'modos', maxPeople: 0, private: false };

// Recherche d'album en ligne (utilisée aussi par le profil)
function albumSearch(input, results, onPick) {
  let t, last = [];
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    t = setTimeout(async () => {
      try { last = await (await fetch(`/api/albums?q=${encodeURIComponent(q)}`)).json(); } catch { last = []; }
      if (input.value.trim() !== q) return;
      results.innerHTML = Array.isArray(last) && last.length
        ? last.slice(0, 6).map((a, i) => `<button type="button" class="alb-row" data-i="${i}">
            <span class="alb-cover">${a.artwork ? `<img src="${esc(a.artwork)}" alt="">` : ''}</span>
            <span class="alb-text"><b>${esc(a.title)}</b><small>${esc(a.artist)}</small></span></button>`).join('')
        : '<p class="alb-none">Rien trouvé</p>';
    }, 250);
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    onPick(last[+b.dataset.i]);
    input.value = '';
    results.innerHTML = '';
  });
}

function settingsForm(container, initial, { onChange = () => {}, namePlaceholder = 'Nom de la salle' } = {}) {
  let v = { ...ROOM_DEFAULTS, ...initial };
  const chips = (key, options) => `
    <div class="chips" data-key="${key}">
      ${options.map(([val, label]) => `<button type="button" class="chip" data-val="${val}">${label}</button>`).join('')}
    </div>`;

  container.innerHTML = `
    <div class="sf">
      <div class="seg" data-key="mode">
        <button type="button" data-mode="party">Listening party</button>
        <button type="button" data-mode="jukebox">Jukebox</button>
      </div>

      <input class="field" data-key="name" maxlength="40" placeholder="${esc(namePlaceholder)}" aria-label="Nom de la salle">

      <div class="sf-album sf-party">
        <div class="alb-picked hidden"></div>
        <div class="alb-search">
          <input class="field" placeholder="Album" autocomplete="off" aria-label="Album">
          <div class="alb-results"></div>
        </div>
      </div>

      <div class="sf-rows">
        <label class="sf-row sf-party"><span>Enchaîner</span><span class="switch"><input type="checkbox" data-key="continuous"><i></i></span></label>
        <div class="sf-row sf-party sf-break"><span>Après les notes</span>${chips('countdown', [[5, '5 s'], [10, '10 s'], [20, '20 s'], [0, 'Manuel']])}</div>
        <div class="sf-row"><span>Contrôle</span>${chips('control', [['chef', 'Chef'], ['modos', '+ modos'], ['all', 'Tous']])}</div>
        <div class="sf-row"><span>Places</span>${chips('maxPeople', [[4, '4'], [8, '8'], [15, '15'], [0, '∞']])}</div>
        <label class="sf-row"><span>Sur invitation</span><span class="switch"><input type="checkbox" data-key="private"><i></i></span></label>
      </div>
    </div>`;

  const $c = (sel) => container.querySelector(sel);
  function paint() {
    if (document.activeElement !== $c('[data-key="name"]')) $c('[data-key="name"]').value = v.name;
    container.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === v.mode));
    $c('[data-key="continuous"]').checked = v.continuous;
    $c('[data-key="private"]').checked = v.private;
    container.querySelectorAll('.chips').forEach((g) => g.querySelectorAll('.chip')
      .forEach((c) => c.classList.toggle('on', String(v[g.dataset.key]) === c.dataset.val)));
    container.querySelectorAll('.sf-party').forEach((el) => el.classList.toggle('hidden', v.mode !== 'party'));
    $c('.sf-break').classList.toggle('hidden', v.mode !== 'party' || v.continuous);
    // Album choisi : sa pochette remplace le champ de recherche
    const a = v.album;
    $c('.alb-picked').classList.toggle('hidden', !a);
    $c('.alb-search').classList.toggle('hidden', !!a);
    $c('.alb-picked').innerHTML = a ? `
      <span class="alb-cover">${a.artwork ? `<img src="${esc(a.artwork)}" alt="">` : ''}</span>
      <span class="alb-text"><b>${esc(a.title)}</b><small>${esc(a.artist)}</small></span>
      <button type="button" class="alb-x" aria-label="Retirer l'album">×</button>` : '';
  }
  function set(key, val) {
    v = { ...v, [key]: val };
    paint();
    onChange({ [key]: val }, v);
  }

  container.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => set('mode', b.dataset.mode)));
  container.querySelectorAll('.chips').forEach((g) => g.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const raw = c.dataset.val;
    set(g.dataset.key, /^\d+$/.test(raw) ? Number(raw) : raw);
  }));
  $c('[data-key="continuous"]').addEventListener('change', (e) => set('continuous', e.target.checked));
  $c('[data-key="private"]').addEventListener('change', (e) => set('private', e.target.checked));
  albumSearch($c('.alb-search input'), $c('.alb-results'), (a) => set('album', a));
  $c('.alb-picked').addEventListener('click', (e) => { if (e.target.closest('.alb-x')) set('album', null); });
  // Le nom est envoyé quand on a fini de taper (pas à chaque lettre)
  let t;
  $c('[data-key="name"]').addEventListener('input', (e) => {
    v.name = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => onChange({ name: v.name.trim() }, v), 600);
  });

  paint();
  return {
    get: () => ({ ...v, name: v.name.trim() }),
    set: (nv) => { v = { ...v, ...nv, ...(document.activeElement === $c('[data-key="name"]') ? { name: v.name } : {}) }; paint(); },
  };
}
