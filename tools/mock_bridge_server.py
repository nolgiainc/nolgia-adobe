#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 NOLGIA Inc
"""In-memory mock of the NOLGIA API endpoints the app plugins use.

Standard library only. Good enough for end-to-end tests of a plugin; not a
model of the real server's storage, auth or rate limits.

Implements, under /v1:
  device login   POST /auth/device, POST /auth/device/token, POST /auth/device/approve
  bridge, plugin POST /bridge/sessions, DELETE /bridge/sessions/{id},
                 GET /bridge/sessions/{id}/next?wait=N, POST /bridge/commands/{id}/result
  bridge, caller GET /bridge/sessions, POST /bridge/commands,
                 GET /bridge/commands/{id}?wait=N, POST /bridge/commands/{id}/cancel
  assets         POST /assets/uploads, POST /assets/uploads/{id}/complete, GET /assets/{id}
Signed storage URLs (no bearer token allowed, like real signed URLs):
  PUT /storage/uploads/{upload_id}, GET /storage/assets/{asset_id}
Test helpers (no auth):
  POST /mock/assets?filename=&content_type=   raw body -> a ready asset
  GET  /mock/assets/{id}/bytes, GET /mock/state, POST /mock/reset,
  POST /mock/device/approve {user_code} | {"all": true}, POST /mock/device/deny

Request bodies are strict: unknown fields are refused with 400, like the Go
API's DisallowUnknownFields, so a plugin that drifts from the wire format
fails loudly here.

Run:  python3 tools/mock_bridge_server.py --port 8765 --token test-token
"""

import argparse
import datetime
import json
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

APPS = ("blender", "after_effects", "premiere", "illustrator", "photoshop", "resolve", "touchdesigner")

# The real API's CreateAssetUploadRequest.content_type enum.
UPLOAD_CONTENT_TYPES = {
    "video/mp4", "video/quicktime", "video/webm",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4",
    "image/png", "image/jpeg", "image/webp",
    "model/gltf-binary",
}
# Not in the real enum yet; the bridge needs it for `export` format `blend`.
PROPOSED_CONTENT_TYPES = {"application/x-blender"}

MAX_RESULT_BYTES = 1000 * 1000
MAX_ARGS_BYTES = 256 * 1024
LIVE_SECONDS = 60


def now():
    return time.time()


def iso(ts):
    if ts is None:
        return None
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def modality(content_type):
    if content_type.startswith("image/"):
        return "image"
    if content_type.startswith("video/"):
        return "video"
    if content_type.startswith("audio/"):
        return "audio"
    return "3d"


class HttpError(Exception):
    def __init__(self, status, title, detail="", code=None):
        super().__init__(detail or title)
        self.status, self.title, self.detail, self.code = status, title, detail, code


class MockState:
    def __init__(self, tokens=("test-token",), device_interval=5, auto_approve_after=None,
                 poll_wait_seconds=25):
        self.cond = threading.Condition()
        self.device_interval = device_interval
        self.auto_approve_after = auto_approve_after
        self.poll_wait_seconds = poll_wait_seconds
        self.initial_tokens = tuple(tokens)
        self.reset()

    def reset(self):
        with self.cond:
            self.users = {}
            self.tokens = {}
            for token in self.initial_tokens:
                self.add_token(token)
            self.sessions = {}
            self.commands = {}
            self.device = {}
            self.uploads = {}
            self.assets = {}
            self.requests = []
            self.deleted_sessions = []
            self.heartbeats = []
            self.results = []
            self.cond.notify_all()

    def add_token(self, token, email="test@nolgia.ai"):
        user_id = self.users.get(email) or str(uuid.uuid4())
        self.users[email] = user_id
        self.tokens[token] = {"user_id": user_id, "email": email}
        return self.tokens[token]

    # --------------------------------------------------------- bridge helpers

    def expire(self):
        t = now()
        changed = False
        for cmd in self.commands.values():
            if cmd["status"] in ("queued", "running") and cmd["expires_at"] <= t:
                cmd["status"] = "expired"
                cmd["error"] = "The command timed out."
                cmd["finished_at"] = t
                changed = True
        if changed:
            self.cond.notify_all()

    def session_live(self, s):
        return not s["disconnected"] and now() - s["last_seen_at"] <= LIVE_SECONDS

    def session_view(self, s):
        out = {k: s[k] for k in ("id", "instance_id", "app", "app_version", "plugin_version",
                                 "machine_name", "document", "capabilities", "allow_agent")}
        out["created_at"] = iso(s["created_at"])
        out["last_seen_at"] = iso(s["last_seen_at"])
        out["live"] = self.session_live(s)
        return out

    def command_view(self, c):
        out = {k: c[k] for k in ("id", "session_id", "kind", "args", "status", "result", "error", "caller")}
        for k in ("created_at", "claimed_at", "finished_at", "expires_at"):
            out[k] = iso(c[k])
        return out

    def asset_view(self, a, host):
        return {
            "id": a["id"],
            "user_id": a["user_id"],
            "modality": modality(a["content_type"]),
            "model": "upload",
            "display_name": a["display_name"],
            "signed_url": "http://%s/storage/assets/%s?X-Mock-Signature=%s" % (host, a["id"], a["sig"]),
            "expires_at": iso(now() + 3600),
            "created_at": iso(a["created_at"]),
            "mime_type": a["content_type"],
            "size_bytes": len(a["bytes"]) if a["bytes"] is not None else a["size_bytes"],
            "tags": a["tags"],
            "status": a["status"],
            "favorite": False,
            "projects": [],
        }

    def new_asset(self, user_id, filename, content_type, size_bytes, display_name=None, tags=None, data=None):
        asset_id = str(uuid.uuid4())
        self.assets[asset_id] = {
            "id": asset_id,
            "user_id": user_id,
            "filename": filename,
            "display_name": (display_name or filename or "").strip(),
            "content_type": content_type,
            "size_bytes": size_bytes,
            "tags": sorted({t.strip().lower() for t in (tags or []) if t.strip()}),
            "status": "ready" if data is not None else "uploading",
            "bytes": data,
            "created_at": now(),
            "sig": secrets.token_hex(8),
        }
        return self.assets[asset_id]


def strict_body(body, required=(), optional=()):
    if not isinstance(body, dict):
        raise HttpError(400, "Bad Request", "invalid JSON request body")
    allowed = set(required) | set(optional)
    unknown = sorted(set(body) - allowed)
    if unknown:
        raise HttpError(400, "Bad Request", "invalid JSON request body: unknown field %s" % unknown[0])
    for key in required:
        if key not in body:
            raise HttpError(400, "Bad Request", "%s is required" % key)
    return body


ROUTES = []


def route(method, pattern):
    def wrap(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return wrap


class Handler(BaseHTTPRequestHandler):
    server_version = "NolgiaMock/1.0"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    @property
    def state(self):
        return self.server.state

    @property
    def host(self):
        return self.headers.get("Host") or "%s:%d" % self.server.server_address[:2]

    # ------------------------------------------------------------- plumbing

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        length = int(self.headers.get("Content-Length") or 0)
        self.raw_body = self.rfile.read(length) if length else b""
        status = 500
        try:
            for m, pattern, fn in ROUTES:
                match = pattern.match(parsed.path)
                if m == method and match:
                    status = fn(self, *match.groups()) or 200
                    break
            else:
                raise HttpError(404, "Not Found", "no route for %s %s" % (method, parsed.path))
        except HttpError as err:
            status = err.status
            body = {"type": "about:blank", "title": err.title, "status": err.status, "detail": err.detail}
            if err.code:
                body["code"] = err.code
            self._send(err.status, body, "application/problem+json")
        except Exception as err:  # keep the server alive; report the bug
            status = 500
            self._send(500, {"type": "about:blank", "title": "Internal Server Error", "status": 500,
                             "detail": "%s: %s" % (type(err).__name__, err)}, "application/problem+json")
        with self.state.cond:
            self.state.requests.append({"method": method, "path": parsed.path, "status": status,
                                        "auth": bool(self.headers.get("Authorization"))})
            del self.state.requests[:-1000]

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _send(self, status, body=None, content_type="application/json", raw=None, headers=None):
        data = raw if raw is not None else (b"" if body is None else json.dumps(body).encode("utf-8"))
        self.send_response(status)
        if data or status != 204:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def json(self):
        if not self.raw_body:
            return {}
        try:
            return json.loads(self.raw_body.decode("utf-8"))
        except ValueError:
            raise HttpError(400, "Bad Request", "invalid JSON request body") from None

    def user(self):
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Bearer "):
            raise HttpError(401, "Unauthorized", "valid authentication is required")
        info = self.state.tokens.get(header[7:].strip())
        if info is None:
            raise HttpError(401, "Unauthorized", "the token is invalid or expired")
        return info

    def no_bearer(self):
        if self.headers.get("Authorization"):
            raise HttpError(400, "Bad Request",
                            "signed storage URLs must not carry an Authorization header")


# ------------------------------------------------------------ device login

@route("POST", r"/v1/auth/device")
def start_device(h):
    body = strict_body(h.json(), ("client_id",), ("client_name", "scope"))
    if not str(body["client_id"]).strip():
        raise HttpError(400, "Bad Request", "client_id is required")
    alphabet = "BCDFGHJKLMNPQRSTVWXZ"
    user_code = "".join(secrets.choice(alphabet) for _ in range(4)) + "-" + \
        "".join(secrets.choice(alphabet) for _ in range(4))
    device_code = secrets.token_urlsafe(32)
    st = h.state
    with st.cond:
        st.device[device_code] = {"user_code": user_code, "client_id": body["client_id"],
                                  "scope": body.get("scope"), "status": "pending",
                                  "interval": st.device_interval, "last_polled": None,
                                  "polls": 0, "expires_at": now() + 900, "user_id": None}
    uri = "http://%s/device" % h.host
    h._send(200, {"device_code": device_code, "user_code": user_code, "verification_uri": uri,
                  "verification_uri_complete": uri + "?user_code=" + user_code,
                  "expires_in": 900, "interval": st.device_interval})


@route("POST", r"/v1/auth/device/token")
def poll_device(h):
    body = strict_body(h.json(), ("client_id", "device_code"))
    st = h.state
    with st.cond:
        code = st.device.get(body["device_code"])
        if code is None:
            raise HttpError(400, "expired_token", "device code is unknown or expired")
        if now() > code["expires_at"]:
            raise HttpError(400, "expired_token", "device code has expired")
        code["polls"] += 1
        if code["status"] == "pending" and st.auto_approve_after is not None \
                and code["polls"] > st.auto_approve_after:
            code["status"] = "approved"
            code["user_id"] = st.tokens[st.initial_tokens[0]]["user_id"] if st.initial_tokens else None
        if code["status"] == "denied":
            del st.device[body["device_code"]]
            raise HttpError(403, "access_denied", "device authorization was denied")
        if code["status"] == "pending":
            last = code["last_polled"]
            code["last_polled"] = now()
            if last is not None and now() - last < code["interval"] - 0.25:
                code["interval"] += 5
                raise HttpError(400, "slow_down", "polling too frequently")
            raise HttpError(400, "authorization_pending", "device authorization is pending")
        del st.device[body["device_code"]]
        token = "nol_mock_" + secrets.token_hex(12)
        info = st.add_token(token)
    h._send(200, {"access_token": token, "token_type": "Bearer", "expires_in": 30 * 24 * 3600,
                  "user_id": info["user_id"], "email": info["email"]})


def _set_device_status(st, body, status, user_id=None):
    hit = 0
    for code in st.device.values():
        if code["status"] == "pending" and (body.get("all") or code["user_code"] == body.get("user_code")):
            code["status"] = status
            code["user_id"] = user_id
            hit += 1
    return hit


@route("POST", r"/v1/auth/device/approve")
def approve_device(h):
    user = h.user()
    body = strict_body(h.json(), ("user_code",))
    with h.state.cond:
        if not _set_device_status(h.state, body, "approved", user["user_id"]):
            raise HttpError(404, "Not Found", "device code is unknown, expired, or already used")
    h._send(204)


@route("POST", r"/mock/device/approve")
def mock_approve(h):
    st = h.state
    with st.cond:
        user_id = st.tokens[st.initial_tokens[0]]["user_id"] if st.initial_tokens else None
        hit = _set_device_status(st, h.json(), "approved", user_id)
    h._send(200, {"approved": hit})


@route("POST", r"/mock/device/deny")
def mock_deny(h):
    with h.state.cond:
        hit = _set_device_status(h.state, h.json(), "denied")
    h._send(200, {"denied": hit})


# ------------------------------------------------------------ bridge, plugin

def _own_session(st, user, session_id):
    s = st.sessions.get(session_id)
    if s is None or s["user_id"] != user["user_id"]:
        raise HttpError(404, "Not Found", "session not found")
    return s


@route("POST", r"/v1/bridge/sessions")
def register_session(h):
    user = h.user()
    body = strict_body(h.json(), ("instance_id", "app"),
                       ("app_version", "plugin_version", "machine_name", "document",
                        "capabilities", "allow_agent"))
    if not isinstance(body["instance_id"], str) or not body["instance_id"].strip():
        raise HttpError(400, "Bad Request", "instance_id is required")
    if body["app"] not in APPS:
        raise HttpError(400, "Bad Request", "app must be one of %s" % ", ".join(APPS))
    for key in ("app_version", "plugin_version", "machine_name"):
        if key in body and not isinstance(body[key], str):
            raise HttpError(400, "Bad Request", "%s must be a string" % key)
    document = body.get("document", {})
    if not isinstance(document, dict) or ("name" in document and not isinstance(document["name"], str)):
        raise HttpError(400, "Bad Request", "document must be an object {name, path?}")
    caps = body.get("capabilities", [])
    if not isinstance(caps, list) or not all(isinstance(c, str) for c in caps):
        raise HttpError(400, "Bad Request", "capabilities must be an array of strings")
    if "allow_agent" in body and not isinstance(body["allow_agent"], bool):
        raise HttpError(400, "Bad Request", "allow_agent must be a boolean")
    st = h.state
    with st.cond:
        s = next((x for x in st.sessions.values()
                  if x["user_id"] == user["user_id"] and x["instance_id"] == body["instance_id"]), None)
        if s is None:
            s = {"id": str(uuid.uuid4()), "user_id": user["user_id"], "instance_id": body["instance_id"],
                 "created_at": now()}
            st.sessions[s["id"]] = s
        s.update({"app": body["app"], "app_version": body.get("app_version", ""),
                  "plugin_version": body.get("plugin_version", ""),
                  "machine_name": body.get("machine_name", ""), "document": document,
                  "capabilities": caps, "allow_agent": body.get("allow_agent", True),
                  "last_seen_at": now(), "disconnected": False})
        st.heartbeats.append({"session_id": s["id"], "at": now(), "body": body})
        view = st.session_view(s)
        view["poll_wait_seconds"] = st.poll_wait_seconds
        st.cond.notify_all()
    h._send(200, {"session": view, "poll_wait_seconds": st.poll_wait_seconds})


@route("DELETE", r"/v1/bridge/sessions/([^/]+)")
def delete_session(h, session_id):
    user = h.user()
    st = h.state
    with st.cond:
        s = _own_session(st, user, session_id)
        s["disconnected"] = True
        st.deleted_sessions.append({"session_id": session_id, "at": now()})
        st.cond.notify_all()
    h._send(204)


@route("GET", r"/v1/bridge/sessions/([^/]+)/next")
def next_command(h, session_id):
    user = h.user()
    try:
        wait = int(h.query.get("wait", "0"))
    except ValueError:
        raise HttpError(400, "Bad Request", "wait must be a whole number") from None
    if not 0 <= wait <= 25:
        raise HttpError(400, "Bad Request", "wait must be between 0 and 25")
    st = h.state
    deadline = now() + wait
    with st.cond:
        while True:
            s = _own_session(st, user, session_id)
            if s["disconnected"]:
                raise HttpError(404, "Not Found", "session is disconnected")
            s["last_seen_at"] = now()
            st.expire()
            queued = sorted((c for c in st.commands.values()
                             if c["session_id"] == session_id and c["status"] == "queued"),
                            key=lambda c: c["created_at"])
            if queued:
                cmd = queued[0]
                cmd["status"] = "running"
                cmd["claimed_at"] = now()
                st.cond.notify_all()
                view = st.command_view(cmd)
                break
            left = deadline - now()
            if left <= 0:
                view = None
                break
            st.cond.wait(min(left, 0.5))
    if view is None:
        h._send(204)
    else:
        h._send(200, {"command": view})


@route("POST", r"/v1/bridge/commands/([^/]+)/result")
def post_result(h, command_id):
    user = h.user()
    if len(h.raw_body) > MAX_RESULT_BYTES + 128 * 1024:
        raise HttpError(413, "Payload Too Large", "result is larger than 1 MB")
    body = strict_body(h.json(), ("status",), ("result", "error"))
    if body["status"] not in ("succeeded", "failed"):
        raise HttpError(400, "Bad Request", "status must be succeeded or failed")
    if "result" in body and body["result"] is not None:
        if len(json.dumps(body["result"]).encode("utf-8")) > MAX_RESULT_BYTES:
            raise HttpError(413, "Payload Too Large", "result is larger than 1 MB")
    if "error" in body and body["error"] is not None and not isinstance(body["error"], str):
        raise HttpError(400, "Bad Request", "error must be a string")
    st = h.state
    with st.cond:
        st.expire()
        cmd = st.commands.get(command_id)
        if cmd is None:
            raise HttpError(404, "Not Found", "command not found")
        _own_session(st, user, cmd["session_id"])
        if cmd["status"] != "running":
            raise HttpError(409, "Conflict", "command is %s, not running" % cmd["status"],
                            code="command_not_running")
        cmd["status"] = body["status"]
        cmd["result"] = body.get("result")
        cmd["error"] = body.get("error")
        cmd["finished_at"] = now()
        st.results.append({"command_id": command_id, "body": body})
        st.cond.notify_all()
        view = st.command_view(cmd)
    h._send(200, {"command": view})


# ------------------------------------------------------------ bridge, caller

@route("GET", r"/v1/bridge/sessions")
def list_sessions(h):
    user = h.user()
    st = h.state
    with st.cond:
        live = [s for s in st.sessions.values() if s["user_id"] == user["user_id"] and st.session_live(s)]
        live.sort(key=lambda s: s["last_seen_at"], reverse=True)
        views = [st.session_view(s) for s in live]
    h._send(200, {"sessions": views})


@route("POST", r"/v1/bridge/commands")
def create_command(h):
    user = h.user()
    body = strict_body(h.json(), ("app", "kind"), ("session_id", "args", "timeout_seconds"))
    args = body.get("args", {})
    if not isinstance(args, dict):
        raise HttpError(400, "Bad Request", "args must be an object")
    if len(json.dumps(args).encode("utf-8")) > MAX_ARGS_BYTES:
        raise HttpError(413, "Payload Too Large", "args are larger than 256 KB")
    timeout = body.get("timeout_seconds", 120)
    if not isinstance(timeout, int) or not 5 <= timeout <= 900:
        raise HttpError(400, "Bad Request", "timeout_seconds must be 5..900")
    caller = h.headers.get("X-Mock-Caller", "user")
    st = h.state
    with st.cond:
        if body.get("session_id"):
            s = _own_session(st, user, body["session_id"])
            if not st.session_live(s):
                raise HttpError(409, "Conflict", "that session is not connected", code="app_not_connected")
        else:
            live = [s for s in st.sessions.values() if s["user_id"] == user["user_id"]
                    and s["app"] == body["app"] and st.session_live(s)]
            if not live:
                raise HttpError(409, "Conflict", "No %s is connected. Install the NOLGIA plugin and switch it on." % body["app"],
                                code="app_not_connected")
            s = max(live, key=lambda x: x["last_seen_at"])
        if body["kind"] not in s["capabilities"]:
            raise HttpError(422, "Unprocessable Entity", "this session cannot do %s" % body["kind"])
        if caller == "agent" and not s["allow_agent"]:
            raise HttpError(403, "Forbidden", "this session does not allow the NOLGIA Agent")
        cmd = {"id": str(uuid.uuid4()), "session_id": s["id"], "user_id": user["user_id"],
               "kind": body["kind"], "args": args, "status": "queued", "result": None, "error": None,
               "caller": caller, "created_at": now(), "claimed_at": None, "finished_at": None,
               "expires_at": now() + timeout}
        st.commands[cmd["id"]] = cmd
        st.cond.notify_all()
        view = st.command_view(cmd)
    h._send(201, {"command": view})


@route("GET", r"/v1/bridge/commands/([^/]+)")
def get_command(h, command_id):
    user = h.user()
    try:
        wait = int(h.query.get("wait", "0"))
    except ValueError:
        raise HttpError(400, "Bad Request", "wait must be a whole number") from None
    st = h.state
    deadline = now() + max(0, min(wait, 60))
    with st.cond:
        while True:
            st.expire()
            cmd = st.commands.get(command_id)
            if cmd is None or cmd["user_id"] != user["user_id"]:
                raise HttpError(404, "Not Found", "command not found")
            if cmd["status"] not in ("queued", "running") or now() >= deadline:
                view = st.command_view(cmd)
                break
            st.cond.wait(min(deadline - now(), 0.5))
    h._send(200, {"command": view})


@route("POST", r"/v1/bridge/commands/([^/]+)/cancel")
def cancel_command(h, command_id):
    user = h.user()
    st = h.state
    with st.cond:
        st.expire()
        cmd = st.commands.get(command_id)
        if cmd is None or cmd["user_id"] != user["user_id"]:
            raise HttpError(404, "Not Found", "command not found")
        if cmd["status"] not in ("queued", "running"):
            raise HttpError(409, "Conflict", "command already %s" % cmd["status"])
        cmd["status"] = "cancelled"
        cmd["finished_at"] = now()
        st.cond.notify_all()
        view = st.command_view(cmd)
    h._send(200, {"command": view})


# ------------------------------------------------------------------ assets

@route("POST", r"/v1/assets/uploads")
def create_upload(h):
    user = h.user()
    body = strict_body(h.json(), ("filename", "content_type", "size_bytes"),
                       ("tags", "display_name", "project_id"))
    ctype = body["content_type"]
    if ctype not in UPLOAD_CONTENT_TYPES | PROPOSED_CONTENT_TYPES:
        raise HttpError(400, "Bad Request", "content_type %s is not supported" % ctype)
    size = body["size_bytes"]
    if not isinstance(size, int) or size < 1:
        raise HttpError(400, "Bad Request", "size_bytes must be at least 1")
    filename = body["filename"]
    if not isinstance(filename, str) or not 1 <= len(filename) <= 255:
        raise HttpError(400, "Bad Request", "filename must be 1..255 characters")
    tags = body.get("tags") or []
    if not isinstance(tags, list) or len(tags) > 10 or not all(isinstance(t, str) and 1 <= len(t) <= 40 for t in tags):
        raise HttpError(400, "Bad Request", "tags must be at most 10 strings of 1..40 characters")
    display = body.get("display_name")
    if display is not None and (not isinstance(display, str) or len(display) > 200):
        raise HttpError(400, "Bad Request", "display_name must be at most 200 characters")
    st = h.state
    with st.cond:
        asset = st.new_asset(user["user_id"], filename, ctype, size, display, tags)
        upload_id = str(uuid.uuid4())
        st.uploads[upload_id] = {"id": upload_id, "asset_id": asset["id"], "content_type": ctype,
                                 "size_bytes": size, "bytes": None, "user_id": user["user_id"],
                                 "proposed_type": ctype in PROPOSED_CONTENT_TYPES}
    h._send(201, {"upload_id": upload_id, "asset_id": asset["id"],
                  "upload_url": "http://%s/storage/uploads/%s?X-Mock-Signature=%s" % (h.host, upload_id, asset["sig"]),
                  "expires_at": iso(now() + 1800)})


@route("PUT", r"/storage/uploads/([^/]+)")
def put_upload(h, upload_id):
    h.no_bearer()
    st = h.state
    with st.cond:
        up = st.uploads.get(upload_id)
        if up is None:
            raise HttpError(404, "Not Found", "no such upload")
        if h.headers.get("Content-Type") != up["content_type"]:
            raise HttpError(403, "SignatureDoesNotMatch",
                            "Content-Type %r does not match the signed %r" % (h.headers.get("Content-Type"), up["content_type"]))
        up["bytes"] = h.raw_body
    h._send(200, raw=b"", content_type="text/plain")


@route("POST", r"/v1/assets/uploads/([^/]+)/complete")
def complete_upload(h, upload_id):
    user = h.user()
    st = h.state
    with st.cond:
        up = st.uploads.get(upload_id)
        if up is None or up["user_id"] != user["user_id"]:
            raise HttpError(404, "Not Found", "upload not found")
        if up["bytes"] is None:
            raise HttpError(409, "Conflict", "the object was not uploaded")
        if len(up["bytes"]) != up["size_bytes"]:
            raise HttpError(409, "Conflict", "uploaded %d bytes, declared %d" % (len(up["bytes"]), up["size_bytes"]))
        asset = st.assets[up["asset_id"]]
        asset["bytes"] = up["bytes"]
        asset["status"] = "ready"
        view = st.asset_view(asset, h.host)
    h._send(200, view)


@route("GET", r"/v1/assets/([^/]+)")
def get_asset(h, asset_id):
    user = h.user()
    st = h.state
    with st.cond:
        asset = st.assets.get(asset_id)
        if asset is None or asset["user_id"] != user["user_id"] or asset["status"] != "ready":
            raise HttpError(404, "Not Found", "asset not found")
        view = st.asset_view(asset, h.host)
    h._send(200, view)


@route("GET", r"/storage/assets/([^/]+)")
def download_asset(h, asset_id):
    h.no_bearer()
    st = h.state
    with st.cond:
        asset = st.assets.get(asset_id)
        if asset is None or asset["bytes"] is None or h.query.get("X-Mock-Signature") != asset["sig"]:
            raise HttpError(403, "AccessDenied", "bad or missing signature")
        data, ctype = asset["bytes"], asset["content_type"]
    h._send(200, raw=data, content_type=ctype)


# ------------------------------------------------------------ test helpers

@route("POST", r"/mock/assets")
def mock_create_asset(h):
    st = h.state
    filename = h.query.get("filename", "file.bin")
    ctype = h.query.get("content_type", "application/octet-stream")
    with st.cond:
        owner = st.tokens[st.initial_tokens[0]]["user_id"]
        asset = st.new_asset(owner, filename, ctype, len(h.raw_body), h.query.get("display_name") or filename,
                             [], h.raw_body)
        view = st.asset_view(asset, h.host)
    h._send(201, view)


@route("GET", r"/mock/assets/([^/]+)/bytes")
def mock_asset_bytes(h, asset_id):
    with h.state.cond:
        asset = h.state.assets.get(asset_id)
        if asset is None or asset["bytes"] is None:
            raise HttpError(404, "Not Found", "asset not found")
        data, ctype = asset["bytes"], asset["content_type"]
    h._send(200, raw=data, content_type=ctype)


@route("GET", r"/mock/state")
def mock_state(h):
    st = h.state
    with st.cond:
        out = {
            "sessions": [dict(st.session_view(s), disconnected=s["disconnected"]) for s in st.sessions.values()],
            "commands": [st.command_view(c) for c in st.commands.values()],
            "deleted_sessions": list(st.deleted_sessions),
            "heartbeats": len(st.heartbeats),
            "last_heartbeat": st.heartbeats[-1]["body"] if st.heartbeats else None,
            "uploads": [{k: v for k, v in u.items() if k != "bytes"} for u in st.uploads.values()],
            "requests": list(st.requests),
        }
    h._send(200, out)


@route("POST", r"/mock/reset")
def mock_reset(h):
    h.state.reset()
    h._send(204)


class MockBridgeServer:
    """Run the mock in a background thread: `with MockBridgeServer() as srv: srv.base_url`."""

    def __init__(self, host="127.0.0.1", port=0, verbose=False, **state_kwargs):
        self.state = MockState(**state_kwargs)
        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.daemon_threads = True
        self.httpd.state = self.state
        self.httpd.verbose = verbose
        self.thread = None

    @property
    def root_url(self):
        host, port = self.httpd.server_address[:2]
        return "http://%s:%d" % (host, port)

    @property
    def base_url(self):
        return self.root_url + "/v1"

    def start(self):
        self.thread = threading.Thread(target=self.httpd.serve_forever, name="mock-nolgia", daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", action="append", default=None,
                        help="bearer token to accept (repeatable; default test-token)")
    parser.add_argument("--device-interval", type=int, default=5)
    parser.add_argument("--auto-approve-after", type=int, default=None,
                        help="approve a device code on its Nth poll")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    server = MockBridgeServer(args.host, args.port, verbose=args.verbose,
                              tokens=tuple(args.token or ["test-token"]),
                              device_interval=args.device_interval,
                              auto_approve_after=args.auto_approve_after)
    print("NOLGIA mock API listening on %s" % server.base_url, flush=True)
    try:
        server.httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
