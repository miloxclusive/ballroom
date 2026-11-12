// Connexion à Firestore (le "classeur" dans le cloud).
// Le serveur cherche la clé à 2 endroits :
//  1. la variable FIREBASE_KEY (sur Render, plus tard)
//  2. le fichier firebase-key.json (sur ton ordi)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function loadKey() {
  if (process.env.FIREBASE_KEY) {
    try { return JSON.parse(process.env.FIREBASE_KEY); }
    catch { console.warn('FIREBASE_KEY illisible'); return null; }
  }
  try { return require('./firebase-key.json'); } catch { return null; }
}

const key = loadKey();
let db = null;
if (key) {
  initializeApp({ credential: cert(key) });
  db = getFirestore();
  console.log('Firestore connecté ✔');
} else {
  console.warn('Pas de clé Firebase : le site marche, mais rien n’est sauvegardé.');
}

module.exports = { db };