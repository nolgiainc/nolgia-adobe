// SPDX-License-Identifier: GPL-3.0-or-later
// `sound_design` through the controller against the mock API, with a fake
// Premiere Pro (an in-memory sequence) standing in for host/ppro.jsx (which
// was proven in the real app; see the README). Place, a repeated place,
// remove, an unsaved project, unsafe names, and the preview upload.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { Controller } = require("../core/controller");

const TB = "10594584000"; // 23.976
const TPS = 254016000000;

let server;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

function wav(seconds = 1) {
  const data = Buffer.alloc(Math.round(48000 * seconds) * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(48000, 24);
  head.writeUInt32LE(96000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Premiere Pro with one saved project, one sequence (V1 and A1 with the
// editor's clip, empty A2 and A3) and a bin tree.
function fakePremiere(root, { saved = true } = {}) {
  const file = saved ? path.join(root, "Edit", "edit.prproj") : null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "project as saved");
  }
  const s = {
    file,
    saves: 0,
    calls: [],
    nextId: 10,
    nextNode: 100,
    bins: {},
    seq: {
      name: "Edit",
      id: "seq-1",
      timebase: TB,
      end: String(16 * TPS),
      width: 1920,
      height: 1080,
      in: null,
      out: null,
      audio: [
        { id: 2, name: "Audio 1", clips: [{ start: "0", end: String(16 * TPS), media: "C:/media/dialogue.wav", node_id: "n1" }] },
        { id: 3, name: "Audio 2", clips: [] },
        { id: 4, name: "Audio 3", clips: [] },
      ],
    },
  };
  const find = (id) => s.seq.audio.find((t) => String(t.id) === String(id));
  const facts = () => {
    const q = s.seq;
    return { name: q.name, id: q.id, timebase: q.timebase, end: q.end, width: q.width, height: q.height, in: q.in, out: q.out };
  };
  s.handlers = {
    snapshot: () => ({ document: s.file ? { name: path.basename(s.file), path: s.file } : { name: "" }, dirty: false }),
    project_file: () => ({ path: s.file, dirty: null }),
    save: () => {
      if (!s.file) throw new Error("This project has never been saved");
      s.saves += 1;
      fs.writeFileSync(s.file, "project saved " + s.saves);
      return { path: s.file };
    },
    sd_state: (args) => ({
      project: s.file,
      sequence: facts(),
      track_names: s.seq.audio.map((t) => t.name),
      tracks: (args.track_ids || []).map(find).filter(Boolean).map((t) => ({ id: t.id, name: t.name, clips: t.clips })),
    }),
    sd_read: () => ({
      project: s.file,
      sequence: facts(),
      video_tracks: [{ index: 1, id: 1, name: "Video 1", locked: false, clips: [{ name: "shot.mp4", start: "0", end: String(16 * TPS), in: "0", out: String(16 * TPS), media: "C:/media/shot.mp4", enabled: true }] }],
      audio_tracks: s.seq.audio.map((t, i) => ({
        index: i + 1, id: t.id, name: t.name, muted: false, locked: false,
        clips: t.clips.map((c) => ({ name: path.basename(c.media), start: c.start, end: c.end, in: "0", out: String(BigInt(c.end) - BigInt(c.start)), media: c.media, enabled: true })),
      })),
      markers: [{ name: "Door", start: String(4.5 * TPS), end: String(4.5 * TPS), type: "Comment", comment: "" }],
      truncated: 0,
    }),
    sd_import: (args) => {
      const key = args.bin_path.join(" / ");
      s.bins[key] = s.bins[key] || [];
      for (const p of args.paths) if (!s.bins[key].includes(p) && fs.existsSync(p)) s.bins[key].push(p);
      return { bin: key, missing: args.paths.filter((p) => !s.bins[key].includes(p)) };
    },
    sd_add_tracks: (args) => ({
      tracks: args.names.map((name) => {
        const t = { id: s.nextId++, name, clips: [] };
        s.seq.audio.push(t);
        return { id: t.id, index: s.seq.audio.length, name };
      }),
    }),
    sd_place: (args) => ({
      results: args.placements.map((p) => {
        const t = find(p.track_id);
        if (!t) return { key: p.key, ok: false, reason: "its track is no longer in the sequence." };
        const end = BigInt(p.start) + BigInt(p.out) - BigInt(p.in);
        if (t.clips.some((c) => BigInt(c.start) < end && BigInt(p.start) < BigInt(c.end))) {
          return { key: p.key, ok: false, reason: "something is on " + t.name + " at that time." };
        }
        const clip = { start: p.start, end: end.toString(), media: p.path, node_id: "n" + s.nextNode++, level: p.level, keys: p.keys };
        t.clips.push(clip);
        return { key: p.key, ok: true, node_id: clip.node_id, start: clip.start, end: clip.end, in: p.in, out: p.out };
      }),
    }),
    sd_remove: (args) => {
      const removed = [];
      const missing = [];
      for (const c of args.clips) {
        let hit = false;
        for (const t of s.seq.audio) {
          const i = t.clips.findIndex((x) => x.node_id === c.node_id);
          if (i >= 0) {
            t.clips.splice(i, 1);
            hit = true;
          }
        }
        (hit ? removed : missing).push(c.key);
      }
      const tracksRemoved = [];
      const tracksKept = [];
      for (const id of args.track_ids) {
        const t = find(id);
        if (!t) continue;
        if (t.clips.length) tracksKept.push({ id: t.id, name: t.name, reason: "it has clips NOLGIA did not place, so it stays." });
        else {
          s.seq.audio.splice(s.seq.audio.indexOf(t), 1);
          tracksRemoved.push(t.id);
        }
      }
      return { removed, missing, tracks_removed: tracksRemoved, tracks_kept: tracksKept };
    },
  };
  return s;
}

function fakeHost(handlers, calls) {
  const root = support.tempDir();
  const host = {
    hostId: "PPRO",
    userData: path.join(root, "userData"),
    documents: path.join(root, "Documents"),
    root,
    async call(kind, args) {
      calls.push(kind);
      const fn = handlers[kind];
      if (!fn) {
        if (kind === "snapshot") return { ok: true, result: { document: { name: "" }, dirty: false, app_version: "26.2.0" } };
        return { ok: false, error: "no handler for " + kind };
      }
      try {
        return { ok: true, result: await fn(args, this) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    openURL() {},
    openPanel() {},
    broadcast() {},
    log() {},
  };
  fs.mkdirSync(host.documents, { recursive: true });
  return host;
}

async function connectedPremiere(env = {}, opts = {}) {
  const root = support.tempDir();
  const pr = fakePremiere(root, opts);
  const host = fakeHost(pr.handlers, pr.calls);
  const ctl = new Controller(host, {
    environ: Object.assign(
      { NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_BRIDGE_AUTOCONNECT: "1", NOLGIA_ASK_BEFORE_RUN: "0" },
      env
    ),
  });
  ctl.start();
  await support.until(() => ctl.worker && ctl.worker.state === "connected", 10, "connected");
  return { ctl, pr, root };
}

async function finish(ctl) {
  const worker = ctl.worker;
  ctl.disconnect();
  if (worker) await worker.finished.wait(10);
}

async function command(args, timeout = 120) {
  const id = await support.enqueue(server, "premiere", "sound_design", args, { timeout });
  for (;;) {
    const cmd = await support.waitCommand(server, id, 10);
    if (cmd.status !== "queued" && cmd.status !== "running") return cmd;
  }
}

function sounds(root) {
  const dir = path.join(root, "library");
  fs.mkdirSync(dir, { recursive: true });
  const make = (name, seconds) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, wav(seconds));
    return p;
  };
  return { door: make("door.wav", 1), rain: make("rain.wav", 4), whoosh: make("whoosh.wav", 1), bell: make("bell.wav", 1), html: (() => {
    const p = path.join(dir, "page.wav");
    fs.writeFileSync(p, "<!DOCTYPE html><html>not a sound</html>");
    return p;
  })() };
}

function cue(id, src, extra = {}) {
  return Object.assign(
    { cue_id: id, name: id, file: "NOLGIA Sounds/" + id + ".wav", path: src, start_ms: 1000, source_in_ms: 0, source_out_ms: 500, gain_db: -6, fade_in_ms: 0, fade_out_ms: 100, role: "sfx", lane: 1 },
    extra
  );
}

test("place: new tracks after the editor's, frame exact, backed up first; a repeat places nothing twice; remove takes exactly that out", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  const files = [
    cue("door", src.door, { start_ms: 1001, file: "NOLGIA Sounds/03 Door slam [fs-1].wav", credit: "Door slam by A (CC BY 4.0)" }),
    cue("whoosh", src.whoosh, { start_ms: 1200 }), // overlaps the door: a second SFX track
    cue("rain", src.rain, { role: "ambience", lane: 2, start_ms: 0, source_out_ms: 4000, gain_db: -18, fade_in_ms: 1000, fade_out_ms: 1000 }),
    cue("evil", src.bell, { file: "../../../Windows/evil.wav", start_ms: 5000 }),
    cue("fake", src.html, { start_ms: 6000 }),
  ];
  const cmd = await command({ action: "place", run_id: "plan-7f3a", files, credits: ["Rain by B (CC BY 4.0)"] });
  assert.equal(cmd.status, "succeeded", cmd.error);
  const r = cmd.result;
  assert.equal(r.placed, 4);
  assert.equal(r.not_placed, 1);
  assert.match(r.cues.find((c) => c.cue_id === "fake").reason, /not a WAV sound/);
  // The editor's tracks are as they were; the sounds are on new tracks after them.
  assert.deepEqual(pr.seq.audio.map((t) => [t.name, t.clips.length]), [
    ["Audio 1", 1], ["Audio 2", 0], ["Audio 3", 0], ["NOLGIA SFX 1", 2], ["NOLGIA SFX 2", 1], ["NOLGIA Ambience", 1],
  ]);
  // Frame exact: 1001 ms at 23.976 is frame 24.
  const door = pr.seq.audio[3].clips.find((c) => /Door slam/.test(c.media));
  assert.equal(door.start, String(24n * 10594584000n));
  assert.equal(door.level.toFixed(5), "0.08913");
  // The rain's fades are keyframes in media time from its in point (0 here).
  const rain = pr.seq.audio[5].clips[0];
  assert.deepEqual(rain.keys.map((k) => k[0]), [0, 1, 3.004, 4.004]);
  // Saved and backed up before the first change (the import), saved after.
  const firstImport = pr.calls.indexOf("sd_import");
  assert.ok(pr.calls.indexOf("save") < firstImport, pr.calls.join(","));
  assert.ok(pr.calls.lastIndexOf("save") > pr.calls.indexOf("sd_place"));
  assert.ok(fs.existsSync(r.backup) && path.dirname(r.backup) === path.join(path.dirname(pr.file), "NOLGIA backups"), r.backup);
  // The sounds sit in NOLGIA Sounds/<run> next to the project, with safe names.
  const folder = path.join(path.dirname(pr.file), "NOLGIA Sounds", "plan-7f3a");
  assert.equal(r.folder, folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["03 Door slam [fs-1].wav", "CREDITS.txt", "evil.wav", "placement.json", "rain.wav", "whoosh.wav"]);
  assert.match(fs.readFileSync(path.join(folder, "CREDITS.txt"), "utf8"), /Rain by B \(CC BY 4.0\)\nDoor slam by A \(CC BY 4.0\)/);
  assert.deepEqual(r.credits, ["Rain by B (CC BY 4.0)", "Door slam by A (CC BY 4.0)"]);
  assert.deepEqual(r.tracks.map((t) => t.name), ["NOLGIA SFX 1", "NOLGIA SFX 2", "NOLGIA Ambience"]);
  assert.match(r.bin, /^NOLGIA imports \/ Sound design \/ \d{4}-\d\d-\d\d plan-7f3/);
  const record = JSON.parse(fs.readFileSync(path.join(folder, "placement.json"), "utf8"));
  assert.equal(record.sequence.id, "seq-1");
  assert.equal(Object.values(record.cues).filter((c) => c.status === "placed").length, 4);

  // The same run again: nothing placed twice, nothing changed, no new backup.
  const saves = pr.saves;
  const again = await command({ action: "place", run_id: "plan-7f3a", files });
  assert.equal(again.status, "succeeded", again.error);
  assert.equal(again.result.placed, 0);
  assert.equal(again.result.already_placed, 4);
  assert.equal(again.result.repeated, true);
  assert.equal(pr.saves, saves, "not saved: nothing changed");
  assert.equal(pr.seq.audio.length, 6);
  assert.equal(fs.readdirSync(path.join(path.dirname(pr.file), "NOLGIA backups")).length, 1);

  // The editor puts a clip of their own on NOLGIA SFX 2; remove keeps that track.
  pr.seq.audio[4].clips.push({ start: String(10 * TPS), end: String(11 * TPS), media: "C:/media/mine.wav", node_id: "mine" });
  const out = await command({ action: "remove", run_id: "plan-7f3a" });
  assert.equal(out.status, "succeeded", out.error);
  assert.equal(out.result.removed, 4);
  assert.deepEqual(out.result.tracks_removed.sort(), ["NOLGIA Ambience", "NOLGIA SFX 1"]);
  assert.equal(out.result.tracks_kept[0].name, "NOLGIA SFX 2");
  assert.deepEqual(pr.seq.audio.map((t) => [t.name, t.clips.length]), [["Audio 1", 1], ["Audio 2", 0], ["Audio 3", 0], ["NOLGIA SFX 2", 1]]);
  assert.ok(fs.existsSync(path.join(folder, "rain.wav")), "the files stay");
  assert.match(out.result.note, /stay in/);
  // Taken out, it can go in again (once).
  const back = await command({ action: "place", run_id: "plan-7f3a", files: files.slice(0, 1) });
  assert.equal(back.result.placed, 1);
  const twice = await command({ action: "remove", run_id: "plan-7f3a" });
  assert.equal(twice.result.removed, 1);
  const thrice = await command({ action: "remove", run_id: "plan-7f3a" });
  assert.match(thrice.result.note, /already out/);
});

test("place refuses an unsaved project and changes nothing", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" }, { saved: false });
  t.after(() => finish(ctl));
  const src = sounds(root);
  const cmd = await command({ action: "place", run_id: "r1", files: [cue("door", src.door)] });
  assert.equal(cmd.status, "failed");
  assert.match(cmd.error, /never been saved\. Save it first \(File > Save\)/);
  assert.deepEqual(pr.calls.filter((k) => k.startsWith("sd_") || k === "save"), []);
});

test("local paths are refused outside tests; a run placed on another sequence is refused", async (t) => {
  const { ctl, pr, root } = await connectedPremiere();
  t.after(() => finish(ctl));
  const src = sounds(root);
  const cmd = await command({ action: "place", run_id: "r1", files: [cue("door", src.door)] });
  assert.equal(cmd.status, "succeeded");
  assert.equal(cmd.result.placed, 0);
  assert.match(cmd.result.cues[0].reason, /no url/);
  assert.match(cmd.result.note, /project was not changed/);
  assert.equal(pr.saves, 0);

  const second = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(second.ctl));
  const s2 = sounds(second.root);
  assert.equal((await command({ action: "place", run_id: "r1", files: [cue("door", s2.door)] })).result.placed, 1);
  second.pr.seq.id = "seq-2";
  second.pr.seq.name = "Other";
  const other = await command({ action: "place", run_id: "r1", files: [cue("door", s2.door)] });
  assert.equal(other.status, "failed");
  assert.match(other.error, /placed on the sequence Edit, not Other/);
});

test("an HTTPS link is downloaded, a plain HTTP one never is", async (t) => {
  const { ctl, pr, root } = await connectedPremiere();
  t.after(() => finish(ctl));
  const asset = await support.seedAsset(server, "door.wav", "audio/wav", wav(1));
  const url = server.root + "/storage/assets/" + asset.id; // the mock serves plain HTTP
  const cmd = await command({ action: "place", run_id: "r1", files: [Object.assign(cue("door", undefined), { path: undefined, url })] });
  assert.equal(cmd.status, "succeeded");
  assert.match(cmd.result.cues[0].reason, /not HTTPS/);
  assert.equal(pr.saves, 0);
  assert.ok(root);
});

test("read: tracks and clips in ms and frames, the empty audio tracks, markers and NOLGIA's runs", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await command({ action: "place", run_id: "r9", files: [cue("door", src.door)] });
  const cmd = await command({ action: "read" });
  assert.equal(cmd.status, "succeeded", cmd.error);
  const r = cmd.result;
  assert.deepEqual(r.sequence, {
    name: "Edit", id: "seq-1", fps: 23.976, timebase_ticks: TB, width: 1920, height: 1080,
    duration_ms: 16000, frames: 383, in_ms: null, out_ms: null,
  });
  assert.deepEqual(r.empty_audio_tracks, ["A2", "A3"]);
  assert.equal(r.audio_tracks[3].name, "NOLGIA SFX 1");
  assert.equal(r.audio_tracks[3].nolgia_run, "r9");
  assert.equal(r.audio_tracks[0].clips[0].media_path, "C:/media/dialogue.wav");
  assert.equal(r.video_tracks[0].clips[0].end_frame, 383);
  assert.deepEqual(r.markers, [{ name: "Door", start_ms: 4500, end_ms: 4500, type: "Comment", comment: "" }]);
  assert.deepEqual(r.nolgia_runs.map((x) => [x.run_id, x.placed, x.tracks]), [["r9", 1, ["NOLGIA SFX 1"]]]);
  assert.ok(pr);
});

test("preview: Premiere's preset edited to 960 px, the in to out range exported and uploaded, its start on the timeline", async (t) => {
  const { ctl, pr, root } = await connectedPremiere();
  t.after(() => finish(ctl));
  const preset = path.join(root, "Mobile Device 480p SD Wide.epr");
  const param = (id, v) => "<ExporterParam><ParamIdentifier>" + id + "</ParamIdentifier><ParamValue>" + v + "</ParamValue></ExporterParam>\n";
  fs.writeFileSync(
    preset,
    "<PremiereData>\n" + ["ADBEVideoWidth", "ADBEVideoHeight", "ADBEVideoFPS", "ADBEVideoTargetBitrate", "ADBEVideoMaxBitrate"].map((id) => param(id, "1")).join("") + "</PremiereData>\n"
  );
  let exported = null;
  pr.seq.in = String(10 * TPS);
  pr.seq.out = String(40 * TPS);
  pr.seq.end = String(120 * TPS);
  pr.handlers.sd_preview_info = () => ({ sequence: { name: "Edit", id: "seq-1", timebase: TB, end: pr.seq.end, width: 1920, height: 1080, in: pr.seq.in, out: pr.seq.out }, preset });
  pr.handlers.sd_export_preview = (args) => {
    exported = { mode: args.mode, preset: fs.readFileSync(args.preset, "utf8") };
    fs.writeFileSync(args.file, Buffer.alloc(2048, 1));
    return { path: args.file };
  };
  const cmd = await command({ action: "preview" });
  assert.equal(cmd.status, "succeeded", cmd.error);
  const r = cmd.result;
  assert.ok(r.asset_id);
  assert.equal(r.filename, "Edit sound preview.mp4");
  assert.deepEqual(r.range, { from: "in_out", start_ms: 10000, end_ms: 40000, duration_ms: 30000 });
  assert.equal(r.timeline_offset_ms, 10000);
  assert.deepEqual([r.width, r.height, r.fps], [960, 540, 23.976]);
  assert.equal(exported.mode, "in_out");
  assert.match(exported.preset, /ADBEVideoWidth<\/ParamIdentifier><ParamValue>960</);
  assert.match(exported.preset, /ADBEVideoFPS<\/ParamIdentifier><ParamValue>10594584000</);
  const bytes = await support.assetBytes(server, r.asset_id);
  assert.equal(bytes.length, 2048);
  // Longer than 10 minutes without in and out: refused with what to do.
  pr.seq.in = null;
  pr.seq.out = null;
  pr.seq.end = String(11 * 60 * TPS);
  const long = await command({ action: "preview" });
  assert.equal(long.status, "failed");
  assert.match(long.error, /at most 10 minutes/);
});
