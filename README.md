# Ballroom

Le chef ouvre une salle, partage le code, colle un album SoundCloud ou YouTube, et tout le monde entend la même chose au même moment.

---

## 1. Le tester sur ton Mac (5 min)

1. Installe **Node.js** (version LTS) : https://nodejs.org
2. Ouvre le **Terminal**, va dans le dossier du projet :
   ```bash
   cd ~/Downloads/ballroom
   ```
3. Installe et lance :
   ```bash
   npm install
   npm start
   ```
4. Ouvre http://localhost:3000 dans deux onglets (ou Chrome + Safari) pour simuler deux personnes.

Pour arrêter : `Ctrl + C` dans le Terminal.

---

## 2. Le mettre en ligne gratuitement (15 min)

On utilise **GitHub** (pour stocker le code) + **Render** (pour le faire tourner sur internet).

### a) Mettre le code sur GitHub
1. Crée un compte sur https://github.com
2. Clique **New repository** → nom : `ballroom` → **Create repository**
3. Sur la page qui s'affiche, clique **uploading an existing file**
4. Glisse **tout le contenu** du dossier `ballroom` (sauf `node_modules` s'il existe) → **Commit changes**

### b) Le lancer sur Render
1. Crée un compte sur https://render.com (connecte-toi avec GitHub, c'est plus simple)
2. **New +** → **Web Service** → choisis ton repo `ballroom`
3. Réglages :
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. **Create Web Service**. Après 2-3 min tu as une adresse du genre `https://ballroom-xxxx.onrender.com` → c'est ton site.

Chaque fois que tu modifies un fichier sur GitHub, Render remet le site à jour tout seul.

### ⚠️ À savoir avec l'offre gratuite de Render
- Le site **s'endort après 15 min sans visite**. La première personne qui arrive attend ~50 secondes, ensuite c'est fluide.
- Quand il s'endort ou redémarre, **les salles sont effacées** (elles sont gardées en mémoire, pas dans une base de données). Pour une soirée d'écoute, aucun souci.

---

## 3. Comment ça s'utilise

| Qui | Peut faire |
|---|---|
| **Chef** (celui qui crée) | Tout : ajouter/retirer des titres, lecture, pause, suivant, aller à un moment précis, passer quelqu'un modo, exclure |
| **Modo** | Lecture, pause, suivant/précédent, aller à un moment précis |
| **Auditeur** | Écouter + réactions |

- **Ajouter de la musique** : colle un lien **SoundCloud** (titre, album, playlist) ou **YouTube** (vidéo, album YouTube Music `music.youtube.com/playlist?list=OLAK5uy_…`, playlist). Plusieurs liens d'un coup, ça marche aussi. On peut mélanger les deux dans la même file.
- **Si quelqu'un n'arrive pas à lire** (YouTube bloqué chez lui), le titre n'est plus sauté pour tout le monde : il voit un message d'aide, et le chef voit qui a un souci dans la liste des membres (pastille orange).
- **Raccourcis (chef/modo)** : `Espace` = pause, `←` `→` = ±10 secondes. Glisse sur la barre pour aller à un moment précis.
- **Si tu rafraîchis la page**, tu gardes ton rôle (le site se souvient de ton navigateur).

### Mode streamer
Dans le menu `•••` :
- **Mode streamer** : grosse mise en page propre avec le code de la salle bien visible, à capturer en plein écran.
- **Lien overlay OBS** : un petit bandeau "En écoute" **sans aucun son**, à ajouter dans OBS comme *Source → Navigateur* (largeur 800, hauteur 250).
  → L'idée anti-copyright : ton stream montre ce qui passe, mais la musique n'est pas diffusée sur le stream. Tes viewers rejoignent avec le code et écoutent de leur côté.
  → **Important** : dans OBS, ne capture pas le son de ton navigateur (ou mets la musique dans un casque via une sortie audio séparée).
  → Options : ajoute `?titre=off` à la fin du lien pour flouter le titre, `?code=off` pour cacher le code.

---

## 4. Comment marche la synchro (pour comprendre)

- Le **serveur** garde l'état officiel : *quel morceau, en lecture ou en pause, à quelle seconde, et à quelle heure ça a été décidé*.
- Chaque navigateur mesure le **décalage entre son horloge et celle du serveur** (un peu comme régler sa montre).
- Avec ça, tout le monde calcule la même position : `position + (maintenant - heure de la décision)`.
- Toutes les secondes, chaque lecteur vérifie s'il est décalé de plus de 0,6 s. Si oui, il se recale tout seul.
- Quand quelqu'un appuie sur pause, ce n'est pas son lecteur qui se met en pause directement : il **demande au serveur**, qui prévient tout le monde en même temps.

### Si le son ne démarre pas
- Safari et l'iPhone bloquent le son tant qu'on n'a pas cliqué **dans** le lecteur. Le site affiche alors « clique sur ▶ dans le lecteur » : un clic, et tu es recalé sur les autres.
- **Diagnostic** : ajoute `?debug` à l'adresse de la salle (ex. `…/r/ABCDE?debug`). Un petit panneau affiche l'état de la salle, l'état de ton lecteur et l'écart entre les deux.

### Limites connues
- **YouTube "Connectez-vous pour confirmer que vous n'êtes pas un robot"** : c'est YouTube qui bloque le navigateur ou la connexion (VPN, iCloud Relais privé, bloqueur de pubs, navigateur pas connecté à YouTube). Ça ne vient pas du site. SoundCloud n'a pas ce problème.
- **Pubs YouTube** : quelqu'un sans YouTube Premium peut avoir une pub. Il sera recalé automatiquement juste après.
- **iPhone** : la toute première lecture doit venir d'un toucher sur la vidéo (règle d'Apple). Le site l'affiche quand c'est nécessaire.
- Certaines vidéos interdisent la lecture hors de YouTube → elles sont sautées automatiquement.

---

## 5. Structure des fichiers

```
ballroom/
├── server.js          ← le serveur : salles, rôles, état de lecture
├── package.json       ← la liste des outils utilisés
└── public/            ← ce que voit le navigateur
    ├── index.html     ← accueil (créer / rejoindre)
    ├── room.html      ← la salle d'écoute
    ├── overlay.html   ← bandeau pour OBS
    ├── favicon.svg    ← icône de l'onglet
    ├── css/style.css  ← tout le design
    └── js/
        ├── common.js  ← outils partagés (horloge, liens…)
        ├── ball.js    ← la boule à facettes animée (le logo)
        ├── players.js ← lecteurs YouTube + SoundCloud
        └── room.js    ← la logique de la salle + synchro
```

## Prochaines étapes possibles
- Spotify (limité à 5 comptes en mode perso) / Apple Music (compte dev Apple 99 €/an)
- Base de données pour garder les salles et l'historique
- Chat, votes pour le prochain titre, mode "album complet" verrouillé

---

## Nouveautés (v2)

### Deux types d'écoute (réglables par le chef : menu `•••` → Réglages de la salle)
- **Listening party** (par défaut) : on écoute un album ensemble. À la fin de chaque titre, pause : chacun note de 1 à 5 étoiles. Les étoiles n'apparaissent qu'une fois le titre fini (ou passé avec « Suivant »), et la moyenne du groupe n'apparaît qu'après avoir donné sa propre note. Quand tout le monde a noté, un décompte de 10 s démarre puis l'album continue. Le chef peut mettre le décompte en pause pour discuter, ou lancer la suite quand il veut.
  - **Enchaîner les titres** : pas de pause entre les titres (pour les albums avec des transitions). On note après coup grâce à une petite carte « Note ce titre ».
  - **Fin de l'album** : récap avec la note du groupe, le titre préféré, et ses notes modifiables.
- **Jukebox** : tout le monde peut ajouter des sons (10 en attente max par personne), ça tourne en fond, pas de notes. On voit qui a ajouté quoi, et chacun peut retirer ses propres sons.

### Synchro du son (perso)
Menu `•••` → Synchro du son : décalage de −0,5 s à +0,5 s par pas de 0,05 s, pour ceux dont le son arrive en retard (Bluetooth). Ça ne change que pour toi, et c'est gardé dans ton navigateur.

### Pochette au lieu de la vidéo
Quand il n'y a pas de vrai clip (titres d'albums YouTube Music « - Topic », vidéos « audio », « lyrics », « visualizer », et tout SoundCloud), le lecteur affiche la pochette en carré. Les vrais clips se jouent normalement.

### Comptes et profils
- Connecté avec Google, tu as un pseudo et une photo (celle de Google, ou ta propre image, recadrée et réduite automatiquement).
- Page profil : `/u/<id>` (menu `•••` → Mon profil, ou clic sur quelqu'un dans la liste des membres) avec le nombre de notes, la moyenne, la répartition des étoiles, les albums notés, les coups de cœur (5★) et un petit « profil de goût ».
- Les notes données avant de se connecter sont rattachées au compte à la connexion.


## Nouveautés (v3)

- **Ouvrir une salle** : on règle d'abord la salle (nom, type d'écoute, enchaînement, durée du décompte après les notes, qui contrôle la lecture, nombre de places, salle sur invitation), puis on arrive dedans. Les réglages sont gardés pour la prochaine fois, et le chef peut les changer à tout moment (icône réglages en haut, ou clic sur le nom de la salle).
- **Connecté = entrée directe** : plus d'écran « Entrer en tant que ». Les invités choisissent juste un pseudo.
- **Salle sur invitation** : les nouveaux attendent, le chef voit « Veulent entrer » dans la liste des personnes (pastille sur les avatars) et accepte ou refuse.
- **Salle pleine** : au-delà du nombre de places, l'entrée est refusée avec un message clair (le chef peut toujours revenir).
- **Barre du haut** : logo · nom de la salle (+ type et places) · code (clic = copier le lien) · personnes · réglages (chef) · ta photo (menu perso : profil, synchro du son, mode streamer, overlay OBS, déconnexion, quitter).
- **Demi-étoiles** : clic sur la moitié gauche d'une étoile = ,5 (3,5 / 4,5…). Aperçu au survol.
- **Ratings** (ratingsmusic.com) n'a pas d'API publique : impossible de noter directement sur ton compte. À la fin d'un album, « Reporter mes notes sur Ratings » copie tes notes converties sur 10 et ouvre Ratings.
- **Profil** : bio (160 caractères), album « en boucle en ce moment », top 4 de tous les temps, liens (Instagram, TikTok, SoundCloud, YouTube, X). Les albums se choisissent avec une recherche (catalogue Apple Music, gratuit, sans clé). La page prend la couleur de ton album du moment.
