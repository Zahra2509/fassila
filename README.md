# فاصلة (Fassila)

A party guessing game. The host plays 10 songs. Players guess each one on their phones, and every correct song flips one of their CDs. In the final round they fill in the missing letters of the secret message. The first player to flip all 10 CDs wins.

It's a plain static website: no build step, no server code. The live sync runs on a free Firebase Realtime Database.

| File | What it is |
|---|---|
| `config.js` | **The only file you edit**: message, song titles, Firebase config |
| `host.html` / `host.js` | Host page, for your laptop |
| `play.html` / `play.js` | Player page, opened by scanning the QR code |
| `common.js` | Shared code: database, CD row, confetti |
| `style.css` | Styles |
| `database.rules.json` | Realtime Database security rules (paste into Firebase) |
| `lan_server.py` | Optional Wi-Fi test server: test on real phones without Firebase |

---

## What you need to fill in

In `config.js`:

1. **`FIREBASE_CONFIG`**: your Firebase web config (step 1 below).
2. **`SONGS[...].title`**: replace `"Song 1"` … `"Song 10"` with the real titles.
   - Optionally change each `letterIndex` (0–9) to choose which CD a song flips. Use each number exactly once. The letters are:
     `0 ن · 1 ه · 2 ا · 3 ر | 4 ز · 5 ي · 6 ن | 7 ه · 8 د · 9 ا`

That's it.

> **Demo mode.** While `FIREBASE_CONFIG` still has placeholders, the game runs in demo mode. Everything is stored in your browser and synced only between tabs of that browser, so you can try it on one laptop. Open `play.html?slot=2` in another tab to add a second test player.

---

## 1. Set up Firebase (free plan, about 5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project**. Any name works, and you can turn off Google Analytics.
2. In the left menu: **Build → Realtime Database → Create database**.
   - Pick a location close to the party.
   - Start in **locked mode**. You'll paste the real rules next.
3. Open the **Rules** tab, delete what's there, paste the contents of `database.rules.json`, and click **Publish**.
4. Go to **Project settings** (⚙️ next to "Project Overview") → **Your apps** → click the **`</>`** (Web) icon → register an app with any nickname. You don't need Firebase Hosting.
5. Firebase shows a `firebaseConfig = { ... }` object. Copy its values into `FIREBASE_CONFIG` in `config.js`.
   - Make sure `databaseURL` is there. It looks like `https://your-project-default-rtdb.firebaseio.com` (or `...firebasedatabase.app` in some regions). If it's missing, copy it from the top of the Realtime Database page.

### About the rules

The rules let **anyone read and write**, but only these paths, and only in the right shape:

- `game/currentSong`, `game/phase`, `game/announced`, `game/winner`
- `players/{nickname}/revealed/{0–9}` (`true`, and only once) and `players/{nickname}/finished`
- `guesses/{songId}/{pushId}` → `{ nickname, guess, time }`
- `claims/{songId}/{nickname}` (`true` = "I got it!", `false` = "Not me", once)

Everything else is blocked. There are no logins, so a tech-savvy guest *could* poke at the database with dev tools. Song titles and the message are also visible in `config.js` to anyone who digs. **For a casual party game that's fine.** Don't reuse this setup for anything with prizes worth cheating for.

---

## 2. Put it online

Pick one. Both are free.

### Option A: Netlify Drop (easiest)
1. Go to <https://app.netlify.com/drop>.
2. Drag the whole `Fassila` folder onto the page.
3. You get a URL like `https://cheerful-fox-123.netlify.app`. Your pages are:
   - Host: `https://cheerful-fox-123.netlify.app/host.html`
   - Players: `https://cheerful-fox-123.netlify.app/play.html`

   Without a free account, Drop sites expire after about an hour, so sign in to keep it. To update later, drag the folder again on the site's **Deploys** tab.

### Option B: GitHub Pages
1. Create a new **public** repository on GitHub and upload all the files (**Add file → Upload files**).
2. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)` → **Save**.
3. After a minute your site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`:
   - Host: `.../host.html`
   - Players: `.../play.html`

---

## 3. The QR code

1. Open **`host.html`** at its public URL on your laptop.
2. In the **Join the party** box, the player URL is pre-filled from the host URL (`.../play.html`). If it looks wrong, paste the public `play.html` URL and press **Save**. It's remembered on this laptop.
3. The QR code updates right away. Put it on the projector or TV and let everyone scan it.

(The QR code is drawn by a small library from cdnjs, so the host laptop needs internet. If it can't load, the link is shown as text instead.)

---

## Music clips (host only)

The host page can play each song's clips from YouTube's official embedded player. Nothing is downloaded. Sign in to YouTube (Premium) in the host browser to skip ads.

- **Next song / Previous song** plays that song's *guessing* clip (e.g. 1:00–1:05) and stops with a short fade.
- **Announce answer** plays the *reveal* clip (e.g. 1:20–1:50).
- **Play clip / Play reveal / Stop** let you replay or cut it.
- The music stops for the final round.

The real titles, artists, video IDs and clip times live in **`songs.private.js`**. That file is in `.gitignore`, so the readable list stays on your laptop. Set `lang: "ar"` for Arabic songs: their title and artist then show right-to-left in Arabic type, on the host screen and on players' phones when announced.

To put the songs online without giving away the answers, **lock** the list with a password:

```bash
python lock_songs.py
```

This writes `songs.locked.js` (AES-256 encrypted), which is safe to publish. The host page asks for the password once and remembers it on that laptop. Run the script again, and push, whenever you change a song.

The YouTube player shows the video, which gives away the answer. Keep the host screen to yourself rather than projecting it.

## Stage screen (projector)

`stage.html` is a big-screen view for the room. On the host page, click **Open stage screen** and drag that window to the projector or TV (press F11 for full screen). It must run in the **same browser on the same laptop** as the host page, which drives it live:

- **How to play:** a demo phone and the 5 steps, next to the QR code. You move through the steps while you explain: **Previous step / Next step** on the host page, or the arrow keys on the stage. It uses dummy letters, never the real message.
- **Song playing:** a spinning CD and an equalizer move while your clip plays, plus the live number of guesses.
- **Answer revealed:** the title and artist (Arabic right-to-left), with the YouTube video playing muted. The sound stays on the host laptop.
- **Final round:** a live leaderboard.
- **Winners:** everyone who cracked the code, with the secret message.

The **How to play** / **Show the game** buttons on the host page switch the stage, and it moves to the game by itself when the first clip plays.

**Several winners:** everyone who completes all 10 CDs on the same song shares the win. After the first player finishes, the others can still claim the song that was just announced. In the final round, everyone who completes before the game ends is a winner too.

## How to host a round

1. Players scan the QR code and pick a nickname. They show up under **Live progress**.
2. Play the song shown on your screen. The title is only visible to you.
3. Players type their guess (one per song).
4. Press **📣 Announce answer**. Everyone sees the title next to their own guess and taps **🎵 I got it!** or **❌ Not me**. Honour system: you never judge guesses.
5. **Next song →** and repeat. You can play songs in any order using **Next/Previous**.
6. Once every song has been announced, **🔤 Start final round** unlocks. Players tap their hidden CDs and type letters. Right letters flip, wrong ones get "Nope, try another one."
7. The first player to flip all 10 wins. Their phone shows the winner screen, everyone else sees "Game over", and your screen shows confetti 🎉.
8. **Reset game** wipes everything for the next party. Players stay signed in under the same nickname.

Small details:
- Guesses have a 3-second cooldown. After a wrong letter in the final round there's a 2-second pause, so nobody can spam the whole alphabet.
- Letter checks are forgiving: `أ/إ/آ` count as `ا`, `ة` as `ه`, `ى` as `ي`.
- The "Start final round" unlock is remembered in the host laptop's browser. Use the same laptop for the whole game.

---

## Testing before the party

### Wi-Fi test mode (real phones, no Firebase needed)

`lan_server.py` turns your laptop into a mini game server for phones on the **same Wi-Fi**. It serves the pages and relays every change between devices. It needs only Python (3.7+), with nothing to install. From the project folder:

```bash
python lan_server.py
```

It prints two addresses, for example:

```
Host (this laptop):  http://192.168.178.75:8080/host.html
Players (phones):    http://192.168.178.75:8080/play.html
```

Open the host address on the laptop and scan the QR code with your phone. Pages show a 📶 *Wi-Fi test mode* banner.

- **If the phone can't connect:** Windows Firewall is probably blocking Python. Set your Wi-Fi to **Private** (Settings → Network & internet → Wi-Fi → your network → *Network profile type*). Then in *Allow an app through Windows Firewall*, tick **Private** for Python.
- **Data lives in memory:** stopping the server (Ctrl+C) wipes the game.
- **Not for the real party:** it only works on that one Wi-Fi, and only while the laptop is running. If Firebase is configured in `config.js`, the pages use Firebase even when served by this script.

### Demo mode (one browser)

Any plain static server works too, and the game then syncs only between tabs of the same browser:

```bash
python -m http.server 8080
```

Open `http://localhost:8080/host.html` and `http://localhost:8080/play.html` (add `?slot=2` for a second player in the same browser).

Pages must be served over `http://`, not opened as `file://`.
