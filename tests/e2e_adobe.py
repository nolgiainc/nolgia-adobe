#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 NOLGIA Inc
"""End-to-end test: the real extension in the real Adobe apps.

For each app (After Effects, Premiere Pro, Illustrator):

1. Builds the signed zxp with adobe/tools/build.js (or takes --zxp) and
   installs it with Adobe's own installer (UnifiedPluginInstallerAgent),
   removing an installed copy first (the installer skips the same version).
2. Points the plugin at the API in <user data>/NOLGIA/adobe/env.json:
   the mock from tools/mock_bridge_server.py (default), or production with
   --api prod and a token file. A fixed NOLGIA_INSTANCE_ID marks the session,
   and every command names that session, so other sessions of the same
   account are never touched. env.json is removed at the end.
3. Starts the app, waits for its session (dismissing the app's own warning
   dialogs, whose text is logged), then drives every command kind through
   POST /bridge/commands as the MCP server would, checking each result.
4. Closes the app's documents without saving and quits it.

Usage (from WSL, or on Windows with a Windows Python):
    python3 adobe/tests/e2e_adobe.py --zxpsigncmd /path/ZXPSignCmd.exe
    python3 adobe/tests/e2e_adobe.py --api prod --token-file ~/.config/nolgia/tokens.json
    python3 adobe/tests/e2e_adobe.py --apps illustrator --workdir "/mnt/c/Users/me/Documents/NOLGIA e2e"

Only Windows hosts are wired up here (the app paths and the dialog helper
are Windows ones). The work folder must be one the apps can reach.
"""

import argparse
import json
import ntpath
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ADOBE = os.path.dirname(HERE)
REPO = os.path.dirname(ADOBE)
sys.path.insert(0, os.path.join(REPO, "tools"))

from mock_bridge_server import MockBridgeServer  # noqa: E402

TOKEN = "e2e-token"
VERSION = json.load(open(os.path.join(ADOBE, "package.json")))["version"]
CAPABILITIES = ["info", "run", "preview", "import_asset", "export", "save", "open"]
UPIA = r"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
APPS = {
    "after_effects": {
        "exe": r"C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\AfterFX.exe",
        "process": "AfterFX",
        "title": "Adobe After Effects",
        "main_class": "AE_CApplication",
        "ext": "aep",
    },
    "premiere": {
        "exe": r"C:\Program Files\Adobe\Adobe Premiere Pro 2026\Adobe Premiere Pro.exe",
        "process": "Adobe Premiere Pro",
        "title": "Adobe Premiere",
        "main_class": "Premiere Pro",
        "ext": "prproj",
    },
    "illustrator": {
        "exe": r"C:\Program Files\Adobe\Adobe Illustrator 2026\Support Files\Contents\Windows\Illustrator.exe",
        "process": "Illustrator",
        "title": "Adobe Illustrator",
        "main_class": "illustrator",
        "ext": "ai",
    },
}

# Lists, reads and presses Enter on (or closes) a process's top-level windows.
WINDOWS_PS1 = r"""
param([string]$action, [string]$proc, [long]$hwnd = 0)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class NW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static List<IntPtr> Top() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p) { var l = new List<IntPtr>(); EnumChildWindows(p, (h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Text(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, 2048); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
"@
$pids = @{}; Get-Process -Name $proc -ErrorAction SilentlyContinue | ForEach-Object { $pids[[uint32]$_.Id] = 1 }
foreach ($h in [NW]::Top()) {
  if (-not [NW]::IsWindowVisible($h)) { continue }
  $p = [uint32]0; [NW]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if (-not $pids.ContainsKey($p)) { continue }
  if ($hwnd -and [long]$h -ne $hwnd) { continue }
  $cls = [NW]::Cls($h)
  if ($action -eq "list") {
    $texts = ([NW]::Kids($h) | ForEach-Object { [NW]::Text($_) } | Where-Object { $_ }) -join " | "
    "$([long]$h)`t$cls`t$([NW]::Text($h))`t$texts"
  } elseif ($action -eq "enter") {
    [NW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [NW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [NW]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 300
    Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  } elseif ($action -eq "close") {
    [NW]::SendMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
}
"""


# ---------------------------------------------------------------- platform


class Windows:
    """Runs Windows programs, from WSL or from Windows itself."""

    def __init__(self):
        self.wsl = os.path.exists("/proc/version") and "microsoft" in open("/proc/version").read().lower()
        if not self.wsl and os.name != "nt":
            raise SystemExit("e2e_adobe.py drives the Windows apps; run it on Windows or in WSL.")
        self.ps1 = None

    def to_win(self, path):
        if not self.wsl:
            return path
        return subprocess.check_output(["wslpath", "-w", path], text=True).strip()

    def from_win(self, path):
        if not self.wsl:
            return path
        return subprocess.check_output(["wslpath", "-u", path], text=True).strip()

    def exe(self, win_path):
        return self.from_win(win_path) if self.wsl else win_path

    def env_var(self, name):
        if not self.wsl:
            return os.environ.get(name, "")
        out = subprocess.check_output(["cmd.exe", "/c", "echo %" + name + "%"], cwd="/mnt/c", text=True)
        return out.strip()

    def powershell(self, script_args, timeout=60):
        if self.ps1 is None:
            folder = self.from_win(self.env_var("TEMP")) if self.wsl else tempfile.gettempdir()
            self.ps1 = os.path.join(folder, "nolgia-e2e-windows.ps1")
            with open(self.ps1, "w", encoding="utf-8") as handle:
                handle.write(WINDOWS_PS1)
        exe = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" if self.wsl else "powershell.exe"
        cmd = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", self.to_win(self.ps1)] + script_args
        try:
            out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return ""
        return out.stdout.replace("\r", "")

    def windows(self, process):
        rows = []
        for line in self.powershell(["-action", "list", "-proc", process]).splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                rows.append({"hwnd": int(parts[0]), "cls": parts[1], "title": parts[2],
                             "text": parts[3] if len(parts) > 3 else ""})
        return rows

    def press_enter(self, process, hwnd):
        self.powershell(["-action", "enter", "-proc", process, "-hwnd", str(hwnd)])

    def close(self, process, hwnd):
        self.powershell(["-action", "close", "-proc", process, "-hwnd", str(hwnd)])

    def running(self, image):
        # The full list: a /FI filter's quotes do not survive the trip from WSL.
        exe = "/mnt/c/Windows/System32/tasklist.exe" if self.wsl else "tasklist.exe"
        out = subprocess.run([exe, "/NH", "/FO", "CSV"], stdout=subprocess.PIPE, text=True,
                             errors="replace").stdout
        return ('"%s"' % image.lower()) in out.lower()


# ---------------------------------------------------------------- fixtures


def make_png(width=64, height=36, colour=(255, 106, 26)):
    raw = b"".join(b"\x00" + bytes(colour) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def png_size(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", data[16:24])


def jpeg_or_png_size(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return png_size(data)
    assert data[:3] == b"\xff\xd8\xff", "not a PNG or JPEG"
    i = 2
    while i < len(data):
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xC3:
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise AssertionError("no JPEG size")


def make_wav(path, seconds=2, rate=48000):
    import math
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate)))
                          for i in range(int(seconds * rate)))
        out.writeframes(frames)


# ------------------------------------------------------------------ caller


class Caller:
    """What the MCP server does: queue a command for one session and wait."""

    def __init__(self, root, token, mock=None):
        self.root = root.rstrip("/")
        self.token = token
        self.mock = mock
        self.session_id = None
        self.app = None
        self.assets = []

    def http(self, method, path, body=None, raw=False, auth=True, url=None, headers=None, tries=4):
        """One request. A TLS handshake that times out never reached the
        server, so it is retried."""
        for attempt in range(tries):
            try:
                return self._http(method, path, body, raw, auth, url, headers)
            except urllib.error.URLError as err:
                if attempt == tries - 1 or "handshake" not in str(err.reason):
                    raise
                time.sleep(2)

    def _http(self, method, path, body=None, raw=False, auth=True, url=None, headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(url or self.root + path, data=data, method=method, headers=headers or {})
        if auth:
            req.add_header("Authorization", "Bearer " + self.token)
        if body is not None and not isinstance(body, bytes):
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
                return resp.status, (payload if raw else (json.loads(payload) if payload else None))
        except urllib.error.HTTPError as err:
            payload = err.read()
            try:
                return err.code, json.loads(payload) if payload else None
            except ValueError:
                return err.code, payload

    def sessions(self):
        status, data = self.http("GET", "/v1/bridge/sessions")
        assert status == 200, (status, data)
        return data["sessions"]

    def command(self, kind, args=None, timeout=180):
        body = {"app": self.app, "session_id": self.session_id, "kind": kind, "args": args or {},
                "timeout_seconds": timeout}
        status, cmd = self.http("POST", "/v1/bridge/commands", body)
        assert status == 201, "enqueue %s: %s %s" % (kind, status, cmd)
        end = time.time() + timeout + 30
        while cmd["status"] in ("queued", "running") and time.time() < end:
            status, cmd = self.http("GET", "/v1/bridge/commands/%s?wait=25" % cmd["id"])
            assert status == 200, (status, cmd)
        aid = (cmd.get("result") or {}).get("asset_id")
        if aid:
            self.assets.append(aid)
        return cmd

    def ok(self, kind, args=None, timeout=180):
        cmd = self.command(kind, args, timeout)
        assert cmd["status"] == "succeeded", "%s %s: %s" % (kind, cmd["status"], cmd.get("error"))
        return cmd["result"]

    def fails(self, kind, args, text):
        cmd = self.command(kind, args)
        assert cmd["status"] == "failed", "expected %s to fail, got %s" % (kind, cmd["status"])
        assert text in (cmd.get("error") or ""), "error %r does not mention %r" % (cmd.get("error"), text)
        return cmd

    def asset_bytes(self, asset_id):
        if self.mock:
            status, data = self.http("GET", "/mock/assets/%s/bytes" % asset_id, raw=True, auth=False)
            assert status == 200, status
            return data
        status, asset = self.http("GET", "/v1/assets/%s" % asset_id)
        assert status == 200, (status, asset)
        status, data = self.http("GET", "", raw=True, auth=False, url=asset["signed_url"])
        assert status == 200, status
        return data

    def upload(self, filename, content_type, data):
        """An asset for import_asset, as the person's own library would hold it."""
        if self.mock:
            status, asset = self.http(
                "POST", "/mock/assets?filename=%s&content_type=%s" % (filename, content_type), data, auth=False)
            assert status == 201, asset
            return asset["id"]
        status, slot = self.http("POST", "/v1/assets/uploads", {
            "filename": filename, "content_type": content_type, "size_bytes": len(data),
            "display_name": "NOLGIA e2e " + filename, "tags": ["nolgia-e2e"]})
        assert status == 201, (status, slot)
        status, _ = self.http("PUT", "", data, raw=True, auth=False, url=slot["upload_url"],
                              headers={"Content-Type": content_type})
        assert status in (200, 201), status
        status, asset = self.http("POST", "/v1/assets/uploads/%s/complete" % slot["upload_id"])
        assert status == 200, (status, asset)
        self.assets.append(asset["id"])
        return asset["id"]

    def trash_assets(self):
        if self.mock:
            return 0
        n = 0
        for aid in self.assets:
            status, _ = self.http("DELETE", "/v1/assets/%s" % aid)
            n += status in (200, 204)
        return n


# ------------------------------------------------------------------ runner


class Checks:
    def __init__(self):
        self.results = []

    def check(self, app, name, fn):
        started = time.time()
        try:
            fn()
        except Exception as err:  # report and keep going
            self.results.append((app, name, False, "%s: %s" % (type(err).__name__, err)))
            print("FAIL %-12s %-46s %5.1fs  %s: %s" % (app, name, time.time() - started, type(err).__name__,
                                                     str(err)[:600]), flush=True)
            return False
        self.results.append((app, name, True, ""))
        print("PASS %-12s %-46s %5.1fs" % (app, name, time.time() - started), flush=True)
        return True


def build_and_install(win, opts):
    zxp = opts.zxp
    if not zxp:
        tool = opts.zxpsigncmd or os.environ.get("ZXPSIGNCMD")
        assert tool, "pass --zxpsigncmd (Adobe's ZXPSignCmd) or --zxp"
        out = subprocess.run(["node", os.path.join(ADOBE, "tools", "build.js"), "--zxpsigncmd", tool],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert out.returncode == 0, out.stdout[-2000:]
        zxp = os.path.join(ADOBE, "dist", "nolgia-adobe-%s.zxp" % VERSION)
    staged = os.path.join(opts.workdir, os.path.basename(zxp))
    shutil.copyfile(zxp, staged)
    upia = win.exe(UPIA)
    subprocess.run([upia, "/remove", "NOLGIA"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = subprocess.run([upia, "/install", win.to_win(staged)], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, errors="replace")
    assert "Installation Successful" in out.stdout, out.stdout[-1500:]
    return staged


def env_file(win):
    appdata = win.from_win(win.env_var("APPDATA"))
    return os.path.join(appdata, "NOLGIA", "adobe", "env.json")


def wait_for_session(win, caller, app, instance_id, proc, timeout=300):
    """Dismiss the app's startup dialogs until our session is live."""
    end = time.time() + timeout
    seen = set()
    while time.time() < end:
        for w in win.windows(proc["process"]):
            if w["cls"] == "#32770":
                if w["hwnd"] not in seen:
                    print("     dialog in %s: %s %s" % (app, w["title"], w["text"][:200]), flush=True)
                    seen.add(w["hwnd"])
                win.press_enter(proc["process"], w["hwnd"])
        for s in caller.sessions():
            if s["instance_id"] == instance_id and s["app"] == app and s["app_version"]:
                return s
        time.sleep(3)
    raise AssertionError("no %s session within %d s" % (app, timeout))


def quit_app(win, caller, app, proc, timeout=120, close_documents=True):
    if close_documents:
        try:
            caller.command("run", {"code": CLOSE_DOCUMENTS[app]}, timeout=30)
        except Exception:
            pass
    image = ntpath.basename(proc["exe"])
    end = time.time() + timeout
    while time.time() < end and win.running(image):
        for w in win.windows(proc["process"]):
            if w["cls"] == "#32770":
                win.press_enter(proc["process"], w["hwnd"])
            elif w["cls"].startswith(proc["main_class"]) or proc["title"] in w["title"]:
                # The main window's title is the document's name while one is open.
                win.close(proc["process"], w["hwnd"])
        time.sleep(4)
    return not win.running(image)


# -------------------------------------------------------------- the checks


def run_app(app, win, caller, checks, opts, api_url, token):
    proc = APPS[app]
    work = os.path.join(opts.workdir, app)
    shutil.rmtree(work, ignore_errors=True)  # a fresh folder: the plugin never overwrites files
    os.makedirs(work, exist_ok=True)
    wwork = win.to_win(work).replace("\\", "/")
    instance_id = "nolgia-e2e-" + app
    env = {"NOLGIA_TOKEN": token, "NOLGIA_API_URL": api_url, "NOLGIA_BRIDGE_AUTOCONNECT": "1",
           "NOLGIA_ASK_BEFORE_RUN": "0", "NOLGIA_ALLOW_AGENT": "1", "NOLGIA_INSTANCE_ID": instance_id,
           "NOLGIA_EXPORT_DIR": win.to_win(os.path.join(work, "exports"))}
    path = env_file(win)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(env, handle)
    caller.app = app
    exe = win.exe(proc["exe"])
    subprocess.Popen([exe], cwd=os.path.dirname(exe), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    session = {}

    def connects():
        session.update(wait_for_session(win, caller, app, instance_id, proc))
        caller.session_id = session["id"]
        assert session["capabilities"] == CAPABILITIES, session["capabilities"]
        assert session["plugin_version"] == VERSION
        assert session["allow_agent"] is True
        assert session["machine_name"]

    if not checks.check(app, "starts with the app and connects", connects):
        quit_app(win, caller, app, proc)
        return

    png = make_png()
    wav = os.path.join(work, "tone.wav")
    make_wav(wav)
    still = os.path.join(work, "plate.png")
    with open(still, "wb") as handle:
        handle.write(make_png(640, 360, (40, 120, 220)))
    wstill = win.to_win(still).replace("\\", "/")

    try:
        checks.check(app, "info with nothing open", lambda: _info_empty(caller, app))
        checks.check(app, "run builds a test document", lambda: _build(caller, app, wwork, wstill))
        checks.check(app, "run: value, stdout, stderr", lambda: _run_values(caller))
        checks.check(app, "run: errors carry the line", lambda: _run_error(caller))
        checks.check(app, "run: other languages refused", lambda: _other_language(caller))
        checks.check(app, "info describes the document", lambda: _info_full(caller, app))
        checks.check(app, "preview uploads a still", lambda: _preview(caller, app))
        checks.check(app, "preview of something missing fails", lambda: caller.fails(
            "preview", {"camera": "No Such Thing"}, "There is no"))
        checks.check(app, "import_asset brings in an image", lambda: _import(caller, app, png))
        if app == "premiere":
            checks.check(app, "import_asset brings in audio", lambda: _import_audio(caller, wav))
        for fmt in {"after_effects": ["png", "mp4"], "premiere": ["png", "mp4"], "illustrator": ["png"]}[app]:
            checks.check(app, "export %s uploads it" % fmt, lambda fmt=fmt: _export_media(caller, app, fmt))
        if app == "illustrator":
            for fmt in ("svg", "pdf"):
                checks.check(app, "export %s stays on this computer" % fmt,
                             lambda fmt=fmt: _export_local(caller, win, fmt))
        checks.check(app, "save to a path, then save", lambda: _save(caller, win, app, work))
        checks.check(app, "export %s copies the project" % proc["ext"],
                     lambda: _export_project(caller, win, proc["ext"]))
        checks.check(app, "open a saved file", lambda: _open(caller, win, app, work))
        checks.check(app, "close documents without saving", lambda: caller.ok("run", {"code": CLOSE_DOCUMENTS[app]}))
        checks.check(app, "ask before running code: nobody there", lambda: _ask(caller, app))
    finally:
        closed = quit_app(win, caller, app, proc, close_documents=False)
        checks.check(app, "quits cleanly", lambda: _assert(closed, "%s did not quit" % app))
        reset_settings(win, app)
        try:
            os.remove(path)
        except OSError:
            pass


def _assert(cond, message):
    assert cond, message


def _info_empty(caller, app):
    if app == "after_effects":
        res = caller.ok("info")
        assert res["app"] == "after_effects" and res["app_version"]
        assert res["document"]["name"] == ""
    elif app == "premiere":
        cmd = caller.command("info")
        # Premiere's Home screen has no project yet.
        assert cmd["status"] == "succeeded" or "no project open" in (cmd.get("error") or ""), cmd
    else:
        res = caller.ok("info")
        assert res["document"]["name"] == "" and res["documents"] == []


BUILD = {
    "after_effects": """
var c = app.project.items.addComp("E2E Comp", 1280, 720, 1, 4, 24);
c.layers.addSolid([1, 0.42, 0.1], "E2E Solid", 640, 360, 1);
var t = c.layers.addText("NOLGIA"); t.property("Position").setValue([640, 360]);
c.openInViewer(); c.time = 1;
result = {comp: c.name, layers: c.numLayers};
""",
    "premiere": """
var ok = app.newProject(%(project)s);
app.project.importFiles([%(still)s], true, app.project.rootItem, false);
var items = [];
for (var i = 0; i < app.project.rootItem.children.numItems; i++) items.push(app.project.rootItem.children[i]);
var seq = app.project.createNewSequenceFromClips("E2E Sequence", items, app.project.rootItem);
result = {project: app.project.name, sequence: seq ? seq.name : null};
""",
    "illustrator": """
var d = app.documents.add(DocumentColorSpace.RGB, 800, 600);
var r = d.pathItems.rectangle(500, 100, 600, 400);
var c = new RGBColor(); c.red = 255; c.green = 106; c.blue = 26; r.fillColor = c; r.stroked = false;
d.artboards.add([900, 600, 1300, 300]); d.artboards[1].name = "Second";
result = {document: d.name, artboards: d.artboards.length};
""",
}


def _build(caller, app, wwork, wstill):
    code = BUILD[app]
    if app == "premiere":
        code = code % {"project": json.dumps(wwork + "/e2e.prproj"), "still": json.dumps(wstill)}
    res = caller.ok("run", {"code": code}, timeout=120)["value"]
    if app == "after_effects":
        assert res == {"comp": "E2E Comp", "layers": 2}, res
    elif app == "premiere":
        assert res == {"project": "e2e.prproj", "sequence": "E2E Sequence"}, res
    else:
        assert res["artboards"] == 2, res


def _run_values(caller):
    res = caller.ok("run", {"code": 'print("out", 1); console.error("err"); $.writeln("w"); 20 + 22'})
    assert res == {"value": 42, "stdout": "out 1\nw\n", "stderr": "err\n"}, res
    res = caller.ok("run", {"code": "if (true) { return {nested: [1, 'two', null]}; }"})
    assert res["value"] == {"nested": [1, "two", None]}, res


def _run_error(caller):
    cmd = caller.fails("run", {"code": 'print("before");\nvar x = 1;\nnull.foo;'}, "on line 3")
    assert "> 3 | null.foo;" in cmd["error"], cmd["error"]
    assert cmd["result"]["stdout"] == "before\n", cmd["result"]


def _other_language(caller):
    """The API may refuse the command itself (it knows each app's language);
    otherwise the plugin does."""
    body = {"app": caller.app, "session_id": caller.session_id, "kind": "run",
            "args": {"code": "print(1)", "language": "python"}, "timeout_seconds": 30}
    status, data = caller.http("POST", "/v1/bridge/commands", body)
    if status == 201:
        while data["status"] in ("queued", "running"):
            status, data = caller.http("GET", "/v1/bridge/commands/%s?wait=25" % data["id"])
        assert data["status"] == "failed" and "runs ExtendScript only" in data["error"], data
    else:
        assert status in (400, 422) and "extendscript" in json.dumps(data).lower(), (status, data)


def _info_full(caller, app):
    res = caller.ok("info")
    assert res["app"] == app
    if app == "after_effects":
        comp = res["active_comp"]
        assert comp["name"] == "E2E Comp" and comp["width"] == 1280 and comp["frame_rate"] == 24, comp
        assert comp["frames"] == 96 and comp["current_frame"] == 24, comp
        assert [l["type"] for l in comp["layer_list"]] == ["text", "solid"], comp["layer_list"]
    elif app == "premiere":
        seq = res["active_sequence"]
        assert seq["name"] == "E2E Sequence" and seq["width"] == 640, seq
        assert seq["in_frame"] is None and seq["video_track_list"][0]["clips"] == 1, seq
        assert res["document"]["name"] == "e2e.prproj", res["document"]
    else:
        assert [a["name"] for a in res["artboards"]] == ["Artboard 1", "Second"], res["artboards"]
        assert res["counts"]["paths"] == 1 and res["document"]["dirty"] is True, res


def _preview(caller, app):
    res = caller.ok("preview", {"width": 640})
    data = caller.asset_bytes(res["asset_id"])
    assert jpeg_or_png_size(data) == (res["width"], res["height"]), (res, jpeg_or_png_size(data))
    assert res["width"] == 640, res
    target = {"after_effects": {"comp": "E2E Comp", "frame": 12},
              "premiere": {"sequence": "E2E Sequence", "frame": 12},
              "illustrator": {"artboard": 2}}[app]
    res = caller.ok("preview", target)
    data = caller.asset_bytes(res["asset_id"])
    assert jpeg_or_png_size(data) == (res["width"], res["height"]), res
    if app == "illustrator":
        assert res["artboard"] == "Second", res
    else:
        assert res["frame"] == 12, res


def _import(caller, app, png):
    asset_id = caller.upload("e2e-import.png", "image/png", png)
    args = {"asset_id": asset_id}
    if app == "after_effects":
        args["as"] = "layer"
    res = caller.ok("import_asset", args)
    assert res["kind"] == "image" and res["imported"], res
    if app == "after_effects":
        assert res["comp"] == "E2E Comp" and res["layer_index"] == 1, res
    if app == "illustrator":
        assert res["type"] == "RasterItem" and res["layer"] == "NOLGIA imports", res
    if app == "after_effects":
        # A footage item (not only a comp) can be previewed.
        shot = caller.ok("preview", {"comp": res["imported"][0]})
        assert shot["source"] == res["imported"][0] and jpeg_or_png_size(caller.asset_bytes(shot["asset_id"])) == (64, 36), shot


def _import_audio(caller, wav):
    with open(wav, "rb") as handle:
        asset_id = caller.upload("e2e-tone.wav", "audio/wav", handle.read())
    res = caller.ok("import_asset", {"asset_id": asset_id})
    assert res["kind"] == "audio" and res["bin"] == "NOLGIA imports", res


def _export_media(caller, app, fmt):
    args = {"format": fmt, "filename": "e2e-" + fmt}
    if fmt == "mp4":
        args["frames"] = "0-23"
    res = caller.ok("export", args, timeout=600)
    data = caller.asset_bytes(res["asset_id"])
    if fmt == "png":
        w, h = png_size(data)
        assert (w, h) == (res["width"], res["height"]), res
    else:
        assert data[4:8] == b"ftyp", data[:16]
        assert res["frames"] == [0, 23], res
    assert res["filename"] == "e2e-%s.%s" % (fmt, fmt) or res["filename"].startswith("e2e-" + fmt), res


def _export_local(caller, win, fmt):
    res = caller.ok("export", {"format": fmt, "filename": "e2e-" + fmt})
    assert res["asset_id"] is None and res["path"].lower().endswith("e2e-%s.%s" % (fmt, fmt)), res
    with open(win.from_win(res["path"]), "rb") as handle:
        head = handle.read(200)
    assert (b"<svg" in head) if fmt == "svg" else head.startswith(b"%PDF"), head[:40]


def _save(caller, win, app, work):
    ext = APPS[app]["ext"]
    target = win.to_win(os.path.join(work, "e2e-saved"))
    res = caller.ok("save", {"path": target})
    assert res["path"].lower().endswith("e2e-saved." + ext), res
    assert os.path.isfile(win.from_win(res["path"])), res
    assert caller.ok("save")["path"] == res["path"]


def _export_project(caller, win, ext):
    res = caller.ok("export", {"format": ext})
    assert res["asset_id"] is None and res["path"].lower().endswith("e2e-saved-copy." + ext), res
    assert os.path.isfile(win.from_win(res["path"])), res


def _open(caller, win, app, work):
    ext = APPS[app]["ext"]
    target = win.to_win(os.path.join(work, "e2e-saved." + ext))
    res = caller.ok("open", {"path": target}, timeout=120)
    assert res["path"].lower() == target.lower(), res
    caller.fails("open", {"path": win.to_win(os.path.join(work, "missing." + ext))}, "There is no file at")


CLOSE_DOCUMENTS = {
    "after_effects": "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); true",
    "premiere": "true",
    "illustrator": "while (app.documents.length) app.documents[0].close(SaveOptions.DONOTSAVECHANGES); true",
}


def _ask(caller, app):
    """Turn on Ask before running code the way the panel does (an event to
    the NOLGIA service, here sent from ExtendScript), then check that code
    waits for a person and does not run when nobody approves it. Clicking
    Approve or Deny needs a person; the unit tests cover those."""
    code = ('var lib = new ExternalObject("lib:PlugPlugExternalObject"); var e = new CSXSEvent(); '
            'e.type = "com.nolgia.adobe.action"; '
            'e.data = \'{"action":"set","name":"ask_before_run","value":true}\'; e.dispatch(); true')
    caller.ok("run", {"code": code})
    time.sleep(1.5)
    name = {"after_effects": "After Effects", "premiere": "Premiere Pro", "illustrator": "Illustrator"}[app]
    cmd = caller.command("run", {"code": "alert('this must not run')"}, timeout=8)
    assert cmd["status"] == "failed", cmd
    assert cmd["error"] == "Nobody approved this in %s in time, so it did not run." % name, cmd["error"]


def reset_settings(win, app):
    """Put Ask before running code back to off in the app's own settings."""
    appdata = win.from_win(win.env_var("APPDATA"))
    path = os.path.join(appdata, "NOLGIA", "adobe", app, "settings.json")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        data["ask_before_run"] = False
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
    except (OSError, ValueError):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apps", default="after_effects,premiere,illustrator")
    parser.add_argument("--api", choices=("mock", "prod"), default="mock")
    parser.add_argument("--api-url", default="https://api.nolgia.ai/v1")
    parser.add_argument("--token-file", default=os.path.expanduser("~/.config/nolgia/tokens.json"),
                        help="JSON with access_token, for --api prod (never printed)")
    parser.add_argument("--zxpsigncmd", default=None)
    parser.add_argument("--zxp", default=None, help="install this zxp instead of building one")
    parser.add_argument("--no-install", action="store_true", help="use the extension already installed")
    parser.add_argument("--workdir", default=None, help="a folder the apps can reach")
    parser.add_argument("--keep-assets", action="store_true", help="prod: leave the test assets in the library")
    parser.add_argument("--report", default=None, help="write the results as JSON here")
    opts = parser.parse_args()

    win = Windows()
    if not opts.workdir:
        docs = win.from_win(win.env_var("USERPROFILE")) + "/Documents"
        opts.workdir = os.path.join(docs, "NOLGIA e2e")
    opts.workdir = os.path.abspath(opts.workdir)
    os.makedirs(opts.workdir, exist_ok=True)
    print("work folder: %s" % opts.workdir, flush=True)
    checks = Checks()
    started = time.time()

    server = None
    if opts.api == "mock":
        server = MockBridgeServer(host="127.0.0.1", tokens=(TOKEN,)).start()
        caller = Caller(server.root_url, TOKEN, mock=server)
        api_url, token = server.base_url, TOKEN
    else:
        with open(os.path.expanduser(opts.token_file), encoding="utf-8") as handle:
            token = json.load(handle)["access_token"]
        api_url = opts.api_url
        caller = Caller(api_url[:-3] if api_url.endswith("/v1") else api_url, token)

    try:
        if not opts.no_install:
            if not checks.check("all", "build and install the signed zxp", lambda: build_and_install(win, opts)):
                return finish(checks, started, opts)
        for app in [a.strip() for a in opts.apps.split(",") if a.strip()]:
            run_app(app, win, caller, checks, opts, api_url, token)
    finally:
        if server is not None:
            server.stop()
        elif not opts.keep_assets:
            print("trashed %d test assets" % caller.trash_assets(), flush=True)
    return finish(checks, started, opts)


def finish(checks, started, opts):
    passed = sum(1 for r in checks.results if r[2])
    failed = [r for r in checks.results if not r[2]]
    print("\n%d passed, %d failed in %.0f s" % (passed, len(failed), time.time() - started), flush=True)
    if opts.report:
        with open(opts.report, "w", encoding="utf-8") as handle:
            json.dump([{"app": a, "check": n, "ok": ok, "error": e} for a, n, ok, e in checks.results], handle,
                      indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
