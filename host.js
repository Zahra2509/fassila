// فاصلة — host page
(async function () {
  "use strict";
  const F = window.Fassila;
  const $ = (id) => document.getElementById(id);
  const ANNOUNCED_KEY = "fassila-host-announced";
  const URL_KEY = "fassila-player-url";

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  // Real titles, artists and clip times come from either:
  //  - songs.private.js (readable, local only), or
  //  - songs.locked.js (encrypted with lock_songs.py, safe on GitHub): unlocked with the host password.
  const PASS_KEY = "fassila-host-password";
  let songsUnlocked = false;
  function applySongDetails(details) {
    SONGS.forEach((s) => Object.assign(s, details[s.id] || {}));
    songsUnlocked = true;
  }

  async function decryptSongs(locked, password) {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: bytes(locked.salt), iterations: locked.iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(locked.iv) }, key, bytes(locked.data));
    const source = new TextDecoder().decode(plain);
    // The file was encrypted and authenticated with your password, so it's your own code.
    return new Function(source + "\nreturn SONG_DETAILS;")();
  }

  async function tryUnlock(password, remember) {
    let details;
    try {
      details = await decryptSongs(SONGS_LOCKED, password);
    } catch (e) {
      return false; // wrong password (or a damaged file)
    }
    applySongDetails(details);
    if (remember) store.set(PASS_KEY, password);
    $("unlock").hidden = true;
    try { if (state.game) render(); } catch (e) { /* page still starting: it renders shortly */ }
    return true;
  }

  if (typeof SONG_DETAILS === "object" && SONG_DETAILS) {
    applySongDetails(SONG_DETAILS);
  } else if (typeof SONGS_LOCKED === "object" && SONGS_LOCKED) {
    const saved = store.get(PASS_KEY);
    if (!(saved && (await tryUnlock(saved, false)))) {
      if (saved) store.del(PASS_KEY); // password changed since last time
      $("unlock").hidden = false;
      $("unlock-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const ok = await tryUnlock($("unlock-input").value, true);
        $("unlock-msg").textContent = ok ? "" : "That's not the password. Try again.";
        $("unlock-msg").className = ok ? "msg" : "msg bad";
        if (ok) $("unlock-input").value = "";
      });
      $("unlock-input").focus();
    }
  }
  const ARABIC = /[؀-ۿ]/;
  const isArabic = (s) => s.lang === "ar" || ARABIC.test(s.title || "");
  // What players see after "Announce answer": "Title — Artist"
  const answerText = (s) => (s.artist ? `${s.title} — ${s.artist}` : s.title);
  function songHtml(s) {
    const attrs = isArabic(s) ? ' lang="ar" dir="rtl"' : ` lang="${s.lang || "en"}" dir="ltr"`;
    return `<span class="song-title"${attrs}>${F.escapeHtml(s.title)}</span>` +
      (s.artist ? `<span class="song-artist"${attrs}>${F.escapeHtml(s.artist)}</span>` : "");
  }

  let qrLib = null; // promise for the QR library script
  setupQr(); // works even before the database connects

  let db;
  try {
    db = await F.connect();
  } catch (e) {
    $("secret-title").textContent = "Couldn't reach Firebase. Check config.js and your connection.";
    console.error(e);
    return;
  }
  F.showModeBanner(db);

  // Wi-Fi mode opened as localhost: point the QR at the laptop's Wi-Fi address instead.
  if (db.mode === "lan" && db.base && !store.get(URL_KEY) && /^(localhost|127\.|\[::1\])/.test(location.hostname)) {
    const u = new URL("play.html", db.base).href;
    $("qr-input").value = u;
    drawQr(u);
  }

  const state = { game: undefined, players: {}, guesses: {}, claims: {}, songKey: null };
  let announcedSet = new Set(JSON.parse(store.get(ANNOUNCED_KEY) || "[]"));
  let celebratedWinner = null;
  const saveAnnounced = () => store.set(ANNOUNCED_KEY, JSON.stringify([...announcedSet]));
  const freshGame = () => ({ currentSong: 0, phase: "songs" });

  // ── Subscriptions ───────────────────────────────────────
  let unsubGuesses = () => {};
  let unsubClaims = () => {};

  db.on("game", (g) => {
    if (g === null) {
      db.set("game", freshGame()); // first run
      return;
    }
    state.game = g;
    if (g.announced) { announcedSet.add(g.currentSong); saveAnnounced(); }
    const key = String(SONGS[g.currentSong].id);
    if (key !== state.songKey) {
      state.songKey = key;
      unsubGuesses();
      unsubClaims();
      unsubGuesses = db.on("guesses/" + key, (v) => { state.guesses = v || {}; render(); });
      unsubClaims = db.on("claims/" + key, (v) => { state.claims = v || {}; render(); });
    }
    render();
  });

  db.on("players", (p) => { state.players = p || {}; render(); });

  // ── Rendering ───────────────────────────────────────────
  function render() {
    const g = state.game;
    if (!g) return;
    const i = g.currentSong;
    const song = SONGS[i];
    const isFinal = g.phase === "final";

    $("phase-label").textContent = isFinal ? "Final round" : "Now playing";
    $("big-song").textContent = isFinal ? "Final round!" : `Song ${i + 1} of ${SONGS.length}`;
    $("secret-title").innerHTML = isFinal ? "Players are filling in the blanks" : songHtml(song);
    renderMusic(song, g);
    $("secret-note").hidden = isFinal;
    $("cd-num").textContent = `${song.letterIndex + 1} (${F.LETTERS[song.letterIndex]})`;

    const guessCount = Object.keys(state.guesses).length;
    const gotCount = Object.values(state.claims).filter((v) => v === true).length;
    $("details").hidden = isFinal;
    $("stat-guesses").textContent = guessCount;
    $("stat-announced").textContent = g.announced ? "Out" : "Hidden";
    $("stat-claims").textContent = g.announced ? gotCount : "–";

    $("song-dots").innerHTML = SONGS.map((s, j) => {
      const cls = ["song-dot", announcedSet.has(j) ? "played" : "", !isFinal && j === i ? "current" : ""].join(" ");
      return `<span class="${cls}" title="Song ${j + 1}${announcedSet.has(j) ? " (announced)" : ""}">${j + 1}</span>`;
    }).join("");

    const over = !!g.winner;
    $("btn-prev").disabled = isFinal || over || i <= 0;
    $("btn-next").disabled = isFinal || over || i >= SONGS.length - 1;
    $("btn-announce").disabled = isFinal || over || !!g.announced;
    $("btn-announce").textContent = g.announced ? "Answer announced" : "Announce answer";
    const allPlayed = SONGS.every((_, j) => announcedSet.has(j));
    $("btn-final").disabled = isFinal || over;
    $("final-hint").textContent = isFinal
      ? "Final round is live. Players are filling in their letters."
      : allPlayed ? "All songs played. Ready when you are!" : `${announcedSet.size} of ${SONGS.length} songs announced so far.`;

    // Winner
    $("winner-banner").hidden = !over;
    if (over) {
      const winners = F.winnersOf(g, state.players);
      $("winner-name").textContent = `${F.joinNames(winners)} cracked the code!`;
      $("winner-banner").querySelector(".label").textContent = winners.length > 1 ? "We have winners" : "We have a winner";
      if (celebratedWinner !== winners.join("|")) { celebratedWinner = winners.join("|"); F.bigConfetti(); }
    } else {
      celebratedWinner = null;
    }

    renderBoard(F.winnersOf(g, state.players));
    pushStage();
  }

  function renderBoard(winners) {
    const won = new Set(winners);
    const rows = Object.entries(state.players).map(([nick, p]) => ({ nick, count: F.revealedSet(p).size }));
    rows.sort((a, b) => b.count - a.count || a.nick.localeCompare(b.nick));
    $("player-count").textContent = rows.length ? `${rows.length} player${rows.length === 1 ? "" : "s"}` : "No players yet";
    $("board-list").innerHTML = rows.length ? "" : '<li class="empty" style="display:block">Show them the QR code below.</li>';
    $("board-list").innerHTML += rows.map((r, k) => `
      <li class="${won.has(r.nick) ? "win" : ""}">
        <span class="rank">${won.has(r.nick) ? "WIN" : String(k + 1).padStart(2, "0")}</span>
        <span class="name" dir="auto">${F.escapeHtml(r.nick)}</span>
        <span class="score">${r.count}/${F.TOTAL}</span>
        <span class="bar"><span style="width:${(r.count / F.TOTAL) * 100}%"></span></span>
      </li>`).join("");
  }

  // ── Controls ────────────────────────────────────────────
  function goTo(i) {
    if (!state.game || i < 0 || i >= SONGS.length) return;
    playClip(i, "guess"); // new song: play its guessing clip (first, so the redraw below doesn't cue it paused)
    db.update("game", { currentSong: i, announced: null });
  }
  $("btn-prev").addEventListener("click", () => goTo(state.game.currentSong - 1));
  $("btn-next").addEventListener("click", () => goTo(state.game.currentSong + 1));

  $("btn-announce").addEventListener("click", () => {
    const g = state.game;
    if (!g || g.phase !== "songs" || g.announced) return;
    if (!songsUnlocked && !confirm("The song list is still locked, so players would only see \"Song " + (g.currentSong + 1) + "\". Announce anyway?")) return;
    announcedSet.add(g.currentSong);
    saveAnnounced();
    db.set("game/announced", answerText(SONGS[g.currentSong]).slice(0, 200));
    playClip(g.currentSong, "reveal"); // answer is out: play the reveal clip
  });

  $("btn-final").addEventListener("click", () => {
    const g = state.game;
    if (!g || g.phase !== "songs" || g.winner) return;
    const left = SONGS.length - SONGS.filter((_, j) => announcedSet.has(j)).length;
    if (left > 0 && !confirm(`${left} song${left === 1 ? " hasn't" : "s haven't"} been announced yet. Start the final round anyway? There's no going back to the songs.`)) return;
    stopClip("Music off for the final round.");
    db.update("game", { phase: "final", announced: null });
  });

  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("Reset the whole game? Every player loses their CDs and guesses.")) return;
    stopClip("");
    announcedSet = new Set();
    store.del(ANNOUNCED_KEY);
    await db.update("", { game: freshGame(), players: null, guesses: null, claims: null });
  });

  // ── Music: YouTube clips ────────────────────────────────
  // Uses YouTube's official embedded player: nothing is downloaded. Sign in to YouTube
  // (Premium) in this browser to skip ads. Clips fade out over the last FADE seconds.
  const FADE = 0.8;
  let yt = null;          // YT.Player
  let ytReady = null;     // promise, resolves when the player can take commands
  let monitor = null;     // interval checking the clip's end
  let playing = null;     // { index, kind, end }
  let loadedId = null;    // video currently loaded in the player

  const toSec = (v) => {
    if (typeof v === "number") return v;
    const p = String(v || "0").trim().split(":").map(Number);
    return p.reduce((acc, n) => acc * 60 + (n || 0), 0);
  };
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
  const clipRange = (s, kind) => (s[kind] ? [toSec(s[kind][0]), toSec(s[kind][1])] : null);

  function ensurePlayer(videoId) {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      const create = () => {
        yt = new YT.Player("yt-player", {
          width: 356, height: 200, videoId,
          playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
          events: { onReady: () => resolve(yt), onError: (e) => onYtError(e) },
        });
      };
      if (window.YT && window.YT.Player) return create();
      window.onYouTubeIframeAPIReady = create;
      F.loadScript("https://www.youtube.com/iframe_api").catch((e) => { ytReady = null; reject(e); });
    });
    return ytReady;
  }

  function onYtError(e) {
    clearInterval(monitor);
    playing = null;
    const s = SONGS[state.game ? state.game.currentSong : 0];
    const link = s.youtube ? `https://music.youtube.com/watch?v=${s.youtube}` : s.link;
    setMusicStatus(`YouTube won't play this one here (error ${e.data}).`, link);
  }

  function setMusicStatus(text, link) {
    const el = $("music-status");
    el.textContent = text;
    if (link) {
      const a = document.createElement("a");
      a.href = link; a.target = "_blank"; a.rel = "noopener";
      a.textContent = " Open it on YouTube Music";
      el.appendChild(a);
    }
  }

  async function playClip(index, kind) {
    const s = SONGS[index];
    const range = clipRange(s, kind);
    if (!s.youtube || !range) {
      stopClip("");
      setMusicStatus(`No video for song ${index + 1} yet. Play it yourself.`, s.link);
      return;
    }
    const [start, end] = range;
    // Claim the player for this song right away, before any await, so the page redraw
    // triggered by changing song doesn't load it "paused" over our play request.
    loadedId = s.youtube;
    try {
      await ensurePlayer(s.youtube);
    } catch (e) {
      setMusicStatus("Couldn't load YouTube. Check the internet connection.", s.link);
      return;
    }
    clearInterval(monitor);
    playing = { index, kind, end, token: Date.now() };
    if (kind === "guess") setStageView("game"); // the game has started: leave "How to play"
    pushStage();
    yt.setVolume(100);
    yt.loadVideoById({ videoId: s.youtube, startSeconds: start });
    loadedId = s.youtube;
    setMusicStatus(`Playing the ${kind === "guess" ? "guessing clip" : "reveal"}: ${fmt(start)} to ${fmt(end)}`);
    monitor = setInterval(() => {
      if (!yt || !playing) return;
      const t = yt.getCurrentTime ? yt.getCurrentTime() : 0;
      if (t < start - 1) return; // still seeking
      const left = end - t;
      if (left <= 0) { stopClip(kind === "guess" ? "Clip done. Replay it if they beg." : "Reveal done."); return; }
      if (left < FADE) yt.setVolume(Math.max(0, Math.round((left / FADE) * 100)));
    }, 80);
  }

  function stopClip(message) {
    clearInterval(monitor);
    playing = null;
    if (yt && yt.pauseVideo) { yt.pauseVideo(); yt.setVolume(100); }
    if (message !== undefined) setMusicStatus(message);
    pushStage();
  }

  function renderMusic(song, g) {
    const isFinal = g.phase === "final";
    $("music").hidden = isFinal;
    if (isFinal) return;
    const hasVideo = !!song.youtube;
    const guess = clipRange(song, "guess");
    const reveal = clipRange(song, "reveal");
    $("btn-play-guess").textContent = guess ? `Play clip ${fmt(guess[0])}–${fmt(guess[1])}` : "Play clip";
    $("btn-play-reveal").textContent = reveal ? `Play reveal ${fmt(reveal[0])}–${fmt(reveal[1])}` : "Play reveal";
    $("btn-play-guess").disabled = !hasVideo || !guess;
    $("btn-play-reveal").disabled = !hasVideo || !reveal;
    $("btn-stop").disabled = !hasVideo;
    if (hasVideo && !ytReady) { loadedId = song.youtube; ensurePlayer(song.youtube).catch(() => {}); }
    // Keep the idle player on the current song (e.g. after a reset or Previous song)
    if (hasVideo && yt && yt.cueVideoById && !playing && loadedId !== song.youtube) {
      yt.cueVideoById(song.youtube);
      loadedId = song.youtube;
    }
    if (!hasVideo && !playing) setMusicStatus(`No video for this song yet. Play it yourself.`, song.link);
    else if (hasVideo && !playing && !$("music-status").textContent) setMusicStatus("Press Next song to start, or play the clip from here.");
  }

  $("btn-play-guess").addEventListener("click", () => state.game && playClip(state.game.currentSong, "guess"));
  $("btn-play-reveal").addEventListener("click", () => state.game && playClip(state.game.currentSong, "reveal"));
  $("btn-stop").addEventListener("click", () => stopClip("Stopped."));

  // ── Stage screen (projector) ────────────────────────────
  // stage.html, opened in this same browser, listens on this channel. It gets the view
  // ("How to play" or the game), what's playing, and the revealed song's details.
  const STAGE_VIEW_KEY = "fassila-stage-view";
  const stageChannel = "BroadcastChannel" in window ? new BroadcastChannel("fassila-stage") : null;
  let stageView = store.get(STAGE_VIEW_KEY) || "intro";
  const DEMO_STEPS = ["Scan and pick a nickname", "Listen, then guess", "Be honest", "Final round", "Crack the code"];
  let demoStep = 0;

  function stageState() {
    const g = state.game;
    const s = g ? SONGS[g.currentSong] : null;
    return {
      type: "state",
      view: stageView,
      demoStep,
      music: playing ? { kind: playing.kind, index: playing.index, token: playing.token } : null,
      reveal: g && g.announced && s ? {
        index: g.currentSong, title: s.title, artist: s.artist || "",
        lang: isArabic(s) ? "ar" : (s.lang || "en"),
        youtube: s.youtube || "", range: clipRange(s, "reveal"),
      } : null,
    };
  }
  function pushStage() {
    if (stageChannel) stageChannel.postMessage(stageState());
    $("btn-stage-intro").classList.toggle("btn-primary", stageView === "intro");
    $("btn-stage-intro").classList.toggle("btn-ghost", stageView !== "intro");
    $("btn-stage-game").classList.toggle("btn-primary", stageView === "game");
    $("btn-stage-game").classList.toggle("btn-ghost", stageView !== "game");
    $("demo-controls").hidden = stageView !== "intro";
    $("demo-now").textContent = `Step ${demoStep + 1} of ${DEMO_STEPS.length}: ${DEMO_STEPS[demoStep]}`;
    $("btn-demo-prev").disabled = demoStep === 0;
    $("btn-demo-next").disabled = demoStep === DEMO_STEPS.length - 1;
    $("stage-hint").textContent = stageView === "intro"
      ? "Showing How to play. It switches to the game when the first clip plays."
      : "Showing the game.";
  }
  function setStageView(v) {
    if (stageView === v) return;
    stageView = v;
    store.set(STAGE_VIEW_KEY, v);
    pushStage();
  }
  function setDemoStep(step) {
    demoStep = Math.max(0, Math.min(DEMO_STEPS.length - 1, step));
    pushStage();
  }
  if (stageChannel) stageChannel.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "hello") pushStage();
    if (m.type === "demo-step") setDemoStep(Number(m.step) || 0); // arrow keys / clicks on the stage
  };
  $("btn-demo-prev").addEventListener("click", () => setDemoStep(demoStep - 1));
  $("btn-demo-next").addEventListener("click", () => setDemoStep(demoStep + 1));
  $("btn-open-stage").addEventListener("click", () => window.open("stage.html", "fassila-stage"));
  $("btn-stage-intro").addEventListener("click", () => { demoStep = 0; setStageView("intro"); pushStage(); });
  $("btn-stage-game").addEventListener("click", () => setStageView("game"));
  if (!stageChannel) $("stage-hint").textContent = "This browser can't link to the stage screen.";

  // ── QR code ─────────────────────────────────────────────
  function defaultPlayerUrl() {
    return new URL("play.html", location.href).href;
  }

  function normalizeUrl(raw) {
    let u = String(raw || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    if (/\/host\.html(\?.*)?$/i.test(u)) u = u.replace(/host\.html(\?.*)?$/i, "play.html");
    else if (u.endsWith("/")) u += "play.html";
    return u;
  }

  function setupQr() {
    const saved = store.get(URL_KEY);
    $("qr-input").value = saved || defaultPlayerUrl();
    drawQr(saved || defaultPlayerUrl());
    $("qr-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const u = normalizeUrl($("qr-input").value);
      if (!u) return;
      store.set(URL_KEY, u);
      $("qr-input").value = u;
      drawQr(u);
    });
  }

  async function drawQr(url, attempt = 1) {
    const box = $("qr-box");
    $("qr-url").textContent = url;
    if (/^file:/i.test(url)) {
      box.innerHTML = '<p class="empty">Paste your public URL below to get a QR code.</p>';
      return;
    }
    try {
      if (!qrLib) qrLib = F.loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
      await qrLib;
      box.innerHTML = "";
      new QRCode(box, { text: url, width: 240, height: 240, colorDark: "#101C7A", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    } catch (e) {
      qrLib = null; // allow a fresh attempt
      if (attempt < 4) {
        box.innerHTML = '<p class="empty">Making your QR code…</p>';
        setTimeout(() => drawQr(url, attempt + 1), 2000 * attempt);
      } else {
        box.innerHTML = '<p class="empty">Couldn\'t load the QR maker. Share the link below, or press Save to retry.</p>';
      }
    }
  }
})();
