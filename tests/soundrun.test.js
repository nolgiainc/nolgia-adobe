// SPDX-License-Identifier: GPL-3.0-or-later
// `sound_design` through the controller against the mock API, with a fake
// Premiere Pro (an in-memory sequence) standing in for host/ppro.jsx (which
// was proven in the real app; see tests/e2e_sound_design.py). Place through
// the plan's package, a repeated place, remove (also after the project is
// opened again), a late answer, an unsaved or switched project, unsafe
// names, real HTTPS downloads, and the preview upload.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const childProcess = require("child_process");
const http = require("http");
const https = require("https");

const support = require("./support");
const { Controller } = require("../core/controller");
const { ApiClient } = require("../core/api");

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
// editor's clip, empty A2 and A3) and a bin tree. It checks what the real
// host (host/ppro.jsx) checks: the open project, a placement's file by the
// path sd_import answered, the track's name; `sd_remove` takes a clip out
// only when its track (id and name), start and file all agree, and never
// looks at node ids.
function fakePremiere(root, { saved = true, nfd = false } = {}) {
  const file = saved ? path.join(root, "Edit", "edit.prproj") : null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "project as saved");
  }
  const s = {
    file,
    open: file,
    saves: 0,
    calls: [],
    nextId: 10,
    nextNode: 100,
    bins: {},
    stallPlace: false,
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
  const sameProject = (args) => {
    if (args.project && args.project !== s.open) throw new Error("The open project is no longer " + args.project + ", so NOLGIA changed nothing.");
  };
  // Premiere on macOS may answer a path in the decomposed form.
  const asPremiere = (p) => (nfd ? p.normalize("NFD") : p);
  s.handlers = {
    snapshot: () => ({ document: s.open ? { name: path.basename(s.open), path: s.open } : { name: "" }, dirty: false }),
    project_file: () => ({ path: s.open, dirty: null }),
    save: () => {
      if (!s.open) throw new Error("This project has never been saved");
      s.saves += 1;
      fs.writeFileSync(s.open, "project saved " + s.saves);
      return { path: s.open };
    },
    sd_state: (args) => ({
      project: s.open,
      sequence: facts(),
      track_names: s.seq.audio.map((t) => t.name),
      tracks: (args.track_ids || []).map(find).filter(Boolean).map((t) => ({ id: t.id, name: t.name, clips: t.clips.map((c) => Object.assign({}, c)) })),
    }),
    sd_read: () => ({
      project: s.open,
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
      sameProject(args);
      const key = args.bin_path.join(" / ");
      s.bins[key] = s.bins[key] || [];
      for (const p of args.paths) if (fs.existsSync(p) && !s.bins[key].includes(asPremiere(p))) s.bins[key].push(asPremiere(p));
      return { bin: key, items: s.bins[key].slice(), mapping: [] };
    },
    sd_add_tracks: (args) => {
      sameProject(args);
      return {
        tracks: args.names.map((name) => {
          const t = { id: s.nextId++, name, clips: [] };
          s.seq.audio.push(t);
          return { id: t.id, index: s.seq.audio.length, name };
        }),
      };
    },
    sd_place: (args) => {
      sameProject(args);
      const inBin = s.bins[args.bin_path.join(" / ")] || [];
      const results = args.placements.map((p) => {
        if (!inBin.includes(p.media)) return { key: p.key, ok: false, reason: "its file is not in the bin." };
        const t = find(p.track_id);
        if (!t) return { key: p.key, ok: false, reason: "its track is no longer in the sequence." };
        if (t.name !== p.track_name) return { key: p.key, ok: false, reason: "its track is now called " + t.name + "." };
        const end = BigInt(p.start) + BigInt(p.out) - BigInt(p.in);
        if (t.clips.some((c) => BigInt(c.start) < end && BigInt(p.start) < BigInt(c.end))) {
          return { key: p.key, ok: false, reason: "something is on " + t.name + " at that time." };
        }
        const clip = { start: p.start, end: end.toString(), media: p.media, node_id: "n" + s.nextNode++, level: p.level, keys: p.keys };
        t.clips.push(clip);
        return { key: p.key, ok: true, node_id: clip.node_id, start: clip.start, end: clip.end, in: p.in, out: p.out };
      });
      if (s.stallPlace) throw new Error("Premiere Pro is still busy with this");
      return { results };
    },
    sd_remove: (args) => {
      sameProject(args);
      const removed = [];
      const missing = [];
      for (const c of args.clips) {
        const t = find(c.track_id);
        const i = t && t.name === c.track_name ? t.clips.findIndex((x) => x.start === c.start && x.media === c.media) : -1;
        if (i >= 0) {
          t.clips.splice(i, 1);
          removed.push(c.key);
        } else missing.push({ key: c.key, reason: "it is not where NOLGIA placed it" });
      }
      const tracksRemoved = [];
      const tracksKept = [];
      for (const want of args.tracks) {
        const t = find(want.id);
        if (!t) continue;
        if (t.name !== want.name) tracksKept.push({ id: t.id, name: t.name, reason: "it was renamed, so it stays." });
        else if (t.clips.length) tracksKept.push({ id: t.id, name: t.name, reason: "it has clips NOLGIA did not place, so it stays." });
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

const PLAN = "4f8a2c1e-0b1d-4c55-9a3e-2b7c9d0e1f23";

// One package file as the route answers it; `path` (tests only) in place of `url`.
function cue(id, src, extra = {}) {
  return Object.assign(
    { cue_id: id, name: id, file: "NOLGIA Sounds/" + id + ".wav", path: src, start_ms: 1000, source_in_ms: 0, source_out_ms: 500, gain_db: -6, fade_in_ms: 0, fade_out_ms: 100, role: "sfx", lane: 1, credit: "", licence: "CC0" },
    extra
  );
}

// What the package route answers for `plan`, one answer per call (the last repeats).
async function packageAnswers(plan, answers) {
  await support.call(server, "POST", "/mock/sound-design-package", { plan_id: plan, answers }, { token: null });
}

function packageOf(files, extra = {}) {
  return { status: 200, body: Object.assign({ plan_id: PLAN, mode: "manifest", format: "manifest", sounds_folder: "NOLGIA Sounds", files, credits: [], warnings: [] }, extra) };
}

test("place: the plugin asks the package itself; new tracks after the editor's, frame exact, backed up first; a repeat places nothing twice; remove takes exactly that out, also after the project is opened again", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  const files = [
    cue("door", src.door, { start_ms: 900, file: "NOLGIA Sounds/03 Door slam [fs-1].wav", credit: "Door slam by A (CC BY 4.0)" }),
    cue("whoosh", src.whoosh, { start_ms: 1200 }), // overlaps the door: a second SFX track
    cue("rain", src.rain, { role: "ambience", lane: 2, start_ms: 0, source_out_ms: 4000, gain_db: -18, fade_in_ms: 1000, fade_out_ms: 1000 }),
    cue("evil", src.bell, { file: "../../../Windows/evil.wav", start_ms: 5000 }),
    cue("fake", src.html, { start_ms: 6000 }),
  ];
  await packageAnswers(PLAN, [packageOf(files, { credits: ["Rain by B (CC BY 4.0)", "Door slam by A (CC BY 4.0)"], warnings: ["e09 was left out: no sound fits."] })]);
  const cmd = await command({
    action: "place", plan_id: PLAN, sequence: "seq-1", timeline_offset_ms: 1001,
    picks: { whoosh: { sound_id: "fs-9" } }, skip: ["e09"], overrides: { door: { start_ms: 1001 }, nope: { lane: 2 } },
  });
  assert.equal(cmd.status, "succeeded", cmd.error);
  const r = cmd.result;
  // The route was asked with the plugin's own sign-in and the agent's choices.
  const st = await support.state(server);
  assert.deepEqual(st.sound_design_requests, [{ plan_id: PLAN, body: { format: "manifest", timeline_offset_ms: 1001, picks: { whoosh: { sound_id: "fs-9" } }, skip: ["e09"] } }]);
  assert.equal(r.run_id, PLAN, "the run id is the plan id");
  assert.equal(r.placed, 4);
  assert.equal(r.not_placed, 1);
  assert.match(r.cues.find((c) => c.cue_id === "fake").reason, /not a WAV sound/);
  assert.deepEqual(r.warnings, ["e09 was left out: no sound fits.", "The override for nope was not used: the plan has no cue nope."]);
  // The editor's tracks are as they were; the sounds are on new tracks after them.
  assert.deepEqual(pr.seq.audio.map((x) => [x.name, x.clips.length]), [
    ["Audio 1", 1], ["Audio 2", 0], ["Audio 3", 0], ["NOLGIA SFX 1", 2], ["NOLGIA SFX 2", 1], ["NOLGIA Ambience", 1],
  ]);
  // Frame exact: the override's 1001 ms at 23.976 is frame 24.
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
  // What is on the tracks is read again after the backup.
  assert.ok(pr.calls.lastIndexOf("sd_state") > pr.calls.indexOf("save"), pr.calls.join(","));
  assert.ok(fs.existsSync(r.backup) && path.dirname(r.backup) === path.join(path.dirname(pr.file), "NOLGIA backups"), r.backup);
  // The sounds sit in NOLGIA Sounds/<run> next to the project, with safe names.
  const folder = path.join(path.dirname(pr.file), "NOLGIA Sounds", PLAN);
  assert.equal(r.folder, folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["03 Door slam [fs-1].wav", "CREDITS.txt", "evil.wav", "placement.json", "rain.wav", "whoosh.wav"]);
  assert.match(fs.readFileSync(path.join(folder, "CREDITS.txt"), "utf8"), /Rain by B \(CC BY 4.0\)\nDoor slam by A \(CC BY 4.0\)/);
  assert.deepEqual(r.credits, ["Rain by B (CC BY 4.0)", "Door slam by A (CC BY 4.0)"]);
  assert.deepEqual(r.tracks.map((x) => x.name), ["NOLGIA SFX 1", "NOLGIA SFX 2", "NOLGIA Ambience"]);
  assert.match(r.bin, /^NOLGIA imports \/ Sound design \/ \d{4}-\d\d-\d\d 4f8a2c1e$/);
  const record = JSON.parse(fs.readFileSync(path.join(folder, "placement.json"), "utf8"));
  assert.equal(record.sequence.id, "seq-1");
  assert.equal(record.plan_id, PLAN);
  assert.equal(Object.values(record.cues).filter((c) => c.status === "placed").length, 4);
  assert.ok(!JSON.stringify(record).includes("pending"), "nothing left pending");

  // The same run again: nothing placed twice, nothing changed, no new backup.
  const saves = pr.saves;
  const again = await command({ action: "place", plan_id: PLAN, overrides: { door: { start_ms: 1001 } } });
  assert.equal(again.status, "succeeded", again.error);
  assert.equal(again.result.placed, 0);
  assert.equal(again.result.already_placed, 4);
  assert.equal(again.result.repeated, true);
  assert.equal(pr.saves, saves, "not saved: nothing changed");
  assert.equal(pr.seq.audio.length, 6);
  assert.equal(fs.readdirSync(path.join(path.dirname(pr.file), "NOLGIA backups")).length, 1);

  // The project is opened again: Premiere numbers its clips anew, and the
  // number the door had now belongs to the editor's clip on A1.
  const doorNode = record.cues.door.node_id;
  let next = 500;
  for (const tr of pr.seq.audio) for (const c of tr.clips) c.node_id = "n" + next++;
  pr.seq.audio[0].clips[0].node_id = doorNode;
  // The editor puts a clip of their own on NOLGIA SFX 2; remove keeps that track.
  pr.seq.audio[4].clips.push({ start: String(10 * TPS), end: String(11 * TPS), media: "C:/media/mine.wav", node_id: "mine" });
  const out = await command({ action: "remove", run_id: PLAN });
  assert.equal(out.status, "succeeded", out.error);
  assert.equal(out.result.removed, 4);
  assert.deepEqual(out.result.left, []);
  assert.deepEqual(out.result.tracks_removed.sort(), ["NOLGIA Ambience", "NOLGIA SFX 1"]);
  assert.equal(out.result.tracks_kept[0].name, "NOLGIA SFX 2");
  assert.deepEqual(pr.seq.audio.map((x) => [x.name, x.clips.length]), [["Audio 1", 1], ["Audio 2", 0], ["Audio 3", 0], ["NOLGIA SFX 2", 1]]);
  assert.equal(pr.seq.audio[0].clips[0].media, "C:/media/dialogue.wav", "the editor's A1 clip stays");
  assert.ok(fs.existsSync(path.join(folder, "rain.wav")), "the files stay");
  assert.match(out.result.note, /stay in/);
  // Taken out, it can go in again (once).
  await packageAnswers(PLAN, [packageOf(files.slice(0, 1))]);
  const back = await command({ action: "place", plan_id: PLAN });
  assert.equal(back.result.placed, 1);
  const twice = await command({ action: "remove", run_id: PLAN });
  assert.equal(twice.result.removed, 1);
  const thrice = await command({ action: "remove", run_id: PLAN });
  assert.match(thrice.result.note, /already out/);
});

test("remove leaves alone a clip the editor moved, and a track the editor renamed", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("door", src.door, { start_ms: 1000 }), cue("rain", src.rain, { role: "ambience", lane: 2, start_ms: 0, source_out_ms: 2000 })])]);
  assert.equal((await command({ action: "place", plan_id: PLAN })).result.placed, 2);
  // The door moves to A2; the ambience track is renamed.
  const door = pr.seq.audio[3].clips.pop();
  pr.seq.audio[1].clips.push(door);
  pr.seq.audio[4].name = "Room tone";
  const out = await command({ action: "remove", run_id: PLAN });
  assert.equal(out.status, "succeeded", out.error);
  assert.equal(out.result.removed, 0);
  assert.deepEqual(out.result.left.map((l) => l.cue_id).sort(), ["door", "rain"]);
  assert.match(out.result.left.find((l) => l.cue_id === "rain").reason, /renamed to Room tone.*left in the sequence/);
  assert.deepEqual(pr.seq.audio.map((x) => [x.name, x.clips.length]), [["Audio 1", 1], ["Audio 2", 1], ["Audio 3", 0], ["Room tone", 1]]);
});

test("a place whose answer comes too late: what it placed is written down first, and remove takes it out", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("door", src.door), cue("bell", src.bell, { start_ms: 3000 })])]);
  pr.stallPlace = true;
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "failed");
  assert.match(cmd.error, /did not finish placing the sounds in time.*place the run again to finish, or remove it/);
  const record = JSON.parse(fs.readFileSync(path.join(path.dirname(pr.file), "NOLGIA Sounds", PLAN, "placement.json"), "utf8"));
  assert.deepEqual(Object.values(record.cues).map((c) => c.status), ["pending", "pending"]);
  assert.equal(pr.seq.audio[3].clips.length, 2, "Premiere did place them");
  pr.stallPlace = false;
  // A retry finds them on the timeline: nothing placed twice.
  const retry = await command({ action: "place", plan_id: PLAN });
  assert.equal(retry.status, "succeeded", retry.error);
  assert.deepEqual([retry.result.placed, retry.result.already_placed], [0, 2]);
  assert.equal(pr.seq.audio[3].clips.length, 2);
  const out = await command({ action: "remove", run_id: PLAN });
  assert.equal(out.result.removed, 2);
  assert.equal(pr.seq.audio.length, 3);
});

test("place refuses an unsaved project and changes nothing", async (t) => {
  const { ctl, pr } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" }, { saved: false });
  t.after(() => finish(ctl));
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "failed");
  assert.match(cmd.error, /never been saved\. Save it first \(File > Save\)/);
  assert.deepEqual(pr.calls.filter((k) => k.startsWith("sd_") || k === "save"), []);
});

test("another project opened while the sounds download: nothing is changed", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("door", src.door)])]);
  const realState = pr.handlers.sd_state;
  pr.handlers.sd_state = (args) => {
    const out = realState(args);
    pr.open = path.join(root, "Other", "other.prproj"); // opened during the downloads
    fs.mkdirSync(path.dirname(pr.open), { recursive: true });
    fs.writeFileSync(pr.open, "another project");
    return out;
  };
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "failed");
  assert.match(cmd.error, /open project changed while NOLGIA worked.*changed nothing/);
  assert.equal(pr.saves, 0);
  assert.deepEqual(pr.calls.filter((k) => ["sd_import", "sd_add_tracks", "sd_place"].includes(k)), []);
});

test("local paths are taken only in tests; a run placed on another sequence is refused", async (t) => {
  const { ctl, pr, root } = await connectedPremiere();
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("door", src.door)])]);
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "succeeded");
  assert.equal(cmd.result.placed, 0);
  assert.match(cmd.result.cues[0].reason, /gave no link/);
  assert.match(cmd.result.note, /project was not changed/);
  assert.equal(pr.saves, 0);

  const second = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(second.ctl));
  const s2 = sounds(second.root);
  await packageAnswers(PLAN, [packageOf([cue("door", s2.door)])]);
  assert.equal((await command({ action: "place", plan_id: PLAN })).result.placed, 1);
  second.pr.seq.id = "seq-2";
  second.pr.seq.name = "Other";
  const other = await command({ action: "place", plan_id: PLAN });
  assert.equal(other.status, "failed");
  assert.match(other.error, /placed on the sequence Edit, not Other/);
});

test("NOLGIA still making sounds: the plugin asks again; a plan that is not done is said plainly", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [
    { status: 202, body: { plan_id: PLAN, files: [] }, headers: { "Retry-After": "0" } },
    packageOf([cue("door", src.door)], { pending: ["bell"], retry_after_ms: 100 }),
    packageOf([cue("door", src.door), cue("bell", src.bell, { start_ms: 3000 })]),
  ]);
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "succeeded", cmd.error);
  assert.equal(cmd.result.placed, 2);
  assert.equal((await support.state(server)).sound_design_requests.length, 3);
  assert.ok(pr);

  const other = "0b1d4c55-4f8a-4c1e-9a3e-2b7c9d0e1f23";
  await packageAnswers(other, [{ status: 409, title: "Conflict", detail: "The plan is running, not done: its sounds can go to an editor once it is done." }]);
  const busy = await command({ action: "place", plan_id: other });
  assert.equal(busy.status, "failed");
  assert.match(busy.error, /The plan is running, not done.*Nothing was changed/);
  const unknown = await command({ action: "place", plan_id: "11111111-2222-4333-8444-555555555555" });
  assert.match(unknown.error, /no sound design plan 11111111-2222-4333-8444-555555555555 for this account/);
  // Too little time to ask and place: said, nothing asked.
  const short = await command({ action: "place", plan_id: PLAN }, 60);
  assert.equal(short.status, "failed");
  assert.match(short.error, /too short/);
});

test("names Premiere answers in another Unicode form (macOS) still match", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" }, { nfd: true });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("e01", src.door, { file: "NOLGIA Sounds/Café door.wav" })])]);
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "succeeded", cmd.error);
  assert.equal(cmd.result.placed, 1);
  assert.equal(pr.seq.audio[3].clips[0].media, pr.seq.audio[3].clips[0].media.normalize("NFD"));
  const out = await command({ action: "remove", run_id: PLAN });
  assert.equal(out.result.removed, 1);
});

// A local HTTPS server with a certificate made for this test (openssl).
function httpsServer(handler) {
  const dir = support.tempDir("nolgia-tls-");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const made = childProcess.spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { encoding: "utf8" });
  if (made.status !== 0) return null;
  const pem = fs.readFileSync(cert);
  const srv = https.createServer({ key: fs.readFileSync(key), cert: pem }, handler);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, pem, port: srv.address().port })));
}

test("the package's HTTPS links are downloaded; plain HTTP, another site and a server's error text never come through", async (t) => {
  const served = [];
  const tls = await httpsServer((req, res) => {
    served.push(req.url);
    if (req.url === "/door.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav(1));
    } else if (req.url === "/elsewhere.wav") {
      res.writeHead(302, { Location: "https://127.0.0.1:" + req.socket.localPort + "/door.wav" });
      res.end();
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("internal bucket policy secret-123");
    }
  });
  if (!tls) {
    t.skip("openssl is not here to make a test certificate");
    return;
  }
  t.after(() => tls.srv.close());
  const ca = https.globalAgent.options.ca;
  https.globalAgent.options.ca = tls.pem;
  t.after(() => {
    https.globalAgent.options.ca = ca;
  });
  const { ctl, pr } = await connectedPremiere();
  t.after(() => finish(ctl));
  const base = "https://localhost:" + tls.port;
  const remote = (id, url, extra) => Object.assign(cue(id, undefined, extra), { path: undefined, url });
  await packageAnswers(PLAN, [packageOf([
    remote("door", base + "/door.wav", { bytes: wav(1).length }),
    remote("plain", "http://localhost:" + tls.port + "/door.wav", { start_ms: 3000 }),
    remote("moved", base + "/elsewhere.wav", { start_ms: 5000 }),
    remote("denied", base + "/denied.wav", { start_ms: 7000 }),
  ])]);
  const cmd = await command({ action: "place", plan_id: PLAN });
  assert.equal(cmd.status, "succeeded", cmd.error);
  const why = Object.fromEntries(cmd.result.cues.map((c) => [c.cue_id, c.reason || c.status]));
  assert.equal(why.door, "placed");
  assert.match(why.plain, /not HTTPS/);
  assert.match(why.moved, /another site/);
  assert.match(why.denied, /the download failed \(HTTP 403\)/);
  assert.ok(!JSON.stringify(cmd.result).includes("secret-123"), "a server's own words never reach the agent");
  assert.ok(!served.includes("/door.wav?plain"), "nothing fetched over plain HTTP");
  const folder = path.join(path.dirname(pr.file), "NOLGIA Sounds", PLAN);
  assert.deepEqual(fs.readdirSync(folder).filter((n) => n.endsWith(".wav")), ["door.wav"], "no partial files left");
  assert.equal(fs.readFileSync(path.join(folder, "door.wav")).length, wav(1).length);
  const record = fs.readFileSync(path.join(folder, "placement.json"), "utf8");
  assert.ok(!record.includes(base + "/door.wav"), "the signed link is not kept");
});

test("a download has one time limit for the whole file, however slowly it trickles", async (t) => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    const timer = setInterval(() => res.write(Buffer.alloc(10)), 100);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const api = new ApiClient({ baseUrl: server.base, token: support.TOKEN });
  const dest = path.join(support.tempDir(), "slow.wav");
  const started = Date.now();
  await assert.rejects(api.download("http://127.0.0.1:" + srv.address().port + "/slow.wav", dest, { limitSeconds: 1 }), /longer than 1 s/);
  assert.ok(Date.now() - started < 5000);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"), "nothing left behind");
});

test("read: tracks and clips in ms and frames, the empty audio tracks, markers and NOLGIA's runs", async (t) => {
  const { ctl, pr, root } = await connectedPremiere({ NOLGIA_SOUND_DESIGN_LOCAL: "1" });
  t.after(() => finish(ctl));
  const src = sounds(root);
  await packageAnswers(PLAN, [packageOf([cue("door", src.door)])]);
  await command({ action: "place", plan_id: PLAN, run_id: "r9" });
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
