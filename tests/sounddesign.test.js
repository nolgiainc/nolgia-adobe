// SPDX-License-Identifier: GPL-3.0-or-later
// Sound design in Premiere Pro (core/sounddesign.js): file names written by
// strangers made safe, milliseconds to frames and ticks, lanes to new tracks,
// overlaps, gain and fades, the placement record, repeat and remove, the
// preview's size, range and preset.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sd = require("../core/sounddesign");
const c = require("../core/commands");
const { APPS } = require("../core/index");

const PR = APPS.PPRO;
// Premiere's frame lengths in ticks (sequence.timebase).
const TB = { "23.976": "10594584000", "25": "10160640000", "29.97": "8475667200", "59.94": "4237833600" };

test("ms to frames and ticks at 23.976, 25, 29.97 and 59.94", () => {
  assert.equal(sd.fpsOf(TB["23.976"]), 23.976);
  assert.equal(sd.fpsOf(TB["25"]), 25);
  assert.equal(sd.fpsOf(TB["29.97"]), 29.97);
  assert.equal(sd.fpsOf(TB["59.94"]), 59.94);
  // One second lands on the nearest frame of each rate.
  assert.equal(sd.msToFrame(1000, TB["23.976"]), 24);
  assert.equal(sd.msToFrame(1000, TB["25"]), 25);
  assert.equal(sd.msToFrame(1000, TB["29.97"]), 30);
  assert.equal(sd.msToFrame(1000, TB["59.94"]), 60);
  // The frame's start in ticks is exact (these are what Premiere read back).
  assert.equal(sd.msToTicks(500, TB["23.976"]), "127135008000"); // 12 frames
  assert.equal(sd.msToTicks(1001, TB["23.976"]), "254270016000"); // 24 frames
  assert.equal(sd.msToTicks(1000, TB["25"]), "254016000000");
  assert.equal(sd.msToTicks(1000, TB["29.97"]), "254270016000");
  assert.equal(sd.msToTicks(1000, TB["59.94"]), "254270016000");
  // Half a frame rounds to the nearer frame; the frame before 41.708 ms is 0.
  assert.equal(sd.msToFrame(20, TB["23.976"]), 0);
  assert.equal(sd.msToFrame(21, TB["23.976"]), 1);
  // Ten hours at 59.94 stays exact (BigInt ticks).
  const frames = sd.msToFrame(36000000, TB["59.94"]);
  assert.equal(frames, 2157842); // 36000 s at 60000/1001
  assert.equal(sd.frameToTicks(frames, TB["59.94"]), (2157842n * 4237833600n).toString());
  // And back: ticks to ms and frames.
  assert.equal(sd.ticksToMs("254270016000"), 1001);
  assert.equal(sd.ticksToMs("4057725672000"), 15974);
  assert.equal(sd.ticksToFrame("254270016000", TB["23.976"]), 24);
  assert.equal(sd.ticksToFrame("254270016001", TB["23.976"], { up: true }), 25);
  assert.throws(() => sd.frameTicks("0"), sd.SoundDesignError);
  assert.throws(() => sd.frameTicks("-5"), sd.SoundDesignError);
});

test("file names from the library are safe on Windows and macOS", () => {
  const name = (raw) => {
    const s = sd.safeSoundName(raw);
    return s.stem + s.ext;
  };
  assert.equal(name("NOLGIA Sounds/03 Door slam [fs-123456].wav"), "03 Door slam [fs-123456].wav");
  // No path traversal: only the last part of any path.
  assert.equal(name("../../../../Windows/System32/evil.wav"), "evil.wav");
  assert.equal(name("..\\..\\Users\\me\\AppData\\evil.wav"), "evil.wav");
  assert.equal(name("/etc/passwd/../x.WAV"), "x.wav");
  // Characters Windows or macOS refuse, control and invisible characters.
  assert.equal(name('a<b>c:d"e|f?g*h.wav'), "a_b_c_d_e_f_g_h.wav");
  assert.equal(name("tab\there\u0000nul.wav"), "tabherenul.wav");
  assert.equal(name("gnp\u202Ecod.wav"), "gnpcod.wav", "a right-to-left override is dropped");
  assert.equal(name("zero\u200Bwidth.wav"), "zerowidth.wav");
  // Windows device names, leading and trailing dots and spaces.
  assert.equal(name("con.wav"), "_con.wav");
  assert.equal(name("LPT1.wav"), "_LPT1.wav");
  assert.equal(name("aux.final.wav"), "_aux.final.wav");
  assert.equal(name("  .hidden.wav"), "hidden.wav");
  assert.equal(name("trailing dots... .wav"), "trailing dots.wav");
  // Letters of any language stay (composed, NFC), emoji do not.
  assert.equal(name("Cafe\u0301 ambience.wav"), "Café ambience.wav");
  assert.equal(name("雨の音 rain.wav"), "雨の音 rain.wav");
  assert.equal(name("boom 💥.wav"), "boom _.wav");
  // Long names are cut (100 characters, 180 bytes).
  assert.equal(sd.safeSoundName("x".repeat(400) + ".wav").stem.length, 100);
  assert.ok(Buffer.byteLength(sd.safeSoundName("雨".repeat(150) + ".wav").stem) <= 180);
  // Nothing left: the fallback.
  assert.equal(name("???.wav"), "_.wav");
  assert.equal(sd.safeSoundName("....wav", "cue 7").stem, "cue 7");
  // Only sounds.
  assert.equal(name("loop.WAVE"), "loop.wav");
  assert.equal(name("hit.aiff"), "hit.aiff");
  for (const bad of ["virus.exe", "sound.wav.exe", "noext", "", "page.html", "a.flac"]) {
    assert.throws(() => sd.safeSoundName(bad), sd.SoundDesignError, bad);
  }
});

test("names are unique in a folder, whatever their case", () => {
  const taken = new Set(["door.wav"]);
  assert.equal(sd.uniqueName("Door", ".wav", taken), "Door (2).wav");
  assert.equal(sd.uniqueName("door", ".wav", taken), "door (3).wav");
  assert.equal(sd.uniqueName("Rain", ".wav", taken), "Rain.wav");
  assert.ok(taken.has("rain.wav"));
});

test("a sound file must look like the sound its name says", () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
  assert.equal(sd.looksLikeAudio(wav, ".wav"), true);
  assert.equal(sd.looksLikeAudio(Buffer.from("<!DOCTYPE html><html>"), ".wav"), false);
  assert.equal(sd.looksLikeAudio(Buffer.from("ID3\u0004\u0000"), ".mp3"), true);
  assert.equal(sd.looksLikeAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00]), ".mp3"), true);
  assert.equal(sd.looksLikeAudio(Buffer.concat([Buffer.from("FORM"), Buffer.alloc(4), Buffer.from("AIFF")]), ".aiff"), true);
  assert.equal(sd.looksLikeAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]), ".m4a"), true);
  assert.equal(sd.looksLikeAudio(wav, ".mp3"), false);
});

test("sound_design arguments: actions, run ids, the plan and placement-only overrides", () => {
  const PLAN = "4f8a2c1e-0b1d-4c55-9a3e-2b7c9d0e1f23";
  assert.ok(c.capabilitiesFor(PR).includes("sound_design"));
  assert.ok(!c.capabilitiesFor(APPS.AEFT).includes("sound_design"), "Premiere Pro only");
  assert.deepEqual(c.validate(PR, "sound_design", { action: "read" }), { action: "read", sequence: null });
  assert.deepEqual(c.validate(PR, "sound_design", { action: "preview", sequence: "Edit" }), { action: "preview", sequence: "Edit", range: "auto" });
  assert.deepEqual(c.validate(PR, "sound_design", { action: "remove", run_id: "plan-1" }), { action: "remove", sequence: null, run_id: "plan-1" });
  assert.throws(() => c.validate(PR, "sound_design", {}), /`action` must be one of: read, preview, place, remove/);
  assert.throws(() => c.validate(PR, "sound_design", { action: "preview", range: "work_area" }), /`range` must be one of/);
  assert.throws(() => c.validate(PR, "sound_design", { action: "remove" }), /`run_id` must be/);
  // Run ids name a folder: no paths, device names or a trailing dot.
  for (const bad of ["../x", "CON", "nul", "com1", "Lpt9.txt", "run.", "a/b", "-x", "x".repeat(81)]) {
    assert.throws(() => c.validate(PR, "sound_design", { action: "remove", run_id: bad }), /`run_id` must be/, bad);
  }
  for (const ok of ["plan-1", "r", "console", "com10", "a.b_c-d", PLAN]) {
    assert.equal(c.validate(PR, "sound_design", { action: "remove", run_id: ok }).run_id, ok);
  }
  assert.throws(() => c.validate(APPS.AEFT, "sound_design", { action: "read" }), /cannot do "sound_design"/);

  // place: the plan id; the run id defaults to it. Links never come from the agent.
  assert.deepEqual(c.validate(PR, "sound_design", { action: "place", plan_id: PLAN.toUpperCase(), sequence: "seq-1" }), {
    action: "place", sequence: "seq-1", plan_id: PLAN, run_id: PLAN, picks: null, skip: null, overrides: null,
  });
  assert.throws(() => c.validate(PR, "sound_design", { action: "place", run_id: "r1" }), /`plan_id` is required/);
  assert.throws(() => c.validate(PR, "sound_design", { action: "place", plan_id: "not-a-plan" }), /`plan_id` is required/);
  assert.throws(() => c.validate(PR, "sound_design", { action: "place", plan_id: PLAN, files: [{ url: "https://x.test/a.wav" }] }), /takes no `files`/);
  assert.throws(() => c.validate(PR, "sound_design", { action: "place", plan_id: PLAN, url: "https://x.test/a.wav" }), /takes no `url`/);
  const full = c.validate(PR, "sound_design", {
    action: "place",
    plan_id: PLAN,
    run_id: "my-run",
    timeline_offset_ms: 1001,
    picks: { e03: { sound_id: "fs-123", gain_db: -3 }, s01: { asset_id: PLAN, fade_in_ms: 500 } },
    skip: ["e07", "e07"],
    overrides: { e03: { start_ms: 4000, lane: 2 }, s01: { gain_db: -18, fade_out_ms: 2000 } },
  });
  assert.equal(full.run_id, "my-run");
  assert.equal(full.timeline_offset_ms, 1001);
  assert.deepEqual(full.picks, { e03: { sound_id: "fs-123", gain_db: -3 }, s01: { asset_id: PLAN, fade_in_ms: 500 } });
  assert.deepEqual(full.skip, ["e07"]);
  assert.deepEqual(full.overrides, { e03: { start_ms: 4000, lane: 2 }, s01: { gain_db: -18, fade_out_ms: 2000 } });
  const place = (extra) => c.validate(PR, "sound_design", Object.assign({ action: "place", plan_id: PLAN }, extra));
  assert.throws(() => place({ overrides: { e03: { url: "https://evil.test/x.wav" } } }), /placement only.*`url` is not one/);
  assert.throws(() => place({ overrides: { e03: { file: "../x.wav" } } }), /`file` is not one/);
  assert.throws(() => place({ overrides: { "../e03": { lane: 1 } } }), /names cues by their id/);
  assert.throws(() => place({ overrides: { e03: { lane: 0 } } }), /lane` must be a whole number/);
  assert.throws(() => place({ overrides: { e03: { gain_db: 40 } } }), /gain_db` must be a number from -96 to/);
  assert.throws(() => place({ picks: { e03: { sound_id: "a", asset_id: PLAN } } }), /not both/);
  assert.throws(() => place({ picks: { e03: { gain_db: 20 } } }), /from -24 to 12/);
  assert.throws(() => place({ picks: { e03: { url: "https://x" } } }), /takes only sound_id, asset_id/);
  assert.throws(() => place({ skip: "e03" }), /`skip` must be a list/);
  assert.throws(() => place({ timeline_offset_ms: -1 }), /timeline_offset_ms/);
});

test("the package's files: each checked on its own, the overrides applied, unknown overrides named", () => {
  const good = {
    cue_id: "c1", name: "Door slam", file: "NOLGIA Sounds/Door slam.wav", url: "https://cdn.example/a.wav",
    bytes: 1000, start_ms: 1200, source_in_ms: 0, source_out_ms: 800, gain_db: -6, fade_in_ms: 0, fade_out_ms: 120,
    role: "sfx", lane: 1, credit: "", licence: "CC0",
  };
  const { cues, unknown } = sd.packageCues(
    [
      good,
      Object.assign({}, good, { cue_id: "c2", url: "http://cdn.example/a.wav" }),
      Object.assign({}, good, { cue_id: "c3", url: "https://me:pw@cdn.example/a.wav" }),
      Object.assign({}, good, { cue_id: "c4", start_ms: -5 }),
      Object.assign({}, good, { cue_id: "c5", source_out_ms: 0 }),
      Object.assign({}, good, { cue_id: "c6", file: "../../evil.exe" }),
      Object.assign({}, good, { cue_id: "c7", bytes: 400 * 1024 * 1024 }),
      Object.assign({}, good, { cue_id: "c8", url: undefined }),
      good,
      "nonsense",
      Object.assign({}, good, { cue_id: "c9", role: "laser", lane: 0, gain_db: "loud", source_out_ms: undefined, duration_ms: 2500 }),
      // Only the allowed hosts, on their own port.
      Object.assign({}, good, { cue_id: "h1", url: "https://evil.example/a.wav" }),
      Object.assign({}, good, { cue_id: "h2", url: "https://cdn.example:8443/a.wav" }),
      // No number past what a sound can be.
      Object.assign({}, good, { cue_id: "n1", start_ms: 1e300 }),
      Object.assign({}, good, { cue_id: "n2", gain_db: 1e300 }),
      Object.assign({}, good, { cue_id: "n3", fade_out_ms: 1e300 }),
      Object.assign({}, good, { cue_id: "n4", source_out_ms: 1e300 }),
    ],
    { c1: { start_ms: 5000, gain_db: -12, lane: 3 }, zz: { lane: 2 } },
    { offsetMs: 1001, hosts: ["cdn.example"] }
  );
  const byId = Object.fromEntries(cues.map((f) => [f.cue_id + ":" + f.index, f]));
  assert.equal(byId["c1:0"].problem, null);
  assert.deepEqual(byId["c1:0"].safe, { stem: "Door slam", ext: ".wav" });
  // The override's start is the planned video's time: the preview's offset is added.
  assert.deepEqual([byId["c1:0"].start_ms, byId["c1:0"].gain_db, byId["c1:0"].lane], [6001, -12, 3], "overridden");
  assert.match(byId["c2:1"].problem, /not HTTPS/);
  assert.match(byId["c3:2"].problem, /user name or password/);
  assert.match(byId["c4:3"].problem, /start_ms/);
  assert.match(byId["c5:4"].problem, /ends before it starts/);
  assert.match(byId["c6:5"].problem, /not a sound file/);
  assert.match(byId["c7:6"].problem, /400 MB, more than the 300 MB/);
  assert.match(byId["c8:7"].problem, /no url/);
  assert.match(byId["c1:8"].problem, /listed twice/);
  assert.match(byId["10:9"].problem, /not an object/);
  const c9 = byId["c9:10"];
  assert.equal(c9.problem, null);
  assert.equal(c9.role, "sfx");
  assert.equal(c9.lane, 1);
  assert.equal(c9.gain_db, 0);
  assert.equal(c9.source_out_ms, 2500, "the sound's length when source_out_ms is missing");
  assert.match(byId["h1:11"].problem, /not on a host NOLGIA downloads sounds from \(evil\.example\)/);
  assert.match(byId["h2:12"].problem, /not on a host NOLGIA downloads sounds from \(cdn\.example:8443\)/);
  assert.match(byId["n1:13"].problem, /start_ms is more than 24 hours/);
  assert.match(byId["n2:14"].problem, /gain_db \(1e\+300\) is not a level/);
  assert.match(byId["n3:15"].problem, /fade_out_ms is more than 10 minutes/);
  assert.match(byId["n4:16"].problem, /source_out_ms is more than 24 hours/);
  assert.deepEqual(unknown, ["zz"]);
  assert.deepEqual(sd.creditLines([" Rain by someone (CC BY 4.0) ", "", 7, "Door by another (CC BY 4.0)"]), ["Rain by someone (CC BY 4.0)", "Door by another (CC BY 4.0)"]);
  assert.throws(() => sd.packageCues(new Array(301).fill({}), null), /more than 300 sounds/);
  assert.throws(() => sd.packageCues(undefined, null), /no list of sounds/);
});

test("download hosts: production's storage by default, a setting otherwise; a port only when named", () => {
  assert.deepEqual(sd.downloadHosts(undefined), ["storage.googleapis.com"]);
  assert.deepEqual(sd.downloadHosts(" Storage.example , localhost:8443,"), ["storage.example", "localhost:8443"]);
  const signed = "https://storage.googleapis.com/nolgia-assets/sound-library/wav/x.wav?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=ab";
  assert.equal(sd.linkProblem(signed), null);
  assert.match(sd.linkProblem("https://storage.googleapis.com:444/x.wav"), /not on a host/);
  assert.match(sd.linkProblem("https://storage.googleapis.com.evil.example/x.wav"), /not on a host/);
  assert.match(sd.linkProblem("https://u@storage.googleapis.com/x.wav"), /user name or password/);
  assert.match(sd.linkProblem("http://storage.googleapis.com/x.wav"), /not HTTPS/);
  assert.equal(sd.linkProblem("https://localhost:8443/x.wav", ["localhost:8443"]), null);
  assert.match(sd.linkProblem("https://localhost:9443/x.wav", ["localhost:8443"]), /not on a host/);
  assert.match(sd.linkProblem("https://localhost/x.wav", ["localhost:8443"]), /not on a host/);
});

test("a cue starts inside the sequence, plus a few seconds' margin", () => {
  assert.equal(sd.startProblem({ start_ms: 16000 }, 16000), null);
  assert.equal(sd.startProblem({ start_ms: 16000 + sd.START_MARGIN_MS }, 16000), null);
  assert.match(sd.startProblem({ start_ms: 22000 }, 16000), /would start at 22 s in the sequence, after the sequence ends \(16 s\)/);
});

test("media paths compare in one Unicode form, either slash, any case", () => {
  const nfd = "C:/Sounds/Cafe\u0301 door.wav".normalize("NFD");
  assert.equal(sd.mediaKey(nfd), sd.mediaKey("c:\\sounds\\CAF\u00c9 DOOR.wav"));
  assert.notEqual(sd.mediaKey("C:/Sounds/door.wav"), sd.mediaKey("C:/Sounds/door2.wav"));
});

test("a cue on the frame grid; shorter than a frame is not placed", () => {
  const f = sd.cueFrames({ start_ms: 500, source_in_ms: 1001, source_out_ms: 3003 }, TB["23.976"]);
  assert.deepEqual(f, {
    start: 12, end: 60, length: 48, in: 24,
    start_ticks: "127135008000", end_ticks: "635675040000", in_ticks: "254270016000", out_ticks: "762810048000",
  });
  assert.match(sd.cueFrames({ start_ms: 0, source_in_ms: 0, source_out_ms: 10 }, TB["25"]).reason, /shorter than one frame/);
});

test("gain is Volume > Level, 10^((dB - 15) / 20), held to -96..+15 dB", () => {
  // Measured in Premiere Pro 26.2: 0 dB is the value Premiere starts with.
  assert.equal(sd.levelForGain(0).value.toFixed(8), "0.17782794");
  assert.equal(sd.levelForGain(-6).value.toFixed(8), "0.08912509");
  assert.equal(sd.levelForGain(-12).value.toFixed(8), "0.04466836");
  assert.deepEqual(sd.levelForGain(20), { value: 1, db: 15, clamped: true });
  assert.equal(sd.levelForGain(-200).db, -96);
  assert.equal(sd.levelForGain(NaN).db, 0);
});

test("fades are Level keyframes in media time, shortened to fit", () => {
  const level = sd.levelForGain(-6).value;
  // A clip whose media starts at 1.001 s, 2.002 s long, 500 ms fades.
  const f = sd.fadeKeys({ inSeconds: 1.001, lengthSeconds: 2.002, fadeInMs: 500, fadeOutMs: 500, level });
  assert.deepEqual(f.keys, [[1.001, 0], [1.501, level], [2.503, level], [3.003, 0]]);
  assert.equal(f.shortened, false);
  // Only a fade out: the level holds until it.
  assert.deepEqual(sd.fadeKeys({ inSeconds: 0, lengthSeconds: 2, fadeInMs: 0, fadeOutMs: 250, level }).keys, [[1.75, level], [2, 0]]);
  // No fades: no keyframes.
  assert.deepEqual(sd.fadeKeys({ inSeconds: 0, lengthSeconds: 2, fadeInMs: 0, fadeOutMs: 0, level }).keys, []);
  // Fades longer than the clip meet in the middle, in proportion.
  const long = sd.fadeKeys({ inSeconds: 0, lengthSeconds: 1, fadeInMs: 3000, fadeOutMs: 1000, level });
  assert.equal(long.shortened, true);
  assert.equal(long.fade_in_ms, 750);
  assert.equal(long.fade_out_ms, 250);
  assert.deepEqual(long.keys, [[0, 0], [0.75, level], [1, 0]]);
});

function cue(id, lane, role, start, end) {
  return { cue_id: id, index: Number(id.replace(/\D/g, "")) || 0, lane, role, start, end };
}

test("lanes become new tracks; overlapping sounds get another track", () => {
  const plan = sd.planTracks(
    [
      cue("c1", 1, "sfx", 0, 24),
      cue("c2", 1, "sfx", 12, 40), // overlaps c1: a second SFX track
      cue("c3", 1, "sfx", 24, 30), // after c1 ends (end is exclusive): back on the first
      cue("c4", 2, "ambience", 0, 500),
      cue("c5", 3, "music", 100, 400),
      cue("c6", 1, "sfx", 30, 35), // the first again
    ],
    { trackNames: ["Audio 1", "Audio 2", "Audio 3"] }
  );
  assert.deepEqual(plan.tracks.map((t) => [t.key, t.name, t.lane]), [
    ["new:0", "NOLGIA SFX 1", 1],
    ["new:1", "NOLGIA SFX 2", 1],
    ["new:2", "NOLGIA Ambience", 2],
    ["new:3", "NOLGIA Music", 3],
  ]);
  assert.deepEqual(plan.assign, { c1: "new:0", c2: "new:1", c3: "new:0", c6: "new:0", c4: "new:2", c5: "new:3" });
});

test("track names never repeat one the sequence has, and each role has its own tracks", () => {
  const plan = sd.planTracks(
    [cue("c1", 1, "ambience", 0, 10), cue("c2", 1, "ambience", 5, 20), cue("c3", 2, "sfx", 0, 10), cue("c4", 2, "voice", 20, 30), cue("c5", 2, "voice", 40, 50)],
    { trackNames: ["NOLGIA SFX 1", "nolgia ambience 1", "Audio 1"] }
  );
  assert.deepEqual(plan.tracks.map((t) => [t.name, t.role, t.lane]), [
    ["NOLGIA SFX 2", "sfx", 2], ["NOLGIA Ambience 2", "ambience", 1], ["NOLGIA Ambience 3", "ambience", 1], ["NOLGIA Voice", "voice", 2],
  ]);
  assert.deepEqual(plan.assign, { c3: "new:0", c1: "new:1", c2: "new:2", c4: "new:3", c5: "new:3" });
});

// Lanes as nolgia-api numbers them (interchange.AssignLanes: the first lane
// free at the cue's start, whatever its role), in the shape its manifest
// answers: an effect and an ambience share lane 1 when they do not overlap.
test("a manifest shaped as production's: ambience and effects never share a track", () => {
  const signed = (name) => "https://storage.googleapis.com/nolgia-assets/sound-library/wav/" + name + ".wav?X-Goog-Signature=1";
  const file = (cue_id, name, role, lane, start_ms, out) => ({
    cue_id, name, file: "NOLGIA Sounds/" + cue_id + " " + name + ".wav", url: signed(cue_id), bytes: 96044, sample_rate: 48000, channels: 2,
    duration_ms: out, start_ms, source_in_ms: 0, source_out_ms: out, gain_db: role === "ambience" ? -10 : 0,
    fade_in_ms: role === "ambience" ? 1000 : 0, fade_out_ms: role === "ambience" ? 1000 : 80, role, lane,
    sound_id: "freesound:" + cue_id, licence: "cc0", credit: "",
  });
  const { cues } = sd.packageCues([
    file("e01", "Door", "sfx", 1, 0, 1000),
    file("s01", "Room tone", "ambience", 1, 2000, 10000), // lane 1 again: the door ended
    file("e02", "Steps gravel", "sfx", 2, 3000, 3000), // under the room tone
    file("e03", "Cup", "sfx", 1, 13000, 500), // after the room tone, lane 1
  ], null);
  assert.ok(cues.every((c) => c.problem === null), JSON.stringify(cues.map((c) => c.problem)));
  const framed = cues.map((c) => Object.assign(c, sd.cueFrames(c, TB["23.976"])));
  const plan = sd.planTracks(framed, { trackNames: ["Audio 1", "Audio 2"] });
  const trackOf = (id) => plan.tracks.find((t) => t.key === plan.assign[id]);
  assert.equal(trackOf("s01").name, "NOLGIA Ambience");
  for (const id of ["e01", "e02", "e03"]) assert.match(trackOf(id).name, /^NOLGIA SFX \d$/, id);
  assert.equal(trackOf("e01"), trackOf("e03"), "effects of one lane share their track");
  assert.deepEqual(plan.tracks.map((t) => t.name), ["NOLGIA SFX 1", "NOLGIA SFX 2", "NOLGIA Ambience"]);
});

test("a repeated place uses the run's own tracks where they are free, and adds one where they are not", () => {
  const existing = [
    { id: 7, name: "NOLGIA SFX 1", lane: 1, role: "sfx", busy: [[0, 24]] },
    { id: 8, name: "NOLGIA Ambience", lane: 2, role: "ambience", busy: [[0, 500]] },
  ];
  const plan = sd.planTracks([cue("c7", 1, "sfx", 30, 40), cue("c8", 1, "sfx", 10, 20), cue("c9", 2, "ambience", 450, 600)], {
    existing,
    trackNames: ["Audio 1", "NOLGIA SFX 1", "NOLGIA Ambience"],
  });
  assert.equal(plan.assign.c7, "id:7");
  assert.equal(plan.assign.c8, "new:0", "busy on SFX 1 at that time");
  assert.equal(plan.assign.c9, "new:1");
  assert.deepEqual(plan.tracks.map((t) => [t.key, t.name, t.isNew]), [
    ["id:7", "NOLGIA SFX 1", false],
    ["new:0", "NOLGIA SFX 2", true],
    ["new:1", "NOLGIA Ambience 2", true],
  ]);
});

test("the run's live tracks: what is on them now; tracks gone, removed or holding the editor's clips left out", () => {
  const record = sd.newRecord({ runId: "r1", project: "p", sequence: { id: "s", name: "Edit" }, folder: "f", bin: ["b"], now: "t" });
  record.tracks.push({ id: 7, name: "NOLGIA SFX 1", lane: 1, role: "sfx" });
  record.tracks.push({ id: 8, name: "NOLGIA Ambience", lane: 2, role: "ambience" });
  record.tracks.push({ id: 9, name: "NOLGIA SFX 2", lane: 1, role: "sfx", removed_at: "t" });
  record.tracks.push({ id: 10, name: "NOLGIA SFX 3", lane: 1, role: "sfx" });
  record.tracks.push({ id: 11, name: "NOLGIA SFX 4", lane: 1, role: "sfx", released_at: "t" });
  record.tracks.push({ id: 12, name: "NOLGIA SFX 5", lane: 2, role: "sfx" });
  record.tracks.push({ id: null, name: "NOLGIA SFX 6", lane: 3, role: "sfx", pending_at: "t", after: 9 });
  record.cues.c1 = { status: "placed", track_id: 7, node_id: "n5", start_ticks: "0", end_ticks: "254270016001", in_ticks: "0", media_path: "C:\\P\\NOLGIA Sounds\\r1\\door.wav" };
  record.cues.c2 = { status: "placed", track_id: 12, node_id: "n6", start_ticks: "0", end_ticks: "500", in_ticks: "0", media_path: "C:\\P\\NOLGIA Sounds\\r1\\hit.wav" };
  const live = sd.liveRunTracks(
    record,
    {
      tracks: [
        // The run's clip is known by its file, start, end and in point (the node id changed on reopening).
        { id: 7, name: "SFX renamed", clips: [{ start: "0", end: "254270016001", in: "0", node_id: "n99", media: "c:/p/nolgia sounds/r1/DOOR.wav" }] },
        { id: 9, name: "x", clips: [] },
        // Same node id as the run's clip, but the editor's file: not the run's.
        { id: 10, name: "NOLGIA SFX 3", clips: [{ start: "0", end: "10", in: "0", node_id: "n5", media: "C:/media/mine.wav" }] },
        { id: 11, name: "NOLGIA SFX 4", clips: [] },
        // The run's clip, trimmed at its end by the editor: the editor's now, so the track is too.
        { id: 12, name: "NOLGIA SFX 5", clips: [{ start: "0", end: "400", in: "0", node_id: "n6", media: "C:/P/NOLGIA Sounds/r1/hit.wav" }] },
      ],
    },
    TB["23.976"]
  );
  assert.deepEqual(live, [{ id: 7, name: "SFX renamed", lane: 1, role: "sfx", busy: [[0, 25]] }]);
  assert.deepEqual(sd.activeTracks(record).map((x) => x.id), [7, 8, 10, 12], "not a track still waiting for Premiere's answer");
  assert.deepEqual(sd.pendingTracks(record).map((x) => x.name), ["NOLGIA SFX 6"]);
});

test("the record: repeat places nothing twice; remove marks what went out, so the run can go in again", () => {
  const record = sd.newRecord({ runId: "r1", project: "p", sequence: { id: "s", name: "Edit" }, folder: "f", bin: ["b"], now: "t0" });
  assert.equal(sd.parseRecord(JSON.parse(JSON.stringify(record)), "r1").run_id, "r1");
  assert.equal(sd.parseRecord(record, "r2"), null, "another run's record is not this one");
  assert.equal(sd.parseRecord({ version: 99, run_id: "r1" }, "r1"), null);
  record.cues.c1 = { status: "placed", track_id: 7 };
  record.cues.c2 = { status: "placed", track_id: 7 };
  record.cues.c3 = { status: "removed" };
  record.tracks.push({ id: 7, name: "NOLGIA SFX 1" });
  const split = sd.splitRepeat([{ cue_id: "c1" }, { cue_id: "c3" }, { cue_id: "c4" }], record);
  assert.deepEqual(split.already.map((x) => x.cue_id), ["c1"]);
  assert.deepEqual(split.todo.map((x) => x.cue_id), ["c3", "c4"]);
  assert.deepEqual(sd.placedCues(record).map((x) => x.cue_id), ["c1", "c2"]);
  record.tracks.push({ id: 8, name: "NOLGIA SFX 2" });
  sd.applyRemoval(record, { removed: ["c1"], missing: ["c2"], tracks_removed: [7], tracks_kept: [{ id: 8, name: "NOLGIA SFX 2" }] }, "t1");
  assert.equal(record.tracks[1].released_at, "t1", "a kept track is the editor's now");
  assert.deepEqual(sd.activeTracks(record), []);
  assert.equal(record.cues.c1.status, "removed");
  assert.equal(record.cues.c2.status, "left");
  assert.match(record.cues.c2.note, /not where NOLGIA placed it/);
  assert.equal(record.tracks[0].removed_at, "t1");
  assert.deepEqual(sd.placedCues(record), []);
  assert.deepEqual(sd.splitRepeat([{ cue_id: "c1" }], record).todo.map((x) => x.cue_id), ["c1"]);
  assert.equal(record.history[0].action, "remove");
});

test("remove matches a clip on the run's own track by name, start, end, in point and file, never by node id alone", () => {
  const record = sd.newRecord({ runId: "r1", project: "p", sequence: { id: "s", name: "Edit" }, folder: "f", bin: ["b"], now: "t0" });
  record.tracks.push({ id: 7, name: "NOLGIA SFX 1" }, { id: 8, name: "NOLGIA SFX 2" }, { id: 9, name: "NOLGIA Ambience" });
  const media = (name) => "C:\\P\\NOLGIA Sounds\\r1\\" + name + ".wav";
  const placed = (name, track, start, end, inTicks = "0") => ({ status: "placed", name, track_id: track, node_id: "x", start_ticks: start, end_ticks: end, in_ticks: inTicks, media_path: media(name.toLowerCase()) });
  record.cues.door = placed("Door", 7, "100", "200");
  record.cues.moved = placed("Whoosh", 7, "500", "600");
  record.cues.renamed = placed("Hit", 8, "100", "200");
  record.cues.gone = placed("Rain", 9, "0", "900");
  record.cues.trimmed = placed("Bell", 7, "1000", "1200"); // the editor trims its end to 1100
  record.cues.slipped = placed("Cup", 7, "2000", "2100", "50"); // the editor slips its media to 80
  record.cues.headcut = placed("Knock", 7, "3000", "3200"); // the editor trims its start to 3050
  const state = {
    tracks: [
      { id: 7, name: "NOLGIA SFX 1", clips: [
        // After reopening, node id "5" belongs to the editor's clip elsewhere; the door's is now "41".
        { start: "100", end: "200", in: "0", node_id: "41", media: media("door") },
        { start: "600", end: "700", in: "0", node_id: "6", media: media("whoosh") },
        { start: "1000", end: "1100", in: "0", node_id: "9", media: media("bell") },
        { start: "2000", end: "2100", in: "80", node_id: "10", media: media("cup") },
        { start: "3050", end: "3200", in: "50", node_id: "11", media: media("knock") },
      ] },
      { id: 8, name: "Hits (mine)", clips: [{ start: "100", end: "200", in: "0", node_id: "7", media: media("hit") }] },
    ],
  };
  const m = sd.matchRunClips(record, state);
  assert.deepEqual(m.clips, [{ key: "door", track_id: 7, track_name: "NOLGIA SFX 1", start: "100", end: "200", in: "0", media: media("door"), node_id: "41" }]);
  const why = Object.fromEntries(m.left.map((l) => [l.key, l.reason]));
  assert.deepEqual(m.left.map((l) => l.name), ["Whoosh", "Hit", "Rain", "Bell", "Cup", "Knock"], "each left one reported by its name");
  assert.match(why.moved, /not where NOLGIA placed it/);
  assert.match(why.renamed, /renamed to Hits \(mine\)/);
  assert.match(why.gone, /no longer in the sequence/);
  assert.match(why.trimmed, /trimmed or slipped .* editor's now/);
  assert.match(why.slipped, /trimmed or slipped .* editor's now/);
  assert.match(why.headcut, /trimmed or slipped .* editor's now/);
});

test("a place that ran out of time: its pending cues are settled by what is on the timeline", () => {
  const record = sd.newRecord({ runId: "r1", project: "p", sequence: { id: "s", name: "Edit" }, folder: "f", bin: ["b"], now: "t0" });
  record.tracks.push({ id: 7, name: "NOLGIA SFX 1" });
  const tpf = 10594584000n;
  const pending = (start, end, file) => ({ status: "pending", pending_at: "t0", track_id: 7, start_ticks: String(BigInt(start) * tpf), end_ticks: String(BigInt(end) * tpf), in_ticks: "0", media_path: "C:/P/" + file });
  record.cues.a = pending(10, 20, "a.wav");
  record.cues.b = pending(30, 40, "b.wav");
  record.cues.c = pending(50, 60, "c.wav");
  assert.deepEqual(sd.pendingCues(record).map((c) => c.cue_id), ["a", "b", "c"]);
  // Pending clips count as the run's on its track (a new sound may go next to them).
  assert.equal(sd.isRunClip(record, 7, { start: String(10n * tpf), end: String(20n * tpf), in: "0", media: "c:\\p\\A.wav" }), true);
  const got = sd.resolvePending(record, { tracks: [{ id: 7, name: "NOLGIA SFX 1", clips: [
    { start: String(10n * tpf), end: String(20n * tpf + 3n), in: "0", node_id: "n1", media: "C:\\P\\a.wav" }, // Premiere's rounding: still the cue
    { start: String(50n * tpf), end: String(55n * tpf), in: "0", node_id: "n3", media: "C:\\P\\c.wav" }, // trimmed since: the editor's
  ] }] }, "t1", TB["23.976"]);
  assert.deepEqual(got, { placed: 1, not_placed: 1, left: 1 });
  assert.equal(record.cues.a.status, "placed");
  assert.equal(record.cues.a.node_id, "n1");
  assert.equal(record.cues.a.end_ticks, String(20n * tpf + 3n), "the clip as Premiere has it");
  assert.equal(record.cues.b.status, "not_placed");
  assert.equal(record.cues.c.status, "left");
  assert.deepEqual(sd.splitRepeat([{ cue_id: "a" }, { cue_id: "b" }], record).todo.map((c) => c.cue_id), ["b"]);
});

test("tracks a place asked for but never heard back about are found by name after the tracks the sequence had", () => {
  const record = sd.newRecord({ runId: "r1", project: "p", sequence: { id: "s", name: "Edit" }, folder: "f", bin: ["b"], now: "t0" });
  record.tracks.push({ id: 7, name: "NOLGIA SFX 1", lane: 1, role: "sfx" });
  record.tracks.push({ id: null, name: "NOLGIA SFX 2", lane: 2, role: "sfx", pending_at: "t0", after: 4 });
  record.tracks.push({ id: null, name: "NOLGIA Ambience", lane: 1, role: "ambience", pending_at: "t0", after: 4 });
  const got = sd.resolvePendingTracks(record, { named: [
    { id: 3, index: 2, name: "NOLGIA Ambience", clips: [] }, // the editor's own track of that name, before NOLGIA's
    { id: 7, index: 4, name: "NOLGIA SFX 1", clips: [] },
    { id: 12, index: 5, name: "NOLGIA SFX 2", clips: [] },
  ] }, "t1");
  assert.deepEqual(got, { added: ["NOLGIA SFX 2"], none: ["NOLGIA Ambience"] });
  assert.deepEqual(sd.activeTracks(record).map((t) => [t.id, t.name]), [[7, "NOLGIA SFX 1"], [12, "NOLGIA SFX 2"]]);
  assert.equal(record.tracks[2].removed_at, "t1");
  assert.deepEqual(sd.pendingTracks(record), []);
});

test("the preview: long side 960, the in to out range or all, at most 10 minutes", () => {
  assert.deepEqual(sd.previewSize(1920, 1080), { width: 960, height: 540 });
  assert.deepEqual(sd.previewSize(1080, 1920), { width: 540, height: 960 });
  assert.deepEqual(sd.previewSize(4096, 2160), { width: 960, height: 506 });
  assert.deepEqual(sd.previewSize(640, 360), { width: 640, height: 360 }, "never larger than the sequence");
  const tps = 254016000000;
  const seq = { end: String(120 * tps), in: null, out: null };
  assert.deepEqual(sd.previewRange(seq, "auto"), { from: "sequence", start_ms: 0, end_ms: 120000, duration_ms: 120000, mode: "entire" });
  const marked = Object.assign({}, seq, { in: String(10 * tps), out: String(40 * tps) });
  assert.deepEqual(sd.previewRange(marked, "auto"), { from: "in_out", start_ms: 10000, end_ms: 40000, duration_ms: 30000, mode: "in_out" });
  assert.equal(sd.previewRange(marked, "sequence").duration_ms, 120000);
  assert.throws(() => sd.previewRange(seq, "in_out"), /no in and out points/);
  assert.throws(() => sd.previewRange({ end: String(11 * 60 * tps), in: null, out: null }, "auto"), /at most 10 minutes.*11 min 0 s/);
  assert.equal(sd.previewRange({ end: String(11 * 60 * tps), in: String(60 * tps), out: String(660 * tps) }, "auto").duration_ms, 600000);
});

test("the preview preset: Premiere's own H.264 preset with size, frame rate and bit rate written in", () => {
  const param = (id, value) =>
    '\t<ExporterParam ObjectID="1" ClassID="x" Version="1">\r\n\t\t<ParamIdentifier>' + id +
    "</ParamIdentifier>\r\n\t\t<ParamType>2</ParamType>\r\n\t\t<ParamValue>" + value + "</ParamValue>\r\n\t</ExporterParam>\r\n";
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\r\n<PremiereData Version="3">\r\n' +
    param("ADBEVideoAspect", "1,1") + param("ADBEVideoWidth", "854") + param("ADBEVideoHeight", "480") +
    param("ADBEVideoFPS", "8467200000") + param("ADBEVideoTargetBitrate", "0.8") + param("ADBEVideoMaxBitrate", "1.") +
    "</PremiereData>\r\n";
  const out = sd.previewPreset(xml, { width: 960, height: 540, timebase: TB["23.976"] });
  const value = (id) => new RegExp("<ParamIdentifier>" + id + "</ParamIdentifier>[\\s\\S]*?<ParamValue>([^<]*)<").exec(out)[1];
  assert.equal(value("ADBEVideoWidth"), "960");
  assert.equal(value("ADBEVideoHeight"), "540");
  assert.equal(value("ADBEVideoFPS"), "10594584000");
  assert.equal(value("ADBEVideoTargetBitrate"), "2");
  assert.equal(value("ADBEVideoMaxBitrate"), "3");
  assert.equal(value("ADBEVideoAspect"), "1,1", "other settings stay");
  assert.equal(out.split("\r\n").length, xml.split("\r\n").length, "line endings kept");
  assert.throws(() => sd.previewPreset("<PremiereData/>", { width: 2, height: 2, timebase: TB["25"] }), /no ADBEVideoWidth/);
});

test("local sources (tests only) must be full paths without ..", () => {
  assert.equal(sd.localSourceOk("C:\\sounds\\a.wav"), true);
  assert.equal(sd.localSourceOk("/Users/me/a.wav"), true);
  assert.equal(sd.localSourceOk("a.wav"), false);
  assert.equal(sd.localSourceOk("/Users/me/../../etc/a.wav"), false);
});
