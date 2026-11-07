#!/usr/bin/env python3
"""
Fassila - Wi-Fi test mode.

Serves the game AND acts as a tiny live database, so phones on the same Wi-Fi
as this laptop can play together without Firebase. For testing only: all data
lives in memory and disappears when you stop the server.

    python lan_server.py          (port 8080)
    python lan_server.py 9000     (another port)

Uses only the Python standard library (3.7+).
"""
import json
import os
import socket
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
MAX_BODY = 200_000

cond = threading.Condition()
state = {"tree": {}, "version": 0, "counter": 0}


# ── Tree helpers (same semantics as Firebase: null deletes, empty objects vanish) ──
def parts(path):
    return [p for p in str(path or "").split("/") if p]


def clean(v):
    if v is None:
        return None
    if isinstance(v, list):
        v = {str(i): x for i, x in enumerate(v)}
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            c = clean(x)
            if c is not None:
                out[str(k)] = c
        return out or None
    return v


def get_at(path):
    node = state["tree"]
    for k in parts(path):
        if not isinstance(node, dict):
            return None
        node = node.get(k)
    return node


def set_at(path, value):
    ks = parts(path)
    c = clean(value)
    if not ks:
        state["tree"] = c if isinstance(c, dict) else {}
        return
    node, trail = state["tree"], []
    for k in ks[:-1]:
        if not isinstance(node.get(k), dict):
            node[k] = {}
        trail.append((node, k))
        node = node[k]
    if c is None:
        node.pop(ks[-1], None)
    else:
        node[ks[-1]] = c
    for parent, k in reversed(trail):
        if isinstance(parent.get(k), dict) and not parent[k]:
            del parent[k]


def base36(n):
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while True:
        n, r = divmod(n, 36)
        s = chars[r] + s
        if n == 0:
            return s


def push_key():
    state["counter"] += 1
    return base36(int(time.time() * 1000)) + base36(state["counter"]).rjust(4, "0")


def same(a, b):
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def apply(op):
    kind, path = op.get("op"), op.get("path", "")
    if kind == "set":
        set_at(path, op.get("value"))
        return {}
    if kind == "update":
        for k, v in (op.get("value") or {}).items():
            set_at((path + "/" if path else "") + k, v)
        return {}
    if kind == "push":
        key = push_key()
        set_at(path + "/" + key, op.get("value"))
        return {"key": key}
    if kind == "cas":  # compare-and-set, used for transactions
        if not same(get_at(path), op.get("expect")):
            return {"committed": False, "current": get_at(path)}
        set_at(path, op.get("value"))
        return {"committed": True}
    raise ValueError("unknown op: %r" % kind)


def snapshot():
    return {"version": state["version"], "tree": state["tree"]}


# ── HTTP ─────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console readable

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ping":
            return self.send_json({"ok": True, "mode": "lan", "base": "http://%s:%d/" % (lan_ip(), PORT)})
        if path == "/api/db":
            with cond:
                return self.send_json(snapshot())
        if path == "/api/events":
            return self.stream()
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/write":
            return self.send_json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send_json({"error": "too big"}, 413)
            ops = json.loads(self.rfile.read(length).decode("utf-8")).get("ops") or []
            with cond:
                results = [apply(op) for op in ops]
                state["version"] += 1
                cond.notify_all()
                out = snapshot()
            out["results"] = results
            return self.send_json(out)
        except Exception as e:  # bad request from a client
            return self.send_json({"error": str(e)}, 400)

    def stream(self):
        """Server-Sent Events: push the whole (small) tree whenever it changes."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = -1
        try:
            while True:
                with cond:
                    if state["version"] == last:
                        cond.wait(timeout=15)
                    payload = None
                    if state["version"] != last:
                        last = state["version"]
                        payload = json.dumps(snapshot(), ensure_ascii=False)
                if payload is None:
                    self.wfile.write(b": ping\n\n")  # keeps the connection alive
                else:
                    self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets are sent; this just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    # On Windows, "reuse address" lets a second server silently share the port,
    # which splits players between two separate games. Refuse instead.
    ThreadingHTTPServer.allow_reuse_address = os.name != "nt"
    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT), partial(Handler, directory=ROOT))
    except OSError:
        print("\n  Port %d is already in use. Is the game server already running in another window?" % PORT)
        print("  Close it first, or pick another port:  python lan_server.py 8081\n")
        sys.exit(1)
    server.daemon_threads = True
    ip = lan_ip()
    print("")
    print("  Fassila - Wi-Fi test mode")
    print("  -------------------------")
    print("  Host (this laptop):  http://%s:%d/host.html" % (ip, PORT))
    print("  Players (phones):    http://%s:%d/play.html" % (ip, PORT))
    print("")
    print("  Phones must be on the same Wi-Fi. Data is kept in memory only.")
    print("  Press Ctrl+C to stop.")
    print("", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Bye!")
