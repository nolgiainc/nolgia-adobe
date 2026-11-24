#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 NOLGIA Inc
"""End-to-end proof of `sound_design` in the real Premiere Pro.

Runs on Windows (from WSL or a Windows Python) and on macOS, against the mock
API (tools/mock_bridge_server.py): no account, no credits, nothing written to
NOLGIA. The sounds are test tones this script writes, handed to `place` as
local paths (NOLGIA_SOUND_DESIGN_LOCAL=1, test mode only).

1. Refuses to start while Premiere Pro is running: it never touches a
   Premiere Pro someone is using.
2. Installs the zxp with Adobe's installer (--zxp FILE, or --zxpsigncmd to
   build one; --no-install uses the installed copy).
3. Backs up Premiere Pro's NOLGIA settings.json, writes env.json (mock API,
   test token, connect at start, Ask before running code off, test mode),
   starts Premiere Pro and waits for its session; env.json is removed as soon
   as it is connected, settings.json put back at the end.
4. In a new work folder: a new project, the bars clip from tests/fixtures
   (640x360, 23.976 fps, silent sound) on a sequence with an in and an out
   and a marker; then sound_design read, preview (uploaded to the mock, its
   size and range checked), place (eight tones on three new tracks: gain 0,
   -6 and -12 dB, a mono tone, fades, an overlap and an ambience lane), the
   mix exported as WAV and MEASURED (RMS per channel over each tone, the fade
   shapes), a repeated place (nothing twice), remove (tracks and clips gone,
   the editor's A1 as it was), each against its expected numbers.
5. Saves and quits Premiere Pro through the plugin, and prints the numbers
   (also as JSON with --report).

Usage:
    python3 tests/e2e_sound_design.py --zxp dist/nolgia-adobe-0.4.0.zxp
    python3 tests/e2e_sound_design.py --no-install --workdir "/mnt/c/Users/me/Desktop/sound proof"
The work folder must be one Premiere Pro can reach (on WSL, under /mnt/c).
"""
import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_adobe as E  # noqa: E402

TICKS = 254016000000
TB = 10594584000  # 23.976
INSTANCE = "nolgia-e2e-sound-design"
BARS = os.path.join(HERE, "fixtures", "sound-proof-bars-23976.mp4")
TONE_AMP = 0.25  # RMS -15.05 dBFS, peak -12.04 dBFS
SOURCE_RMS = 20 * math.log10(TONE_AMP / math.sqrt(2))


def tone(path, channels, seconds=4.0, rate=48000, freq=1000.0):
    frames = bytearray()
    for i in range(int(seconds * rate)):
        v = int(round(TONE_AMP * 32767 * math.sin(2 * math.pi * freq * i / rate)))
        frames += struct.pack("<h", v) * channels
    with wave.open(path, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(bytes(frames))


def rms_db(samples, rate, a, b):
    seg = samples[int(a * rate):int(b * rate)]
    if not seg:
        return None
    v = math.sqrt(sum(x * x for x in seg) / len(seg)) / 32768.0
    return round(20 * math.log10(v), 2) if v > 0 else -999.0


def read_wav(path):
    with wave.open(path) as f:
        rate, ch, n = f.getframerate(), f.getnchannels(), f.getnframes()
        data = struct.unpack("<%dh" % (n * ch), f.readframes(n))
    left = data[0::ch]
    right = data[1::ch] if ch > 1 else left
    return rate, left, right


class WindowsFromExplorer(E.Windows):
    """Premiere Pro started from WSL directly fails (a DLL entry point error);
    through explorer.exe it starts as from the Start menu."""

    def start(self, proc):
        if self.wsl:
            subprocess.Popen(["/mnt/c/Windows/explorer.exe", proc["exe"]], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        else:
            super().start(proc)


SETUP = r"""
var out = {};
app.newProject(%(project)s);
app.project.importFiles([%(bars)s], true, app.project.rootItem, false);
var bars = null;
for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
  var c = app.project.rootItem.children[i];
  if (String(c.getMediaPath()).replace(/\\/g, "/").toLowerCase() === %(bars)s.toLowerCase()) bars = c;
}
var seq = app.project.createNewSequenceFromClips("Sound proof", [bars], app.project.rootItem);
seq.setInPoint(String(24 * %(tb)d));
seq.setOutPoint(String(240 * %(tb)d));
var m = seq.markers.createMarker(4.5); m.name = "Door";
app.project.save();
result = { project: String(app.project.path), sequence: seq.name, timebase: String(seq.timebase), a1: seq.audioTracks[0].clips.numItems };
"""

EXPORT_WAV = r"""
var seq = app.project.activeSequence;
var preset = new File(String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/") + "MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr");
if (!preset.exists) preset = new File(String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/") + "Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr");
var out = new File(%(out)s);
var r = seq.exportAsMediaDirect(out.fsName, preset.fsName, app.encoder.ENCODE_ENTIRE);
result = { r: String(r), exists: out.exists, preset: preset.exists };
"""

# Where each tone goes (ms) and what the exported mix must measure there.
CUES = [
    # cue_id, source, start, in, out, gain, fade in, fade out, role, lane
    ("t0", "stereo", 500, 0, 2000, 0, 0, 0, "sfx", 1),
    ("t6", "stereo", 3000, 1001, 3001, -6, 0, 0, "sfx", 1),
    ("t12", "stereo", 5500, 0, 2000, -12, 0, 0, "sfx", 1),
    ("mono", "mono", 8000, 0, 1500, 0, 0, 0, "sfx", 1),
    ("fades", "stereo", 10000, 1001, 3003, -6, 500, 500, "sfx", 1),
    ("over_a", "stereo", 12500, 0, 1000, -20, 0, 0, "sfx", 1),
    ("over_b", "stereo", 13000, 0, 1000, -20, 0, 0, "sfx", 1),
    ("amb", "stereo", 14500, 0, 1000, -20, 0, 0, "ambience", 2),
]


def frame_s(ms):
    return round(ms * TICKS / 1000 / TB) * TB / TICKS


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zxpsigncmd", default=None)
    parser.add_argument("--zxp", default=None, help="install this zxp instead of building one")
    parser.add_argument("--no-install", action="store_true", help="use the extension already installed")
    parser.add_argument("--workdir", default=None, help="a new folder Premiere Pro can reach")
    parser.add_argument("--report", default=None, help="write the measured numbers as JSON here")
    opts = parser.parse_args()
    report, opts.report = opts.report, None  # ours has the numbers; E.finish writes none

    win = E.Mac() if sys.platform == "darwin" else WindowsFromExplorer()
    proc = E.APPS["premiere"]
    if win.running(proc):
        print("Premiere Pro is running. Quit it first: this test never touches a Premiere Pro in use.")
        return 2
    if not opts.workdir:
        opts.workdir = os.path.join(win.documents(), "NOLGIA sound design proof " + time.strftime("%Y%m%d-%H%M%S"))
    work = os.path.abspath(opts.workdir)
    os.makedirs(work, exist_ok=True)
    wwork = win.to_win(work).replace("\\", "/")
    print("work folder: %s" % work, flush=True)

    checks = E.Checks()
    started = time.time()
    numbers = {}
    if not opts.no_install:
        opts.workdir = work
        if not checks.check("premiere", "install the zxp", lambda: E.build_and_install(win, opts)):
            return E.finish(checks, started, opts)

    settings_dir = os.path.join(win.user_data(), "NOLGIA", "adobe", "premiere")
    settings = os.path.join(settings_dir, "settings.json")
    saved_settings = open(settings, "rb").read() if os.path.exists(settings) else None
    env_path = E.env_file(win)
    server = E.MockBridgeServer(host="127.0.0.1", tokens=(E.TOKEN,)).start()
    caller = E.Caller(server.root_url, E.TOKEN, mock=server)
    caller.app = "premiere"
    os.makedirs(os.path.dirname(env_path), exist_ok=True)
    with open(env_path, "w", encoding="utf-8") as handle:
        json.dump({"NOLGIA_TOKEN": E.TOKEN, "NOLGIA_API_URL": server.base_url, "NOLGIA_BRIDGE_AUTOCONNECT": "1",
                   "NOLGIA_ASK_BEFORE_RUN": "0", "NOLGIA_ALLOW_AGENT": "1", "NOLGIA_INSTANCE_ID": INSTANCE,
                   "NOLGIA_UPDATE_CHECK": "0", "NOLGIA_SOUND_DESIGN_LOCAL": "1"}, handle)
    win.start(proc)
    try:
        def connects():
            s = E.wait_for_session(win, caller, "premiere", INSTANCE, proc)
            caller.session_id = s["id"]
            os.remove(env_path)  # read at start only
            assert "sound_design" in s["capabilities"], s["capabilities"]
            numbers["plugin_version"] = s["plugin_version"]
            numbers["app_version"] = s["app_version"]
        if not checks.check("premiere", "starts and connects with sound_design", connects):
            return E.finish(checks, started, opts)
        run_proof(caller, checks, win, work, wwork, numbers)
    finally:
        try:
            caller.command("run", {"code": "app.project.save();"}, timeout=30)
        except Exception:
            pass
        E.quit_app(win, caller, "premiere", proc, close_documents=False, via_plugin=True)
        if os.path.exists(env_path):
            os.remove(env_path)
        if saved_settings is not None:
            with open(settings, "wb") as handle:
                handle.write(saved_settings)
        server.stop()
        print(json.dumps(numbers, indent=1), flush=True)
        if report:
            with open(report, "w", encoding="utf-8") as handle:
                json.dump({"numbers": numbers, "checks": [{"check": n, "ok": ok, "error": e} for _, n, ok, e in checks.results]},
                          handle, indent=1)
    return E.finish(checks, started, opts)


def run_proof(caller, checks, win, work, wwork, numbers):
    media = os.path.join(work, "media")
    os.makedirs(media, exist_ok=True)
    bars = os.path.join(media, os.path.basename(BARS))
    shutil.copyfile(BARS, bars)
    tone(os.path.join(media, "tone stereo.wav"), 2)
    tone(os.path.join(media, "tone mono.wav"), 1)
    project = wwork + "/project/sound proof.prproj"
    os.makedirs(os.path.join(work, "project"), exist_ok=True)
    state = {}

    def setup():
        code = SETUP % {"project": json.dumps(project), "bars": json.dumps(win.to_win(bars).replace("\\", "/")), "tb": TB}
        res = caller.ok("run", {"code": code}, timeout=120)["value"]
        assert res["timebase"] == str(TB) and res["a1"] == 1, res
    if not checks.check("premiere", "a scratch project with the bars on a 23.976 sequence", setup):
        return

    def read_before():
        r = caller.ok("sound_design", {"action": "read"}, timeout=60)
        s = r["sequence"]
        assert (s["fps"], s["in_ms"], s["out_ms"]) == (23.976, 1001, 10010), s
        assert [t["track"] for t in r["audio_tracks"]] == ["A1", "A2", "A3"], r["audio_tracks"]
        assert r["empty_audio_tracks"] == ["A2", "A3"], r["empty_audio_tracks"]
        assert r["markers"][0]["name"] == "Door" and r["markers"][0]["start_ms"] == 4500, r["markers"]
        state["a1"] = r["audio_tracks"][0]["clips"]
        state["v1"] = r["video_tracks"][0]["clips"]
        numbers["read"] = {"fps": s["fps"], "duration_ms": s["duration_ms"], "in_ms": s["in_ms"], "out_ms": s["out_ms"]}
    checks.check("premiere", "read: tracks, clips, in and out, markers", read_before)

    def preview():
        t0 = time.time()
        r = caller.ok("sound_design", {"action": "preview"}, timeout=300)
        numbers["preview"] = dict(r, seconds=round(time.time() - t0, 1))
        rng = r["range"]
        assert (rng["from"], rng["start_ms"], rng["end_ms"], rng["duration_ms"]) == ("in_out", 1001, 10010, 9009), rng
        assert r["timeline_offset_ms"] == 1001 and (r["width"], r["height"]) == (640, 360), r
        data = caller.asset_bytes(r["asset_id"])
        assert data[4:8] == b"ftyp" and len(data) == r["bytes"], len(data)
        path = os.path.join(work, "preview.mp4")
        with open(path, "wb") as handle:
            handle.write(data)
        if shutil.which("ffprobe"):
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration",
                                  "-of", "json", path], stdout=subprocess.PIPE, text=True).stdout
            probe = json.loads(out)
            numbers["preview_probe"] = probe
            video = [s for s in probe["streams"] if s.get("width")][0]
            assert (video["codec_name"], video["width"], video["height"], video["r_frame_rate"]) == ("h264", 640, 360, "24000/1001"), video
            assert any(s["codec_name"] == "aac" for s in probe["streams"]), probe
            assert abs(float(probe["format"]["duration"]) - 9.009) < 0.1, probe["format"]
    checks.check("premiere", "preview: H.264 of the in to out range, uploaded, its start on the timeline", preview)

    files = []
    for cue_id, src, start, a, b, gain, fi, fo, role, lane in CUES:
        files.append({"cue_id": cue_id, "name": cue_id, "file": "NOLGIA Sounds/%s %s.wav" % (cue_id, src),
                      "path": win.to_win(os.path.join(media, "tone %s.wav" % src)), "start_ms": start,
                      "source_in_ms": a, "source_out_ms": b, "gain_db": gain, "fade_in_ms": fi, "fade_out_ms": fo,
                      "role": role, "lane": lane, "credit": "Tone %s by NOLGIA (CC BY 4.0)" % cue_id if cue_id == "amb" else ""})

    def place():
        r = caller.ok("sound_design", {"action": "place", "run_id": "e2e-run-1", "files": files}, timeout=300)
        numbers["place"] = {k: r.get(k) for k in ("placed", "not_placed", "tracks", "folder", "bin", "backup", "record", "credits")}
        assert r["placed"] == len(CUES), r["cues"]
        assert [t["name"] for t in r["tracks"]] == ["NOLGIA SFX 1", "NOLGIA SFX 2", "NOLGIA Ambience"], r["tracks"]
        assert os.path.exists(win.from_win(r["backup"])), r["backup"]
        assert os.path.exists(win.from_win(r["record"])), r["record"]
        after = caller.ok("sound_design", {"action": "read"}, timeout=60)
        names = [(t["name"], len(t["clips"])) for t in after["audio_tracks"]]
        numbers["tracks_after_place"] = names
        assert names[3:] == [("NOLGIA SFX 1", 6), ("NOLGIA SFX 2", 1), ("NOLGIA Ambience", 1)], names
        assert after["audio_tracks"][0]["clips"] == state["a1"], "A1 changed"
        assert after["video_tracks"][0]["clips"] == state["v1"], "V1 changed"
        # Frame exact: 500 ms at 23.976 is frame 12.
        assert after["audio_tracks"][3]["clips"][0]["start_frame"] == 12, after["audio_tracks"][3]["clips"][0]
    if not checks.check("premiere", "place: eight tones on three new tracks, the editor's tracks as they were", place):
        return

    def measure():
        out = wwork + "/mix.wav"
        res = caller.ok("run", {"code": EXPORT_WAV % {"out": json.dumps(out)}}, timeout=200)["value"]
        assert res["exists"], res
        rate, left, right = read_wav(os.path.join(work, "mix.wav"))
        m = {}

        def window(name, start_ms, length_ms, expected, both=True):
            a = frame_s(start_ms) + 0.1
            b = frame_s(start_ms) + length_ms / 1000 - 0.1
            m[name] = {"L": rms_db(left, rate, a, b), "R": rms_db(right, rate, a, b), "expected": round(expected, 2)}
            assert abs(m[name]["L"] - expected) < 0.2 and (not both or abs(m[name]["R"] - expected) < 0.2), (name, m[name])
        window("gain 0 dB", 500, 2002, SOURCE_RMS)
        window("gain -6 dB", 3000, 2002, SOURCE_RMS - 6)
        window("gain -12 dB", 5500, 2002, SOURCE_RMS - 12)
        window("mono 0 dB (each side)", 8000, 1502, SOURCE_RMS - 3.01)
        window("fades -6 dB (middle)", 10000 + 500, 1002, SOURCE_RMS - 6)
        start = frame_s(10000)
        fade_in = [rms_db(left, rate, start + k * 0.05, start + (k + 1) * 0.05) for k in range(12)]
        end = start + 2.002
        fade_out = [rms_db(left, rate, end - (12 - k) * 0.05, end - (11 - k) * 0.05) for k in range(12)]
        m["fade in, 50 ms windows"] = fade_in
        m["fade out, 50 ms windows"] = fade_out
        assert fade_in[0] < -40 and abs(fade_in[-1] - (SOURCE_RMS - 6)) < 0.5, fade_in
        assert all(fade_in[k] <= fade_in[k + 1] + 0.05 for k in range(11)), fade_in
        assert fade_out[-1] < -40 and abs(fade_out[0] - (SOURCE_RMS - 6)) < 0.5, fade_out
        m["silence before the first tone"] = rms_db(left, rate, 0.05, 0.45)
        assert m["silence before the first tone"] < -80
        numbers["measured"] = m
    checks.check("premiere", "the mix measures: gain 0/-6/-12 dB, mono centred, fades from silence", measure)

    def repeat():
        r = caller.ok("sound_design", {"action": "place", "run_id": "e2e-run-1", "files": files}, timeout=300)
        assert (r["placed"], r["already_placed"]) == (0, len(CUES)), r
        after = caller.ok("sound_design", {"action": "read"}, timeout=60)
        assert len(after["audio_tracks"]) == 6, [t["name"] for t in after["audio_tracks"]]
    checks.check("premiere", "a repeated place places nothing twice", repeat)

    def remove():
        r = caller.ok("sound_design", {"action": "remove", "run_id": "e2e-run-1"}, timeout=300)
        numbers["remove"] = r
        assert r["removed"] == len(CUES) and sorted(r["tracks_removed"]) == ["NOLGIA Ambience", "NOLGIA SFX 1", "NOLGIA SFX 2"], r
        after = caller.ok("sound_design", {"action": "read"}, timeout=60)
        assert len(after["audio_tracks"]) == 3, [t["name"] for t in after["audio_tracks"]]
        assert after["audio_tracks"][0]["clips"] == state["a1"], "A1 changed"
        folder = win.from_win(numbers["place"]["folder"])
        assert os.path.exists(os.path.join(folder, "t0 stereo.wav")), os.listdir(folder)
    checks.check("premiere", "remove: the run's clips and tracks out, the files kept, A1 as it was", remove)


if __name__ == "__main__":
    sys.exit(main())
