const { db } = require('./db');

(async () => {
  if (!db) return console.log('❌ Clé introuvable. Vérifie le nom et l’emplacement du fichier.');
  try {
    const ref = db.collection('test').doc('hello');
    await ref.set({ message: 'ça marche', date: new Date().toISOString() });
    const snap = await ref.get();
    console.log('✅ Lu dans Firestore :', snap.data());
    await ref.delete();
    console.log('Test terminé, tout est bon.');
  } catch (e) {
    console.log('❌ Erreur :', e.message);
  }
  process.exit(0);
})();