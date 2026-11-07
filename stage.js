// فاصلة — stage screen (projector).
// Game data comes from the database like every page. Music, the "how to play" slide and the
// revealed song's video come from the host page in the same browser, over a BroadcastChannel.
(async function () {
  "use strict";
  const F = window.Fassila;
  const $ = (id) => document.getElementById(id);
  const ARABIC = /[؀-ۿ]/;

  let db;
  try {
    db = await F.connect();
  } catch (e) {
    console.error(e);
    return;
  }
  F.showModeBanner(db);

  const st = {
    game: undefined, players: {}, guesses: {}, claims: {}, songKey: null,
    host: { view: "intro", music: null, reveal: null }, // last state sent by the host page
    hostSeen: false,
  };

  // ── Link to the host page ───────────────────────────────
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("fassila-stage") : null;
  if (channel) {
    channel.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === "state") {
        st.host = m; st.hostSeen = true; render();
        if (demoActive && hostStep() !== demoStep) demoGo(hostStep());
      }
    };
    channel.postMessage({ type: "hello" }); // ask the host for its current state
  }

  // ── Database ────────────────────────────────────────────
  let unsubGuesses = () => {};
  let unsubClaims = () => {};
  db.on("game", (g) => {
    st.game = g;
    const key = g ? String(SONGS[g.currentSong].id) : null;
    if (key !== st.songKey) {
      st.songKey = key;
      unsubGuesses(); unsubClaims();
      st.guesses = {}; st.claims = {};
      if (key) {
        unsubGuesses = db.on("guesses/" + key, (v) => { st.guesses = v || {}; render(); });
        unsubClaims = db.on("claims/" + key, (v) => { st.claims = v || {}; render(); });
      }
    }
    render();
  });
  db.on("players", (p) => { st.players = p || {}; render(); });

  // ── Views ───────────────────────────────────────────────
  const VIEWS = ["v-wait", "v-intro", "v-song", "v-reveal", "v-final", "v-win"];
  let currentView = null;
  function show(id) {
    if (id === currentView) return;
    currentView = id;
    VIEWS.forEach((v) => ($(v).hidden = v !== id));
    if (id === "v-intro") startDemo(); else stopDemo();
    if (id !== "v-reveal") stopVideo();
  }

  function pickView(g) {
    if (g === undefined) return "v-wait";
    if (g && g.winner) return "v-win";
    // Without the host page in this browser, guess: intro until the game has visibly started.
    const view = st.hostSeen ? st.host.view
      : (g && (g.announced || g.currentSong > 0 || g.phase === "final" || Object.keys(st.guesses).length) ? "game" : "intro");
    if (view === "intro") return "v-intro";
    if (!g) return "v-wait";
    if (g.phase === "final") return "v-final";
    return g.announced ? "v-reveal" : "v-song";
  }

  let celebrated = "";
  function render() {
    const g = st.game;
    const view = pickView(g);
    show(view);
    renderFooter(g);
    if (!g) return;

    if (view === "v-song") {
      $("song-num").textContent = `Song ${g.currentSong + 1} of ${SONGS.length}`;
      const m = st.host.music;
      const listening = !!(m && m.kind === "guess" && m.index === g.currentSong);
      $("listen").classList.toggle("playing", listening);
      $("song-status").textContent = listening ? "Listen closely…" : "Type your guess on your phone";
      const n = Object.keys(st.guesses).length;
      $("guess-count").textContent = `${n} guess${n === 1 ? "" : "es"} in`;
    }

    if (view === "v-reveal") {
      const r = st.host.reveal && st.host.reveal.index === g.currentSong ? st.host.reveal : null;
      let title = r ? r.title : g.announced;
      let artist = r ? r.artist : "";
      if (!r && g.announced.includes(" — ")) [title, artist] = g.announced.split(" — ");
      const ar = (r && r.lang === "ar") || ARABIC.test(title);
      for (const [id, text] of [["reveal-title", title], ["reveal-artist", artist]]) {
        $(id).textContent = text || "";
        $(id).lang = ar ? "ar" : "";
        $(id).dir = ar ? "rtl" : "ltr";
      }
      const got = Object.values(st.claims).filter((v) => v === true).length;
      $("got-count").textContent = `${got} got it`;
      const m = st.host.music;
      if (r && r.youtube && m && m.kind === "reveal" && m.index === g.currentSong) playVideo(r, m.token);
      else if (!m) pauseVideo();
    }

    if (view === "v-final") {
      const rows = Object.entries(st.players).map(([nick, p]) => ({ nick, count: F.revealedSet(p).size }))
        .sort((a, b) => b.count - a.count || a.nick.localeCompare(b.nick)).slice(0, 8);
      $("final-board").innerHTML = rows.map((r, k) => `
        <li><span class="rank">${String(k + 1).padStart(2, "0")}</span>
        <span class="name" dir="auto">${F.escapeHtml(r.nick)}</span>
        <span class="score">${r.count}/${F.TOTAL}</span>
        <span class="bar"><span style="width:${(r.count / F.TOTAL) * 100}%"></span></span></li>`).join("");
    }

    if (view === "v-win") {
      const winners = F.winnersOf(g, st.players);
      $("win-label").textContent = winners.length > 1 ? "Winners" : "Winner";
      $("win-names").textContent = `${F.joinNames(winners)} cracked the code!`;
      $("win-message").textContent = MESSAGE;
      const key = winners.join("|");
      if (key !== celebrated) { celebrated = key; F.bigConfetti(); }
    } else {
      celebrated = "";
    }
  }

  function renderFooter(g) {
    const n = Object.keys(st.players).length;
    $("player-count").textContent = n ? `${n} player${n === 1 ? "" : "s"}` : "";
    const cur = g ? g.currentSong : -1;
    const final = g && g.phase === "final";
    $("dots").innerHTML = SONGS.map((_, j) => {
      const cls = ["song-dot", final || j < cur ? "played" : "", !final && j === cur ? "current" : ""].join(" ");
      return `<span class="${cls}">${j + 1}</span>`;
    }).join("");
  }

  // ── Revealed song's video (muted: the host laptop plays the sound) ──
  let yt = null, ytReady = null, ytToken = null, ytMonitor = null;
  function ensureYt() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve) => {
      const make = () => {
        yt = new YT.Player("stage-yt", {
          width: 640, height: 360,
          playerVars: { rel: 0, playsinline: 1, controls: 0, modestbranding: 1 },
          events: { onReady: () => { yt.mute(); resolve(yt); } },
        });
      };
      if (window.YT && window.YT.Player) make();
      else { window.onYouTubeIframeAPIReady = make; F.loadScript("https://www.youtube.com/iframe_api").catch(() => {}); }
    });
    return ytReady;
  }
  async function playVideo(r, token) {
    if (token === ytToken) return; // already playing this one
    ytToken = token;
    $("stage-yt-wrap").hidden = false;
    await ensureYt();
    if (ytToken !== token) return;
    const [start, end] = r.range || [0, 30];
    yt.mute();
    yt.loadVideoById({ videoId: r.youtube, startSeconds: start });
    clearInterval(ytMonitor);
    ytMonitor = setInterval(() => {
      if (yt.getCurrentTime && yt.getCurrentTime() >= end) { yt.pauseVideo(); clearInterval(ytMonitor); }
    }, 200);
  }
  function pauseVideo() {
    clearInterval(ytMonitor);
    if (yt && yt.pauseVideo) yt.pauseVideo();
  }
  function stopVideo() {
    pauseVideo();
    ytToken = null;
    $("stage-yt-wrap").hidden = true;
  }

  // ── "How to play" demo phone ────────────────────────────
  const DUMMY = ["ب", "ت", "س", "ق", "ل", "م", "ك", "ج", "ف", "ع"]; // never the real message letters
  const demoCds = F.buildCdRow($("demo-cds"));
  let demoStep = 0;
  function demoReveal(indices) {
    demoCds.forEach((cd, i) => {
      const on = indices.includes(i);
      cd.querySelector(".cd-back .cd-glyph").textContent = on ? DUMMY[i] : "";
      cd.classList.toggle("revealed", on);
      cd.classList.remove("selected");
    });
  }
  function demoGo(step) {
    demoStep = step;
    $("demo-phone").dataset.state = step;
    document.querySelectorAll("#steps li").forEach((li, i) => li.classList.toggle("active", i === step));
    $("demo-song").textContent = step >= 3 ? "Final round!" : "Song 4 of 10";
    if (step <= 1) demoReveal([]);
    if (step === 2) { demoReveal([]); setTimeout(() => demoStep === 2 && demoReveal([5]), 900); }
    if (step === 3) { demoReveal([0, 2, 5, 7, 8]); demoCds[1].classList.add("selected"); }
    if (step === 4) demoReveal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }
  // The host moves through the steps (host page buttons, or arrow keys / clicks here).
  let demoActive = false;
  function hostStep() {
    const n = Number(st.host.demoStep);
    return Number.isInteger(n) && n >= 0 && n < 5 ? n : 0;
  }
  function startDemo() {
    demoActive = true;
    demoGo(hostStep());
  }
  function stopDemo() {
    demoActive = false;
  }
  function askStep(step) {
    step = Math.max(0, Math.min(4, step));
    if (channel && st.hostSeen) channel.postMessage({ type: "demo-step", step }); // host decides and echoes back
    else demoGo(step); // no host page in this browser: just move locally
  }
  document.addEventListener("keydown", (e) => {
    if (!demoActive) return;
    if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); askStep(demoStep + 1); }
    if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); askStep(demoStep - 1); }
  });
  document.querySelectorAll("#steps li").forEach((li, i) => li.addEventListener("click", () => askStep(i)));

  // ── QR code (same saved link as the host page) ──────────
  (async function drawQr() {
    let url;
    try { url = localStorage.getItem("fassila-player-url"); } catch (e) {}
    url = url || new URL("play.html", location.href).href;
    $("qr-url").textContent = url.replace(/^https?:\/\//, "");
    try {
      await F.loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
      new QRCode($("qr-box"), { text: url, width: 180, height: 180, colorDark: "#101C7A", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    } catch (e) { /* the link text is still there */ }
  })();

  render();
})();
