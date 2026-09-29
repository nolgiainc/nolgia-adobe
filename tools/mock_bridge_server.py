#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 NOLGIA Inc
"""In-memory mock of the NOLGIA API endpoints the app plugins use.

Standard library only. The /bridge/* part follows the real API
(nolgia-api internal/handlers/bridge.go and bridge_store.go) rule for rule:
the same validation, limits, problem codes, ordering and response shapes, so
a plugin that passes against this mock speaks the real wire format. Storage,
auth and the rest of the API are simplified.

Under /v1:
  device login   POST /auth/device, POST /auth/device/token, POST /auth/device/approve, GET /me
  bridge, plugin POST /bridge/sessions, DELETE /bridge/sessions/{id},
                 GET /bridge/sessions/{id}/next?wait=N, POST /bridge/commands/{id}/result
  bridge, caller GET /bridge/sessions, POST /bridge/commands,
                 GET /bridge/commands/{id}?wait=N, POST /bridge/commands/{id}/cancel
                 (a caller is the NOLGIA Agent when it sends X-Nolgia-Surface: hermes)
  assets         POST /assets/uploads, POST /assets/uploads/{id}/complete, GET /assets/{id}
Signed storage URLs (a bearer token is refused, as signed URLs would):
  PUT /storage/uploads/{upload_id}, GET /storage/assets/{asset_id}
Test helpers (no auth):
  POST /mock/assets?filename=&content_type=   raw body -> a ready asset
  GET  /mock/assets/{id}/bytes, GET /mock/state, POST /mock/reset,
  POST /mock/device/approve {user_code} | {"all": true}, POST /mock/device/deny

Run:  python3 tools/mock_bridge_server.py --port 8765 --token test-token
"""

import argparse
import collections
import datetime
import json
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ------------------------------------------------ constants from bridge.go

APPS = ("after_effects", "blender", "illustrator", "photoshop", "premiere", "resolve", "touchdesigner")
APP_NAMES = {
    "blender": "Blender", "after_effects": "After Effects", "premiere": "Premiere Pro",
    "illustrator": "Illustrator", "photoshop": "Photoshop", "resolve": "DaVinci Resolve Studio",
    "touchdesigner": "TouchDesigner",
}
LIVE_WINDOW = 60.0
MAX_WAIT = 25
DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT = 120, 5, 900
MAX_ARGS_BYTES = 256 << 10
MAX_RESULT_BYTES = 1 << 20
MAX_ERROR_BYTES = 64 << 10
BODY_SLACK = 16 << 10
REGISTER_MAX_BYTES = 64 << 10
RATE_LIMIT, RATE_WINDOW = 120, 60.0
INSTANCE_ID_MAX, VERSION_MAX, MACHINE_NAME_MAX = 128, 64, 128
DOCUMENT_NAME_MAX, DOCUMENT_PATH_MAX, MAX_CAPABILITIES = 512, 4096, 32
PLUGINS_URL = "https://nolgia.ai/plugins"
KIND_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
BUILTIN_KINDS = ("info", "run")

ERROR_EXPIRED = "The app did not finish this command before it expired."
ERROR_DISCONNECTED = "The app disconnected before this command finished."
ERROR_CANCELLED = "Cancelled before it finished."
ERROR_TOO_LARGE = ("The app's result was larger than 1 MB, the most NOLGIA accepts. Ask for a smaller "
                   "result, or have the app upload big outputs as assets and return their ids.")
ERROR_NO_DETAIL = "The app reported a failure without details."

# The real API's CreateAssetUploadRequest.content_type enum.
UPLOAD_CONTENT_TYPES = {
    "video/mp4", "video/quicktime", "video/webm",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4",
    "image/png", "image/jpeg", "image/webp",
    "model/gltf-binary",
}

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def now():
    return time.time()


def rfc3339(ts):
    """Go's time.Time JSON (RFC 3339, trailing zeros of the fraction dropped),
    at Postgres's microsecond precision."""
    dt = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    text = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if dt.microsecond:
        text += ("." + "%06d" % dt.microsecond).rstrip("0")
    return text + "Z"


def modality(content_type):
    for prefix in ("image", "video", "audio"):
        if content_type.startswith(prefix + "/"):
            return prefix
    return "3d"


def one_line_ok(value, limit):
    return len(value) <= limit and not any(ord(ch) < 32 or 127 <= ord(ch) < 160 for ch in value)


def truncate_bytes(text, limit):
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    return raw[:limit].decode("utf-8", "ignore")


def go_json_size(value):
    """len(json.Marshal(value)) in Go: compact, UTF-8, with <, >, & escaped."""
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return len(text.encode("utf-8")) + 5 * (text.count("<") + text.count(">") + text.count("&"))


def strip_nul(value):
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, dict):
        return {strip_nul(k): strip_nul(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_nul(v) for v in value]
    return value


class HttpError(Exception):
    def __init__(self, status, title, detail="", code=None, headers=None):
        super().__init__(detail or title)
        self.status, self.title, self.detail, self.code = status, title, detail, code
        self.headers = headers or {}


def bad_request(detail):
    return HttpError(400, "Bad Request", detail)


class MockState:
    def __init__(self, tokens=("test-token",), device_interval=5, auto_approve_after=None,
                 poll_wait_seconds=MAX_WAIT, rate_limit=RATE_LIMIT):
        self.cond = threading.Condition()
        self.device_interval = device_interval
        self.auto_approve_after = auto_approve_after
        self.poll_wait_seconds = poll_wait_seconds
        self.rate_limit = rate_limit
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
            self.rate = collections.defaultdict(collections.deque)
            self.cond.notify_all()

    def add_token(self, token, email="test@nolgia.ai"):
        user = self.users.get(email)
        if user is None:
            user = {"id": str(uuid.uuid4()), "email": email, "created_at": now()}
            self.users[email] = user
        self.tokens[token] = {"user_id": user["id"], "email": email}
        return self.tokens[token]

    # ----------------------------------------------------- bridge_store.go

    @staticmethod
    def live(s, at):
        return s["disconnected_at"] is None and s["last_seen_at"] > at - LIVE_WINDOW

    def expire_session_commands(self, session_id, at):
        for c in self.commands.values():
            if c["session_id"] == session_id and c["status"] in ("queued", "running") and c["expires_at"] <= at:
                c.update(status="expired", finished_at=at, error=ERROR_EXPIRED)

    def get_command(self, user_id, command_id, at):
        """GetBridgeCommand: marks an overdue queued/running command expired first."""
        c = self.commands.get(command_id)
        if c is None or c["user_id"] != user_id:
            return None
        if c["status"] in ("queued", "running") and c["expires_at"] <= at:
            c.update(status="expired", finished_at=at, error=ERROR_EXPIRED)
            self.cond.notify_all()
        return c

    def finish_command(self, user_id, command_id, status, result, error, at):
        """FinishBridgeCommand: only a running, unexpired command takes it."""
        c = self.commands.get(command_id)
        if c is None or c["user_id"] != user_id:
            return None, False
        if c["status"] == "running" and c["expires_at"] > at:
            c.update(status=status, result=result, error=error, finished_at=at)
            s = self.sessions.get(c["session_id"])
            if s is not None and s["disconnected_at"] is None:
                s["last_seen_at"] = max(s["last_seen_at"], at)
            self.cond.notify_all()
            return c, True
        return self.get_command(user_id, command_id, at), False

    # ------------------------------------------------------------ views

    @staticmethod
    def session_view(s):
        document = {k: s["document"][k] for k in ("name", "path") if k in s["document"]}
        return {
            "id": s["id"], "instance_id": s["instance_id"], "app": s["app"], "app_version": s["app_version"],
            "plugin_version": s["plugin_version"], "machine_name": s["machine_name"], "document": document,
            "capabilities": list(s["capabilities"]), "allow_agent": s["allow_agent"],
            "created_at": rfc3339(s["created_at"]), "last_seen_at": rfc3339(s["last_seen_at"]),
        }

    @staticmethod
    def command_view(c):
        """BridgeCommand: optional fields are left out when unset, never null."""
        out = {"id": c["id"], "session_id": c["session_id"], "kind": c["kind"], "args": c["args"],
               "status": c["status"]}
        if c["result"] is not None:
            out["result"] = c["result"]
        if c["error"] is not None:
            out["error"] = c["error"]
        out["caller"] = c["caller"]
        out["created_at"] = rfc3339(c["created_at"])
        if c["claimed_at"] is not None:
            out["claimed_at"] = rfc3339(c["claimed_at"])
        if c["finished_at"] is not None:
            out["finished_at"] = rfc3339(c["finished_at"])
        out["expires_at"] = rfc3339(c["expires_at"])
        return out

    def asset_view(self, a, host):
        return {
            "id": a["id"],
            "user_id": a["user_id"],
            "modality": modality(a["content_type"]),
            "model": "upload",
            "display_name": a["display_name"],
            "signed_url": "http://%s/storage/assets/%s?X-Mock-Signature=%s" % (host, a["id"], a["sig"]),
            "expires_at": rfc3339(now() + 3600),
            "created_at": rfc3339(a["created_at"]),
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


# ------------------------------------------------------------- decoding

def strict_json(raw, allowed, required=(), cap=None, types=None):
    """decodeBridgeJSON: a single JSON object, unknown fields refused."""
    if cap is not None and len(raw) > cap:
        raise HttpError(413, "Request Entity Too Large", "request body must be at most %d bytes" % cap)
    try:
        body = json.loads(raw.decode("utf-8") if raw else "")
    except ValueError as err:
        if raw and raw.strip():
            raise bad_request("invalid JSON request body: request body must contain a single JSON object") from None
        raise bad_request("invalid JSON request body: EOF") from err
    if not isinstance(body, dict):
        raise bad_request("invalid JSON request body: json: cannot unmarshal %s into Go value of type object"
                          % type(body).__name__)
    for key in body:
        if key not in allowed:
            raise bad_request('invalid JSON request body: json: unknown field "%s"' % key)
    for key, expected in (types or {}).items():
        if key in body and body[key] is not None and not isinstance(body[key], expected):
            raise bad_request("invalid JSON request body: json: cannot unmarshal into field %s" % key)
        if key in body and expected is int and isinstance(body[key], bool):
            raise bad_request("invalid JSON request body: json: cannot unmarshal into field %s" % key)
    for key in required:
        if key not in body:
            # The Go struct just leaves it zero; the handler's own checks answer.
            body[key] = None
    return body


ROUTES = []


def route(method, pattern):
    def wrap(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return wrap


def uuid_param(value, name="id"):
    if not UUID_RE.match(value):
        raise bad_request("Invalid format for parameter %s: error unmarshaling '%s' text as *uuid.UUID" % (name, value))
    return value.lower()


def wait_param(query, fallback):
    raw = query.get("wait")
    if raw is None:
        return fallback
    try:
        wait = int(raw)
    except ValueError:
        raise bad_request("Invalid format for parameter wait: error binding string parameter") from None
    if not 0 <= wait <= MAX_WAIT:
        raise bad_request("wait must be 0 to %d seconds" % MAX_WAIT)
    return wait


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

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        length = int(self.headers.get("Content-Length") or 0)
        self.raw_body = self.rfile.read(length) if length else b""
        self.request_id = "mock-" + secrets.token_hex(6)
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
            self.problem(err)
        except Exception as err:  # keep the server alive; report the bug
            status = 500
            self.problem(HttpError(500, "Internal Server Error", "%s: %s" % (type(err).__name__, err)))
        with self.state.cond:
            self.state.requests.append({"method": method, "path": parsed.path, "status": status,
                                        "auth": bool(self.headers.get("Authorization")), "at": now()})
            del self.state.requests[:-2000]

    def problem(self, err):
        body = {"type": "about:blank", "title": err.title, "status": err.status, "detail": err.detail}
        if err.code:
            body["code"] = err.code
        body["request_id"] = self.request_id
        self._send(err.status, body, "application/problem+json", headers=err.headers)

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
        if status != 204:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)
        return status

    def json(self):
        if not self.raw_body:
            return {}
        try:
            return json.loads(self.raw_body.decode("utf-8"))
        except ValueError:
            raise bad_request("invalid JSON request body") from None

    def user(self):
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Bearer "):
            raise HttpError(401, "Unauthorized", "authenticated user is required")
        info = self.state.tokens.get(header[7:].strip())
        if info is None:
            raise HttpError(401, "Unauthorized", "authenticated user is required")
        return info

    def from_agent(self):
        return (self.headers.get("X-Nolgia-Surface") or "").strip().lower() == "hermes"

    def no_bearer(self):
        if self.headers.get("Authorization"):
            raise bad_request("signed storage URLs must not carry an Authorization header")


# --------------------------------------------------------------- device login

@route("POST", r"/v1/auth/device")
def start_device(h):
    # The handler's own struct takes client_name too; the schema lists only these two.
    body = strict_json(h.raw_body, ("client_id", "client_name", "scope"))
    if not str(body.get("client_id") or "").strip():
        raise bad_request("client_id is required")
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
    return h._send(200, {"device_code": device_code, "user_code": user_code, "verification_uri": uri,
                         "verification_uri_complete": uri + "?user_code=" + user_code,
                         "expires_in": 900, "interval": st.device_interval})


@route("POST", r"/v1/auth/device/token")
def poll_device(h):
    try:
        body = strict_json(h.raw_body, ("client_id", "device_code"))
    except HttpError:
        raise HttpError(400, "invalid_request", "invalid JSON request body") from None
    if not str(body.get("device_code") or "").strip() or not str(body.get("client_id") or "").strip():
        raise HttpError(400, "invalid_request", "device_code and client_id are required")
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
            if last is not None and now() - last < code["interval"] - 0.25:
                code["interval"] += 5
                code["last_polled"] = now()
                raise HttpError(400, "slow_down", "polling too frequently")
            code["last_polled"] = now()
            raise HttpError(400, "authorization_pending", "device authorization is pending")
        del st.device[body["device_code"]]
        token = "nol_mock_" + secrets.token_hex(12)
        st.add_token(token)
    # The documented DeviceTokenResponse: no email, no user_id (read GET /me).
    return h._send(200, {"access_token": token, "token_type": "Bearer", "expires_in": 30 * 24 * 3600})


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
    body = strict_json(h.raw_body, ("user_code",))
    with h.state.cond:
        if not _set_device_status(h.state, body, "approved", user["user_id"]):
            raise HttpError(404, "Not Found", "device code is unknown, expired, or already used")
    return h._send(204)


@route("GET", r"/v1/me")
def get_me(h):
    user = h.user()
    record = h.state.users[user["email"]]
    return h._send(200, {"id": record["id"], "email": record["email"], "name": None, "image_url": None,
                         "created_at": rfc3339(record["created_at"]), "organizations": [],
                         "active_organization": None})


@route("POST", r"/mock/device/approve")
def mock_approve(h):
    st = h.state
    with st.cond:
        user_id = st.tokens[st.initial_tokens[0]]["user_id"] if st.initial_tokens else None
        hit = _set_device_status(st, h.json(), "approved", user_id)
    return h._send(200, {"approved": hit})


@route("POST", r"/mock/device/deny")
def mock_deny(h):
    with h.state.cond:
        hit = _set_device_status(h.state, h.json(), "denied")
    return h._send(200, {"denied": hit})


# ------------------------------------------------------------ bridge, plugin

@route("POST", r"/v1/bridge/sessions")
def register_session(h):
    user = h.user()
    body = strict_json(h.raw_body, ("instance_id", "app", "app_version", "plugin_version", "machine_name",
                                    "document", "capabilities", "allow_agent"),
                       required=("instance_id", "app"), cap=REGISTER_MAX_BYTES,
                       types={"instance_id": str, "app": str, "app_version": str, "plugin_version": str,
                              "machine_name": str, "document": dict, "capabilities": list, "allow_agent": bool})
    instance_id = (body["instance_id"] or "").strip()
    if not instance_id:
        raise bad_request("instance_id is required")
    if not one_line_ok(instance_id, INSTANCE_ID_MAX):
        raise bad_request("instance_id must be one line of at most %d characters" % INSTANCE_ID_MAX)
    if body["app"] not in APPS:
        raise bad_request("app must be one of " + ", ".join(APPS))
    fields = {}
    for name, limit in (("app_version", VERSION_MAX), ("plugin_version", VERSION_MAX),
                        ("machine_name", MACHINE_NAME_MAX)):
        value = strip_nul(body.get(name) or "").strip()
        if not one_line_ok(value, limit):
            raise bad_request("%s must be one line of at most %d characters" % (name, limit))
        fields[name] = value
    document = {}
    raw_doc = body.get("document") or {}
    for key in raw_doc:
        if key not in ("name", "path"):
            raise bad_request('invalid JSON request body: json: unknown field "%s"' % key)
    if raw_doc.get("name") is not None:
        name = strip_nul(raw_doc["name"])
        if len(name) > DOCUMENT_NAME_MAX:
            raise bad_request("document.name must be at most %d characters" % DOCUMENT_NAME_MAX)
        document["name"] = name
    if raw_doc.get("path") is not None:
        path = strip_nul(raw_doc["path"])
        if len(path) > DOCUMENT_PATH_MAX:
            raise bad_request("document.path must be at most %d characters" % DOCUMENT_PATH_MAX)
        document["path"] = path
    capabilities = []
    if body.get("capabilities") is not None:
        if len(body["capabilities"]) > MAX_CAPABILITIES:
            raise bad_request("capabilities lists at most %d command kinds" % MAX_CAPABILITIES)
        for cap in body["capabilities"]:
            if not isinstance(cap, str) or not KIND_PATTERN.match(cap):
                raise bad_request("capabilities: %s must be lowercase letters, digits and underscores, starting "
                                  "with a letter, at most 64 characters" % json.dumps(cap))
            if cap not in capabilities:
                capabilities.append(cap)
    allow_agent = body["allow_agent"] if body.get("allow_agent") is not None else True
    st = h.state
    at = now()
    with st.cond:
        s = next((x for x in st.sessions.values()
                  if x["user_id"] == user["user_id"] and x["instance_id"] == instance_id), None)
        if s is None:
            s = {"id": str(uuid.uuid4()), "user_id": user["user_id"], "instance_id": instance_id,
                 "created_at": at, "last_seen_at": at}
            st.sessions[s["id"]] = s
        s.update(app=body["app"], document=document, capabilities=capabilities, allow_agent=allow_agent,
                 disconnected_at=None, last_seen_at=max(s["last_seen_at"], at), **fields)
        st.heartbeats.append({"session_id": s["id"], "at": at, "body": body})
        view = st.session_view(s)
        view["poll_wait_seconds"] = st.poll_wait_seconds
        st.cond.notify_all()
    return h._send(200, view)


@route("DELETE", r"/v1/bridge/sessions/([^/]+)")
def delete_session(h, session_id):
    user = h.user()
    session_id = uuid_param(session_id)
    st = h.state
    at = now()
    with st.cond:
        s = st.sessions.get(session_id)
        if s is None or s["user_id"] != user["user_id"]:
            raise HttpError(404, "Not Found", "session not found")
        if s["disconnected_at"] is None:
            s["disconnected_at"] = at
        for c in st.commands.values():
            if c["session_id"] == session_id and c["status"] in ("queued", "running"):
                c.update(status="expired", finished_at=at, error=ERROR_DISCONNECTED)
        st.deleted_sessions.append({"session_id": session_id, "at": at})
        st.cond.notify_all()
    return h._send(204)


@route("GET", r"/v1/bridge/sessions/([^/]+)/next")
def next_command(h, session_id):
    user = h.user()
    session_id = uuid_param(session_id)
    wait = wait_param(h.query, MAX_WAIT)
    st = h.state
    with st.cond:
        s = st.sessions.get(session_id)
        if s is None or s["user_id"] != user["user_id"]:
            raise HttpError(404, "Not Found", "session not found: register it with POST /bridge/sessions")
        if s["disconnected_at"] is not None:
            raise HttpError(409, "Conflict", "this session was disconnected: register it again with "
                            "POST /bridge/sessions to reconnect", code="session_disconnected")
        s["last_seen_at"] = max(s["last_seen_at"], now())
        st.expire_session_commands(session_id, now())
        deadline = now() + wait
        claimed = None
        while True:
            at = now()
            queued = sorted((c for c in st.commands.values()
                             if c["session_id"] == session_id and c["status"] == "queued" and c["expires_at"] > at),
                            key=lambda c: (c["created_at"], c["id"]))
            if queued:
                claimed = queued[0]
                claimed.update(status="running", claimed_at=at)
                st.cond.notify_all()
                break
            left = deadline - at
            if left <= 0:
                break
            st.cond.wait(min(left, 0.5))
        view = st.command_view(claimed) if claimed else None
    if view is None:
        return h._send(204)
    return h._send(200, view)


def _fail_too_large(h, user_id, command_id):
    with h.state.cond:
        h.state.finish_command(user_id, command_id, "failed", None, ERROR_TOO_LARGE, now())
    raise HttpError(413, "Request Entity Too Large",
                    "result must be at most 1 MB as JSON, so the command was marked failed. Upload big outputs "
                    "as assets (POST /assets/uploads) and return their ids instead")


@route("POST", r"/v1/bridge/commands/([^/]+)/result")
def post_result(h, command_id):
    user = h.user()
    command_id = uuid_param(command_id)
    if len(h.raw_body) > MAX_RESULT_BYTES + MAX_ERROR_BYTES + BODY_SLACK:
        _fail_too_large(h, user["user_id"], command_id)
    body = strict_json(h.raw_body, ("status", "result", "error"), required=("status",),
                       types={"status": str, "result": dict, "error": str})
    if body["status"] not in ("succeeded", "failed"):
        raise bad_request("status must be succeeded or failed")
    result = None
    if body.get("result") is not None:
        result = strip_nul(body["result"])
        if go_json_size(result) > MAX_RESULT_BYTES:
            _fail_too_large(h, user["user_id"], command_id)
    elif body["status"] == "succeeded":
        result = {}
    error = None
    if body.get("error") is not None and body["error"].strip():
        error = truncate_bytes(strip_nul(body["error"]), MAX_ERROR_BYTES)
    elif body["status"] == "failed":
        error = ERROR_NO_DETAIL
    st = h.state
    with st.cond:
        c, applied = st.finish_command(user["user_id"], command_id, body["status"], result, error, now())
        if c is None:
            raise HttpError(404, "Not Found", "command not found")
        if not applied:
            detail = {
                "cancelled": "this command was cancelled, so its result was not recorded",
                "expired": "this command expired before its result arrived, so the result was not recorded",
                "queued": "this command has not been picked up yet: take it from GET /bridge/sessions/{id}/next first",
            }.get(c["status"], "this command already has a result")
            raise HttpError(409, "Conflict", detail, code="command_not_running")
        st.results.append({"command_id": command_id, "body": body})
        view = st.command_view(c)
    return h._send(200, view)


# ------------------------------------------------------------ bridge, caller

def _not_connected(app, session=None):
    name = APP_NAMES.get(app, app)
    detail = ("%s is not connected to NOLGIA right now. To connect it, install the NOLGIA plugin for %s from %s, "
              "sign in, and switch it on (Connected), then try again" % (name, name, PLUGINS_URL))
    if session is not None:
        suffix = " on " + session["machine_name"] if session["machine_name"] else ""
        detail = ("that %s session%s is not connected right now. Open %s and check that the NOLGIA plugin is "
                  "signed in and switched on (Connected); the plugin is at %s" % (name, suffix, name, PLUGINS_URL))
    return HttpError(409, "App Not Connected", detail, code="app_not_connected")


@route("GET", r"/v1/bridge/sessions")
def list_sessions(h):
    user = h.user()
    st = h.state
    at = now()
    with st.cond:
        live = [s for s in st.sessions.values() if s["user_id"] == user["user_id"] and st.live(s, at)]
        live.sort(key=lambda s: (-s["last_seen_at"], s["id"]))
        views = [st.session_view(s) for s in live[:100]]
    return h._send(200, {"sessions": views})


@route("POST", r"/v1/bridge/commands")
def create_command(h):
    user = h.user()
    st = h.state
    with st.cond:
        window = st.rate[user["user_id"]]
        cutoff = now() - RATE_WINDOW
        while window and window[0] <= cutoff:
            window.popleft()
        if len(window) >= st.rate_limit:
            raise HttpError(429, "Too Many Requests",
                            "more than %d commands in a minute: wait a moment, then try again" % st.rate_limit,
                            headers={"Retry-After": str(int(RATE_WINDOW))})
        window.append(now())
    body = strict_json(h.raw_body, ("app", "session_id", "kind", "args", "timeout_seconds"), required=("app", "kind"),
                       cap=MAX_ARGS_BYTES + BODY_SLACK,
                       types={"app": str, "session_id": str, "kind": str, "args": dict, "timeout_seconds": int})
    if body["app"] not in APPS:
        raise bad_request("app must be one of " + ", ".join(APPS))
    app = body["app"]
    kind = (body["kind"] or "").strip()
    if not KIND_PATTERN.match(kind):
        raise bad_request("kind must be lowercase letters, digits and underscores, starting with a letter, "
                          "at most 64 characters")
    timeout = body["timeout_seconds"] if body.get("timeout_seconds") is not None else DEFAULT_TIMEOUT
    if not MIN_TIMEOUT <= timeout <= MAX_TIMEOUT:
        raise bad_request("timeout_seconds must be %d to %d" % (MIN_TIMEOUT, MAX_TIMEOUT))
    args = strip_nul(body.get("args") or {})
    if go_json_size(args) > MAX_ARGS_BYTES:
        raise HttpError(413, "Request Entity Too Large", "args must be at most 256 KB as JSON")
    from_agent = h.from_agent()
    at = now()
    with st.cond:
        if body.get("session_id"):
            sid = uuid_param(body["session_id"], "session_id")
            s = st.sessions.get(sid)
            if s is None or s["user_id"] != user["user_id"]:
                raise HttpError(404, "Not Found", "session not found")
            if s["app"] != app:
                raise bad_request("session_id: that session is %s, not %s" % (APP_NAMES[s["app"]], APP_NAMES[app]))
            if not st.live(s, at):
                raise _not_connected(app, s)
        else:
            live = sorted((x for x in st.sessions.values() if x["user_id"] == user["user_id"] and st.live(x, at)),
                          key=lambda x: (-x["last_seen_at"], x["id"]))
            s = None
            for x in live:
                if x["app"] != app:
                    continue
                if s is None or (from_agent and not s["allow_agent"] and x["allow_agent"]):
                    s = x
            if s is None:
                raise _not_connected(app)
        if kind not in BUILTIN_KINDS and kind not in s["capabilities"]:
            suffix = " on " + s["machine_name"] if s["machine_name"] else ""
            raise HttpError(422, "Unprocessable Entity",
                            "the NOLGIA plugin in %s%s does not support %s. It supports: %s. Update the plugin from "
                            "%s to get newer commands" % (APP_NAMES[app], suffix, json.dumps(kind),
                                                          ", ".join(["info", "run"] + s["capabilities"]), PLUGINS_URL),
                            code="capability_not_supported")
        if from_agent and not s["allow_agent"]:
            raise HttpError(403, "Forbidden",
                            "this %s session does not allow the NOLGIA Agent. To let the agent send commands, turn on "
                            "Allow NOLGIA Agent in the NOLGIA panel in %s" % (APP_NAMES[app], APP_NAMES[app]),
                            code="agent_not_allowed")
        if s["disconnected_at"] is not None:
            raise _not_connected(app)
        c = {"id": str(uuid.uuid4()), "session_id": s["id"], "user_id": user["user_id"], "kind": kind,
             "args": args, "status": "queued", "result": None, "error": None,
             "caller": "agent" if from_agent else "user", "created_at": at, "claimed_at": None,
             "finished_at": None, "expires_at": at + timeout}
        st.commands[c["id"]] = c
        st.cond.notify_all()
        view = st.command_view(c)
    return h._send(201, view)


@route("GET", r"/v1/bridge/commands/([^/]+)")
def get_command(h, command_id):
    user = h.user()
    command_id = uuid_param(command_id)
    wait = wait_param(h.query, 0)
    st = h.state
    deadline = now() + wait
    with st.cond:
        while True:
            c = st.get_command(user["user_id"], command_id, now())
            if c is None:
                raise HttpError(404, "Not Found", "command not found")
            if c["status"] not in ("queued", "running") or now() >= deadline:
                view = st.command_view(c)
                break
            st.cond.wait(min(deadline - now(), 0.5))
    return h._send(200, view)


@route("POST", r"/v1/bridge/commands/([^/]+)/cancel")
def cancel_command(h, command_id):
    user = h.user()
    command_id = uuid_param(command_id)
    st = h.state
    at = now()
    with st.cond:
        c = st.commands.get(command_id)
        if c is None or c["user_id"] != user["user_id"]:
            raise HttpError(404, "Not Found", "command not found")
        if c["status"] in ("queued", "running") and c["expires_at"] > at:
            c.update(status="cancelled", finished_at=at, error=ERROR_CANCELLED)
            st.cond.notify_all()
        else:
            c = st.get_command(user["user_id"], command_id, at)
            if c["status"] != "cancelled":
                raise HttpError(409, "Conflict", "this command already finished (%s), so there is nothing to cancel"
                                % c["status"], code="command_finished")
        view = st.command_view(c)
    return h._send(200, view)


# ------------------------------------------------------------------ assets

@route("POST", r"/v1/assets/uploads")
def create_upload(h):
    user = h.user()
    body = strict_json(h.raw_body, ("filename", "content_type", "size_bytes", "tags", "display_name", "project_id"),
                       required=("filename", "content_type", "size_bytes"))
    ctype = body["content_type"]
    if ctype not in UPLOAD_CONTENT_TYPES:
        raise bad_request("content_type %s is not supported" % ctype)
    size = body["size_bytes"]
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise bad_request("size_bytes must be at least 1")
    filename = body["filename"]
    if not isinstance(filename, str) or not 1 <= len(filename) <= 255:
        raise bad_request("filename must be 1..255 characters")
    tags = body.get("tags") or []
    if not isinstance(tags, list) or len(tags) > 10 or not all(isinstance(t, str) and 1 <= len(t) <= 40 for t in tags):
        raise bad_request("tags must be at most 10 strings of 1..40 characters")
    display = body.get("display_name")
    if display is not None and (not isinstance(display, str) or len(display) > 200):
        raise bad_request("display_name must be at most 200 characters")
    st = h.state
    with st.cond:
        asset = st.new_asset(user["user_id"], filename, ctype, size, display, tags)
        upload_id = str(uuid.uuid4())
        st.uploads[upload_id] = {"id": upload_id, "asset_id": asset["id"], "content_type": ctype,
                                 "size_bytes": size, "bytes": None, "user_id": user["user_id"],
                                 "filename": filename}
    return h._send(201, {"upload_id": upload_id, "asset_id": asset["id"],
                         "upload_url": "http://%s/storage/uploads/%s?X-Mock-Signature=%s" % (h.host, upload_id, asset["sig"]),
                         "expires_at": rfc3339(now() + 1800)})


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
    return h._send(200, raw=b"", content_type="text/plain")


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
    return h._send(200, view)


@route("GET", r"/v1/assets/([^/]+)")
def get_asset(h, asset_id):
    user = h.user()
    st = h.state
    with st.cond:
        asset = st.assets.get(asset_id)
        if asset is None or asset["user_id"] != user["user_id"] or asset["status"] != "ready":
            raise HttpError(404, "Not Found", "asset not found")
        view = st.asset_view(asset, h.host)
    return h._send(200, view)


@route("GET", r"/storage/assets/([^/]+)")
def download_asset(h, asset_id):
    h.no_bearer()
    st = h.state
    with st.cond:
        asset = st.assets.get(asset_id)
        if asset is None or asset["bytes"] is None or h.query.get("X-Mock-Signature") != asset["sig"]:
            raise HttpError(403, "AccessDenied", "bad or missing signature")
        data, ctype = asset["bytes"], asset["content_type"]
    return h._send(200, raw=data, content_type=ctype)


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
    return h._send(201, view)


@route("GET", r"/mock/assets/([^/]+)/bytes")
def mock_asset_bytes(h, asset_id):
    with h.state.cond:
        asset = h.state.assets.get(asset_id)
        if asset is None or asset["bytes"] is None:
            raise HttpError(404, "Not Found", "asset not found")
        data, ctype = asset["bytes"], asset["content_type"]
    return h._send(200, raw=data, content_type=ctype)


@route("GET", r"/mock/state")
def mock_state(h):
    st = h.state
    at = now()
    with st.cond:
        out = {
            "sessions": [dict(st.session_view(s), live=st.live(s, at), disconnected=s["disconnected_at"] is not None)
                         for s in st.sessions.values()],
            "commands": [st.command_view(c) for c in st.commands.values()],
            "deleted_sessions": list(st.deleted_sessions),
            "heartbeats": len(st.heartbeats),
            "last_heartbeat": st.heartbeats[-1]["body"] if st.heartbeats else None,
            "uploads": [{k: v for k, v in u.items() if k != "bytes"} for u in st.uploads.values()],
            "requests": list(st.requests),
        }
    return h._send(200, out)


@route("POST", r"/mock/reset")
def mock_reset(h):
    h.state.reset()
    return h._send(204)


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
    parser.add_argument("--poll-wait-seconds", type=int, default=MAX_WAIT,
                        help="poll_wait_seconds the session answers (shorter long polls in tests)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    server = MockBridgeServer(args.host, args.port, verbose=args.verbose,
                              tokens=tuple(args.token or ["test-token"]),
                              device_interval=args.device_interval,
                              auto_approve_after=args.auto_approve_after,
                              poll_wait_seconds=args.poll_wait_seconds)
    print("NOLGIA mock API listening on %s" % server.base_url, flush=True)
    try:
        server.httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
