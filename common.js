// Shared code for host.html and play.html: database adapter, CD row, confetti, helpers.
(function () {
  "use strict";

  const LETTERS = Array.from(MESSAGE.replace(/\s+/g, ""));
  const WORDS = MESSAGE.trim().split(/\s+/);
  const TOTAL = LETTERS.length;

  // ── Config sanity checks (shown in the console) ──────────────
  (function checkConfig() {
    const idx = SONGS.map((s) => s.letterIndex).sort((a, b) => a - b);
    const ok = idx.length === TOTAL && idx.every((v, i) => v === i);
    if (!ok) console.warn(`[Fassila] SONGS letterIndex values should use each number 0–${TOTAL - 1} exactly once.`);
    if (SONGS.length !== TOTAL) console.warn(`[Fassila] MESSAGE has ${TOTAL} letters but there are ${SONGS.length} songs.`);
  })();

  // ── Database ─────────────────────────────────────────────────
  function isFirebaseConfigured() {
    const c = typeof FIREBASE_CONFIG === "object" && FIREBASE_CONFIG;
    if (!c || !c.apiKey || !c.databaseURL) return false;
    return !/PASTE|YOUR-PROJECT/i.test(c.apiKey + c.databaseURL);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  const FIREBASE_VERSION = "10.12.2";

  async function connect() {
    if (isFirebaseConfigured()) {
      await loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-database-compat.js`);
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      return firebaseAdapter(firebase.database());
    }
    const lan = await detectLan();
    if (lan) return lanAdapter(lan);
    return localAdapter();
  }

  function firebaseAdapter(d) {
    const ref = (p) => (p ? d.ref(p) : d.ref());
    return {
      mode: "firebase",
      on(path, cb) {
        const r = ref(path);
        const h = (snap) => cb(snap.val());
        r.on("value", h, (err) => console.error("[Fassila] read failed:", path, err));
        return () => r.off("value", h);
      },
      get: (path) => ref(path).get().then((s) => s.val()),
      set: (path, v) => ref(path).set(v),
      update: (path, obj) => ref(path).update(obj),
      push: (path, v) => ref(path).push(v),
      transaction: (path, fn) => ref(path).transaction(fn).then((r) => r.committed),
      onConnection(cb) {
        const r = d.ref(".info/connected");
        const h = (s) => cb(s.val() === true);
        r.on("value", h);
        return () => r.off("value", h);
      },
    };
  }

  // ── Tree helpers shared by demo mode and Wi-Fi mode (Firebase-like: null deletes) ──
  const parts = (p) => String(p || "").split("/").filter(Boolean);
  const clean = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "object") return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x);
      if (c !== null) o[k] = c;
    }
    return Object.keys(o).length ? o : null;
  };
  const getAt = (tree, path) => {
    let n = tree;
    for (const k of parts(path)) {
      if (n === null || typeof n !== "object") return null;
      n = n[k];
    }
    return n === undefined ? null : n;
  };
  const setAt = (tree, path, val) => {
    const ks = parts(path);
    if (!ks.length) return clean(val) || {};
    let n = tree;
    const trail = [];
    for (let i = 0; i < ks.length - 1; i++) {
      if (n[ks[i]] === null || typeof n[ks[i]] !== "object") n[ks[i]] = {};
      trail.push([n, ks[i]]);
      n = n[ks[i]];
    }
    const c = clean(val);
    if (c === null) delete n[ks[ks.length - 1]];
    else n[ks[ks.length - 1]] = c;
    for (let i = trail.length - 1; i >= 0; i--) {
      const [p, k] = trail[i];
      if (p[k] && typeof p[k] === "object" && !Object.keys(p[k]).length) delete p[k];
    }
    return tree;
  };
  // Calls each listener whose path's value changed in `tree`.
  function notifyListeners(listeners, tree) {
    for (const l of listeners) {
      const json = JSON.stringify(getAt(tree, l.path));
      if (json !== l.last) {
        l.last = json;
        l.cb(JSON.parse(json));
      }
    }
  }

  // Is this page served by lan_server.py (Wi-Fi test mode)?
  async function detectLan() {
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch("api/ping", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.mode === "lan" ? j : null;
    } catch (e) {
      return null;
    }
  }

  // Wi-Fi mode: lan_server.py on the laptop holds the data and streams every change to all devices.
  function lanAdapter(info) {
    let tree = {};
    let version = -1;
    let connected = false;
    const listeners = new Set();
    const connListeners = new Set();
    const setConn = (up) => {
      if (up === connected) return;
      connected = up;
      connListeners.forEach((cb) => cb(up));
    };
    const apply = (data) => {
      if (!data || typeof data.version !== "number" || data.version < version) return;
      version = data.version;
      tree = data.tree || {};
      notifyListeners(listeners, tree);
    };
    const es = new EventSource("api/events");
    es.onmessage = (e) => { setConn(true); apply(JSON.parse(e.data)); };
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSource reconnects by itself
    async function write(ops) {
      const r = await fetch("api/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "write failed");
      apply(j);
      return j.results;
    }
    return {
      mode: "lan",
      base: info.base,
      on(path, cb) {
        const l = { path, cb, last: undefined };
        listeners.add(l);
        if (version >= 0) {
          setTimeout(() => {
            if (!listeners.has(l) || l.last !== undefined) return;
            l.last = JSON.stringify(getAt(tree, path));
            cb(JSON.parse(l.last));
          }, 0);
        }
        return () => listeners.delete(l);
      },
      async get(path) {
        const r = await fetch("api/db", { cache: "no-store" });
        apply(await r.json());
        return getAt(tree, path);
      },
      set: (path, v) => write([{ op: "set", path, value: v === undefined ? null : v }]),
      update: (path, obj) => write([{ op: "update", path, value: obj }]),
      async push(path, v) {
        const [res] = await write([{ op: "push", path, value: v }]);
        return { key: res.key };
      },
      async transaction(path, fn) {
        let cur = getAt(tree, path);
        for (let i = 0; i < 5; i++) {
          const next = fn(cur === null ? null : JSON.parse(JSON.stringify(cur)));
          if (next === undefined) return false;
          const [res] = await write([{ op: "cas", path, expect: cur, value: next }]);
          if (res.committed) return true;
          cur = res.current === undefined ? null : res.current;
        }
        return false;
      },
      onConnection(cb) {
        connListeners.add(cb);
        setTimeout(() => cb(connected), 0);
        return () => connListeners.delete(cb);
      },
    };
  }

  // Demo mode: the same API, stored in localStorage and synced across tabs of one browser.
  function localAdapter() {
    const KEY = "fassila-local-db";
    const listeners = new Set();
    const read = () => {
      try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
    };
    // Not re-entrant: a listener that writes (e.g. claiming the win) triggers a fresh pass
    // afterwards, instead of a nested one that the outer pass would overwrite with old data.
    let notifying = false, again = false;
    const notify = () => {
      if (notifying) { again = true; return; }
      notifying = true;
      try {
        do { again = false; notifyListeners(listeners, read()); } while (again);
      } finally {
        notifying = false;
      }
    };
    const write = (tree) => {
      localStorage.setItem(KEY, JSON.stringify(tree));
      notify();
    };
    window.addEventListener("storage", (e) => {
      if (e.key === KEY || e.key === null) notify();
    });
    let counter = 0;
    const api = {
      mode: "local",
      on(path, cb) {
        const l = { path, cb, last: undefined };
        listeners.add(l);
        setTimeout(() => {
          if (!listeners.has(l) || l.last !== undefined) return;
          const json = JSON.stringify(getAt(read(), path));
          l.last = json;
          cb(JSON.parse(json));
        }, 0);
        return () => listeners.delete(l);
      },
      get: async (path) => getAt(read(), path),
      set: async (path, v) => write(setAt(read(), path, v)),
      async update(path, obj) {
        let t = read();
        for (const [k, v] of Object.entries(obj)) t = setAt(t, (path ? path + "/" : "") + k, v);
        write(t);
      },
      async push(path, v) {
        const key = Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);
        await api.set(path + "/" + key, v);
        return { key };
      },
      async transaction(path, fn) {
        const t = read();
        const next = fn(getAt(t, path));
        if (next === undefined) return false;
        write(setAt(t, path, next));
        return true;
      },
      onConnection(cb) {
        setTimeout(() => cb(true), 0);
        return () => {};
      },
    };
    return api;
  }

  function showModeBanner(db) {
    const el = document.getElementById("mode-banner");
    if (!el) return;
    if (db.mode === "local") {
      el.textContent = "Demo mode: no Firebase config yet, so this only syncs between tabs in this browser.";
      el.hidden = false;
      return;
    }
    const normal = db.mode === "lan" ? "Wi-Fi test mode · synced through the laptop · set up Firebase before the party" : "";
    const lost = db.mode === "lan" ? "Can't reach the laptop. Reconnecting…" : "Reconnecting…";
    const paint = (text) => { el.textContent = text; el.hidden = !text; };
    paint(normal);
    let everConnected = false;
    db.onConnection((up) => {
      if (up) { everConnected = true; paint(normal); }
      else if (everConnected) paint(lost);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────
  function sanitizeNick(raw) {
    return String(raw || "")
      .replace(/[.#$\[\]\/\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16);
  }

  // Make Arabic letter guesses forgiving: أ/إ/آ → ا, ة → ه, ى → ي, drop diacritics.
  function normalizeLetter(raw) {
    return String(raw || "")
      .replace(/[ً-ْـ\s]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .toLowerCase();
  }

  function revealedSet(player) {
    const r = (player && player.revealed) || {};
    const set = new Set();
    for (const [k, v] of Object.entries(r)) if (v === true) set.add(Number(k));
    return set;
  }

  // ── CD row ───────────────────────────────────────────────────
  function makeCd(index) {
    const cd = document.createElement("button");
    cd.type = "button";
    cd.className = "cd";
    cd.dataset.index = index;
    cd.setAttribute("aria-label", `CD ${index + 1}: hidden`);
    cd.innerHTML =
      '<span class="cd-inner">' +
      '<span class="cd-face cd-front"><span class="cd-glyph">?</span></span>' +
      '<span class="cd-face cd-back"><span class="cd-glyph" lang="ar"></span></span>' +
      "</span>";
    return cd;
  }

  // Lays the CDs out right to left, one group per word.
  function buildCdRow(el) {
    el.innerHTML = "";
    el.classList.add("cd-row");
    el.setAttribute("dir", "rtl");
    const cds = [];
    let i = 0;
    for (const word of WORDS) {
      const w = document.createElement("span");
      w.className = "cd-word";
      for (const _ of Array.from(word)) {
        const cd = makeCd(i++);
        w.appendChild(cd);
        cds.push(cd);
      }
      el.appendChild(w);
    }
    return cds;
  }

  function flipCd(cd, animate) {
    if (cd.classList.contains("revealed")) return false;
    const i = Number(cd.dataset.index);
    cd.querySelector(".cd-back .cd-glyph").textContent = LETTERS[i];
    cd.setAttribute("aria-label", `CD ${i + 1}: ${LETTERS[i]}`);
    if (!animate) cd.classList.add("no-anim");
    cd.classList.add("revealed");
    if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => cd.classList.remove("no-anim")));
    return true;
  }

  function hideCd(cd) {
    cd.classList.remove("revealed", "selected");
    cd.querySelector(".cd-back .cd-glyph").textContent = "";
    cd.setAttribute("aria-label", `CD ${Number(cd.dataset.index) + 1}: hidden`);
  }

  // ── Confetti (tiny, dependency-free) ─────────────────────────
  const COLORS = ["#1E33CC", "#1E33CC", "#101C7A", "#C9A24A"];
  let canvas, ctx, particles = [], running = false;
  const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "confetti-canvas";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    addEventListener("resize", size);
  }

  function burst({ x = innerWidth / 2, y = innerHeight / 2, count = 40, power = 1, spread = Math.PI * 2, angle = -Math.PI / 2 } = {}) {
    ensureCanvas();
    if (document.hidden) return; // don't queue confetti nobody can see
    if (reduced) count = Math.ceil(count / 4);
    count = Math.min(count, 600 - particles.length);
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = (4 + Math.random() * 6) * power;
      particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        born: now,
        max: 1300 + Math.random() * 900, // ms
      });
    }
    if (!running) { running = true; requestAnimationFrame(tick); }
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const now = performance.now();
    particles = particles.filter((p) => now - p.born < p.max && p.y < innerHeight + 40);
    for (const p of particles) {
      p.life = now - p.born;
      p.vy += 0.22;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 1);
      ctx.restore();
    }
    if (particles.length) requestAnimationFrame(tick);
    else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  function smallConfetti(el) {
    const r = el ? el.getBoundingClientRect() : null;
    burst({ x: r ? r.left + r.width / 2 : innerWidth / 2, y: r ? r.top + r.height / 2 : innerHeight / 2, count: 36, power: 0.7 });
  }

  function bigConfetti() {
    const shots = [
      () => burst({ x: 0, y: innerHeight, count: 90, power: 1.7, angle: -Math.PI / 3, spread: 0.9 }),
      () => burst({ x: innerWidth, y: innerHeight, count: 90, power: 1.7, angle: (-2 * Math.PI) / 3, spread: 0.9 }),
      () => burst({ x: innerWidth / 2, y: innerHeight * 0.35, count: 120, power: 1.2 }),
    ];
    shots.forEach((s, i) => setTimeout(s, i * 250));
    setTimeout(() => shots.forEach((s) => s()), 1200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Everyone who flipped all their CDs. The first finisher (game/winner) is listed first.
  function winnersOf(game, players) {
    const first = game && game.winner;
    const set = new Set(Object.entries(players || {}).filter(([, p]) => p && p.finished === true).map(([n]) => n));
    if (first) set.add(first);
    return [...set].sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)));
  }
  // "Lina", "Lina & Omar", "Lina, Omar & Sara"
  function joinNames(list) {
    if (list.length <= 1) return list[0] || "";
    return list.slice(0, -1).join(", ") + " & " + list[list.length - 1];
  }

  // ── Lenient answer matching (used by the host page) ─────
  // Forgives typos, accents, Arabizi digits (3, 7, 9…), "el/al/the", hamza and taa-marbuta
  // variants and missing vowels. Arabic guesses are compared with Arabic answers and Latin
  // with Latin, so list both spellings in a song's `accept` list.
  const AR_RE = /[\u0600-\u06FF]/;
  const LATIN_SKIP = new Set(["the", "a", "an", "le", "la", "les", "l", "el", "al", "de", "du", "des", "d",
    "ft", "feat", "featuring", "and", "et", "wa", "w", "by", "par", "song", "chanson", "from", "of", "dyal", "ta3"]);
  const AR_SKIP = new Set(["و", "من", "ديال", "اغنية", "اغنيه"]);

  function baseNorm(s) {
    return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ء/g, "")
      .replace(/['’`´]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function latinWord(w) {
    return w.replace(/3/g, "a").replace(/7/g, "h").replace(/9/g, "k").replace(/5/g, "kh").replace(/2/g, "a")
      .replace(/ph/g, "f").replace(/kh/g, "k").replace(/gh/g, "g").replace(/ch|sh/g, "s").replace(/th/g, "t")
      .replace(/dj/g, "j").replace(/ck|q|c/g, "k")
      .replace(/ou|oo|u|o|w/g, "u").replace(/ee|ei|ai|ay|ey|ie|y|e|i/g, "i")
      .replace(/h/g, "").replace(/(.)\1+/g, "$1");
  }
  function arabicWord(w) {
    return w.replace(/[^\u0600-\u06FF]/g, "").replace(/^(وال|ال)(?=..)/, "").replace(/(.)\1+/g, "$1");
  }
  function guessTokens(s) {
    const n = baseNorm(s);
    const ar = AR_RE.test(n);
    const words = n.split(" ").filter(Boolean);
    const keep = words.filter((w) => !(ar ? AR_SKIP : LATIN_SKIP).has(w));
    const toks = (keep.length ? keep : words).map(ar ? arabicWord : latinWord).filter(Boolean);
    return { ar, toks };
  }
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }
  // Short words must match exactly (after vowel/spelling normalising): "dina" is not "zina".
  // Longer ones allow about one mistake per 5 letters.
  const needed = (len) => (len <= 4 ? 1 : len <= 7 ? 0.8 : 0.75);
  const wordsMatch = (x, y) => similarity(x, y) >= needed(Math.max(x.length, y.length));

  // Is `guess` close enough to one of `accepts`? `ignore` lists extra words that don't count
  // against the guess (e.g. the artist's name: "ya rayah rachid taha" still counts).
  function matchGuess(guess, accepts, ignore = []) {
    const g = guessTokens(guess);
    const gKey = g.toks.join("");
    if (gKey.length < 3) return { ok: false, score: 0 };
    const ignored = ignore.flatMap((x) => guessTokens(x).toks);
    let best = 0, bestAnswer = null;
    for (const answer of accepts) {
      const a = guessTokens(answer);
      if (a.ar !== g.ar || !a.toks.length) continue;
      // 1) the whole guess against the whole answer (spaces ignored: "yarayah")
      const aKey = a.toks.join("");
      const whole = similarity(gKey, aKey);
      const wholeOk = whole >= needed(Math.max(gKey.length, aKey.length));
      // 2) word by word: share of the answer's words found in the guess, lowered by unrelated
      //    extra words (artist names don't count as extra)
      const covered = a.toks.filter((at) => g.toks.some((gt) => wordsMatch(gt, at))).length / a.toks.length;
      const extra = g.toks.filter((gt) => !a.toks.some((at) => wordsMatch(gt, at)) && !ignored.some((x) => wordsMatch(gt, x))).length;
      const byWords = covered * (a.toks.length / (a.toks.length + extra));
      const score = wholeOk ? Math.max(whole, byWords, 0.75) : byWords;
      if (score > best) { best = score; bestAnswer = answer; }
    }
    return { ok: best >= 0.75, score: Math.round(best * 100) / 100, answer: bestAnswer };
  }

  window.Fassila = {
    LETTERS, WORDS, TOTAL,
    connect, showModeBanner, loadScript,
    sanitizeNick, normalizeLetter, revealedSet,
    buildCdRow, flipCd, hideCd,
    smallConfetti, bigConfetti, escapeHtml,
    winnersOf, joinNames, matchGuess,
  };
})();
