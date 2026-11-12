// ─────────────────────────────────────────────────────────────
//  Connexion (Google) via Firebase. Ce fichier ne fait que gérer
//  le compte ; la page de la salle l'utilise via window.ballroomAuth.
//  La config ci-dessous n'est PAS secrète (c'est l'adresse publique
//  du projet). Le secret, c'est firebase-key.json, qui reste sur le serveur.
// ─────────────────────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCtck2AT3AVSkeeJwymv5tyjk9IzdWboNc',
  authDomain: 'ballroom-19c81.firebaseapp.com',
  projectId: 'ballroom-19c81',
  storageBucket: 'ballroom-19c81.firebasestorage.app',
  messagingSenderId: '470120850140',
  appId: '1:470120850140:web:d8e3a04e7ffdced81eca19',
};

const auth = getAuth(initializeApp(firebaseConfig));
auth.languageCode = 'fr';

window.ballroomAuth = {
  user: null, // { uid, name } quand on est connecté
  signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),
  getIdToken: () => auth.currentUser.getIdToken(),
};

onAuthStateChanged(auth, (u) => {
  window.ballroomAuth.user = u ? { uid: u.uid, name: u.displayName || '' } : null;
  window.dispatchEvent(new Event('ballroom:auth'));
});
