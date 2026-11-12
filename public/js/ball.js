// ─────────────────────────────────────────────────────────────
//  Le logo de Ballroom : le « B » gothique, en 3D, qui tourne sur lui-même.
//  - tout de suite : le B plat (aucun chargement)
//  - dès que la 3D est prête (b3d.mjs + three.js) : le B en relief prend le relais
//  Il tourne pendant la musique et revient se poser de face en pause.
//  (garde le nom createBall pour ne rien changer ailleurs dans le site)
// ─────────────────────────────────────────────────────────────
const B_PATH = 'M387 286Q378 281 368.5 276.5Q359 272 352 269Q346 266 342 266Q320 266 320 289Q320 301 331 308Q489 395 651.5 519.0Q814 643 813 857Q812 991 723.0 1133.0Q634 1275 453 1275Q330 1275 225.0 1188.5Q120 1102 120 995Q120 884 184.0 801.0Q248 718 389 697Q502 694 571 744Q580 751 592.5 765.5Q605 780 617 780Q632 780 636.0 767.0Q640 754 631 745Q608 720 566 694Q500 652 415 652Q188 649 101.0 763.5Q14 878 31.0 1058.0Q48 1238 195.5 1364.0Q343 1490 536 1482Q701 1475 800.0 1411.0Q899 1347 951 1250Q956 1239 967 1241Q979 1241 981 1253Q1009 1354 1086.5 1416.0Q1164 1478 1284 1478Q1399 1478 1485.0 1404.5Q1571 1331 1610 1166Q1639 1057 1691 1059Q1712 1059 1715.5 1042.5Q1719 1026 1699 1016L1473 911Q1462 905 1464 894Q1465 883 1477 880Q1596 853 1686.5 750.5Q1777 648 1777 501Q1773 270 1473 93Q1308 -3 1155.0 -20.0Q1002 -37 867 10Q713 64 603.5 191.5Q494 319 387 286ZM1049 758 1439 942Q1448 949 1448 956Q1448 966 1440 971Q1372 1011 1338 1144Q1311 1242 1270.0 1303.0Q1229 1364 1150 1356Q1044 1332 1025.5 1242.0Q1007 1152 1020 1037Q1042 852 916.0 702.5Q790 553 649 449Q739 450 836 357Q904 290 977.5 233.0Q1051 176 1133 138Q1236 89 1339.0 100.5Q1442 112 1516 208Q1570 278 1571.5 371.5Q1573 465 1501.5 560.0Q1430 655 1323.5 690.0Q1217 725 1058 715Q1036 714 1032.5 731.5Q1029 749 1049 758Z';

function createBall(el, { speed = 0.35 } = {}) {
  // On remplace l'ancien <canvas> par le logo, en gardant ses classes (et donc sa taille)
  const box = document.createElement('span');
  box.className = `${el.className || ''} b3d`;
  box.setAttribute('aria-hidden', 'true');
  if (el.id) box.id = el.id;
  box.innerHTML = `<svg class="b3d-flat" viewBox="0 0 1800 1800"><g transform="translate(-2 1628) scale(1 -1)"><path d="${B_PATH}"/></g></svg>`;
  el.replaceWith(box);

  const state = { angle: 0, alive: true, accent: readAccent() };
  let current = speed, target = speed, last = performance.now();
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { current = 0; target = 0; }
  const degPerSec = 70;

  function readAccent() {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return c || '#e9e6df';
  }
  function frame(now) {
    if (!state.alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    current += (target - current) * Math.min(1, dt * 2.2);
    if (target === 0 && Math.abs(current) < 0.03) {
      // En pause : retour en douceur de face
      const rest = Math.round(state.angle / 360) * 360;
      state.angle += (rest - state.angle) * Math.min(1, dt * 3);
    } else {
      state.angle += current * degPerSec * dt;
    }
    if (!box.classList.contains('gl-ready')) box.firstChild.style.transform = `rotateY(${state.angle.toFixed(1)}deg)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // La vraie 3D, chargée à la demande (si le navigateur sait faire)
  import('/js/b3d.mjs').then((m) => { if (state.alive) m.mount(box, state); }).catch(() => {});

  return {
    spin(on) { target = on && !still ? speed : 0; },
    refreshColor() { state.accent = readAccent(); },
    stop() { state.alive = false; },
  };
}
