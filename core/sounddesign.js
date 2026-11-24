// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Sound design in Premiere Pro (`sound_design`): the parts that need no app.
//
// NOLGIA watches a small preview of the sequence and writes a cue sheet; its
// package route (format `manifest`) answers `files[]`, one per cue: a WAV
// `url`, a relative `file` name, `start_ms` on the person's timeline,
// `source_in_ms` and `source_out_ms`, `gain_db`, `fade_in_ms`, `fade_out_ms`,
// `role` and `lane`. This module checks those, makes the names safe to write
// on Windows and macOS, turns milliseconds into frames and Premiere's ticks,
// plans which new audio track each sound goes on, works out the volume and
// fade keyframes, and keeps the record of what a run placed, so a repeated
// `place` places nothing twice and `remove` takes out exactly what it put in.
//
// The numbers behind gain and fades were measured in Premiere Pro 26.2 on
// Windows (an exported mix of a -15.05 dBFS RMS tone): Volume > Level is
// 10^((dB - 15) / 20) (0, -6 and -12 dB measured -15.05, -21.05 and -27.05),
// and Level keyframe times are the clip's media time (its in point plus the
// offset), not sequence time.

"use strict";

const path = require("path");

const TICKS_PER_SECOND = 254016000000;
const TICKS_PER_MS = 254016000;
const ACTIONS = ["read", "preview", "place", "remove"];
const RANGES = ["auto", "sequence", "in_out"];
const ROLES = ["sfx", "ambience", "music", "voice"];
const ROLE_LABELS = { sfx: "SFX", ambience: "Ambience", music: "Music", voice: "Voice" };
const AUDIO_EXTS = [".wav", ".wave", ".aif", ".aiff", ".mp3", ".m4a"];
const SOUNDS_FOLDER = "NOLGIA Sounds";
const RECORD_FILE = "placement.json";
const CREDITS_FILE = "CREDITS.txt";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PREVIEW_MS = 10 * 60 * 1000; // the plan route watches at most 10 minutes
const PREVIEW_LONG_SIDE = 960;
const PREVIEW_MBPS = 2;
const MIN_GAIN_DB = -96;
const MAX_GAIN_DB = 15; // Premiere's Volume > Level goes no higher
const MAX_TEXT = 200;
const RECORD_VERSION = 1;

class SoundDesignError extends Error {
  constructor(message) {
    super(message);
    this.name = "SoundDesignError";
  }
}

function fail(message) {
  throw new SoundDesignError(message);
}

// ------------------------------------------------------------ time

// A sequence's frame length in ticks (Premiere's `sequence.timebase`), as a
// BigInt. Throws on anything that is not a positive whole number.
function frameTicks(timebase) {
  const text = String(timebase === undefined || timebase === null ? "" : timebase).trim();
  if (!/^[1-9][0-9]{0,15}$/.test(text)) fail("The sequence's frame length (" + text + ") is not a number of ticks.");
  return BigInt(text);
}

// Frames per second of a timebase, for people: 23.976, 25, 29.97, 59.94.
function fpsOf(timebase) {
  return Math.round((TICKS_PER_SECOND / Number(frameTicks(timebase))) * 1000) / 1000;
}

// The frame nearest to `ms` at this timebase.
function msToFrame(ms, timebase) {
  const tpf = Number(frameTicks(timebase));
  return Math.round((Number(ms) * TICKS_PER_MS) / tpf);
}

// A frame's start as Premiere's ticks, a decimal string (exact).
function frameToTicks(frame, timebase) {
  return (BigInt(Math.round(frame)) * frameTicks(timebase)).toString();
}

// `ms` on the frame grid of this timebase, as ticks.
function msToTicks(ms, timebase) {
  return frameToTicks(msToFrame(ms, timebase), timebase);
}

// Ticks (a string or number) as whole milliseconds.
function ticksToMs(ticks) {
  const t = BigInt(String(ticks).trim());
  const whole = t / BigInt(TICKS_PER_MS);
  const rest = t % BigInt(TICKS_PER_MS);
  return Number(whole) + Math.round(Number(rest) / TICKS_PER_MS);
}

// Ticks as frames (rounded down for a start, up for an end), for clips that
// may not sit on the frame grid.
function ticksToFrame(ticks, timebase, { up = false } = {}) {
  const t = BigInt(String(ticks).trim());
  const tpf = frameTicks(timebase);
  const q = t / tpf;
  return Number(up && t % tpf !== 0n && t > 0n ? q + 1n : q);
}

// ------------------------------------------------------------ names

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Bidirectional overrides and invisible characters, which can make a name
// read as something else ("evil‮vaw.exe").
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/g;
const NOT_ALLOWED = /[^\p{L}\p{M}\p{N} ._\-()[\],'&+!#@]/gu;
const MAX_STEM_CHARS = 100;
const MAX_STEM_BYTES = 180;

// The extension of a file name, lower case, when it is a sound Premiere
// imports; otherwise null.
function audioExtension(name) {
  const ext = path.posix.extname(String(name || "")).toLowerCase();
  return AUDIO_EXTS.includes(ext) ? ext : null;
}

// A file name to write on Windows and macOS from a name strangers wrote
// (sound library titles): only the last part of any path, no characters
// either system refuses or hides, no device names, no leading dots, at most
// 100 characters. Resolves {stem, ext}. Throws when it is not a sound file.
function safeSoundName(raw, fallback = "sound") {
  let name = String(raw === undefined || raw === null ? "" : raw).normalize("NFC");
  name = name.replace(INVISIBLE, "");
  name = name.split(/[\\/]/).pop();
  const ext = audioExtension(name);
  if (!ext) fail("“" + cut(name, 80) + "” is not a sound file NOLGIA places (" + AUDIO_EXTS.join(", ") + ").");
  let stem = name.slice(0, name.length - ext.length);
  stem = stem.replace(NOT_ALLOWED, "_").replace(/\s+/g, " ").replace(/_{2,}/g, "_");
  stem = stem.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  stem = clipStem(stem);
  if (!stem) stem = clipStem(String(fallback).replace(NOT_ALLOWED, "_").replace(/^[\s.]+|[\s.]+$/g, "")) || "sound";
  if (RESERVED.test(stem) || RESERVED.test(stem.split(".")[0])) stem = "_" + stem;
  return { stem, ext: ext === ".wave" ? ".wav" : ext === ".aif" ? ".aif" : ext };
}

function clipStem(stem) {
  let out = Array.from(stem).slice(0, MAX_STEM_CHARS).join("");
  while (Buffer.byteLength(out, "utf8") > MAX_STEM_BYTES) out = Array.from(out).slice(0, -1).join("");
  return out.replace(/[\s.]+$/, "");
}

// "stem.ext", or "stem (2).ext" and so on when the name is taken. `taken`
// holds lower-case names (Windows and macOS ignore case); the name chosen is
// added to it.
function uniqueName(stem, ext, taken) {
  let name = stem + ext;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = stem + " (" + n + ")" + ext;
  taken.add(name.toLowerCase());
  return name;
}

// A run's folder name: run ids are checked against RUN_ID already.
function runFolderName(runId) {
  return String(runId);
}

// ------------------------------------------------------------ arguments

function cut(text, n) {
  const s = String(text);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function optText(value, key, max = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail("`" + key + "` must be text.");
  return value.length > max ? value.slice(0, max) : value;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Check `sound_design` arguments. Problems with the command as a whole throw;
// a problem with one cue does not: that cue comes back with `problem` and is
// reported as not placed.
function validateArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("`args` must be an object.");
  const action = args.action === undefined || args.action === null || args.action === "" ? null : args.action;
  if (!ACTIONS.includes(action)) fail("`action` must be one of: " + ACTIONS.join(", ") + ".");
  const out = { action, sequence: optText(args.sequence, "sequence", 256) };
  if (action === "preview") {
    const range = args.range === undefined || args.range === null || args.range === "" ? "auto" : args.range;
    if (!RANGES.includes(range)) fail("`range` must be one of: " + RANGES.join(", ") + ".");
    out.range = range;
    return out;
  }
  if (action === "read") return out;
  out.run_id = runIdArg(args.run_id);
  if (action === "remove") return out;
  const files = args.files;
  if (!Array.isArray(files) || !files.length) {
    fail("`files` is required: the `files` list of NOLGIA's sound design package (format manifest).");
  }
  if (files.length > MAX_FILES) fail("`files` lists at most " + MAX_FILES + " sounds; place the rest with a second run.");
  const seen = new Set();
  out.files = files.map((f, i) => {
    const cue = normalizeCue(f, i);
    if (seen.has(cue.cue_id)) cue.problem = cue.problem || "The cue " + cue.cue_id + " is listed twice; only the first is placed.";
    seen.add(cue.cue_id);
    return cue;
  });
  const credits = args.credits;
  if (credits !== undefined && credits !== null) {
    if (!Array.isArray(credits) || credits.some((c) => typeof c !== "string")) fail("`credits` must be a list of text lines.");
    out.credits = credits.map((c) => c.trim()).filter(Boolean).slice(0, MAX_FILES).map((c) => cut(c, 500));
  } else {
    out.credits = [];
  }
  return out;
}

function runIdArg(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    fail("`run_id` is required: letters, digits, dot, dash or underscore, at most 80 (the sound design plan's id works).");
  }
  return value;
}

// One entry of `files`, checked. Keeps what can be read and says what is
// wrong in `problem` (the cue is then not placed).
function normalizeCue(f, index) {
  const cue = { index, cue_id: String(index + 1), problem: null };
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    cue.problem = "Entry " + (index + 1) + " of `files` is not an object.";
    return cue;
  }
  if (typeof f.cue_id === "string" || (typeof f.cue_id === "number" && Number.isFinite(f.cue_id))) {
    const id = String(f.cue_id).trim();
    if (id) cue.cue_id = cut(id, 128);
  }
  const problems = [];
  cue.name = typeof f.name === "string" ? cut(f.name.trim(), MAX_TEXT) : "";
  cue.file = typeof f.file === "string" ? f.file : "";
  if (!cue.file && cue.name) cue.file = cue.name + ".wav";
  if (typeof f.url === "string" && f.url) {
    cue.url = f.url;
    let u = null;
    try {
      u = new URL(f.url);
    } catch (e) {
      problems.push("its url is not a web address");
    }
    if (u && u.protocol !== "https:") problems.push("its url is not HTTPS");
    if (u && (u.username || u.password)) problems.push("its url carries a user name or password");
  } else if (typeof f.path === "string" && f.path) {
    cue.path = f.path; // only taken in test mode (the controller checks)
  } else {
    problems.push("it has no url");
  }
  for (const key of ["bytes", "duration_ms", "sample_rate", "channels"]) {
    if (finite(f[key]) && f[key] >= 0) cue[key] = f[key];
  }
  if (cue.bytes !== undefined && cue.bytes > MAX_FILE_BYTES) {
    problems.push("its file is " + Math.round(cue.bytes / 1048576) + " MB, more than the " + MAX_FILE_BYTES / 1048576 + " MB NOLGIA places");
  }
  if (!finite(f.start_ms) || f.start_ms < 0) problems.push("its start_ms is missing or before the sequence starts");
  else cue.start_ms = f.start_ms;
  cue.source_in_ms = finite(f.source_in_ms) && f.source_in_ms >= 0 ? f.source_in_ms : 0;
  if (finite(f.source_out_ms)) cue.source_out_ms = f.source_out_ms;
  else if (cue.duration_ms !== undefined) cue.source_out_ms = cue.duration_ms;
  else problems.push("it has no source_out_ms");
  if (cue.duration_ms !== undefined && cue.source_out_ms !== undefined && cue.source_out_ms > cue.duration_ms) {
    cue.source_out_ms = cue.duration_ms;
  }
  if (cue.source_out_ms !== undefined && !(cue.source_out_ms > cue.source_in_ms)) problems.push("it ends before it starts");
  cue.gain_db = finite(f.gain_db) ? f.gain_db : 0;
  cue.fade_in_ms = finite(f.fade_in_ms) && f.fade_in_ms > 0 ? f.fade_in_ms : 0;
  cue.fade_out_ms = finite(f.fade_out_ms) && f.fade_out_ms > 0 ? f.fade_out_ms : 0;
  cue.role = ROLES.includes(f.role) ? f.role : "sfx";
  cue.lane = Number.isInteger(f.lane) && f.lane >= 1 && f.lane <= 64 ? f.lane : 1;
  cue.credit = typeof f.credit === "string" ? cut(f.credit.trim(), 500) : "";
  cue.licence = typeof f.licence === "string" ? cut(f.licence.trim(), 100) : typeof f.license === "string" ? cut(f.license.trim(), 100) : "";
  if (!problems.length) {
    try {
      cue.safe = safeSoundName(cue.file, cue.name || "cue " + cue.cue_id);
    } catch (e) {
      problems.push(e.message.replace(/\.$/, "").replace(/^“/, "its file “"));
    }
  }
  if (problems.length) cue.problem = "Not placed: " + problems.join("; ") + ".";
  return cue;
}

// ------------------------------------------------------------ frames per cue

// Where a cue sits on the frame grid: start, length and source in point in
// frames, and the same as ticks. Null with a reason when it would be empty.
function cueFrames(cue, timebase) {
  const start = msToFrame(cue.start_ms, timebase);
  const inF = msToFrame(cue.source_in_ms, timebase);
  const outF = msToFrame(cue.source_out_ms, timebase);
  const length = outF - inF;
  if (length < 1) return { reason: "Not placed: it is shorter than one frame." };
  return {
    start,
    end: start + length,
    length,
    in: inF,
    start_ticks: frameToTicks(start, timebase),
    end_ticks: frameToTicks(start + length, timebase),
    in_ticks: frameToTicks(inF, timebase),
    out_ticks: frameToTicks(outF, timebase),
  };
}

// ------------------------------------------------------------ gain and fades

// Volume > Level for a gain in dB (Premiere: 10^((dB - 15) / 20); 0 dB is
// 0.1778). Gains outside -96 to +15 dB are held to that range.
function levelForGain(db) {
  const wanted = finite(db) ? db : 0;
  const held = Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, wanted));
  return { value: Math.pow(10, (held - 15) / 20), db: held, clamped: held !== wanted };
}

// Level keyframes for the fades, as [seconds of media time, level]: Premiere
// times a clip's keyframes from the start of its media, so the in point is
// added. Fades longer than the clip are shortened in proportion so that they
// meet. No fades: no keyframes (the level is set once).
function fadeKeys({ inSeconds, lengthSeconds, fadeInMs, fadeOutMs, level }) {
  let fi = Math.max(0, (fadeInMs || 0) / 1000);
  let fo = Math.max(0, (fadeOutMs || 0) / 1000);
  if (!(fi > 0) && !(fo > 0)) return { keys: [], fade_in_ms: 0, fade_out_ms: 0, shortened: false };
  let shortened = false;
  if (fi + fo > lengthSeconds) {
    const k = lengthSeconds / (fi + fo);
    fi *= k;
    fo *= k;
    shortened = true;
  }
  const a = inSeconds;
  const b = inSeconds + lengthSeconds;
  const keys = [];
  const add = (t, v) => {
    const last = keys[keys.length - 1];
    if (last && Math.abs(last[0] - t) < 1e-6) last[1] = Math.min(last[1], v);
    else keys.push([round6(t), v]);
  };
  if (fi > 0) {
    add(a, 0);
    add(a + fi, level);
  }
  if (fo > 0) {
    add(b - fo, level);
    add(b, 0);
  }
  return { keys, fade_in_ms: Math.round(fi * 1000), fade_out_ms: Math.round(fo * 1000), shortened };
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// ------------------------------------------------------------ tracks

function trackLabel(role) {
  return ROLE_LABELS[role] || "SFX";
}

// The role a lane's track is named for: the role most of its cues have
// (SFX when tied).
function laneRole(cues) {
  const count = {};
  for (const c of cues) count[c.role] = (count[c.role] || 0) + 1;
  let best = "sfx";
  for (const role of ROLES) if ((count[role] || 0) > (count[best] || 0)) best = role;
  return best;
}

function overlaps(busy, start, end) {
  for (const [s, e] of busy) if (start < e && s < end) return true;
  return false;
}

// Which track each cue goes on. `cues` carry `lane`, `role` and frames
// (`start`, `end`); `existing` are this run's tracks still in the sequence,
// [{id, name, lane, role, busy: [[startFrame, endFrame], ...]}] (what is on
// them now, whoever put it there); `trackNames` every audio track name in
// the sequence. A cue goes on the first track of its lane with nothing at
// its time; when every one is busy there, a new track is added for that
// lane. New tracks come after all others, lane by lane, named "NOLGIA SFX 1",
// "NOLGIA Ambience" and so on, never a name the sequence already has.
// Resolves {tracks: [{key, id?, name, lane, role, isNew}], assign: {cue_id: key}}.
function planTracks(cues, { existing = [], trackNames = [] } = {}) {
  const byLane = new Map();
  for (const c of cues) {
    if (!byLane.has(c.lane)) byLane.set(c.lane, []);
    byLane.get(c.lane).push(c);
  }
  const lanes = Array.from(byLane.keys()).sort((a, b) => a - b);
  const tracks = existing.map((t) => ({
    key: "id:" + t.id,
    id: t.id,
    name: t.name,
    lane: t.lane,
    role: t.role,
    isNew: false,
    busy: (t.busy || []).map((b) => [b[0], b[1]]),
  }));
  const fresh = [];
  const assign = {};
  for (const lane of lanes) {
    const laneCues = byLane.get(lane).slice().sort((a, b) => a.start - b.start || a.index - b.index);
    const role = laneRole(laneCues);
    for (const c of laneCues) {
      let target = tracks.find((t) => t.lane === lane && !overlaps(t.busy, c.start, c.end));
      if (!target) {
        target = { key: "new:" + fresh.length, name: null, lane, role, isNew: true, busy: [] };
        tracks.push(target);
        fresh.push(target);
      }
      target.busy.push([c.start, c.end]);
      assign[c.cue_id] = target.key;
    }
  }
  nameTracks(fresh, tracks.filter((t) => !t.isNew).map((t) => t.name).concat(trackNames));
  return {
    tracks: tracks.filter((t) => t.isNew || Object.values(assign).includes(t.key)).map((t) => {
      const out = { key: t.key, name: t.name, lane: t.lane, role: t.role, isNew: t.isNew };
      if (t.id !== undefined) out.id = t.id;
      return out;
    }),
    assign,
  };
}

// Names for new tracks: "NOLGIA SFX 1", "NOLGIA SFX 2" (SFX are always
// numbered), "NOLGIA Ambience" (others only when there are several), and
// never a name already in `taken`.
function nameTracks(fresh, taken) {
  const used = new Set(taken.filter(Boolean).map((n) => String(n).toLowerCase()));
  const perLabel = {};
  for (const t of fresh) perLabel[trackLabel(t.role)] = (perLabel[trackLabel(t.role)] || 0) + 1;
  const counter = {};
  for (const t of fresh) {
    const label = trackLabel(t.role);
    const numbered = label === "SFX" || perLabel[label] > 1;
    let n = counter[label] || 0;
    let name;
    for (;;) {
      n += 1;
      name = numbered || n > 1 ? "NOLGIA " + label + " " + n : "NOLGIA " + label;
      if (!used.has(name.toLowerCase())) break;
    }
    counter[label] = n;
    used.add(name.toLowerCase());
    t.name = name;
  }
}

// ------------------------------------------------------------ the record

// The record a run keeps beside its sounds (`placement.json`): which
// sequence, which tracks it added, and per cue the clip it placed.
function newRecord({ runId, project, sequence, folder, bin, now }) {
  return {
    version: RECORD_VERSION,
    run_id: runId,
    created_at: now,
    updated_at: now,
    project,
    sequence: { id: sequence.id, name: sequence.name },
    folder,
    bin,
    tracks: [],
    cues: {},
    credits: [],
    history: [],
  };
}

// A record read from disk, or null when it is not one of ours.
function parseRecord(value, runId) {
  if (!value || typeof value !== "object" || value.version !== RECORD_VERSION || value.run_id !== runId) return null;
  if (!value.sequence || typeof value.cues !== "object" || !Array.isArray(value.tracks)) return null;
  value.credits = Array.isArray(value.credits) ? value.credits : [];
  value.history = Array.isArray(value.history) ? value.history : [];
  return value;
}

// Cues of a run that are on the timeline now (as far as the record knows).
function placedCues(record) {
  if (!record) return [];
  return Object.keys(record.cues)
    .filter((id) => record.cues[id].status === "placed")
    .map((id) => Object.assign({ cue_id: id }, record.cues[id]));
}

// Splits `cues` of a place into those to place now and those the run
// already placed (a repeated place places nothing twice).
function splitRepeat(cues, record) {
  const todo = [];
  const already = [];
  for (const c of cues) {
    const was = record && record.cues[c.cue_id];
    if (was && was.status === "placed") already.push(c);
    else todo.push(c);
  }
  return { todo, already };
}

// The tracks a run added and still holds: not removed, and not handed over
// to the editor (a track `remove` kept because the editor put clips on it).
function activeTracks(record) {
  return record ? record.tracks.filter((t) => !t.removed_at && !t.released_at) : [];
}

// The run's tracks that are still in the sequence, with what is on them now,
// for planTracks. `state` is the host's {tracks: [{id, name, clips: [{start,
// end, node_id}]}]} (ticks); tracks it no longer finds are left out, and so
// is a track holding any clip this run did not place (the editor's now: a
// new sound never goes on a track with someone else's clips).
function liveRunTracks(record, state, timebase) {
  if (!record) return [];
  const found = new Map((state.tracks || []).map((t) => [String(t.id), t]));
  const ours = new Set(placedCues(record).map((c) => String(c.node_id)));
  const out = [];
  for (const t of activeTracks(record)) {
    const live = found.get(String(t.id));
    if (!live) continue;
    if ((live.clips || []).some((c) => !ours.has(String(c.node_id)))) continue;
    out.push({
      id: t.id,
      name: live.name || t.name,
      lane: t.lane,
      role: t.role,
      busy: (live.clips || []).map((c) => [ticksToFrame(c.start, timebase), ticksToFrame(c.end, timebase, { up: true })]),
    });
  }
  return out;
}

function noteHistory(record, entry) {
  record.history.push(entry);
  if (record.history.length > 50) record.history.splice(0, record.history.length - 50);
}

// After `remove`: the clips taken out are marked removed (so the run can be
// placed again), the tracks Premiere let go of are marked removed.
function applyRemoval(record, outcome, now) {
  const removed = new Set(outcome.removed || []);
  const gone = new Set(outcome.missing || []);
  for (const id of Object.keys(record.cues)) {
    const c = record.cues[id];
    if (c.status !== "placed") continue;
    if (removed.has(id)) {
      c.status = "removed";
      c.removed_at = now;
    } else if (gone.has(id)) {
      c.status = "removed";
      c.removed_at = now;
      c.note = "It was no longer on the timeline when the run was taken out.";
    }
  }
  const tracksRemoved = new Set((outcome.tracks_removed || []).map(String));
  const tracksKept = new Set((outcome.tracks_kept || []).map((k) => String(k.id)));
  for (const t of record.tracks) {
    if (tracksRemoved.has(String(t.id))) t.removed_at = now;
    else if (tracksKept.has(String(t.id))) t.released_at = now; // the editor's now
  }
  record.updated_at = now;
  noteHistory(record, {
    at: now,
    action: "remove",
    removed: removed.size,
    missing: gone.size,
    tracks_removed: tracksRemoved.size,
  });
  return record;
}

// ------------------------------------------------------------ preview

// The size of the preview: the long side 960 px (even numbers, as H.264
// needs), the sequence's shape kept.
function previewSize(width, height) {
  const w = Math.max(2, Number(width) || 1920);
  const h = Math.max(2, Number(height) || 1080);
  const scale = Math.min(1, PREVIEW_LONG_SIDE / Math.max(w, h));
  const even = (n) => Math.max(2, 2 * Math.round((n * scale) / 2));
  return { width: even(w), height: even(h) };
}

// Premiere's H.264 preset with the frame size, frame rate and bit rate of
// the preview written in. `xml` is one of Premiere's own .epr presets
// (Mobile Device 480p SD Wide). Throws when a setting is not where it should be.
function previewPreset(xml, { width, height, timebase, mbps = PREVIEW_MBPS }) {
  let text = String(xml);
  const set = (ident, value) => {
    const re = new RegExp(
      "(<ExporterParam\\b[^>]*>(?:(?!</ExporterParam>)[\\s\\S])*?<ParamIdentifier>" + ident +
        "</ParamIdentifier>(?:(?!</ExporterParam>)[\\s\\S])*?<ParamValue>)([^<]*)(</ParamValue>)"
    );
    if (!re.test(text)) fail("Premiere Pro's H.264 preset has no " + ident + " setting NOLGIA can change.");
    text = text.replace(re, (m, a, b, c) => a + value + c);
  };
  set("ADBEVideoWidth", String(width));
  set("ADBEVideoHeight", String(height));
  set("ADBEVideoFPS", frameTicks(timebase).toString());
  set("ADBEVideoTargetBitrate", String(mbps));
  set("ADBEVideoMaxBitrate", String(mbps * 1.5));
  return text;
}

// The part of the sequence the preview shows. `seq` holds ticks strings:
// end, and in and out (null when not set). `range` is auto (the in and out
// when both are set, else all), sequence or in_out.
function previewRange(seq, range) {
  const end = ticksToMs(seq.end);
  const hasInOut = seq.in !== null && seq.in !== undefined && seq.out !== null && seq.out !== undefined &&
    BigInt(seq.out) > BigInt(seq.in);
  if (range === "in_out" && !hasInOut) {
    fail("The sequence has no in and out points. Mark an in and an out on the timeline, or ask for the whole sequence.");
  }
  const useInOut = range === "in_out" || (range === "auto" && hasInOut);
  const start = useInOut ? ticksToMs(seq.in) : 0;
  const stop = useInOut ? ticksToMs(seq.out) : end;
  const duration = stop - start;
  if (duration <= 0) fail("The sequence is empty: there is nothing to watch.");
  if (duration > MAX_PREVIEW_MS) {
    fail(
      "NOLGIA plans the sound for at most 10 minutes at a time, and this " + (useInOut ? "in to out range" : "sequence") +
        " is " + minutes(duration) + ". Mark an in and an out around up to 10 minutes and do the sound design part by part."
    );
  }
  return { from: useInOut ? "in_out" : "sequence", start_ms: start, end_ms: stop, duration_ms: duration, mode: useInOut ? "in_out" : "entire" };
}

function minutes(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + " min " + s + " s";
}

// ------------------------------------------------------------ downloads

// Does the start of a file look like the sound its name says? (A download
// link that answers an HTML page must not be imported as a .wav.)
function looksLikeAudio(head, ext) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const ascii = (from, to) => b.slice(from, to).toString("latin1");
  if (ext === ".wav" || ext === ".wave") return (ascii(0, 4) === "RIFF" || ascii(0, 4) === "RF64") && ascii(8, 12) === "WAVE";
  if (ext === ".aif" || ext === ".aiff") return ascii(0, 4) === "FORM" && /^AIF[FC]$/.test(ascii(8, 12));
  if (ext === ".mp3") return ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (ext === ".m4a") return ascii(4, 8) === "ftyp";
  return false;
}

// A local path given in test mode (NOLGIA_SOUND_DESIGN_LOCAL=1): absolute,
// no ".." parts.
function localSourceOk(p) {
  const text = String(p || "");
  if (!text || text.split(/[\\/]/).includes("..")) return false;
  return path.isAbsolute(text) || path.win32.isAbsolute(text);
}

module.exports = {
  TICKS_PER_SECOND,
  ACTIONS,
  RANGES,
  ROLES,
  AUDIO_EXTS,
  SOUNDS_FOLDER,
  RECORD_FILE,
  CREDITS_FILE,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_PREVIEW_MS,
  SoundDesignError,
  frameTicks,
  fpsOf,
  msToFrame,
  frameToTicks,
  msToTicks,
  ticksToMs,
  ticksToFrame,
  audioExtension,
  safeSoundName,
  uniqueName,
  runFolderName,
  validateArgs,
  normalizeCue,
  cueFrames,
  levelForGain,
  fadeKeys,
  planTracks,
  newRecord,
  parseRecord,
  placedCues,
  splitRepeat,
  liveRunTracks,
  activeTracks,
  noteHistory,
  applyRemoval,
  previewSize,
  previewPreset,
  previewRange,
  looksLikeAudio,
  localSourceOk,
};
