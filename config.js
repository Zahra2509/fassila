// ─────────────────────────────────────────────────────────────
//  فاصيلة (Fassila) — game config. This is the only file you edit.
// ─────────────────────────────────────────────────────────────

// The secret message. Spaces split it into words (shown with a gap).
// It has 10 letters, one per CD. Index 0 is the first (rightmost) letter.
//   0 ن  1 ه  2 ا  3 ر   |   4 ز  5 ي  6 ن   |   7 ه  8 د  9 ا
const MESSAGE = "نهار زين هدا";

// The 10 songs. Fill in the real titles.
//  - id:          stable id for the database (keep 1–10).
//  - title:       the real song title. Players see it only after you press "Announce answer".
//  - letterIndex: which CD (0–9) this song flips. Use each number 0–9 exactly once.
// The order here is the order of the host's "Next song" button.
const SONGS = [
  { id: 1,  title: "Song 1",  letterIndex: 3 },
  { id: 2,  title: "Song 2",  letterIndex: 7 },
  { id: 3,  title: "Song 3",  letterIndex: 0 },
  { id: 4,  title: "Song 4",  letterIndex: 9 },
  { id: 5,  title: "Song 5",  letterIndex: 5 },
  { id: 6,  title: "Song 6",  letterIndex: 1 },
  { id: 7,  title: "Song 7",  letterIndex: 8 },
  { id: 8,  title: "Song 8",  letterIndex: 2 },
  { id: 9,  title: "Song 9",  letterIndex: 6 },
  { id: 10, title: "Song 10", letterIndex: 4 },
];

// Paste your Firebase web config here (Firebase console → Project settings → Your apps).
// While this still holds the placeholders, the game runs in local DEMO MODE: it only
// syncs between tabs in the same browser, which is handy for trying it out.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCTrwX9D5YINabG4JHyUUq2sQdU6lENIRI",
  authDomain: "fassila-mor.firebaseapp.com",
  databaseURL: "https://fassila-mor-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fassila-mor",
  storageBucket: "fassila-mor.firebasestorage.app",
  messagingSenderId: "272755859567",
  appId: "1:272755859567:web:ecdf0ef14a9778dd1f2d9a",
};
