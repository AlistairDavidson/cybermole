#!/usr/bin/env python3
"""zed-launcher.py — the authed folder-open endpoint inside the zed
container (docs/zed-webapp.md). web-pi's server POSTs here over the
compose network (it has no docker socket by design); we run `zed <path>`
as this user (uid 2000) with the session env.

The zed CLI does the heavy lifting (crates/cli/src/main.rs): it sends the
open request over ~/.local/share/zed/zed-<channel>.sock to the running
instance — or, when the socket is absent, double-forks and execs the
editor with the path as its first workspace. Either way one invocation
is "make sure this folder is open in Zed", so Zed needs no supervisor:
if it dies, the next open boots it again.

Endpoints:
  GET  /healthz  — 200 (compose healthcheck / curl smoke test)
  POST /open     — Authorization: Bearer <WEB_PI_ZED_LAUNCH_TOKEN>,
                   body {"path": "/workspace/..."} → {"opened": true}
                   400 invalid path (not absolute / not inside-or-equal-to
                   /workspace / not a directory), 401 bad token, 404
                   anything else.
"""

import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("ZED_LAUNCHER_PORT", "7999"))
TOKEN = os.environ.get("WEB_PI_ZED_LAUNCH_TOKEN", "")
WORKSPACE_ROOT = os.environ.get("ZED_WORKSPACE_ROOT", "/workspace")
MAX_BODY = 8 * 1024

ZED_ENV = {
    **os.environ,
    "DISPLAY": os.environ.get("DISPLAY", ":1"),
    # Unset Wayland so Zed's platform probe picks X11 (KasmVNC's server).
    "WAYLAND_DISPLAY": "",
}


def fail(handler, status: int, error: str) -> None:
    body = json.dumps({"error": error}).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/healthz":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        fail(self, 404, "not found")

    def do_POST(self) -> None:
        if self.path != "/open":
            fail(self, 404, "not found")
            return
        if not TOKEN:
            print("zed-launcher: WEB_PI_ZED_LAUNCH_TOKEN is not set", file=sys.stderr)
            fail(self, 500, "launcher is not configured")
            return
        auth = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth, f"Bearer {TOKEN}"):
            fail(self, 401, "bad token")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            fail(self, 400, "bad body")
            return
        try:
            req = json.loads(self.rfile.read(length))
            path = req["path"]
            if not isinstance(path, str):
                raise ValueError("path must be a string")
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            fail(self, 400, f"bad body: {e}")
            return

        # Same rules the web server applies, checked again on the side
        # that will spawn: absolute, a directory, inside-or-equal-to
        # /workspace (the root itself is compose's default
        # WEB_PI_NEW_SESSION_CWD — its session rows must open the
        # workspace root, not be rejected). This is not the trust
        # boundary (the caller already owns a shell as this user) — it
        # keeps typos from opening /etc.
        real = os.path.realpath(path)
        root = os.path.realpath(WORKSPACE_ROOT)
        if not os.path.isabs(path) or (real != root and not real.startswith(root + os.sep)) or not os.path.isdir(real):
            fail(self, 400, f"not a workspace directory: {path}")
            return

        try:
            # The CLI exits immediately (socket forward or fork+exec);
            # its detached child outlives this request. stdout/stderr to
            # /dev/null — Zed logs to ~/.local/share/zed/logs/Zed.log.
            subprocess.Popen(
                ["setsid", "zed", real],
                env=ZED_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as e:
            fail(self, 500, f"could not spawn zed: {e}")
            return
        body = json.dumps({"opened": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"zed-launcher: {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"zed-launcher: listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
