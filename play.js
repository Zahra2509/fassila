// فاصيلة — player page
(async function () {
  "use strict";
  const F = window.Fassila;
  const $ = (id) => document.getElementById(id);

  // ?slot=2 keeps a separate nickname per tab, so you can test several players in one browser.
  const SLOT = new URLSearchParams(location.search).get("slot");
  const NICK_KEY = "fassila-nickname" + (SLOT ? "-" + SLOT : "");
  const COOLDOWN_KEY = NICK_KEY + "-last-guess";
  const GUESS_COOLDOWN_MS = 3000;
  const LETTER_COOLDOWN_MS = 2000; // short pause after a wrong letter, so nobody machine-guns the alphabet

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  let db;
  try {
    db = await F.connect();
  } catch (e) {
    $("loading").textContent = "Couldn't reach the game server. Check your connection and refresh.";
    console.error(e);
    return;
  }
  F.showModeBanner(db);

  // ── Nickname ─────────────────────────────────────────────
  let me = F.sanitizeNick(store.get(NICK_KEY));
  if (!me) me = await askNickname();
  $("loading").hidden = true;
  $("who").textContent = "🎧 " + me;
  $("who").hidden = false;
  $("game").hidden = false;

  function askNickname() {
    $("loading").hidden = true;
    $("join").hidden = false;
    $("nick-input").focus();
    return new Promise((resolve) => {
      $("join-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const nick = F.sanitizeNick($("nick-input").value);
        const msg = $("join-msg");
        if (!nick) { setMsg(msg, "Gotta have a name!", "bad"); return; }
        const existing = await db.get("players/" + nick);
        if (existing) { setMsg(msg, "That name's taken! Try another one.", "bad"); return; }
        await db.set(`players/${nick}/finished`, false);
        store.set(NICK_KEY, nick);
        $("join").hidden = true;
        resolve(nick);
      });
    });
  }

  // ── State ───────────────────────────────────────────────
  const state = {
    game: undefined,   // undefined = not loaded yet, null = host hasn't started
    player: undefined,
    myGuess: undefined, // string, or null if no guess yet for the current song
    claim: undefined,   // true / false / null for the current song
    songKey: null,
  };
  let firstPlayerLoad = true;
  let winClaimed = false;
  let celebrated = false;
  let winnerDismissed = false;
  let letterLockUntil = 0;
  let selected = null;

  const cds = F.buildCdRow($("cd-row"));
  cds.forEach((cd) => cd.addEventListener("click", () => selectCd(Number(cd.dataset.index))));

  // ── Subscriptions ───────────────────────────────────────
  let unsubGuesses = () => {};
  let unsubClaim = () => {};

  db.on("game", (g) => {
    state.game = g;
    const song = g ? SONGS[g.currentSong] : null;
    const key = song ? String(song.id) : null;
    if (key !== state.songKey) {
      state.songKey = key;
      state.myGuess = undefined;
      state.claim = undefined;
      ["guess-msg", "claim-msg"].forEach((id) => setMsg($(id), "", "", false));
      unsubGuesses();
      unsubClaim();
      if (key) {
        unsubGuesses = db.on("guesses/" + key, (list) => {
          const mine = Object.values(list || {}).find((x) => x && x.nickname === me);
          state.myGuess = mine ? mine.guess : null;
          render();
        });
        unsubClaim = db.on(`claims/${key}/${me}`, (c) => {
          state.claim = c === null ? null : c;
          render();
        });
      }
    }
    render();
  });

  db.on("players/" + me, (p) => {
    // After a reset the host wipes all players: quietly sign back in.
    if (p === null) db.set(`players/${me}/finished`, false);
    state.player = p || {};
    render();
  });

  // ── Rendering ───────────────────────────────────────────
  function render() {
    const g = state.game;
    if (g === undefined || state.player === undefined) return;

    const revealed = F.revealedSet(state.player);
    syncCds(revealed);
    const count = revealed.size;
    $("count").textContent = `${count} / ${F.TOTAL} CDs`;

    const panels = ["panel-wait", "panel-guess", "panel-claim", "panel-final", "panel-over"];
    const show = (id) => panels.forEach((p) => ($(p).hidden = p !== id));

    if (!g) {
      $("song-label").textContent = "Get ready…";
      $("status").textContent = "The host hasn't started yet.";
      show("panel-wait");
      return;
    }

    // Winner check: all 10 flipped → claim the win (first one in wins).
    if (count >= F.TOTAL && !winClaimed) claimWin();
    if (count < F.TOTAL) winClaimed = false;

    const isFinal = g.phase === "final";
    $("song-label").textContent = isFinal ? "Final round!" : `Song ${g.currentSong + 1} of ${SONGS.length}`;
    document.querySelectorAll(".cd").forEach((cd) => cd.classList.toggle("selectable", isFinal && !g.winner && !cd.classList.contains("revealed")));

    // Game over
    if (g.winner) {
      setSelected(null);
      if (g.winner === me) {
        $("status").textContent = "You cracked it! 🏆";
        $("winner-title").textContent = `${me} cracked the code!`;
        $("winner-message").textContent = MESSAGE;
        $("over-title").textContent = `${me} cracked the code!`;
        $("over-message").textContent = MESSAGE;
        show("panel-over");
        if (!winnerDismissed) $("winner").hidden = false;
        if (!celebrated) { celebrated = true; F.bigConfetti(); }
      } else {
        $("status").textContent = "Game over!";
        $("over-title").textContent = `${g.winner} cracked the code!`;
        $("over-message").textContent = MESSAGE;
        show("panel-over");
        $("winner").hidden = true;
      }
      return;
    }
    $("winner").hidden = true;
    celebrated = false;
    winnerDismissed = false;

    if (isFinal) {
      show("panel-final");
      if (selected === null || revealed.has(selected)) setSelected(firstHidden(revealed));
      $("status").textContent = count >= F.TOTAL ? "All done!" : `${F.TOTAL - count} letter${F.TOTAL - count === 1 ? "" : "s"} to go. You've got this.`;
      return;
    }
    setSelected(null);

    const song = SONGS[g.currentSong];
    if (g.announced) {
      show("panel-claim");
      $("answer-title").textContent = g.announced;
      $("claim-guess").textContent = state.myGuess || "nothing 🤐";
      const msg = $("claim-msg");
      const buttons = $("claim-buttons");
      if (state.claim === true) {
        buttons.hidden = true;
        setMsg(msg, revealed.has(song.letterIndex) ? "Nailed it! CD flipped 💿" : "Nailed it!", "good", false);
        $("status").textContent = "Nice ear! Wait for the next song.";
      } else if (state.claim === false) {
        buttons.hidden = true;
        setMsg(msg, "No worries, the next one's yours.", "", false);
        $("status").textContent = "Shake it off. Next song coming up.";
      } else if (state.myGuess === null) {
        buttons.hidden = true;
        setMsg(msg, "No guess, no glory. Catch the next one!", "", false);
        $("status").textContent = "Answer's out!";
      } else if (state.myGuess === undefined) {
        buttons.hidden = true;
        $("status").textContent = "Answer's out!";
      } else {
        buttons.hidden = false;
        $("btn-got").disabled = $("btn-not").disabled = false;
        if (!msg.classList.contains("bad")) setMsg(msg, "Be honest… 👀", "", false);
        $("status").textContent = "Answer's out! Did you get it?";
      }
      return;
    }

    // Guessing
    show("panel-guess");
    const form = $("guess-form");
    if (typeof state.myGuess === "string") {
      form.hidden = true;
      $("guess-locked").hidden = false;
      $("guess-locked-text").textContent = state.myGuess;
      $("status").textContent = "Guess locked in. Fingers crossed 🤞";
    } else {
      form.hidden = false;
      $("guess-locked").hidden = true;
      $("status").textContent = "Listen up and type your guess!";
    }
  }

  function syncCds(revealed) {
    cds.forEach((cd, i) => {
      if (revealed.has(i)) {
        if (F.flipCd(cd, !firstPlayerLoad)) {
          if (!firstPlayerLoad) setTimeout(() => F.smallConfetti(cd), 250);
        }
      } else if (cd.classList.contains("revealed")) {
        F.hideCd(cd); // game was reset
      }
    });
    firstPlayerLoad = false;
  }

  function firstHidden(revealed) {
    for (let i = 0; i < F.TOTAL; i++) if (!revealed.has(i)) return i;
    return null;
  }

  function selectCd(i) {
    const g = state.game;
    if (!g || g.phase !== "final" || g.winner) return;
    if (F.revealedSet(state.player).has(i)) return;
    setSelected(i);
    $("letter-input").focus();
  }

  function setSelected(i) {
    selected = i;
    cds.forEach((cd, j) => cd.classList.toggle("selected", j === i));
    $("final-target").textContent = i === null ? "" : `(CD ${i + 1} picked)`;
  }

  function setMsg(el, text, kind, animate = true) {
    if (el.textContent === text && el.className.includes(kind || "msg")) return;
    el.textContent = text;
    el.className = "msg" + (kind ? " " + kind : "");
    if (animate) { void el.offsetWidth; el.classList.add("pop"); }
  }

  // ── Actions ─────────────────────────────────────────────
  // Sends a guess for the song at `songIndex`. Rejected unless that is the live song.
  async function submitGuess(songIndex, text) {
    const msg = $("guess-msg");
    text = String(text || "").trim();
    if (!text) { setMsg(msg, "Type something first!", "bad"); return false; }

    const now = Date.now();
    const last = Number(store.get(COOLDOWN_KEY)) || 0;
    if (now - last < GUESS_COOLDOWN_MS) { setMsg(msg, "Easy tiger, wait a sec...", "bad"); return false; }
    store.set(COOLDOWN_KEY, String(now));

    const live = await db.get("game");
    if (!live || live.phase !== "songs" || live.currentSong !== songIndex || live.announced || live.winner) {
      setMsg(msg, "Too late! That song's not playing anymore.", "bad");
      return false;
    }
    const song = SONGS[songIndex];
    const list = (await db.get("guesses/" + song.id)) || {};
    if (Object.values(list).some((x) => x && x.nickname === me)) {
      setMsg(msg, "One guess per song!", "bad");
      return false;
    }
    await db.push("guesses/" + song.id, { nickname: me, guess: text.slice(0, 100), time: now });
    setMsg(msg, "Locked in! 🔒", "good");
    return true;
  }

  async function claim(got) {
    const g = state.game;
    if (!g || g.phase !== "songs" || !g.announced || g.winner) return;
    if (state.claim === true || state.claim === false) return;
    if (got && typeof state.myGuess !== "string") return;
    const song = SONGS[g.currentSong];
    $("btn-got").disabled = $("btn-not").disabled = true;
    const updates = { [`claims/${song.id}/${me}`]: got };
    if (got && !F.revealedSet(state.player).has(song.letterIndex)) {
      updates[`players/${me}/revealed/${song.letterIndex}`] = true;
    }
    try {
      await db.update("", updates);
    } catch (e) {
      console.error(e);
      setMsg($("claim-msg"), "Hmm, that didn't stick. Try again?", "bad");
      $("btn-got").disabled = $("btn-not").disabled = false;
    }
  }

  // Final round: try `letter` on hidden CD `index`.
  async function fillLetter(index, letter) {
    const msg = $("letter-msg");
    const g = state.game;
    if (!g || g.phase !== "final" || g.winner) { setMsg(msg, "Not the final round yet!", "bad"); return false; }
    if (index === null || index === undefined || index < 0 || index >= F.TOTAL) { setMsg(msg, "Tap a mystery CD first!", "bad"); return false; }
    if (F.revealedSet(state.player).has(index)) { setMsg(msg, "That CD's already flipped!", "bad"); return false; }

    const guess = F.normalizeLetter(letter);
    if (!guess) { setMsg(msg, "Type a letter first!", "bad"); return false; }
    if (Array.from(guess).length !== 1) { setMsg(msg, "Just one letter!", "bad"); return false; }
    if (Date.now() < letterLockUntil) { setMsg(msg, "Easy tiger, wait a sec...", "bad"); return false; }

    if (guess === F.normalizeLetter(F.LETTERS[index])) {
      await db.set(`players/${me}/revealed/${index}`, true);
      setMsg(msg, "Yes! 💿", "good");
      return true;
    }
    letterLockUntil = Date.now() + LETTER_COOLDOWN_MS;
    setMsg(msg, "Nope, try another one.", "bad");
    const cd = cds[index];
    cd.classList.remove("shake");
    void cd.offsetWidth;
    cd.classList.add("shake");
    return false;
  }

  async function claimWin() {
    winClaimed = true;
    await db.set(`players/${me}/finished`, true);
    await db.transaction("game/winner", (cur) => (cur ? undefined : me));
  }

  // ── Wiring ──────────────────────────────────────────────
  $("guess-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.game) return;
    const ok = await submitGuess(state.game.currentSong, $("guess-input").value);
    if (ok) $("guess-input").value = "";
  });
  $("btn-got").addEventListener("click", () => claim(true));
  $("btn-not").addEventListener("click", () => claim(false));
  $("letter-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await fillLetter(selected, $("letter-input").value);
    $("letter-input").value = "";
    if (!ok) $("letter-input").focus();
  });
  $("winner-close").addEventListener("click", () => { winnerDismissed = true; $("winner").hidden = true; });

  // Handy for testing from the console.
  window.FassilaPlayer = { me, submitGuess, fillLetter, claim };
})();
