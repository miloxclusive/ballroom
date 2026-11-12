// ─────────────────────────────────────────────────────────────
//  Le « B » gothique en vraie 3D (three.js) : la lettre est extrudée
//  avec un léger biseau. Face blanc cassé, tranche couleur pochette.
//  Chargé à la demande par ball.js ; si la 3D n'est pas dispo, le B plat reste.
// ─────────────────────────────────────────────────────────────
import * as THREE from '/vendor/three.module.min.js';
import { SVGLoader } from '/vendor/SVGLoader.js';

const B_PATH = 'M387 286Q378 281 368.5 276.5Q359 272 352 269Q346 266 342 266Q320 266 320 289Q320 301 331 308Q489 395 651.5 519.0Q814 643 813 857Q812 991 723.0 1133.0Q634 1275 453 1275Q330 1275 225.0 1188.5Q120 1102 120 995Q120 884 184.0 801.0Q248 718 389 697Q502 694 571 744Q580 751 592.5 765.5Q605 780 617 780Q632 780 636.0 767.0Q640 754 631 745Q608 720 566 694Q500 652 415 652Q188 649 101.0 763.5Q14 878 31.0 1058.0Q48 1238 195.5 1364.0Q343 1490 536 1482Q701 1475 800.0 1411.0Q899 1347 951 1250Q956 1239 967 1241Q979 1241 981 1253Q1009 1354 1086.5 1416.0Q1164 1478 1284 1478Q1399 1478 1485.0 1404.5Q1571 1331 1610 1166Q1639 1057 1691 1059Q1712 1059 1715.5 1042.5Q1719 1026 1699 1016L1473 911Q1462 905 1464 894Q1465 883 1477 880Q1596 853 1686.5 750.5Q1777 648 1777 501Q1773 270 1473 93Q1308 -3 1155.0 -20.0Q1002 -37 867 10Q713 64 603.5 191.5Q494 319 387 286ZM1049 758 1439 942Q1448 949 1448 956Q1448 966 1440 971Q1372 1011 1338 1144Q1311 1242 1270.0 1303.0Q1229 1364 1150 1356Q1044 1332 1025.5 1242.0Q1007 1152 1020 1037Q1042 852 916.0 702.5Q790 553 649 449Q739 450 836 357Q904 290 977.5 233.0Q1051 176 1133 138Q1236 89 1339.0 100.5Q1442 112 1516 208Q1570 278 1571.5 371.5Q1573 465 1501.5 560.0Q1430 655 1323.5 690.0Q1217 725 1058 715Q1036 714 1032.5 731.5Q1029 749 1049 758Z';

// La forme du B (coordonnées de la police, axe Y vers le haut) → géométrie 3D, centrée
let geometryCache = null;
function geometry() {
  if (geometryCache) return geometryCache;
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${B_PATH}"/></svg>`);
  const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p));
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: 220, curveSegments: 12,
    bevelEnabled: true, bevelThickness: 26, bevelSize: 14, bevelSegments: 4,
  });
  g.computeBoundingBox();
  const b = g.boundingBox, c = new THREE.Vector3();
  b.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  const s = 1 / Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
  g.scale(s, s, s);
  geometryCache = g;
  return g;
}

export function mount(box, state) {
  const canvas = document.createElement('canvas');
  canvas.className = 'b3d-gl';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  camera.position.set(0, 0, 2.35);

  // Lumière douce, pas de brillance "plastique"
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-1.5, 2, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.set(2, -1, -2);
  scene.add(rim);

  const face = new THREE.MeshStandardMaterial({ color: 0xf3f3f1, roughness: 0.5, metalness: 0.05, emissive: 0x3a3a38 });
  const side = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.6, metalness: 0.15 });
  const mesh = new THREE.Mesh(geometry(), [face, side]);
  scene.add(mesh);

  box.appendChild(canvas);
  box.classList.add('gl-ready');

  let lastAccent = '', lastKey = '';
  function fit() {
    const w = box.clientWidth || 24, h = box.clientHeight || w;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  }
  function frame() {
    if (!state.alive) { renderer.dispose(); return; }
    if (state.accent !== lastAccent) {
      lastAccent = state.accent;
      // Tranche = couleur de la pochette, un peu assombrie pour donner du relief
      side.color.set(state.accent).multiplyScalar(0.72);
    }
    fit();
    // On ne redessine que si quelque chose a bougé (logo posé en pause = zéro calcul)
    const key = `${state.angle.toFixed(2)}|${lastAccent}|${canvas.width}`;
    if (key !== lastKey) {
      lastKey = key;
      mesh.rotation.y = THREE.MathUtils.degToRad(state.angle);
      mesh.rotation.x = THREE.MathUtils.degToRad(-8);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
