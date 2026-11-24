// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Sound design in Premiere Pro (`sound_design`): the parts that need no app.
//
// NOLGIA watches a small preview of the sequence and writes a cue sheet. The
// plugin asks the plan's package route itself (format `manifest`, with its
// own sign-in): `files[]`, one per cue: a WAV `url` (a signed storage link
// on storage.googleapis.com), a relative `file` name, `start_ms` on the
// person's timeline (the route adds `timeline_offset_ms`), `source_in_ms` and
// `source_out_ms`, `gain_db`, `fade_in_ms`, `fade_out_ms`, `role` and `lane`
// (the route's lanes ignore the role: tracks are planned by role, then lane).
// The agent never hands the plugin a link: `place` takes the plan id, the
// package route's own choices (`picks`, `skip`) and placement-only
// `overrides`.
//
// One clock for the agent: every time it sends (an override's `start_ms`) or
// is told (a placed cue's `start_ms` and `end_ms`) is in the PLANNED VIDEO's
// time, the cue sheet's; the plugin adds `timeline_offset_ms` (where the
// preview starts in the sequence) itself.
//
// This module checks those, makes the names safe to write on Windows and
// macOS, turns milliseconds into frames and Premiere's ticks, plans which new
// audio track each sound goes on, works out the volume and fade keyframes,
// and keeps the record of what a run placed, so a repeated `place` places
// nothing twice and `remove` takes out exactly what it put in.
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
// A run id names a folder: letters, digits, dot, dash, underscore; it starts
// with a letter or digit and does not end with a dot (Windows drops it).
const RUN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,78}[A-Za-z0-9_-])?$/;
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OVERRIDE_KEYS = ["start_ms", "gain_db", "fade_in_ms", "fade_out_ms", "lane"];
const PICK_KEYS = ["sound_id", "asset_id", "gain_db", "fade_in_ms", "fade_out_ms"];
const MAX_OFFSET_MS = 24 * 3600 * 1000;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PREVIEW_MS = 10 * 60 * 1000; // the plan route watches at most 10 minutes
const PREVIEW_LONG_SIDE = 960;
const PREVIEW_MBPS = 2;
const MIN_GAIN_DB = -96;
const MAX_GAIN_DB = 15; // Premiere's Volume > Level goes no higher
// A package's gain outside this is not a level at all (it is refused, not held).
const MAX_PACKAGE_GAIN_DB = 200;
const MAX_FADE_MS = 600000;
// A cue may start at most this long after the sequence ends (a sound placed
// past the end is a mistake, not a tail).
const START_MARGIN_MS = 5000;
// Where the package's links may point: production signs its WAV links on
// Google Cloud Storage (V4 signed URLs on storage.googleapis.com). A setting:
// NOLGIA_SOUND_DOWNLOAD_HOSTS, comma separated, "host" or "host:port".
const DOWNLOAD_HOSTS = ["storage.googleapis.com"];
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
  if (action === "remove") {
    out.run_id = runIdArg(args.run_id);
    return out;
  }
  // place: the plugin asks the plan's package route itself; links never
  // come from the agent.
  for (const key of ["files", "url", "urls"]) {
    if (args[key] !== undefined && args[key] !== null) {
      fail("`place` takes no `" + key + "`: pass the plan's `plan_id`, and NOLGIA fetches the plan's sounds itself.");
    }
  }
  if (typeof args.plan_id !== "string" || !PLAN_ID.test(args.plan_id)) {
    fail("`plan_id` is required: the id of the finished sound design plan.");
  }
  out.plan_id = args.plan_id.toLowerCase();
  out.run_id = args.run_id === undefined || args.run_id === null || args.run_id === "" ? out.plan_id : runIdArg(args.run_id);
  if (args.timeline_offset_ms !== undefined && args.timeline_offset_ms !== null) {
    if (!finite(args.timeline_offset_ms) || args.timeline_offset_ms < 0 || args.timeline_offset_ms > MAX_OFFSET_MS) {
      fail("`timeline_offset_ms` must be a number of milliseconds from 0 to 24 hours (the preview's timeline_offset_ms).");
    }
    out.timeline_offset_ms = args.timeline_offset_ms;
  }
  out.picks = picksArg(args.picks);
  out.skip = skipArg(args.skip);
  out.overrides = overridesArg(args.overrides);
  // The end-to-end proof's way to fail a place right after its tracks are
  // added; honoured only in test mode (NOLGIA_SOUND_DESIGN_LOCAL=1).
  if (args.test_fail_after_tracks === true) out.test_fail_after_tracks = true;
  return out;
}

function runIdArg(value) {
  if (typeof value !== "string" || !RUN_ID.test(value) || RESERVED.test(value.split(".")[0])) {
    fail(
      "`run_id` must be letters, digits, dot, dash or underscore, at most 80, starting with a letter or digit, " +
        "not ending with a dot and not a device name such as CON (the sound design plan's id works)."
    );
  }
  return value;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cueIdKey(key, what) {
  if (!CUE_ID.test(key)) fail("`" + what + "` names cues by their id (s01, e03 ...); " + JSON.stringify(cut(key, 40)) + " is not one.");
}

function numberIn(value, key, lo, hi) {
  if (!finite(value) || value < lo || value > hi) fail("`" + key + "` must be a number from " + lo + " to " + hi + ".");
  return value;
}

// `picks`, as the package route takes it: cue id to {sound_id or asset_id,
// gain_db, fade_in_ms, fade_out_ms}. Checked here so a mistake is said in
// plain words before anything is asked.
function picksArg(value) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) fail("`picks` must be an object: cue id to the sound it takes.");
  const ids = Object.keys(value);
  if (ids.length > MAX_FILES) fail("`picks` names at most " + MAX_FILES + " cues.");
  const out = {};
  for (const id of ids) {
    cueIdKey(id, "picks");
    const pick = value[id];
    if (!plainObject(pick)) fail("`picks." + id + "` must be an object.");
    const p = {};
    for (const key of Object.keys(pick)) {
      if (!PICK_KEYS.includes(key)) fail("`picks." + id + "` takes only " + PICK_KEYS.join(", ") + ".");
    }
    if (pick.sound_id !== undefined) {
      if (typeof pick.sound_id !== "string" || !pick.sound_id || pick.sound_id.length > 128) fail("`picks." + id + ".sound_id` must be a Sound Library id.");
      p.sound_id = pick.sound_id;
    }
    if (pick.asset_id !== undefined) {
      if (typeof pick.asset_id !== "string" || !PLAN_ID.test(pick.asset_id)) fail("`picks." + id + ".asset_id` must be a Library asset id.");
      if (p.sound_id) fail("`picks." + id + "` names a sound_id or an asset_id, not both.");
      p.asset_id = pick.asset_id;
    }
    if (pick.gain_db !== undefined) p.gain_db = numberIn(pick.gain_db, "picks." + id + ".gain_db", -24, 12);
    if (pick.fade_in_ms !== undefined) p.fade_in_ms = numberIn(pick.fade_in_ms, "picks." + id + ".fade_in_ms", 0, 30000);
    if (pick.fade_out_ms !== undefined) p.fade_out_ms = numberIn(pick.fade_out_ms, "picks." + id + ".fade_out_ms", 0, 30000);
    out[id] = p;
  }
  return ids.length ? out : null;
}

function skipArg(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 200 || value.some((v) => typeof v !== "string")) {
    fail("`skip` must be a list of at most 200 cue ids.");
  }
  value.forEach((id) => cueIdKey(id, "skip"));
  return value.length ? Array.from(new Set(value)) : null;
}

// `overrides`: cue id to where and how loud it goes (start_ms, gain_db,
// fade_in_ms, fade_out_ms, lane). Placement only: never a link or a name.
// `start_ms` is in the planned video's time, like the cue sheet: the plugin
// adds timeline_offset_ms (packageCues).
function overridesArg(value) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) fail("`overrides` must be an object: cue id to {" + OVERRIDE_KEYS.join(", ") + "}.");
  const ids = Object.keys(value);
  if (ids.length > MAX_FILES) fail("`overrides` names at most " + MAX_FILES + " cues.");
  const out = {};
  for (const id of ids) {
    cueIdKey(id, "overrides");
    const o = value[id];
    if (!plainObject(o)) fail("`overrides." + id + "` must be an object.");
    const v = {};
    for (const key of Object.keys(o)) {
      if (!OVERRIDE_KEYS.includes(key)) fail("`overrides` change placement only (" + OVERRIDE_KEYS.join(", ") + "); `" + key + "` is not one.");
    }
    if (o.start_ms !== undefined) v.start_ms = numberIn(o.start_ms, "overrides." + id + ".start_ms", 0, MAX_OFFSET_MS);
    if (o.gain_db !== undefined) v.gain_db = numberIn(o.gain_db, "overrides." + id + ".gain_db", MIN_GAIN_DB, MAX_GAIN_DB);
    if (o.fade_in_ms !== undefined) v.fade_in_ms = numberIn(o.fade_in_ms, "overrides." + id + ".fade_in_ms", 0, MAX_FADE_MS);
    if (o.fade_out_ms !== undefined) v.fade_out_ms = numberIn(o.fade_out_ms, "overrides." + id + ".fade_out_ms", 0, MAX_FADE_MS);
    if (o.lane !== undefined) {
      if (!Number.isInteger(o.lane) || o.lane < 1 || o.lane > 64) fail("`overrides." + id + ".lane` must be a whole number from 1 to 64.");
      v.lane = o.lane;
    }
    out[id] = v;
  }
  return ids.length ? out : null;
}

// The package's `files`, checked one by one (a problem with one sound does
// not stop the others), with the agent's overrides applied. The package's
// start_ms is already on the timeline; an override's start_ms is in the
// planned video's time, so `offsetMs` (timeline_offset_ms) is added to it.
// `hosts` are where a link may point (downloadHosts). Resolves {cues,
// unknown: override ids the package has no cue for}.
function packageCues(files, overrides, { offsetMs = 0, hosts = DOWNLOAD_HOSTS } = {}) {
  if (!Array.isArray(files)) fail("NOLGIA's package for this plan has no list of sounds.");
  if (files.length > MAX_FILES) fail("The plan has more than " + MAX_FILES + " sounds; NOLGIA places at most that many in one run.");
  const seen = new Set();
  const cues = files.map((f, i) => {
    const cue = normalizeCue(f, i, { hosts });
    if (seen.has(cue.cue_id)) cue.problem = cue.problem || "The cue " + cue.cue_id + " is listed twice; only the first is placed.";
    seen.add(cue.cue_id);
    const o = overrides && overrides[cue.cue_id];
    if (o && !cue.problem) {
      for (const key of OVERRIDE_KEYS) {
        if (o[key] === undefined) continue;
        cue[key] = key === "start_ms" ? o[key] + offsetMs : o[key];
      }
      cue.overridden = Object.keys(o);
    }
    return cue;
  });
  const unknown = Object.keys(overrides || {}).filter((id) => !seen.has(id));
  return { cues, unknown };
}

// The hosts a package's links may point to: NOLGIA_SOUND_DOWNLOAD_HOSTS
// (comma separated, "host" or "host:port", lower case), else production's
// storage host. A port is allowed only when the entry names it.
function downloadHosts(setting) {
  const text = setting === undefined || setting === null ? "" : String(setting);
  const list = text.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DOWNLOAD_HOSTS.slice();
}

// Is `url` HTTPS on one of `hosts`, with no user name or password? Answers
// null when it is, else what is wrong (for a person).
function linkProblem(url, hosts = DOWNLOAD_HOSTS) {
  let u;
  try {
    u = new URL(String(url));
  } catch (e) {
    return "its link is not a web address";
  }
  if (u.protocol !== "https:") return "its link is not HTTPS";
  if (u.username || u.password) return "its link carries a user name or password";
  const host = u.hostname.toLowerCase();
  const ok = hosts.some((entry) => {
    const at = entry.lastIndexOf(":");
    const named = at > 0 && /^\d+$/.test(entry.slice(at + 1));
    return named ? entry.slice(0, at) === host && entry.slice(at + 1) === u.port : entry === host && u.port === "";
  });
  return ok ? null : "its link is not on a host NOLGIA downloads sounds from (" + u.host + ")";
}

// Credit lines from the package, trimmed.
function creditLines(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((c) => typeof c === "string").map((c) => c.trim()).filter(Boolean).slice(0, MAX_FILES).map((c) => cut(c, 500));
}

// One entry of `files`, checked. Keeps what can be read and says what is
// wrong in `problem` (the cue is then not placed). Every number is held to a
// range a sound can have (never 1e300): times within 24 hours, fades within
// 10 minutes, a gain within +-200 dB (Premiere's -96 to +15 is applied later).
function normalizeCue(f, index, { hosts = DOWNLOAD_HOSTS } = {}) {
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
    const wrong = linkProblem(f.url, hosts);
    if (wrong) problems.push(wrong);
  } else if (typeof f.path === "string" && f.path) {
    cue.path = f.path; // only taken in test mode (the controller checks)
  } else {
    problems.push("it has no url");
  }
  const within = (value, hi) => finite(value) && value >= 0 && value <= hi;
  if (within(f.bytes, Number.MAX_SAFE_INTEGER)) cue.bytes = f.bytes;
  if (within(f.duration_ms, MAX_OFFSET_MS)) cue.duration_ms = f.duration_ms;
  if (within(f.sample_rate, 768000)) cue.sample_rate = f.sample_rate;
  if (within(f.channels, 64)) cue.channels = f.channels;
  if (cue.bytes !== undefined && cue.bytes > MAX_FILE_BYTES) {
    problems.push("its file is " + Math.round(cue.bytes / 1048576) + " MB, more than the " + MAX_FILE_BYTES / 1048576 + " MB NOLGIA places");
  }
  if (!finite(f.start_ms) || f.start_ms < 0) problems.push("its start_ms is missing or before the sequence starts");
  else if (f.start_ms > MAX_OFFSET_MS) problems.push("its start_ms is more than 24 hours");
  else cue.start_ms = f.start_ms;
  if (finite(f.source_in_ms) && f.source_in_ms > MAX_OFFSET_MS) problems.push("its source_in_ms is more than 24 hours");
  cue.source_in_ms = within(f.source_in_ms, MAX_OFFSET_MS) ? f.source_in_ms : 0;
  if (within(f.source_out_ms, MAX_OFFSET_MS)) cue.source_out_ms = f.source_out_ms;
  else if (finite(f.source_out_ms) && f.source_out_ms > MAX_OFFSET_MS) problems.push("its source_out_ms is more than 24 hours");
  else if (cue.duration_ms !== undefined) cue.source_out_ms = cue.duration_ms;
  else problems.push("it has no source_out_ms");
  if (cue.duration_ms !== undefined && cue.source_out_ms !== undefined && cue.source_out_ms > cue.duration_ms) {
    cue.source_out_ms = cue.duration_ms;
  }
  if (cue.source_out_ms !== undefined && !(cue.source_out_ms > cue.source_in_ms)) problems.push("it ends before it starts");
  if (finite(f.gain_db) && Math.abs(f.gain_db) > MAX_PACKAGE_GAIN_DB) problems.push("its gain_db (" + f.gain_db + ") is not a level");
  cue.gain_db = finite(f.gain_db) && Math.abs(f.gain_db) <= MAX_PACKAGE_GAIN_DB ? f.gain_db : 0;
  for (const key of ["fade_in_ms", "fade_out_ms"]) {
    if (finite(f[key]) && f[key] > MAX_FADE_MS) problems.push("its " + key + " is more than 10 minutes");
    cue[key] = within(f[key], MAX_FADE_MS) && f[key] > 0 ? f[key] : 0;
  }
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

// A cue must start inside the sequence (plus a few seconds' margin): a
// sound placed far past the end is a mistake. Answers the reason, or null.
function startProblem(cue, sequenceEndMs) {
  const end = Number(sequenceEndMs);
  if (!Number.isFinite(end) || cue.start_ms <= end + START_MARGIN_MS) return null;
  return "Not placed: it would start at " + seconds(cue.start_ms) + " in the sequence, after the sequence ends (" + seconds(end) + ").";
}

function seconds(ms) {
  return Math.round(ms / 100) / 10 + " s";
}

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

function overlaps(busy, start, end) {
  for (const [s, e] of busy) if (start < e && s < end) return true;
  return false;
}

// Which track each cue goes on. `cues` carry `lane`, `role` and frames
// (`start`, `end`); `existing` are this run's tracks still in the sequence,
// [{id, name, lane, role, busy: [[startFrame, endFrame], ...]}] (what is on
// them now, whoever put it there); `trackNames` every audio track name in
// the sequence. Tracks are by ROLE, then lane: NOLGIA's package numbers
// lanes across all roles (an effect and an ambience can share lane 1 when
// they do not overlap), and an effect must never land on "NOLGIA Ambience".
// A cue goes on the first track of its role and lane with nothing at its
// time; when every one is busy there, a new track is added for that role
// and lane. New tracks come after all others (effects, ambience, music,
// voice; lane by lane), named "NOLGIA SFX 1", "NOLGIA Ambience" and so on,
// never a name the sequence already has.
// Resolves {tracks: [{key, id?, name, lane, role, isNew}], assign: {cue_id: key}}.
function planTracks(cues, { existing = [], trackNames = [] } = {}) {
  const groups = new Map();
  for (const c of cues) {
    const role = ROLES.includes(c.role) ? c.role : "sfx";
    const key = role + ":" + c.lane;
    if (!groups.has(key)) groups.set(key, { role, lane: c.lane, cues: [] });
    groups.get(key).cues.push(c);
  }
  const order = Array.from(groups.values()).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.lane - b.lane);
  const tracks = existing.map((t) => ({
    key: "id:" + t.id,
    id: t.id,
    name: t.name,
    lane: t.lane,
    role: ROLES.includes(t.role) ? t.role : "sfx",
    isNew: false,
    busy: (t.busy || []).map((b) => [b[0], b[1]]),
  }));
  const fresh = [];
  const assign = {};
  for (const group of order) {
    const { role, lane } = group;
    const groupCues = group.cues.slice().sort((a, b) => a.start - b.start || a.index - b.index);
    for (const c of groupCues) {
      let target = tracks.find((t) => t.role === role && t.lane === lane && !overlaps(t.busy, c.start, c.end));
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

// A media path as a key to compare: forward slashes, one Unicode form (NFC:
// Premiere on macOS may answer the decomposed form of a name written
// composed), case ignored (Windows and macOS ignore it).
function mediaKey(p) {
  return String(p === undefined || p === null ? "" : p).normalize("NFC").replace(/\\/g, "/").toLowerCase();
}

// Cues of a run that are on the timeline now (as far as the record knows).
function placedCues(record) {
  if (!record) return [];
  return Object.keys(record.cues)
    .filter((id) => record.cues[id].status === "placed")
    .map((id) => Object.assign({ cue_id: id }, record.cues[id]));
}

// Cues a `sd_place` was sent for whose answer never came back (the command
// ran out of time): on the timeline or not, as Premiere says now.
function pendingCues(record) {
  if (!record) return [];
  return Object.keys(record.cues)
    .filter((id) => record.cues[id].status === "pending")
    .map((id) => Object.assign({ cue_id: id }, record.cues[id]));
}

// Two tick values within half a frame of each other (`tolerance` ticks).
function nearTicks(a, b, tolerance) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  const d = BigInt(String(a).trim()) - BigInt(String(b).trim());
  return (d < 0n ? -d : d) <= tolerance;
}

// Settles pending cues against what is on the run's tracks now (`state` as
// for liveRunTracks): a clip of that file at that start on that track, with
// the end and in point NOLGIA asked for, is the cue, placed. One of that file
// at that start that the editor has since trimmed or slipped is left (the
// editor's now); anything else was not placed. `timebase` sets the half
// frame Premiere's rounding may add. Resolves how many of each.
function resolvePending(record, state, now, timebase = null) {
  const out = { placed: 0, not_placed: 0, left: 0 };
  if (!record) return out;
  const half = timebase ? frameTicks(timebase) / 2n : 0n;
  const found = new Map(((state && state.tracks) || []).map((t) => [String(t.id), t]));
  for (const c of pendingCues(record)) {
    const live = found.get(String(c.track_id));
    const clip = live && (live.clips || []).find((x) => String(x.start) === String(c.start_ticks) && mediaKey(x.media) === mediaKey(c.media_path));
    const cue = record.cues[c.cue_id];
    const asked = clip && nearTicks(clip.end, c.end_ticks, half) && (clip.in === undefined || nearTicks(clip.in, c.in_ticks, half));
    if (asked) {
      cue.status = "placed";
      cue.node_id = clip.node_id || null;
      cue.end_ticks = String(clip.end);
      if (clip.in !== undefined) cue.in_ticks = String(clip.in);
      cue.placed_at = cue.placed_at || now;
      cue.note = "Its placing took longer than the command; it was found on the timeline afterwards.";
      out.placed += 1;
    } else if (clip) {
      cue.status = "left";
      cue.left_at = now;
      cue.note = "Its placing took longer than the command, and it has been trimmed or slipped since, so it is the editor's now.";
      out.left += 1;
    } else {
      cue.status = "not_placed";
      cue.note = "Its placing took longer than the command and it is not on the timeline.";
      out.not_placed += 1;
    }
    delete cue.pending_at;
  }
  return out;
}

// Tracks a place asked Premiere to add whose answer never came back (or came
// back failed): written down with their names BEFORE the call, without an id.
function pendingTracks(record) {
  return record ? record.tracks.filter((t) => t.pending_at && !t.removed_at) : [];
}

// Settles pending tracks against the sequence's audio tracks now (`state`
// with `named`: [{id, index, name, clips}] for the names asked about): a
// track of that name after the tracks the sequence had when NOLGIA asked,
// not already one of the run's, is the one NOLGIA added; none means
// Premiere added none. Resolves {added: [names], none: [names]}.
function resolvePendingTracks(record, state, now) {
  const out = { added: [], none: [] };
  if (!record) return out;
  const named = (state && state.named) || [];
  for (const t of pendingTracks(record)) {
    const taken = new Set(record.tracks.filter((o) => o !== t && o.id !== null && o.id !== undefined).map((o) => String(o.id)));
    const live = named.find((n) => String(n.name) === String(t.name) && !taken.has(String(n.id)) && Number(n.index) > Number(t.after || 0));
    delete t.pending_at;
    if (live) {
      t.id = live.id;
      t.added_at = t.added_at || now;
      t.note = "Premiere Pro added it although its answer did not come back in time.";
      out.added.push(t.name);
    } else {
      t.removed_at = now;
      t.note = "Premiere Pro did not add it.";
      out.none.push(t.name);
    }
  }
  return out;
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

// The tracks a run added and still holds: not removed, not still waiting
// for Premiere's answer, and not handed over to the editor (a track
// `remove` kept because the editor put clips on it).
function activeTracks(record) {
  return record ? record.tracks.filter((t) => !t.removed_at && !t.released_at && !t.pending_at && t.id !== null && t.id !== undefined) : [];
}

// Is `clip` (the host's {start, end, in, media}) exactly as this run placed
// it, cue `c`? Its start, its end, its in point and its file all agree: a
// clip the editor trimmed at either end, slipped or moved is not (it is the
// editor's now). Never by Premiere's node id (node ids are not kept when a
// project is opened again).
function sameClip(c, clip) {
  return String(c.start_ticks) === String(clip.start) && String(c.end_ticks) === String(clip.end) &&
    (clip.in === undefined || String(c.in_ticks) === String(clip.in)) && mediaKey(c.media_path) === mediaKey(clip.media);
}

// Is `clip` one this run placed on track `trackId`, as it placed it?
function isRunClip(record, trackId, clip) {
  for (const id of Object.keys(record.cues)) {
    const c = record.cues[id];
    if ((c.status === "placed" || c.status === "pending") && String(c.track_id) === String(trackId) && sameClip(c, clip)) return true;
  }
  return false;
}

// The run's tracks that are still in the sequence, with what is on them now,
// for planTracks. `state` is the host's {tracks: [{id, name, clips: [{start,
// end, node_id, media}]}]} (ticks); tracks it no longer finds are left out,
// and so is a track holding any clip this run did not place (the editor's
// now: a new sound never goes on a track with someone else's clips).
function liveRunTracks(record, state, timebase) {
  if (!record) return [];
  const found = new Map((state.tracks || []).map((t) => [String(t.id), t]));
  const out = [];
  for (const t of activeTracks(record)) {
    const live = found.get(String(t.id));
    if (!live) continue;
    if ((live.clips || []).some((c) => !isRunClip(record, t.id, c))) continue;
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

// What `remove` may take out: each clip the run placed, found on the run's
// own track (same id, still carrying the name NOLGIA gave it), exactly as
// NOLGIA placed it: the same start, end, in point and file. A clip that does
// not agree on all of these (moved, trimmed at either end, slipped, renamed
// track) is left alone and reported by name. Resolves {clips: [{key,
// track_id, track_name, start, end, in, media}], left: [{key, name,
// reason}]}; `media` is the path exactly as Premiere answered it, and the
// host checks all of it again before removing.
function matchRunClips(record, state) {
  const found = new Map(((state && state.tracks) || []).map((t) => [String(t.id), t]));
  const names = {};
  for (const t of record.tracks) names[String(t.id)] = t.name;
  const clips = [];
  const left = [];
  for (const c of placedCues(record)) {
    const live = found.get(String(c.track_id));
    let reason = null;
    let clip = null;
    if (!live) reason = "its track (" + (names[String(c.track_id)] || c.track_name || "?") + ") is no longer in the sequence";
    else if (String(live.name) !== String(names[String(c.track_id)])) reason = "its track was renamed to " + live.name + ", so it is not NOLGIA's to change";
    else {
      clip = (live.clips || []).find((x) => sameClip(c, x));
      if (!clip) {
        const there = (live.clips || []).find((x) => mediaKey(x.media) === mediaKey(c.media_path) && (String(x.start) === String(c.start_ticks) || String(x.end) === String(c.end_ticks)));
        reason = there
          ? "it was trimmed or slipped on " + live.name + " since NOLGIA placed it, so it is the editor's now"
          : "it is not where NOLGIA placed it on " + live.name + " (moved, trimmed or deleted)";
      }
    }
    if (clip) {
      const entry = { key: c.cue_id, track_id: c.track_id, track_name: live.name, start: String(clip.start), end: String(clip.end), media: clip.media, node_id: clip.node_id || null };
      if (clip.in !== undefined) entry.in = String(clip.in);
      clips.push(entry);
    } else left.push({ key: c.cue_id, name: c.name || c.cue_id, reason });
  }
  return { clips, left };
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
      // Left alone (not where NOLGIA put it): no longer the run's to change.
      c.status = "left";
      c.left_at = now;
      c.note = "It was not where NOLGIA placed it when the run was taken out, so it was left in the sequence.";
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
  PLAN_ID,
  MIN_GAIN_DB,
  MAX_GAIN_DB,
  OVERRIDE_KEYS,
  packageCues,
  creditLines,
  mediaKey,
  pendingCues,
  resolvePending,
  pendingTracks,
  resolvePendingTracks,
  sameClip,
  isRunClip,
  matchRunClips,
  DOWNLOAD_HOSTS,
  START_MARGIN_MS,
  downloadHosts,
  linkProblem,
  startProblem,
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
