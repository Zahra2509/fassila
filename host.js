// فاصيلة — host page
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
    $("secret-title").textContent = isFinal ? "Players are filling in the blanks" : song.title;
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
      $("winner-name").textContent = `${g.winner} cracked the code!`;
      if (celebratedWinner !== g.winner) { celebratedWinner = g.winner; F.bigConfetti(); }
    } else {
      celebratedWinner = null;
    }

    renderBoard(g.winner);
  }

  function renderBoard(winner) {
    const rows = Object.entries(state.players).map(([nick, p]) => ({ nick, count: F.revealedSet(p).size }));
    rows.sort((a, b) => b.count - a.count || a.nick.localeCompare(b.nick));
    $("player-count").textContent = rows.length ? `${rows.length} player${rows.length === 1 ? "" : "s"}` : "No players yet";
    $("board-list").innerHTML = rows.length ? "" : '<li class="empty" style="display:block">Show them the QR code below.</li>';
    $("board-list").innerHTML += rows.map((r, k) => `
      <li class="${r.nick === winner ? "win" : ""}">
        <span class="rank">${r.nick === winner ? "WIN" : String(k + 1).padStart(2, "0")}</span>
        <span class="name">${F.escapeHtml(r.nick)}</span>
        <span class="score">${r.count}/${F.TOTAL}</span>
        <span class="bar"><span style="width:${(r.count / F.TOTAL) * 100}%"></span></span>
      </li>`).join("");
  }

  // ── Controls ────────────────────────────────────────────
  function goTo(i) {
    if (!state.game || i < 0 || i >= SONGS.length) return;
    db.update("game", { currentSong: i, announced: null });
  }
  $("btn-prev").addEventListener("click", () => goTo(state.game.currentSong - 1));
  $("btn-next").addEventListener("click", () => goTo(state.game.currentSong + 1));

  $("btn-announce").addEventListener("click", () => {
    const g = state.game;
    if (!g || g.phase !== "songs" || g.announced) return;
    announcedSet.add(g.currentSong);
    saveAnnounced();
    db.set("game/announced", SONGS[g.currentSong].title);
  });

  $("btn-final").addEventListener("click", () => {
    const g = state.game;
    if (!g || g.phase !== "songs" || g.winner) return;
    const left = SONGS.length - SONGS.filter((_, j) => announcedSet.has(j)).length;
    if (left > 0 && !confirm(`${left} song${left === 1 ? " hasn't" : "s haven't"} been announced yet. Start the final round anyway? There's no going back to the songs.`)) return;
    db.update("game", { phase: "final", announced: null });
  });

  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("Reset the whole game? Every player loses their CDs and guesses.")) return;
    announcedSet = new Set();
    store.del(ANNOUNCED_KEY);
    await db.update("", { game: freshGame(), players: null, guesses: null, claims: null });
  });

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
