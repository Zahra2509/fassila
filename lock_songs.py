#!/usr/bin/env python3
"""
Fassila - lock the song list with a password.

Reads songs.private.js (readable, stays on your laptop) and writes songs.locked.js
(encrypted, safe to put on GitHub). The host page asks for the password once and
decrypts the list in the browser. Run this again whenever you change the songs.

    python lock_songs.py

Encryption: AES-256-GCM, key derived from your password with PBKDF2-SHA256.
The same scheme is decrypted by the browser's built-in Web Crypto API.
"""
import base64
import getpass
import json
import os
import sys

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
except ImportError:
    sys.exit("This needs the 'cryptography' package:  pip install cryptography")

ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(ROOT, "songs.private.js")
TARGET = os.path.join(ROOT, "songs.locked.js")
ITERATIONS = 250_000


def b64(data):
    return base64.b64encode(data).decode("ascii")


def main():
    if not os.path.exists(SOURCE):
        sys.exit("songs.private.js not found next to this script.")
    with open(SOURCE, "r", encoding="utf-8") as f:
        plain = f.read()
    if "SONG_DETAILS" not in plain:
        sys.exit("songs.private.js doesn't define SONG_DETAILS.")

    # FASSILA_PASSWORD lets scripts run this without a prompt (used for testing).
    password = os.environ.get("FASSILA_PASSWORD")
    if not password:
        password = getpass.getpass("Choose a host password: ")
        if getpass.getpass("Type it again: ") != password:
            sys.exit("The passwords don't match. Nothing was written.")
    if len(password) < 6:
        sys.exit("Use at least 6 characters.")

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(password.encode("utf-8"))
    data = AESGCM(key).encrypt(iv, plain.encode("utf-8"), None)  # ciphertext + 16-byte tag

    locked = {"v": 1, "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "data": b64(data)}
    with open(TARGET, "w", encoding="utf-8", newline="\n") as f:
        f.write("// Encrypted song list for the host page. Made by lock_songs.py; safe to publish.\n")
        f.write("const SONGS_LOCKED = " + json.dumps(locked) + ";\n")
    print("Locked! Wrote songs.locked.js. Remember your password: you'll type it once on the host laptop.")


if __name__ == "__main__":
    main()
