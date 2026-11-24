#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 NOLGIA Inc
"""End-to-end proof of `sound_design` in the real Premiere Pro.

Runs on Windows (from WSL or a Windows Python) and on macOS, against the mock
API (tools/mock_bridge_server.py): no account, no credits, nothing written to
NOLGIA. `place` asks the mock's package route for the plan, as it asks
NOLGIA's; the mock answers test tones this script writes as local paths
(NOLGIA_SOUND_DESIGN_LOCAL=1, test mode only), so nothing is downloaded.

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
   and a marker, and a second sequence. Then, each against expected numbers:
   - read, preview (uploaded to the mock; size, frame rate, range);
   - place by plan id: nine tones on three new tracks (gain 0, -6, -12 and
     +12 dB, a mono tone, fades, an overlap, an ambience lane); the mix
     exported as WAV and MEASURED (RMS per channel, the fade shapes);
   - a repeated place places nothing twice;
   - the project saved, Premiere Pro quit and started again, the project
     opened: do Premiere's clip ids (nodeId) survive? The editor then adds a
     clip on A1, the OTHER sequence is made the active one, and remove runs:
     the run's clips and tracks go, A1 keeps both clips, the other sequence
     keeps its tracks (QE must be on the run's sequence);
   - the stereo tone's project item set to two mono clips (what the Default
     Audio Tracks preference "Stereo Media: Mono" does at import; checked
     with a sequence made from it), then placed again: one clip on one track,
     both channels at the right level.
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
PLAN = "e2e0b1d4-0b1d-4c55-9a3e-2b7c9d0e1f23"
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
app.newProject(%(project)s);
app.project.importFiles([%(bars)s], true, app.project.rootItem, false);
var bars = null;
for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
  var c = app.project.rootItem.children[i];
  if (String(c.getMediaPath()).replace(/\\/g, "/").toLowerCase() === %(bars)s.toLowerCase()) bars = c;
}
var other = app.project.createNewSequenceFromClips("Other cut", [bars], app.project.rootItem);
var seq = app.project.createNewSequenceFromClips("Sound proof", [bars], app.project.rootItem);
app.project.openSequence(seq.sequenceID);
seq.setInPoint(String(24 * %(tb)d));
seq.setOutPoint(String(240 * %(tb)d));
var m = seq.markers.createMarker(4.5); m.name = "Door";
app.project.save();
result = { project: String(app.project.path), sequence: seq.name, id: String(seq.sequenceID), other: String(other.sequenceID),
           timebase: String(seq.timebase), a1: seq.audioTracks[0].clips.numItems, other_audio: other.audioTracks.numTracks };
"""

EXPORT_WAV = r"""
var seq = null;
for (var i = 0; i < app.project.sequences.numSequences; i++) if (String(app.project.sequences[i].sequenceID) === %(id)s) seq = app.project.sequences[i];
var base = String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/");
var preset = new File(base + "MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr");
if (!preset.exists) preset = new File(base + "Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr");
var out = new File(%(out)s);
var r = seq.exportAsMediaDirect(out.fsName, preset.fsName, app.encoder.ENCODE_ENTIRE);
result = { r: String(r), exists: out.exists, preset: preset.exists };
"""

# Premiere's clip ids, per audio track, and the sequence that is active.
NODE_IDS = r"""
var seq = null;
for (var i = 0; i < app.project.sequences.numSequences; i++) if (String(app.project.sequences[i].sequenceID) === %(id)s) seq = app.project.sequences[i];
var out = [];
for (var t = 0; t < seq.audioTracks.numTracks; t++) {
  var tr = seq.audioTracks[t];
  for (var c = 0; c < tr.clips.numItems; c++) out.push({ track: tr.name, start: tr.clips[c].start.ticks, node: String(tr.clips[c].nodeId), media: String(tr.clips[c].projectItem.getMediaPath()) });
}
result = out;
"""

# The editor's own edit on A1: a piece of the stereo tone at 12 s.
EDIT_A1 = r"""
var seq = null;
for (var i = 0; i < app.project.sequences.numSequences; i++) if (String(app.project.sequences[i].sequenceID) === %(id)s) seq = app.project.sequences[i];
app.project.importFiles([%(tone)s], true, app.project.rootItem, false);
var item = null;
for (var j = 0; j < app.project.rootItem.children.numItems; j++) {
  var c = app.project.rootItem.children[j];
  try { if (String(c.getMediaPath()).replace(/\\/g, "/").toLowerCase() === %(tone)s.toLowerCase()) item = c; } catch (e) {}
}
item.setInPoint(0, 4); item.setOutPoint(String(24 * %(tb)d), 4);
seq.audioTracks[0].overwriteClip(item, String(288 * %(tb)d));
item.clearInPoint(); item.clearOutPoint();
result = { a1: seq.audioTracks[0].clips.numItems, node: String(seq.audioTracks[0].clips[seq.audioTracks[0].clips.numItems - 1].nodeId) };
"""

# Make `other` the active sequence, then ask QE (in the same script) which
# sequence it is on after openSequence of the run's sequence.
ACTIVATE_OTHER = r"""
var other = null; var mine = null;
for (var i = 0; i < app.project.sequences.numSequences; i++) {
  var s = app.project.sequences[i];
  if (String(s.sequenceID) === %(other)s) other = s;
  if (String(s.sequenceID) === %(id)s) mine = s;
}
app.enableQE();
app.project.openSequence(mine.sequenceID);
app.project.activeSequence = mine;
var q1 = qe.project.getActiveSequence();
var follows = { name: String(q1.name), guid: (function () { try { return String(q1.guid); } catch (e) { return "none"; } })(), mine_id: String(mine.sequenceID) };
app.project.openSequence(other.sequenceID);
app.project.activeSequence = other;
var q2 = qe.project.getActiveSequence();
result = { follows: follows, now: String(app.project.activeSequence.name), qe_now: String(q2.name), other_audio: other.audioTracks.numTracks };
"""

# The stereo tone's item as two mono clips (what "Stereo Media: Mono" makes),
# checked with a sequence made from it.
SPLIT_STEREO = r"""
function find(bin, key) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var c = bin.children[i];
    if (c.type === ProjectItemType.BIN) { var x = find(c, key); if (x) return x; continue; }
    try { if (String(c.getMediaPath()).replace(/\\/g, "/").toLowerCase() === key) return c; } catch (e) {}
  }
  return null;
}
var item = find(app.project.rootItem, %(key)s);
var m = item.getAudioChannelMapping;
if (typeof m === "function") m = item.getAudioChannelMapping();
var before = { type: m.audioChannelsType, clips: m.audioClipsNumber };
m.audioChannelsType = 0;
m.audioClipsNumber = 2;
var set = item.setAudioChannelMapping(m);
var a = item.getAudioChannelMapping;
if (typeof a === "function") a = item.getAudioChannelMapping();
var check = app.project.createNewSequenceFromClips("Mapping check", [item], app.project.rootItem);
var tracksWithClips = 0;
for (var t = 0; t < check.audioTracks.numTracks; t++) if (check.audioTracks[t].clips.numItems) tracksWithClips++;
var mine = null;
for (var i = 0; i < app.project.sequences.numSequences; i++) if (String(app.project.sequences[i].sequenceID) === %(id)s) mine = app.project.sequences[i];
app.project.openSequence(mine.sequenceID);
result = { before: before, set: String(set), after: { type: a.audioChannelsType, clips: a.audioClipsNumber }, check_tracks_with_clips: tracksWithClips };
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
    ("loud", "stereo", 16000, 0, 1000, 12, 0, 0, "sfx", 1),
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

    settings = os.path.join(win.user_data(), "NOLGIA", "adobe", "premiere", "settings.json")
    saved_settings = open(settings, "rb").read() if os.path.exists(settings) else None
    env_path = E.env_file(win)
    server = E.MockBridgeServer(host="127.0.0.1", tokens=(E.TOKEN,)).start()
    caller = E.Caller(server.root_url, E.TOKEN, mock=server)
    caller.app = "premiere"
    env = {"NOLGIA_TOKEN": E.TOKEN, "NOLGIA_API_URL": server.base_url, "NOLGIA_BRIDGE_AUTOCONNECT": "1",
           "NOLGIA_ASK_BEFORE_RUN": "0", "NOLGIA_ALLOW_AGENT": "1", "NOLGIA_INSTANCE_ID": INSTANCE,
           "NOLGIA_UPDATE_CHECK": "0", "NOLGIA_SOUND_DESIGN_LOCAL": "1"}

    def start_and_connect(again=False):
        os.makedirs(os.path.dirname(env_path), exist_ok=True)
        with open(env_path, "w", encoding="utf-8") as handle:
            json.dump(env, handle)
        # The API keeps one session per instance: started again, Premiere Pro
        # registers the same session anew (a new heartbeat with its version).
        with server.state.cond:
            beats = len(server.state.heartbeats)
        win.start(proc)
        end = time.time() + 300
        session = None
        while time.time() < end and session is None:
            for w in win.windows(proc["process"]):
                if w["cls"] == win.DIALOG:
                    print("     dialog: %s %s" % (w["title"], w["text"][:200]), flush=True)
                    win.press_enter(proc["process"], w["hwnd"])
            with server.state.cond:
                fresh = len(server.state.heartbeats) > beats
            for s in caller.sessions():
                if s["instance_id"] == INSTANCE and s["app_version"] and (fresh or not again):
                    session = s
            time.sleep(3)
        if os.path.exists(env_path):
            os.remove(env_path)  # read at start only
        assert session, "no Premiere Pro session within 300 s"
        caller.session_id = session["id"]
        return session

    try:
        def connects():
            s = start_and_connect()
            assert "sound_design" in s["capabilities"], s["capabilities"]
            numbers["plugin_version"] = s["plugin_version"]
            numbers["app_version"] = s["app_version"]
        if not checks.check("premiere", "starts and connects with sound_design", connects):
            return E.finish(checks, started, opts)
        run_proof(caller, checks, win, work, wwork, numbers, start_and_connect, proc, server)
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
                json.dump({"numbers": numbers,
                           "checks": [{"check": n, "ok": ok, "error": e} for _, n, ok, e in checks.results]},
                          handle, indent=1)
    return E.finish(checks, started, opts)


def run_proof(caller, checks, win, work, wwork, numbers, start_and_connect, proc, server):
    media = os.path.join(work, "media")
    os.makedirs(media, exist_ok=True)
    bars = os.path.join(media, os.path.basename(BARS))
    shutil.copyfile(BARS, bars)
    tone(os.path.join(media, "tone stereo.wav"), 2)
    tone(os.path.join(media, "tone mono.wav"), 1)
    tone(os.path.join(media, "editor tone.wav"), 2)
    project = wwork + "/project/sound proof.prproj"
    os.makedirs(os.path.join(work, "project"), exist_ok=True)
    state = {}

    def setup():
        code = SETUP % {"project": json.dumps(project), "bars": json.dumps(win.to_win(bars).replace("\\", "/")), "tb": TB}
        res = caller.ok("run", {"code": code}, timeout=120)["value"]
        assert res["timebase"] == str(TB) and res["a1"] == 1, res
        state.update(seq=res["id"], other=res["other"], other_audio=res["other_audio"])
    if not checks.check("premiere", "a scratch project: the bars on a 23.976 sequence, and a second sequence", setup):
        return

    def read_before():
        r = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)
        s = r["sequence"]
        assert (s["id"], s["fps"], s["in_ms"], s["out_ms"]) == (state["seq"], 23.976, 1001, 10010), s
        assert [t["track"] for t in r["audio_tracks"]] == ["A1", "A2", "A3"], r["audio_tracks"]
        assert r["empty_audio_tracks"] == ["A2", "A3"], r["empty_audio_tracks"]
        assert r["markers"][0]["name"] == "Door" and r["markers"][0]["start_ms"] == 4500, r["markers"]
        state["a1"] = r["audio_tracks"][0]["clips"]
        state["v1"] = r["video_tracks"][0]["clips"]
        numbers["read"] = {"fps": s["fps"], "duration_ms": s["duration_ms"], "in_ms": s["in_ms"], "out_ms": s["out_ms"]}
    checks.check("premiere", "read: tracks, clips, in and out, markers", read_before)

    def preview():
        t0 = time.time()
        r = caller.ok("sound_design", {"action": "preview", "sequence": state["seq"]}, timeout=300)
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
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                                  "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", path],
                                 stdout=subprocess.PIPE, text=True).stdout
            probe = json.loads(out)
            numbers["preview_probe"] = probe
            video = [s for s in probe["streams"] if s.get("width")][0]
            assert (video["codec_name"], video["width"], video["height"], video["r_frame_rate"]) == (
                "h264", 640, 360, "24000/1001"), video
            assert any(s["codec_name"] == "aac" for s in probe["streams"]), probe
            assert abs(float(probe["format"]["duration"]) - 9.009) < 0.1, probe["format"]
    checks.check("premiere", "preview: H.264 of the in to out range, uploaded, its start on the timeline", preview)

    files = []
    for cue_id, src, start, a, b, gain, fi, fo, role, lane in CUES:
        files.append({"cue_id": cue_id, "name": cue_id, "file": "NOLGIA Sounds/%s %s.wav" % (cue_id, src),
                      "url": "", "path": win.to_win(os.path.join(media, "tone %s.wav" % src)), "start_ms": start,
                      "source_in_ms": a, "source_out_ms": b, "gain_db": gain, "fade_in_ms": fi, "fade_out_ms": fo,
                      "role": role, "lane": lane, "licence": "CC0", "credit": ""})
    for f in files:
        del f["url"]
    files[7]["credit"] = "Tone amb by NOLGIA (CC BY 4.0)"
    package = {"plan_id": PLAN, "mode": "manifest", "format": "manifest", "sounds_folder": "NOLGIA Sounds",
               "files": files, "credits": ["Tone amb by NOLGIA (CC BY 4.0)"], "warnings": []}
    with server.state.cond:
        server.state.sound_design_packages[PLAN] = [{"status": 200, "body": package}]

    def place():
        r = caller.ok("sound_design", {"action": "place", "plan_id": PLAN, "sequence": state["seq"]}, timeout=600)
        numbers["place"] = {k: r.get(k) for k in ("placed", "not_placed", "tracks", "folder", "bin", "backup", "record",
                                                  "credits", "warnings")}
        numbers["place"]["notes"] = [c for c in r["cues"] if c.get("note")]
        with server.state.cond:
            numbers["package_requests"] = list(server.state.sound_design_requests)
        assert r["placed"] == len(CUES), r["cues"]
        assert [t["name"] for t in r["tracks"]] == ["NOLGIA SFX 1", "NOLGIA SFX 2", "NOLGIA Ambience"], r["tracks"]
        assert os.path.exists(win.from_win(r["backup"])), r["backup"]
        assert os.path.exists(win.from_win(r["record"])), r["record"]
        after = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)
        names = [(t["name"], len(t["clips"])) for t in after["audio_tracks"]]
        numbers["tracks_after_place"] = names
        assert names[3:] == [("NOLGIA SFX 1", 7), ("NOLGIA SFX 2", 1), ("NOLGIA Ambience", 1)], names
        assert after["audio_tracks"][0]["clips"] == state["a1"], "A1 changed"
        assert after["video_tracks"][0]["clips"] == state["v1"], "V1 changed"
        # Frame exact: 500 ms at 23.976 is frame 12.
        assert after["audio_tracks"][3]["clips"][0]["start_frame"] == 12, after["audio_tracks"][3]["clips"][0]
        state["folder"] = r["folder"]
    if not checks.check("premiere", "place by plan id: nine tones on three new tracks, the editor's tracks as they were",
                        place):
        return

    def export_mix(name):
        out = wwork + "/" + name
        res = caller.ok("run", {"code": EXPORT_WAV % {"out": json.dumps(out), "id": json.dumps(state["seq"])}},
                        timeout=200)["value"]
        assert res["exists"], res
        return read_wav(os.path.join(work, name))

    def window(m, left, right, rate, name, start_ms, length_ms, expected, tol=0.2):
        a = frame_s(start_ms) + 0.1
        b = frame_s(start_ms) + length_ms / 1000 - 0.1
        m[name] = {"L": rms_db(left, rate, a, b), "R": rms_db(right, rate, a, b), "expected": round(expected, 2)}
        return abs(m[name]["L"] - expected) < tol and abs(m[name]["R"] - expected) < tol

    def measure():
        rate, left, right = export_mix("mix.wav")
        m = {}
        ok = [
            window(m, left, right, rate, "gain 0 dB", 500, 2002, SOURCE_RMS),
            window(m, left, right, rate, "gain -6 dB", 3000, 2002, SOURCE_RMS - 6),
            window(m, left, right, rate, "gain -12 dB", 5500, 2002, SOURCE_RMS - 12),
            window(m, left, right, rate, "mono 0 dB (each side)", 8000, 1502, SOURCE_RMS - 3.01),
            window(m, left, right, rate, "fades -6 dB (middle)", 10000 + 500, 1002, SOURCE_RMS - 6),
        ]
        # +12 dB: measured, whatever Premiere does with it (its slider stops at +6).
        window(m, left, right, rate, "gain +12 dB asked", 16000, 1001, SOURCE_RMS + 12)
        start = frame_s(10000)
        fade_in = [rms_db(left, rate, start + k * 0.05, start + (k + 1) * 0.05) for k in range(12)]
        end = start + 2.002
        fade_out = [rms_db(left, rate, end - (12 - k) * 0.05, end - (11 - k) * 0.05) for k in range(12)]
        m["fade in, 50 ms windows"] = fade_in
        m["fade out, 50 ms windows"] = fade_out
        m["silence before the first tone"] = rms_db(left, rate, 0.05, 0.45)
        numbers["measured"] = m
        assert all(ok), m
        assert fade_in[0] < -40 and abs(fade_in[-1] - (SOURCE_RMS - 6)) < 0.5, fade_in
        assert all(fade_in[k] <= fade_in[k + 1] + 0.05 for k in range(11)), fade_in
        assert fade_out[-1] < -40 and abs(fade_out[0] - (SOURCE_RMS - 6)) < 0.5, fade_out
        assert m["silence before the first tone"] < -80
    checks.check("premiere", "the mix measures: gain 0/-6/-12 dB, mono centred, fades from silence; +12 dB measured",
                 measure)

    def repeat():
        r = caller.ok("sound_design", {"action": "place", "plan_id": PLAN, "sequence": state["seq"]}, timeout=600)
        assert (r["placed"], r["already_placed"]) == (0, len(CUES)), r
        after = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)
        assert len(after["audio_tracks"]) == 6, [t["name"] for t in after["audio_tracks"]]
    checks.check("premiere", "a repeated place places nothing twice", repeat)

    def reopen_edit_remove():
        before = caller.ok("run", {"code": NODE_IDS % {"id": json.dumps(state["seq"])}}, timeout=60)["value"]
        caller.ok("run", {"code": "app.project.save();"}, timeout=60)
        E.quit_app(win, caller, "premiere", proc, close_documents=False, via_plugin=True)
        assert not win.running(proc), "Premiere Pro did not quit"
        start_and_connect(again=True)
        opened = caller.ok("open", {"path": win.to_win(os.path.join(work, "project", "sound proof.prproj"))}, timeout=180)
        numbers["reopened"] = opened.get("path")
        after = caller.ok("run", {"code": NODE_IDS % {"id": json.dumps(state["seq"])}}, timeout=60)["value"]
        key = lambda c: (c["track"], c["start"], c["media"].lower())
        old_ids = {key(c): c["node"] for c in before}
        same = sum(1 for c in after if old_ids.get(key(c)) == c["node"])
        numbers["node_ids"] = {"clips": len(after), "same_after_reopen": same,
                               "before": [c["node"] for c in before][:12], "after": [c["node"] for c in after][:12]}
        # The editor's own edit on A1, then another sequence on screen.
        edit = caller.ok("run", {"code": EDIT_A1 % {"id": json.dumps(state["seq"]), "tb": TB,
                                                     "tone": json.dumps(win.to_win(os.path.join(media, "editor tone.wav")).replace("\\", "/"))}},
                         timeout=60)["value"]
        numbers["editor_a1"] = edit
        run_nodes = {c["node"] for c in before if c["track"].startswith("NOLGIA")}
        numbers["editor_clip_has_a_run_node_id"] = edit["node"] in run_nodes
        other = caller.ok("run", {"code": ACTIVATE_OTHER % {"id": json.dumps(state["seq"]),
                                                            "other": json.dumps(state["other"])}}, timeout=60)["value"]
        numbers["qe_follows_openSequence"] = other
        assert other["now"] == "Other cut", other
        a1_edited = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)["audio_tracks"][0]["clips"]
        numbers["a1_after_edit"] = len(a1_edited)
        r = caller.ok("sound_design", {"action": "remove", "run_id": PLAN}, timeout=300)
        numbers["remove"] = r
        assert r["removed"] == len(CUES) and r["left"] == [], r
        assert sorted(r["tracks_removed"]) == ["NOLGIA Ambience", "NOLGIA SFX 1", "NOLGIA SFX 2"], r
        seqs = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)
        assert len(seqs["audio_tracks"]) == 3, [t["name"] for t in seqs["audio_tracks"]]
        # The editor's overwrite split the bars clip: A1 is as the editor left it.
        assert seqs["audio_tracks"][0]["clips"] == a1_edited, seqs["audio_tracks"][0]["clips"]
        oth = caller.ok("sound_design", {"action": "read", "sequence": state["other"]}, timeout=60)
        assert len(oth["audio_tracks"]) == state["other_audio"], [t["name"] for t in oth["audio_tracks"]]
        folder = win.from_win(state["folder"])
        assert os.path.exists(os.path.join(folder, "t0 stereo.wav")), os.listdir(folder)
    checks.check("premiere",
                 "reopened, the editor's clip on A1, another sequence active: remove takes out exactly the run",
                 reopen_edit_remove)
    numbers["other_after_remove"] = [t["name"] for t in caller.ok(
        "sound_design", {"action": "read", "sequence": state["other"]}, timeout=60)["audio_tracks"]]

    def stereo_stays_one_clip():
        key = win.to_win(os.path.join(win.from_win(state["folder"]), "t0 stereo.wav")).replace("\\", "/").lower()
        split = caller.ok("run", {"code": SPLIT_STEREO % {"key": json.dumps(key), "id": json.dumps(state["seq"])}},
                          timeout=60)["value"]
        numbers["stereo_as_two_mono_clips"] = split
        r = caller.ok("sound_design", {"action": "place", "plan_id": PLAN, "sequence": state["seq"]}, timeout=600)
        numbers["replace"] = {k: r.get(k) for k in ("placed", "not_placed", "tracks", "audio_mapping_fixed", "audio_mapping_errors")}
        assert r["placed"] == len(CUES), r["cues"]
        after = caller.ok("sound_design", {"action": "read", "sequence": state["seq"]}, timeout=60)
        names = [(t["name"], len(t["clips"])) for t in after["audio_tracks"]]
        numbers["tracks_after_replace"] = names
        assert names[3:] == [("NOLGIA SFX 1", 7), ("NOLGIA SFX 2", 1), ("NOLGIA Ambience", 1)], names
        rate, left, right = export_mix("mix-after-split.wav")
        m = {}
        ok = window(m, left, right, rate, "stereo gain 0 dB after the split", 500, 2002, SOURCE_RMS)
        numbers["measured_after_split"] = m
        assert ok, m
    checks.check("premiere", "a stereo sound split into two mono clips at import still goes in as one stereo clip",
                 stereo_stays_one_clip)


if __name__ == "__main__":
    sys.exit(main())
