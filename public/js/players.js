// ─────────────────────────────────────────────────────────────
//  Les deux lecteurs (YouTube et SoundCloud) derrière une même
//  "télécommande". room.js ne sait pas lequel joue : il demande
//  juste play / pause / aller à X secondes.
// ─────────────────────────────────────────────────────────────
const playerEvents = { ended() {}, error() {}, playing() {}, meta() {}, ready() {} };

// ══════════ YouTube ══════════
const YTP = {
  player: null, ready: false, id: null, cuePos: 0,
  init() {
    this.player = new YT.Player('yt-player', {
      width: '100%', height: '100%',
      host: 'https://www.youtube.com',
      playerVars: {
        controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, modestbranding: 1,
        enablejsapi: 1,
        origin: location.origin,          // indique à YouTube quel site intègre la vidéo
        widget_referrer: location.href,
      },
      events: {
        onReady: () => { this.ready = true; playerEvents.ready(); },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) playerEvents.playing({ duration: this.duration() });
          if (e.data === YT.PlayerState.ENDED) playerEvents.ended();
        },
        // 2 = id invalide, 5 = erreur HTML5, 100 = supprimée, 101/150 = intégration refusée
        // (ou contrôle anti-robot de YouTube), 153 = site non identifié
        onError: (e) => playerEvents.error({ source: 'yt', code: e.data }),
      },
    });
  },
  load(item, start, autoplay) {
    this.id = item.id;
    this.cuePos = start;
    if (autoplay) this.player.loadVideoById({ videoId: item.id, startSeconds: start });
    else this.player.cueVideoById({ videoId: item.id, startSeconds: start });
  },
  play() { this.player.playVideo(); },
  pause() { this.player.pauseVideo(); },
  stop() { try { this.player.stopVideo(); } catch {} this.id = null; },
  seek(sec) {
    // Vidéo jamais lancée : seekTo la démarrerait, donc on la "repose" à la bonne seconde.
    // (utilisé seulement quand la salle est en pause, jamais pendant la lecture)
    if (this.status() === 'idle') { this.cuePos = sec; this.player.cueVideoById({ videoId: this.id, startSeconds: sec }); }
    else this.player.seekTo(sec, true);
  },
  time() { return this.status() === 'idle' ? this.cuePos : (this.player.getCurrentTime() || 0); },
  poll() {},
  duration() { return this.player.getDuration() || 0; },
  status() {
    const S = YT.PlayerState;
    return ({ [S.PLAYING]: 'playing', [S.BUFFERING]: 'buffering', [S.PAUSED]: 'paused', [S.ENDED]: 'ended' })[this.player.getPlayerState()] || 'idle';
  },
};

// ══════════ SoundCloud ══════════
const SC_OPTS = {
  auto_play: false, visual: true, show_comments: false, sharing: false, buying: false,
  download: false, show_user: true, hide_related: true, show_teaser: false, show_playcount: false,
};
const bigArt = (u) => (u || '').replace('-large.', '-t500x500.');

const SCP = {
  widget: null, ready: false, st: 'idle', loading: false,
  pos: 0, posAt: 0, dur: 0, pendingSeek: null, id: null,
  init() {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media';
    iframe.title = 'Lecteur SoundCloud';
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://api.soundcloud.com/tracks/293') + '&visual=true&auto_play=false';
    document.getElementById('sc-layer').appendChild(iframe);
    this.widget = SC.Widget(iframe);
    this.widget.bind(SC.Widget.Events.READY, () => {
      this.bindAll();
      if (!this.ready) { this.ready = true; playerEvents.ready(); }
    });
  },
  // (Re)branche les événements : certains navigateurs les perdent quand on change de son
  bindAll() {
    const E = SC.Widget.Events, w = this.widget;
    [E.PLAY, E.PLAY_PROGRESS, E.PAUSE, E.FINISH, E.ERROR].forEach((ev) => w.unbind(ev));
    w.bind(E.PLAY, () => this.markPlaying());
    w.bind(E.PLAY_PROGRESS, (e) => {
      this.pos = e.currentPosition / 1000;
      this.posAt = performance.now();
      if (this.st !== 'playing' && this.st !== 'ended') this.markPlaying();
    });
    w.bind(E.PAUSE, () => { if (this.st !== 'ended') this.st = 'paused'; });
    w.bind(E.FINISH, () => { this.st = 'ended'; playerEvents.ended(); });
    w.bind(E.ERROR, () => playerEvents.error({ source: 'sc' }));
  },
  markPlaying() {
    const first = this.st !== 'playing';
    this.st = 'playing';
    this.loading = false;
    if (!this.posAt) this.posAt = performance.now();
    if (this.pendingSeek != null) { this.widget.seekTo(this.pendingSeek * 1000); this.pos = this.pendingSeek; this.posAt = performance.now(); this.pendingSeek = null; }
    if (first) this.widget.getDuration((d) => { this.dur = d / 1000; playerEvents.playing({ duration: this.dur }); });
  },
  load(item, start, autoplay) {
    this.id = item.id;
    this.loading = true;
    this.loadAt = performance.now();
    this.st = 'idle';
    this.pos = start;
    this.posAt = 0;
    this.dur = item.duration || 0;
    this.pendingSeek = start > 0.5 ? start : null;
    this.widget.load(item.id, {
      ...SC_OPTS,
      auto_play: !!autoplay,
      callback: () => {
        this.loading = false;
        this.bindAll();
        this.widget.getCurrentSound((s) => s && playerEvents.meta({
          title: s.title, author: s.user?.username, artwork: bigArt(s.artwork_url || s.user?.avatar_url),
          duration: s.duration ? s.duration / 1000 : null,
        }));
      },
    });
  },
  play() { this.widget.play(); },
  pause() { this.widget.pause(); },
  stop() { try { this.widget.pause(); } catch {} this.id = null; this.st = 'idle'; },
  seek(sec) {
    this.pos = sec;
    this.posAt = performance.now();
    if (this.st === 'playing' || this.st === 'paused') this.widget.seekTo(sec * 1000);
    else this.pendingSeek = sec;
  },
  // On ne fait pas aveuglément confiance aux événements : on demande au lecteur son vrai état
  poll() {
    if (!this.ready || !this.id) return;
    if (this.loading && performance.now() - this.loadAt > 8000) this.loading = false;
    this.widget.isPaused((paused) => {
      if (!paused && this.st !== 'playing') this.markPlaying();
      else if (paused && this.st === 'playing') this.st = 'paused';
    });
    if (this.st === 'playing') this.widget.getPosition((ms) => { this.pos = ms / 1000; this.posAt = performance.now(); });
  },
  time() { return this.st === 'playing' ? this.pos + (performance.now() - this.posAt) / 1000 : this.pos; },
  duration() { return this.dur; },
  status() { return this.loading ? 'buffering' : this.st; },
};

const BACKENDS = { yt: YTP, sc: SCP };

// ══════════ Lecture du contenu des albums / playlists ══════════
// YouTube : un lecteur caché charge la playlist et nous donne la liste des vidéos
function readYouTubePlaylist(listId) {
  return new Promise((resolve) => {
    const host = document.getElementById('reader');
    const el = document.createElement('div');
    host.appendChild(el);
    let done = false, p;
    const finish = (ids) => {
      if (done) return;
      done = true;
      try { p.destroy(); } catch {}
      el.remove();
      resolve((ids || []).map((id) => ({ source: 'yt', id })));
    };
    p = new YT.Player(el, {
      width: 200, height: 200,
      playerVars: { listType: 'playlist', list: listId, autoplay: 0, origin: location.origin },
      events: {
        onReady: () => {
          p.mute();
          const tryGet = (n) => {
            const ids = p.getPlaylist();
            if (ids && ids.length) finish(ids);
            else if (n > 0) setTimeout(() => tryGet(n - 1), 300);
            else finish([]);
          };
          tryGet(25);
        },
        onError: () => finish([]),
      },
    });
    setTimeout(() => finish([]), 12000);
  });
}

// SoundCloud : pareil avec un widget caché (marche pour un titre, un album ou une playlist)
function readSoundCloud(url) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) + '&auto_play=false';
    document.getElementById('reader').appendChild(iframe);
    const w = SC.Widget(iframe);
    let done = false, lastCount = -1;
    const finish = (sounds) => {
      if (done) return;
      done = true;
      iframe.remove();
      resolve((sounds || []).filter((s) => s && s.id).map((s) => ({
        source: 'sc',
        id: s.permalink_url || `https://api.soundcloud.com/tracks/${s.id}`,
        title: s.title || '',
        author: s.user?.username || '',
        artwork: bigArt(s.artwork_url || s.user?.avatar_url),
        duration: s.duration ? s.duration / 1000 : null,
      })));
    };
    w.bind(SC.Widget.Events.READY, () => {
      // Pour les gros albums, SoundCloud charge la liste petit à petit : on attend qu'elle soit stable
      const poll = (n) => w.getSounds((sounds) => {
        const count = sounds ? sounds.length : 0;
        if (count && count === lastCount) return finish(sounds);
        lastCount = count;
        if (n > 0) setTimeout(() => poll(n - 1), 500);
        else finish(sounds);
      });
      poll(20);
    });
    w.bind(SC.Widget.Events.ERROR, () => finish([]));
    setTimeout(() => finish([]), 15000);
  });
}
