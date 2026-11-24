// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// `sound_design` in Premiere Pro: read the sequence, make the preview NOLGIA
// watches, place a package's sounds on new audio tracks, take a run out.
// The app side is host/ppro.jsx (sd_*); the rules are core/sounddesign.js.
//
// Nothing the editor made is changed: the sounds go on NEW audio tracks
// after all others, never on a track with clips on it. Premiere's scripting
// has no undo group, so before anything changes the project is saved in
// place and copied into NOLGIA backups next to it, and `remove` takes out
// exactly the clips and tracks a run added (its record, placement.json,
// sits beside the sounds in NOLGIA Sounds/<run> next to the project).

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const sd = require("./sounddesign");
const util = require("./util");
const work = require("./work");
const { CommandError } = require("./commands");
const { ApiError, NetworkError } = require("./api");
const { readJson, writeJson } = require("./settings");

const UNSAVED =
  "This project has never been saved. Save it first (File > Save): NOLGIA keeps the sounds in a folder next to " +
  "the project file, and backs the project up there before it changes anything.";

// `helpers.waitForFile` comes from the controller (no circular require).
async function soundDesign(ctl, command, api, helpers) {
  const action = command.args.action;
  try {
    if (action === "read") return await read(ctl, command);
    if (action === "preview") return await preview(ctl, command, api, helpers);
    if (action === "place") return await place(ctl, command, api);
    if (action === "remove") return await remove(ctl, command);
  } catch (err) {
    if (err instanceof sd.SoundDesignError) throw new CommandError(err.message);
    throw err;
  }
  throw new CommandError("`action` must be one of: " + sd.ACTIONS.join(", ") + ".");
}

// ------------------------------------------------------------ read

async function read(ctl, command) {
  const raw = await ctl.hostOrFail("sd_read", { sequence: command.args.sequence }, command);
  const runs = raw.project ? runsBeside(raw.project) : [];
  return readView(raw, runs);
}

// The sound design runs recorded next to `projectFile`: [{run_id, sequence,
// tracks: [{id, name}], placed}].
function runsBeside(projectFile) {
  const root = path.join(path.dirname(projectFile), sd.SOUNDS_FOLDER);
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, 200)) {
    const rec = sd.parseRecord(readJson(path.join(root, name, sd.RECORD_FILE)), name);
    if (!rec) continue;
    out.push({
      run_id: rec.run_id,
      sequence: rec.sequence,
      tracks: sd.activeTracks(rec).map((t) => ({ id: t.id, name: t.name })),
      placed: sd.placedCues(rec).length,
      folder: path.join(root, name),
    });
  }
  return out;
}

// The host's read (ticks) as milliseconds and frames, with which audio
// tracks are empty and which ones a NOLGIA run added.
function readView(raw, runs = []) {
  const s = raw.sequence;
  const tb = s.timebase;
  const ms = (t) => (t === null || t === undefined ? null : sd.ticksToMs(t));
  const frame = (t) => sd.ticksToFrame(t, tb);
  const seqRuns = runs.filter((r) => r.sequence && String(r.sequence.id) === String(s.id));
  const runOfTrack = {};
  for (const r of seqRuns) for (const t of r.tracks) runOfTrack[String(t.id)] = r.run_id;
  const clipView = (c) => {
    const v = {
      name: c.name,
      start_ms: ms(c.start),
      end_ms: ms(c.end),
      in_ms: ms(c.in),
      out_ms: ms(c.out),
      start_frame: frame(c.start),
      end_frame: frame(c.end),
      media_path: c.media || null,
      enabled: c.enabled !== false,
    };
    if (c.kind && c.kind !== "clip") v.kind = c.kind;
    return v;
  };
  const trackView = (t, letter) => {
    const v = { track: letter + t.index, index: t.index, id: t.id, name: t.name, locked: Boolean(t.locked) };
    if (t.muted !== undefined && t.muted !== null) v.muted = Boolean(t.muted);
    v.clips = (t.clips || []).map(clipView);
    v.empty = v.clips.length === 0;
    if (runOfTrack[String(t.id)]) v.nolgia_run = runOfTrack[String(t.id)];
    return v;
  };
  const video = (raw.video_tracks || []).map((t) => trackView(t, "V"));
  const audio = (raw.audio_tracks || []).map((t) => trackView(t, "A"));
  const view = {
    project: raw.project || null,
    sequence: {
      name: s.name,
      id: s.id,
      fps: sd.fpsOf(tb),
      timebase_ticks: String(tb),
      width: s.width,
      height: s.height,
      duration_ms: ms(s.end),
      frames: frame(s.end),
      in_ms: ms(s.in),
      out_ms: ms(s.out),
    },
    video_tracks: video,
    audio_tracks: audio,
    empty_audio_tracks: audio.filter((t) => t.empty).map((t) => t.track),
    markers: (raw.markers || []).map((m) => ({
      name: m.name || "",
      start_ms: ms(m.start),
      end_ms: ms(m.end),
      type: m.type || "",
      comment: m.comment || "",
    })),
    nolgia_runs: seqRuns.map((r) => ({ run_id: r.run_id, tracks: r.tracks.map((t) => t.name), placed: r.placed, folder: r.folder })),
  };
  if (raw.truncated) view.truncated = "The sequence has more clips than NOLGIA lists; the first " + raw.truncated + " are here.";
  return view;
}

// ------------------------------------------------------------ preview

async function preview(ctl, command, api, helpers) {
  const a = command.args;
  const info = await ctl.hostOrFail("sd_preview_info", { sequence: a.sequence }, command);
  const seq = info.sequence;
  const range = sd.previewRange(seq, a.range);
  if (!info.preset) {
    throw new CommandError("Premiere Pro's H.264 presets were not found (looked for " + (info.looked || "MediaIO/systempresets") + ").");
  }
  const size = sd.previewSize(seq.width, seq.height);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "nolgia-sound-preview-"));
  try {
    const preset = path.join(folder, "NOLGIA sound preview.epr");
    fs.writeFileSync(preset, sd.previewPreset(fs.readFileSync(info.preset, "utf8"), Object.assign({ timebase: seq.timebase }, size)), "utf8");
    const stem = util.safeFilename(seq.name, "sequence") + " sound preview";
    const file = path.join(folder, stem + ".mp4");
    const out = await ctl.hostOrFail("sd_export_preview", { sequence: seq.id, preset, file, mode: range.mode }, command);
    const done = await helpers.waitForFile(out.path || file, Math.max(5, command.remaining()));
    const bytes = fs.statSync(done).size;
    const asset = await ctl.upload(api, done, "video/mp4", { filename: path.basename(done), displayName: path.basename(done) });
    return {
      asset_id: asset.id,
      filename: path.basename(done),
      bytes,
      sequence: seq.name,
      sequence_id: seq.id,
      range: { from: range.from, start_ms: range.start_ms, end_ms: range.end_ms, duration_ms: range.duration_ms },
      timeline_offset_ms: range.start_ms,
      width: size.width,
      height: size.height,
      fps: sd.fpsOf(seq.timebase),
    };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ place

function today(seconds) {
  const d = new Date(seconds * 1000);
  const two = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
}

function isoTime(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runPaths(projectFile, runId) {
  const folder = path.join(path.dirname(projectFile), sd.SOUNDS_FOLDER, sd.runFolderName(runId));
  return { folder, record: path.join(folder, sd.RECORD_FILE), credits: path.join(folder, sd.CREDITS_FILE) };
}

function readRecord(file, runId) {
  if (!fs.existsSync(file)) return null;
  const rec = sd.parseRecord(readJson(file), runId);
  if (!rec) throw new CommandError("NOLGIA cannot read the record of run " + runId + " (" + file + "); it changed nothing.");
  return rec;
}

// Save in place, then a byte copy into NOLGIA backups next to the project:
// the project exactly as it was before NOLGIA's change. Throws (and nothing
// changes) when either fails.
async function saveAndBackUp(ctl, command, projectFile, label) {
  try {
    await ctl.hostOrFail("save", {}, command);
  } catch (err) {
    throw new CommandError("NOLGIA could not save the project before changing it (" + err.message + "), so it changed nothing.");
  }
  try {
    const backup = work.backupProject(projectFile, ctl.documentsDir(), ctl.clock(), label);
    ctl.log("Backed up " + path.basename(projectFile) + " before " + label + ": " + backup + ".");
    return backup;
  } catch (err) {
    throw new CommandError("NOLGIA could not back up the project (" + err.message + "), so it changed nothing.");
  }
}

async function place(ctl, command, api) {
  const a = command.args;
  const localOk = ctl.env.NOLGIA_SOUND_DESIGN_LOCAL === "1";
  const pf = await ctl.hostOrFail("project_file", {}, command);
  if (!pf.path) throw new CommandError(UNSAVED);
  const paths = runPaths(pf.path, a.run_id);
  let record = readRecord(paths.record, a.run_id);
  const state = await ctl.hostOrFail(
    "sd_state",
    { sequence: a.sequence, track_ids: sd.activeTracks(record).map((t) => t.id) },
    command
  );
  const seq = state.sequence;
  if (record && String(record.sequence.id) !== String(seq.id) && sd.placedCues(record).length) {
    throw new CommandError(
      "Run " + a.run_id + " is placed on the sequence " + record.sequence.name + ", not " + seq.name +
        ". Take it out there first (action remove), or place the sounds with a new run_id."
    );
  }
  const report = {};
  const say = (cue, status, reason, extra = {}) => {
    report[cue.cue_id] = Object.assign({ cue_id: cue.cue_id, name: cue.name || cue.cue_id, status }, reason ? { reason } : {}, extra);
  };

  // What can be placed: checked, on the frame grid, not placed by this run before.
  const ready = [];
  for (const cue of a.files) {
    if (report[cue.cue_id]) continue; // listed twice
    if (cue.problem) {
      say(cue, "not_placed", cue.problem);
      continue;
    }
    if (cue.path && !cue.url && !localOk) {
      say(cue, "not_placed", "Not placed: it has no url (a local path is only taken in NOLGIA's tests).");
      continue;
    }
    if (cue.path && !sd.localSourceOk(cue.path)) {
      say(cue, "not_placed", "Not placed: its path is not a full path.");
      continue;
    }
    const frames = sd.cueFrames(cue, seq.timebase);
    if (frames.reason) {
      say(cue, "not_placed", frames.reason);
      continue;
    }
    ready.push(Object.assign(cue, frames));
  }
  const split = sd.splitRepeat(ready, record);
  for (const cue of split.already) {
    const was = record.cues[cue.cue_id];
    say(cue, "already_placed", "This run placed it before (" + was.track_name + " at " + sd.ticksToMs(was.start_ticks) + " ms); it is not placed twice.");
  }
  const result = {
    run_id: a.run_id,
    sequence: seq.name,
    sequence_id: seq.id,
    folder: paths.folder,
    repeated: Boolean(record),
  };
  if (!split.todo.length) return finishReport(result, a.files, report, record, null);

  // The sounds, into NOLGIA Sounds/<run> next to the project.
  fs.mkdirSync(paths.folder, { recursive: true });
  const fetched = await fetchSounds(ctl, api, split.todo, paths.folder, record, localOk, say, command);
  const todo = split.todo.filter((c) => fetched.has(c.cue_id));
  if (!todo.length) return finishReport(result, a.files, report, record, null);

  // Saved and backed up before anything in the project changes.
  const now = ctl.clock();
  const backup = await saveAndBackUp(ctl, command, pf.path, "sound design " + a.run_id);
  result.backup = backup;
  if (!record) {
    record = sd.newRecord({
      runId: a.run_id,
      project: pf.path,
      sequence: { id: seq.id, name: seq.name },
      folder: paths.folder,
      bin: ["NOLGIA imports", "Sound design", today(now) + " " + a.run_id.slice(0, 8).replace(/[._-]+$/, "")],
      now: isoTime(now),
    });
  }
  record.sequence = { id: seq.id, name: seq.name };
  try {
    // Into the run's own bin.
    const imported = await ctl.hostOrFail("sd_import", { paths: Array.from(new Set(todo.map((c) => fetched.get(c.cue_id)))), bin_path: record.bin }, command);
    result.bin = imported.bin;
    const missing = new Set((imported.missing || []).map((p) => work.pathKey(p)));
    const placeable = [];
    for (const c of todo) {
      if (missing.has(work.pathKey(fetched.get(c.cue_id)))) say(c, "not_placed", "Not placed: Premiere Pro did not import " + path.basename(fetched.get(c.cue_id)) + ".");
      else placeable.push(c);
    }
    // New tracks after all others, one per lane (more where sounds overlap).
    const existing = sd.liveRunTracks(record, state, seq.timebase);
    const plan = sd.planTracks(placeable, { existing, trackNames: state.track_names || [] });
    const fresh = plan.tracks.filter((t) => t.isNew);
    const ids = {};
    for (const t of plan.tracks) if (!t.isNew) ids[t.key] = t.id;
    if (fresh.length) {
      const added = await ctl.hostOrFail("sd_add_tracks", { sequence: seq.id, names: fresh.map((t) => t.name) }, command);
      fresh.forEach((t, i) => {
        const got = added.tracks[i];
        ids[t.key] = got.id;
        record.tracks.push({ id: got.id, name: got.name, lane: t.lane, role: t.role, added_at: isoTime(now) });
      });
      writeJson(paths.record, record); // a failure from here on can still be taken out
    }
    const names = {};
    for (const t of record.tracks) names[String(t.id)] = t.name;
    const placements = placeable.map((c) => {
      const level = sd.levelForGain(c.gain_db);
      const fades = sd.fadeKeys({
        inSeconds: Number(BigInt(c.in_ticks)) / sd.TICKS_PER_SECOND,
        lengthSeconds: (Number(BigInt(c.end_ticks) - BigInt(c.start_ticks))) / sd.TICKS_PER_SECOND,
        fadeInMs: c.fade_in_ms,
        fadeOutMs: c.fade_out_ms,
        level: level.value,
      });
      c.level = level;
      c.fades = fades;
      return {
        key: c.cue_id,
        path: fetched.get(c.cue_id),
        track_id: ids[plan.assign[c.cue_id]],
        start: c.start_ticks,
        end: c.end_ticks,
        in: c.in_ticks,
        out: c.out_ticks,
        level: level.value,
        keys: fades.keys,
      };
    });
    const placed = placements.length
      ? await ctl.hostOrFail("sd_place", { sequence: seq.id, bin_path: record.bin, placements }, command)
      : { results: [] };
    const byKey = new Map(placed.results.map((r) => [r.key, r]));
    for (const c of placeable) {
      const r = byKey.get(c.cue_id);
      if (!r || !r.ok) {
        say(c, "not_placed", "Not placed: " + ((r && r.reason) || "Premiere Pro did not place it."));
        continue;
      }
      const trackId = ids[plan.assign[c.cue_id]];
      record.cues[c.cue_id] = {
        status: "placed",
        name: c.name,
        file: path.basename(fetched.get(c.cue_id)),
        media_path: fetched.get(c.cue_id),
        track_id: trackId,
        track_name: names[String(trackId)] || "",
        node_id: r.node_id || null,
        start_ticks: r.start || c.start_ticks,
        end_ticks: r.end || c.end_ticks,
        in_ticks: r.in || c.in_ticks,
        out_ticks: r.out || c.out_ticks,
        gain_db: c.level.db,
        fade_in_ms: c.fades.fade_in_ms,
        fade_out_ms: c.fades.fade_out_ms,
        role: c.role,
        lane: c.lane,
        credit: c.credit || "",
        licence: c.licence || "",
        placed_at: isoTime(now),
      };
      const notes = [];
      if (r.note) notes.push(r.note);
      if (c.level.clamped) notes.push("gain held to " + c.level.db + " dB (Premiere's range is -96 to +15)");
      if (c.fades.shortened) notes.push("the fades were longer than the sound, so they meet in the middle");
      say(c, "placed", null, {
        track: names[String(trackId)] || "",
        start_ms: sd.ticksToMs(record.cues[c.cue_id].start_ticks),
        end_ms: sd.ticksToMs(record.cues[c.cue_id].end_ticks),
        gain_db: c.level.db,
        fade_in_ms: c.fades.fade_in_ms,
        fade_out_ms: c.fades.fade_out_ms,
        file: record.cues[c.cue_id].file,
      });
      if (notes.length) report[c.cue_id].note = notes.join("; ") + ".";
    }
  } finally {
    record.credits = mergeCredits(record.credits, a.credits, record.cues);
    record.updated_at = isoTime(ctl.clock());
    sd.noteHistory(record, {
      at: record.updated_at,
      action: "place",
      placed: Object.values(report).filter((r) => r.status === "placed").length,
      not_placed: Object.values(report).filter((r) => r.status === "not_placed").length,
    });
    writeJson(paths.record, record);
    writeCredits(paths.credits, record.credits);
    try {
      const saved = await ctl.hostOrFail("save", {}, command);
      result.saved = { path: saved.path || pf.path, at: isoTime(ctl.clock()) };
    } catch (err) {
      result.save_note = "NOLGIA placed the sounds but could not save the project (" + err.message + "): save it with File > Save.";
    }
  }
  return finishReport(result, a.files, report, record, paths.record);
}

// Download (or, in tests, copy) each cue's sound into `folder`. The same
// link is fetched once; a file this run already fetched is used again.
// Resolves Map(cue_id -> file path); cues that fail are reported.
async function fetchSounds(ctl, api, cues, folder, record, localOk, say, command) {
  const out = new Map();
  const bySource = new Map();
  const taken = new Set();
  try {
    for (const name of fs.readdirSync(folder)) taken.add(name.toLowerCase());
  } catch (e) {
    // a new folder
  }
  let total = 0;
  let n = 0;
  for (const cue of cues) {
    const source = cue.url || cue.path;
    if (bySource.has(source)) {
      out.set(cue.cue_id, bySource.get(source));
      continue;
    }
    // A sound this run fetched before (a repeated place after a failure).
    const before = record && record.cues[cue.cue_id] && record.cues[cue.cue_id].file;
    if (before) {
      const p = path.join(folder, before);
      if (fs.existsSync(p) && (cue.bytes === undefined || fs.statSync(p).size === cue.bytes)) {
        out.set(cue.cue_id, p);
        bySource.set(source, p);
        continue;
      }
    }
    if (command.remaining() < 20) {
      say(cue, "not_placed", "Not placed: there was no time left to download it. Place the run again to add the rest.");
      continue;
    }
    if (cue.bytes !== undefined && total + cue.bytes > sd.MAX_TOTAL_BYTES) {
      say(cue, "not_placed", "Not placed: the run's sounds add up to more than 2 GB. Place the rest with another run.");
      continue;
    }
    n += 1;
    const temp = path.join(folder, ".nolgia-download-" + process.pid + "-" + n);
    const finalName = sd.uniqueName(cue.safe.stem, cue.safe.ext, taken);
    const target = path.join(folder, finalName);
    try {
      if (cue.url) {
        await api.download(cue.url, temp, { maxBytes: sd.MAX_FILE_BYTES, httpsOnly: true });
      } else if (localOk) {
        const st = fs.statSync(cue.path);
        if (st.size > sd.MAX_FILE_BYTES) throw new Error("the file is larger than 300 MB");
        fs.copyFileSync(cue.path, temp);
      }
      const size = fs.statSync(temp).size;
      if (!size) throw new Error("the file is empty");
      const head = Buffer.alloc(16);
      const fd = fs.openSync(temp, "r");
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!sd.looksLikeAudio(head, cue.safe.ext)) throw new Error("what came back is not a " + cue.safe.ext.slice(1).toUpperCase() + " sound");
      total += size;
      if (total > sd.MAX_TOTAL_BYTES) throw new Error("the run's sounds add up to more than 2 GB");
      fs.renameSync(temp, target);
      out.set(cue.cue_id, target);
      bySource.set(source, target);
    } catch (err) {
      taken.delete(finalName.toLowerCase());
      let why = err && err.message ? err.message : String(err);
      if (err instanceof ApiError) why = err.status === 413 ? "the file is larger than 300 MB" : (err.detail || err.title || "download failed " + err.status);
      if (err instanceof NetworkError) why = "the download failed (" + err.message + ")";
      say(cue, "not_placed", "Not placed: " + why.replace(/\.$/, "") + ".");
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  return out;
}

function mergeCredits(have, given, cues) {
  const lines = [];
  const seen = new Set();
  const add = (line) => {
    const text = String(line || "").trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      lines.push(text);
    }
  };
  (have || []).forEach(add);
  (given || []).forEach(add);
  for (const id of Object.keys(cues || {})) if (cues[id].status === "placed") add(cues[id].credit);
  return lines;
}

function writeCredits(file, lines) {
  if (!lines.length) return;
  const text =
    "Sounds in this folder that ask for credit (CC BY). Publish these lines with the film:\n\n" + lines.join("\n") + "\n";
  fs.writeFileSync(file, text, "utf8");
}

function finishReport(result, files, report, record, recordPath) {
  const cues = [];
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.cue_id)) continue;
    seen.add(f.cue_id);
    if (report[f.cue_id]) cues.push(report[f.cue_id]);
  }
  const count = (s) => cues.filter((c) => c.status === s).length;
  result.placed = count("placed");
  result.already_placed = count("already_placed");
  result.not_placed = count("not_placed");
  result.cues = cues;
  if (record) {
    result.tracks = sd.activeTracks(record).map((t) => ({ id: t.id, name: t.name, lane: t.lane }));
    result.bin = result.bin || record.bin.join(" / ");
    result.credits = record.credits;
  }
  if (recordPath) result.record = recordPath;
  result.undo = "To take these sounds out again: sound_design with action remove and run_id " + result.run_id + ".";
  if (!result.placed && !result.already_placed) result.note = "Nothing was placed and the project was not changed.";
  return result;
}

// ------------------------------------------------------------ remove

async function remove(ctl, command) {
  const a = command.args;
  const pf = await ctl.hostOrFail("project_file", {}, command);
  if (!pf.path) throw new CommandError(UNSAVED);
  const paths = runPaths(pf.path, a.run_id);
  const record = readRecord(paths.record, a.run_id);
  if (!record) {
    throw new CommandError("There is no sound design run " + a.run_id + " next to this project (" + paths.folder + ").");
  }
  if (a.sequence && a.sequence !== record.sequence.name && a.sequence !== String(record.sequence.id)) {
    throw new CommandError("Run " + a.run_id + " was placed on the sequence " + record.sequence.name + ", not " + a.sequence + ".");
  }
  const clips = sd.placedCues(record).map((c) => ({
    key: c.cue_id,
    track_id: c.track_id,
    node_id: c.node_id,
    start: c.start_ticks,
    media: c.media_path,
  }));
  const trackIds = sd.activeTracks(record).map((t) => t.id);
  const result = { run_id: a.run_id, sequence: record.sequence.name, folder: paths.folder, bin: record.bin.join(" / ") };
  if (!clips.length && !trackIds.length) {
    return Object.assign(result, { removed: 0, missing: 0, tracks_removed: [], tracks_kept: [], note: "This run is already out of the sequence." });
  }
  result.backup = await saveAndBackUp(ctl, command, pf.path, "removing sound design " + a.run_id);
  let outcome;
  try {
    outcome = await ctl.hostOrFail("sd_remove", { sequence: record.sequence.id, clips, track_ids: trackIds }, command);
  } finally {
    if (outcome) {
      sd.applyRemoval(record, outcome, isoTime(ctl.clock()));
      writeJson(paths.record, record);
    }
  }
  try {
    const saved = await ctl.hostOrFail("save", {}, command);
    result.saved = { path: saved.path || pf.path, at: isoTime(ctl.clock()) };
  } catch (err) {
    result.save_note = "NOLGIA took the sounds out but could not save the project (" + err.message + "): save it with File > Save.";
  }
  const names = {};
  for (const t of record.tracks) names[String(t.id)] = t.name;
  return Object.assign(result, {
    removed: (outcome.removed || []).length,
    missing: (outcome.missing || []).length,
    tracks_removed: (outcome.tracks_removed || []).map((id) => names[String(id)] || String(id)),
    tracks_kept: (outcome.tracks_kept || []).map((t) => ({ name: t.name || names[String(t.id)], reason: t.reason })),
    note:
      "The sound files stay in " + paths.folder + " and in the bin " + record.bin.join(" / ") +
      "; delete them by hand if they are not wanted.",
  });
}

module.exports = { soundDesign, readView, runsBeside, mergeCredits };
