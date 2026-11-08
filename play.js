// فاصلة — player page
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
  $("who").textContent = "Playing as " + me;
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
    all: {},            // every player, to name all the winners
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
    const key = g ? roundKey(g) : null;
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

  db.on("players", (all) => { state.all = all || {}; render(); });

  // "demo" during the practice round, else the current song's id
  function roundKey(g) {
    return g.phase === "demo" ? "demo" : String(SONGS[g.currentSong].id);
  }

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
    const isDemo = g.phase === "demo";
    $("song-label").textContent = isFinal ? "Final round!" : isDemo ? "Practice round" : `Song ${g.currentSong + 1} of ${SONGS.length}`;
    document.querySelectorAll(".cd").forEach((cd) => cd.classList.toggle("selectable", isFinal && !g.winner && !cd.classList.contains("revealed")));

    // Game over: everyone who completes all 10 CDs wins. During the songs, players who
    // haven't claimed the current song yet can still claim it, so ties share the win.
    const iWon = count >= F.TOTAL;
    const canStillClaim = g.winner && !iWon && g.phase === "songs" && g.announced &&
      typeof state.myGuess === "string" && (state.claim === null || state.claim === undefined);
    if (g.winner && !canStillClaim) {
      setSelected(null);
      const winners = F.winnersOf(g, state.all);
      const headline = `${F.joinNames(winners)} cracked the code!`;
      $("over-title").textContent = headline;
      $("over-message").textContent = MESSAGE;
      show("panel-over");
      if (iWon) {
        $("status").textContent = "You cracked it.";
        $("winner-title").textContent = headline;
        $("winner-message").textContent = MESSAGE;
        if (!winnerDismissed) $("winner").hidden = false;
        if (!celebrated) { celebrated = true; F.bigConfetti(); }
      } else {
        $("status").textContent = "Game over!";
        $("winner").hidden = true;
      }
      return;
    }
    $("winner").hidden = true;
    if (!g.winner) { celebrated = false; winnerDismissed = false; }

    if (isFinal) {
      show("panel-final");
      if (selected === null || revealed.has(selected)) setSelected(firstHidden(revealed));
      $("status").textContent = count >= F.TOTAL ? "All done!" : `${F.TOTAL - count} letter${F.TOTAL - count === 1 ? "" : "s"} to go. You've got this.`;
      return;
    }
    setSelected(null);

    if (g.announced) {
      show("panel-claim");
      $("answer-title").textContent = g.announced;
      const arabicAnswer = /[؀-ۿ]/.test(g.announced);
      $("answer-title").lang = arabicAnswer ? "ar" : "";
      $("answer-title").dir = arabicAnswer ? "rtl" : "auto";
      $("claim-guess").textContent = state.myGuess || "nothing";
      const msg = $("claim-msg");
      $("claim-buttons").hidden = true; // the host page checks guesses now
      if (state.claim === true) {
        setMsg(msg, isDemo ? "Correct! In the real game, that flips a CD." : "Correct! Your CD flipped.", "good", false);
        $("status").textContent = isDemo ? "That's how it works. Get ready!" : "Nice ear! Wait for the next song.";
      } else if (state.claim === false) {
        setMsg(msg, "Not this time. The next one's yours.", "", false);
        $("status").textContent = isDemo ? "Just practice. The real game starts soon." : "Shake it off. Next song coming up.";
      } else if (state.myGuess === null) {
        setMsg(msg, "No guess, no glory. Catch the next one!", "", false);
        $("status").textContent = "Answer's out!";
      } else {
        setMsg(msg, "Checking your answer…", "", false);
        $("status").textContent = "Answer's out!";
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
      $("status").textContent = "Guess locked in. Fingers crossed.";
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
  // Sends a guess for round `key` ("demo" or a song id). Rejected unless that round is live.
  async function submitGuess(key, text) {
    const msg = $("guess-msg");
    text = String(text || "").trim();
    if (!text) { setMsg(msg, "Type something first!", "bad"); return false; }

    const now = Date.now();
    const last = Number(store.get(COOLDOWN_KEY)) || 0;
    if (now - last < GUESS_COOLDOWN_MS) { setMsg(msg, "Easy tiger, wait a sec...", "bad"); return false; }
    store.set(COOLDOWN_KEY, String(now));

    const live = await db.get("game");
    if (!live || (live.phase !== "songs" && live.phase !== "demo") || roundKey(live) !== String(key) || live.announced || live.winner) {
      setMsg(msg, "Too late! That song's not playing anymore.", "bad");
      return false;
    }
    const list = (await db.get("guesses/" + key)) || {};
    if (Object.values(list).some((x) => x && x.nickname === me)) {
      setMsg(msg, "One guess per song!", "bad");
      return false;
    }
    await db.push("guesses/" + key, { nickname: me, guess: text.slice(0, 100), time: now });
    setMsg(msg, "Locked in!", "good");
    return true;
  }

  async function claim(got) {
    const g = state.game;
    if (!g || g.phase !== "songs" || !g.announced) return; // still allowed after a winner: ties share the win
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
      setMsg(msg, "Yes! That's the one.", "good");
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
    const ok = await submitGuess(roundKey(state.game), $("guess-input").value);
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
