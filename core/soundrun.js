// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// `sound_design` in Premiere Pro: read the sequence, make the preview NOLGIA
// watches, place a package's sounds on new audio tracks, take a run out.
// The app side is host/ppro.jsx (sd_*); the rules are core/sounddesign.js.
//
// Nothing the editor made is changed: the sounds go on NEW audio tracks
// after all others, never on a track with clips on it. Premiere's scripting
// has no undo group (a place is many undo steps in Premiere, not one), so
// before anything changes the project file as last saved is copied into
// NOLGIA backups next to it, then saved in place, and `remove` takes out
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

// Seconds a place keeps for the Premiere side (save, backup, import, new
// tracks, placing) once the sounds are in: downloads and asking for the
// package stop while that much is left.
function premiereReserve(cueCount) {
  return 60 + cueCount;
}

// The project must still be the one the command started with: someone may
// open another while the sounds download. Resolves Premiere's project_file
// answer ({path, dirty}).
async function sameProject(ctl, command, projectFile) {
  const now = await ctl.hostOrFail("project_file", {}, command);
  if (!now.path || work.pathKey(now.path) !== work.pathKey(projectFile)) {
    throw new CommandError(
      "The open project changed while NOLGIA worked (it was " + projectFile + ", now " + (now.path || "an unsaved project") +
        "), so it changed nothing. Open " + path.basename(projectFile) + " again and ask once more."
    );
  }
  return now;
}

// Before NOLGIA changes the project: FIRST a byte copy of the project file
// as the person last saved it into NOLGIA backups next to it (no save has
// touched it yet), THEN a save in place (Premiere checks it is still this
// project), so the person's unsaved work is on disk before NOLGIA's change;
// when there was unsaved work (or Premiere cannot say), that is copied too,
// the project exactly as it was before NOLGIA's change. Throws (and nothing
// changes) when the first copy or the save fails, or another project is
// open now; the error names the backup. Resolves the backups, the one
// exactly before NOLGIA's change last.
async function saveAndBackUp(ctl, command, projectFile, label) {
  const now = await sameProject(ctl, command, projectFile);
  const backups = [];
  try {
    backups.push(work.backupProject(projectFile, ctl.documentsDir(), ctl.clock(), label));
  } catch (err) {
    throw new CommandError("NOLGIA could not back up the project (" + err.message + "), so it changed nothing.");
  }
  try {
    await ctl.hostOrFail("save", { project: projectFile }, command);
  } catch (err) {
    throw new CommandError(
      "NOLGIA could not save the project before changing it (" + err.message + "), so it changed nothing. " +
        "The project as you last saved it is backed up at " + backups[0] + "."
    );
  }
  if (now.dirty !== false) {
    try {
      backups.push(work.backupProject(projectFile, ctl.documentsDir(), ctl.clock(), label + ", with unsaved changes"));
    } catch (err) {
      ctl.log("The backup with the unsaved changes of " + path.basename(projectFile) + " was not made (" + err.message + ").");
    }
  }
  ctl.log("Backed up " + path.basename(projectFile) + " before " + label + ": " + backups.join(", ") + ".");
  return backups;
}

// The package route works on the plan's sounds for up to 100 s before it
// answers (nolgia-api soundDesignPackagePrepare); past that it answers 503
// with the code sound_design_package_preparing and Retry-After: 30, keeping
// what it made, and the same request asked again finishes. So every request
// is given at least that wait plus a margin, and all of them fit in one
// limit: the command's time less what placing needs afterwards.
const PACKAGE_SERVER_WAIT = 100;
const PACKAGE_MARGIN = 15;
const PACKAGE_REQUEST_MIN = PACKAGE_SERVER_WAIT + PACKAGE_MARGIN;
const PACKAGE_REQUEST_MAX = 290;
const STILL_PREPARING = "NOLGIA is still preparing the sounds. Try again in a minute; nothing was placed.";

// How long the next request may take with `left` seconds of the limit:
// null when that is less than the route's own wait plus the margin (it
// would fail as "could not be reached" while NOLGIA is still working).
function packageRequestTimeout(left) {
  if (!(left >= PACKAGE_REQUEST_MIN)) return null;
  return Math.min(left, PACKAGE_REQUEST_MAX);
}

function stillPreparing(err) {
  return err instanceof ApiError && err.status === 503 && (err.code === "sound_design_package_preparing" || err.retryAfter !== null);
}

// The plan's package (format manifest), asked with the plugin's own
// sign-in: 200 is the package; 503 sound_design_package_preparing is asked
// again after its Retry-After, within the limit. Resolves the package.
async function fetchPackage(api, a, command) {
  const body = { format: "manifest" };
  if (a.timeline_offset_ms !== undefined) body.timeline_offset_ms = a.timeline_offset_ms;
  if (a.picks) body.picks = a.picks;
  if (a.skip) body.skip = a.skip;
  const left = () => command.remaining() - premiereReserve(0);
  let asked = 0;
  for (;;) {
    const timeout = packageRequestTimeout(left());
    if (timeout === null) break;
    asked += 1;
    let res;
    try {
      res = await api.packageSoundDesign(a.plan_id, body, { timeout });
    } catch (err) {
      if (!stillPreparing(err)) throw new CommandError(packageProblem(err, a.plan_id));
      const wait = Math.max(0.2, Math.min(30, err.retryAfter !== null ? err.retryAfter : 30));
      if (packageRequestTimeout(left() - wait) === null) break;
      await util.sleep(wait * 1000);
      continue;
    }
    return res.body && typeof res.body === "object" && !Array.isArray(res.body) ? res.body : {};
  }
  if (!asked) {
    throw new CommandError(
      "The command's time (" + Math.round(command.timeout) + " s) is too short to fetch the plan's sounds and place them, so nothing " +
        "was changed. Send it again with timeout_seconds 900."
    );
  }
  throw new CommandError(STILL_PREPARING);
}

function packageProblem(err, planId) {
  if (err instanceof NetworkError) return "NOLGIA could not be reached for the plan's sounds (" + err.message + "), so nothing was changed.";
  if (!(err instanceof ApiError)) return String((err && err.message) || err);
  const said = (err.detail || err.title || "").replace(/\.$/, "");
  if (err.status === 404) return "NOLGIA has no sound design plan " + planId + " for this account, so nothing was changed.";
  if (err.status === 409) return (said || "The plan is not done yet") + ". Nothing was changed.";
  if (err.status === 401) return "NOLGIA refused this computer's sign-in for the plan's sounds; sign in again in the panel. Nothing was changed.";
  return "NOLGIA could not hand over the plan's sounds (" + err.status + (said ? ": " + said : "") + "), so nothing was changed.";
}

// sd_state's arguments for a run: its tracks by id, and the tracks it is
// still waiting to hear about by name.
function stateArgs(sequence, record) {
  return {
    sequence,
    track_ids: sd.activeTracks(record).map((t) => t.id),
    track_names: sd.pendingTracks(record).map((t) => t.name),
  };
}

// sd_state's tracks with the ones found by name added (once their id is known).
function allTracks(state) {
  const tracks = ((state && state.tracks) || []).slice();
  const ids = new Set(tracks.map((t) => String(t.id)));
  for (const t of (state && state.named) || []) if (!ids.has(String(t.id))) tracks.push(t);
  return Object.assign({}, state, { tracks });
}

// Settles a run's pending tracks and cues against what Premiere has now.
function settle(record, state, now) {
  const tracks = sd.resolvePendingTracks(record, state, now);
  const cues = sd.resolvePending(record, allTracks(state), now, state && state.sequence ? state.sequence.timebase : null);
  return { tracks, cues };
}

// After sd_add_tracks failed or answered too late: which of the tracks NOLGIA
// asked for are in the sequence now, as far as Premiere can say in the time
// left. Resolves {added: [names], none: [names]} or {unknown: [names]}.
async function tracksLeft(ctl, command, record, sequence) {
  const names = sd.pendingTracks(record).map((t) => t.name);
  if (!names.length) return { added: [], none: [] };
  try {
    const now = await ctl.hostOrFail("sd_state", { sequence, track_ids: [], track_names: names }, command);
    return sd.resolvePendingTracks(record, now, isoTime(ctl.clock()));
  } catch (err) {
    return { unknown: names };
  }
}

function tracksLeftText(left, runId) {
  if (left.unknown) {
    return "NOLGIA could not check which of its new tracks (" + left.unknown.join(", ") + ") Premiere Pro added; it wrote them down, " +
      "and action remove with run_id " + runId + " takes out any of them that are in the sequence.";
  }
  const kept = (left.kept || []).length
    ? " A new track named " + left.kept.join(", ") + " holds clips NOLGIA did not place, so NOLGIA does not take it as its own and leaves it."
    : "";
  if (left.added.length) {
    return "These empty NOLGIA tracks are in the sequence: " + left.added.join(", ") + "; action remove with run_id " + runId + " takes them out." + kept;
  }
  return "No NOLGIA track was left in the sequence." + kept;
}

async function place(ctl, command, api) {
  const a = command.args;
  const localOk = ctl.env.NOLGIA_SOUND_DESIGN_LOCAL === "1";
  const hosts = sd.downloadHosts(ctl.env.NOLGIA_SOUND_DOWNLOAD_HOSTS);
  // The planned video's time to the sequence's: what the agent sends and
  // is told is in the planned video's time.
  const offset = a.timeline_offset_ms || 0;
  const pf = await ctl.hostOrFail("project_file", {}, command);
  if (!pf.path) throw new CommandError(UNSAVED);
  const paths = runPaths(pf.path, a.run_id);
  let record = readRecord(paths.record, a.run_id);
  const first = await ctl.hostOrFail("sd_state", stateArgs(a.sequence, record), command);
  const seq = first.sequence;
  const busy = (r) => sd.placedCues(r).length || sd.pendingCues(r).length || sd.pendingTracks(r).length;
  if (record && String(record.sequence.id) !== String(seq.id) && busy(record)) {
    throw new CommandError(
      "Run " + a.run_id + " is placed on the sequence " + record.sequence.name + ", not " + seq.name +
        ". Take it out there first (action remove), or place the sounds with a new run_id."
    );
  }
  // A place that ran out of time before: the tracks and clips it left in the
  // sequence are the run's.
  if (record && (sd.pendingCues(record).length || sd.pendingTracks(record).length)) {
    settle(record, first, isoTime(ctl.clock()));
    writeJson(paths.record, record);
  }

  const pkg = await fetchPackage(api, a, command);
  const { cues, unknown } = sd.packageCues(pkg.files, a.overrides, { offsetMs: offset, hosts });
  const warnings = (Array.isArray(pkg.warnings) ? pkg.warnings.filter((w) => typeof w === "string") : []).slice(0, 50);
  for (const id of unknown) warnings.push("The override for " + id + " was not used: the plan has no cue " + id + ".");
  const report = {};
  const order = [];
  const say = (cue, status, reason, extra = {}) => {
    if (!report[cue.cue_id]) order.push(cue.cue_id);
    report[cue.cue_id] = Object.assign({ cue_id: cue.cue_id, name: cue.name || cue.cue_id, status }, reason ? { reason } : {}, extra);
  };

  // What can be placed: checked, inside the sequence, on the frame grid, not
  // placed by this run before.
  const sequenceEndMs = sd.ticksToMs(seq.end);
  const ready = [];
  for (const cue of cues) {
    if (report[cue.cue_id]) continue; // listed twice
    if (cue.problem) {
      say(cue, "not_placed", cue.problem);
      continue;
    }
    if (cue.path && !cue.url && !localOk) {
      say(cue, "not_placed", "Not placed: NOLGIA's package gave no link for it.");
      continue;
    }
    if (cue.path && !sd.localSourceOk(cue.path)) {
      say(cue, "not_placed", "Not placed: its path is not a full path.");
      continue;
    }
    const outside = sd.startProblem(cue, sequenceEndMs);
    if (outside) {
      say(cue, "not_placed", outside);
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
    const at = sd.ticksToMs(was.start_ticks) - (was.timeline_offset_ms !== undefined ? was.timeline_offset_ms : offset);
    say(cue, "already_placed", "This run placed it before (" + was.track_name + " at " + at + " ms of the planned video); it is not placed twice.");
  }
  const result = {
    run_id: a.run_id,
    plan_id: a.plan_id,
    sequence: seq.name,
    sequence_id: seq.id,
    timeline_offset_ms: offset,
    folder: paths.folder,
    repeated: Boolean(record),
  };
  if (warnings.length) result.warnings = warnings;
  if (!split.todo.length) return finishReport(result, order, report, record, null);

  // The sounds, into NOLGIA Sounds/<run> next to the project.
  fs.mkdirSync(paths.folder, { recursive: true });
  const fetched = await fetchSounds(ctl, api, split.todo, paths.folder, record, { localOk, hosts }, say, command);
  const todo = split.todo.filter((c) => fetched.has(c.cue_id));
  if (!todo.length) return finishReport(result, order, report, record, null);

  // Backed up and saved before anything in the project changes; what is on
  // the tracks is read again after that (the downloads can take minutes).
  const now = ctl.clock();
  const backups = await saveAndBackUp(ctl, command, pf.path, "sound design " + a.run_id);
  result.backup = backups[backups.length - 1];
  if (backups.length > 1) result.backup_as_last_saved = backups[0];
  const state = await ctl.hostOrFail("sd_state", stateArgs(seq.id, record), command);
  if (String(state.sequence.id) !== String(seq.id)) throw new CommandError("The sequence " + seq.name + " changed while NOLGIA worked, so it changed nothing.");
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
  record.plan_id = a.plan_id;
  record.sequence = { id: seq.id, name: seq.name };
  const project = pf.path;
  let failure = null;
  try {
    // Into the run's own bin. Premiere answers each item's path as it keeps
    // it (on macOS perhaps in another Unicode form): matched by mediaKey.
    const wanted = Array.from(new Set(todo.map((c) => fetched.get(c.cue_id))));
    const imported = await ctl.hostOrFail("sd_import", { project, paths: wanted, bin_path: record.bin }, command);
    result.bin = imported.bin;
    const inBin = new Map((imported.items || []).map((m) => [sd.mediaKey(m), m]));
    const placeable = [];
    for (const c of todo) {
      const media = inBin.get(sd.mediaKey(fetched.get(c.cue_id)));
      if (!media) say(c, "not_placed", "Not placed: Premiere Pro did not import " + path.basename(fetched.get(c.cue_id)) + ".");
      else {
        c.media = media;
        placeable.push(c);
      }
    }
    // New tracks after all others, by role, then lane (more where sounds overlap).
    const existing = sd.liveRunTracks(record, state, seq.timebase);
    const plan = sd.planTracks(placeable, { existing, trackNames: state.track_names || [] });
    const fresh = plan.tracks.filter((t) => t.isNew);
    const ids = {};
    for (const t of plan.tracks) if (!t.isNew) ids[t.key] = t.id;
    if (fresh.length) {
      // Written down BEFORE Premiere is asked, by name: if its answer comes
      // too late (or it fails after adding some), a later place or remove
      // still finds them.
      const planned = fresh.map((t) => ({
        id: null,
        name: t.name,
        lane: t.lane,
        role: t.role,
        pending_at: isoTime(ctl.clock()),
        after: (state.track_names || []).length,
        // The sequence's own tracks by id: a later place or remove takes as
        // NOLGIA's only a track of that name with an id not in here.
        before_ids: Array.isArray(state.audio_ids) ? state.audio_ids.map(String) : undefined,
      }));
      record.tracks.push(...planned);
      writeJson(paths.record, record);
      const args = { project, sequence: seq.id, names: fresh.map((t) => t.name) };
      if (localOk && a.test_fail_after_tracks) args.fail_after_add = true;
      if (localOk && a.test_tracks_at !== undefined) args.insert_at = a.test_tracks_at;
      let added;
      try {
        added = await ctl.hostOrFail("sd_add_tracks", args, command);
      } catch (err) {
        const left = await tracksLeft(ctl, command, record, seq.id);
        throw new CommandError("Premiere Pro did not add the new audio tracks (" + err.message.replace(/\.$/, "") + "). " + tracksLeftText(left, a.run_id));
      }
      const got = (added && added.tracks) || [];
      fresh.forEach((t, i) => {
        if (!got[i]) return;
        Object.assign(planned[i], { id: got[i].id, name: got[i].name, added_at: isoTime(now) });
        delete planned[i].pending_at;
        delete planned[i].after;
        delete planned[i].before_ids;
        ids[t.key] = got[i].id;
      });
      writeJson(paths.record, record); // a failure from here on can still be taken out
      if (got.length !== fresh.length) {
        const left = await tracksLeft(ctl, command, record, seq.id);
        throw new CommandError("Premiere Pro added " + got.length + " of the " + fresh.length + " new audio tracks. " + tracksLeftText(left, a.run_id));
      }
    }
    const names = {};
    for (const t of record.tracks) names[String(t.id)] = t.name;
    const placements = placeable.map((c) => {
      const level = sd.levelForGain(c.gain_db);
      const fades = sd.fadeKeys({
        inSeconds: Number(BigInt(c.in_ticks)) / sd.TICKS_PER_SECOND,
        lengthSeconds: Number(BigInt(c.end_ticks) - BigInt(c.start_ticks)) / sd.TICKS_PER_SECOND,
        fadeInMs: c.fade_in_ms,
        fadeOutMs: c.fade_out_ms,
        level: level.value,
      });
      c.level = level;
      c.fades = fades;
      const trackId = ids[plan.assign[c.cue_id]];
      // Written down BEFORE Premiere is asked: if its answer comes too late,
      // a later place or remove still knows what went in.
      record.cues[c.cue_id] = cueRecord(c, {
        status: "pending",
        pending_at: isoTime(ctl.clock()),
        media_path: fetched.get(c.cue_id),
        track_id: trackId,
        track_name: names[String(trackId)] || "",
        timeline_offset_ms: offset,
      });
      return {
        key: c.cue_id,
        media: c.media,
        track_id: trackId,
        track_name: names[String(trackId)] || "",
        start: c.start_ticks,
        end: c.end_ticks,
        in: c.in_ticks,
        out: c.out_ticks,
        level: level.value,
        keys: fades.keys,
      };
    });
    writeJson(paths.record, record);
    let placed = { results: [] };
    if (placements.length) {
      try {
        placed = await ctl.hostOrFail("sd_place", { project, sequence: seq.id, bin_path: record.bin, placements }, command);
      } catch (err) {
        throw new CommandError(
          "Premiere Pro did not finish placing the sounds in time (" + err.message.replace(/\.$/, "") + "). NOLGIA wrote down what it was " +
            "placing: place the run again to finish, or remove it to take out whatever went in."
        );
      }
    }
    // Items Premiere had split into mono clips (Default Audio Tracks), set back to one clip.
    const mapping = placed.mapping || [];
    const remapped = mapping.filter((m) => m && m.changed).map((m) => path.basename(String(m.media)));
    if (remapped.length) result.audio_mapping_fixed = remapped;
    const unmapped = mapping.filter((m) => m && m.error).map((m) => path.basename(String(m.media)) + ": " + m.error);
    if (unmapped.length) result.audio_mapping_errors = unmapped;
    const byKey = new Map(placed.results.map((r) => [r.key, r]));
    for (const c of placeable) {
      const r = byKey.get(c.cue_id);
      const rec = record.cues[c.cue_id];
      if (!r || !r.ok) {
        rec.status = "not_placed";
        rec.reason = (r && r.reason) || "Premiere Pro did not place it.";
        delete rec.pending_at;
        say(c, "not_placed", "Not placed: " + rec.reason);
        continue;
      }
      Object.assign(rec, {
        status: "placed",
        node_id: r.node_id || null,
        start_ticks: r.start || c.start_ticks,
        end_ticks: r.end || c.end_ticks,
        in_ticks: r.in || c.in_ticks,
        out_ticks: r.out || c.out_ticks,
        placed_at: isoTime(now),
      });
      delete rec.pending_at;
      const notes = [];
      if (r.note) notes.push(r.note);
      if (c.level.clamped) notes.push("gain held to " + c.level.db + " dB (Premiere's clip Level goes from " + sd.MIN_GAIN_DB + " to +" + sd.MAX_GAIN_DB + " dB)");
      if (c.fades.shortened) notes.push("the fades were longer than the sound, so they meet in the middle");
      const startMs = sd.ticksToMs(rec.start_ticks);
      say(c, "placed", null, {
        track: rec.track_name,
        start_ms: startMs - offset,
        end_ms: sd.ticksToMs(rec.end_ticks) - offset,
        timeline_start_ms: startMs,
        gain_db: c.level.db,
        fade_in_ms: c.fades.fade_in_ms,
        fade_out_ms: c.fades.fade_out_ms,
        file: rec.file,
      });
      if (notes.length) report[c.cue_id].note = notes.join("; ") + ".";
    }
  } catch (err) {
    failure = err;
  }
  record.credits = mergeCredits(record.credits, sd.creditLines(pkg.credits), record.cues);
  record.updated_at = isoTime(ctl.clock());
  sd.noteHistory(record, {
    at: record.updated_at,
    action: "place",
    placed: Object.values(report).filter((r) => r.status === "placed").length,
    not_placed: Object.values(report).filter((r) => r.status === "not_placed").length,
    failed: failure ? String(failure.message || failure).slice(0, 300) : undefined,
  });
  writeJson(paths.record, record);
  writeCredits(paths.credits, record.credits);
  let notSaved = null;
  try {
    await sameProject(ctl, command, pf.path);
    const saved = await ctl.hostOrFail("save", { project }, command);
    result.saved = { path: saved.path || pf.path, at: isoTime(ctl.clock()) };
  } catch (err) {
    notSaved = err.message.replace(/\.$/, "");
    result.save_note = "NOLGIA placed the sounds but did not save the project (" + notSaved + "): save it with File > Save.";
  }
  if (failure) {
    const said = String(failure.message || failure).replace(/\.?\s*$/, ".");
    const saved = notSaved === null
      ? "NOLGIA saved the project as it is now (action remove with run_id " + a.run_id + " takes out whatever this run put in)."
      : "The project was not saved after this (" + notSaved + ").";
    throw new CommandError(said + " " + saved + " The project as it was before NOLGIA's change is backed up at " + result.backup + ".");
  }
  return finishReport(result, order, report, record, paths.record);
}

// What the record keeps of a cue.
function cueRecord(c, extra) {
  return Object.assign(
    {
      name: c.name,
      file: path.basename(extra.media_path),
      start_ticks: c.start_ticks,
      end_ticks: c.end_ticks,
      in_ticks: c.in_ticks,
      out_ticks: c.out_ticks,
      gain_db: c.level.db,
      fade_in_ms: c.fades.fade_in_ms,
      fade_out_ms: c.fades.fade_out_ms,
      role: c.role,
      lane: c.lane,
      credit: c.credit || "",
      licence: c.licence || "",
      sound_url_host: c.url ? hostOf(c.url) : null,
    },
    extra
  );
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return null;
  }
}

// Download (or, in tests, copy) each cue's sound into `folder`. The links
// are only those NOLGIA's package answered, on the allowed storage hosts
// (`hosts`): HTTPS, never with NOLGIA's sign-in (no Authorization header),
// redirects only within the link's own host and port and never to a link
// with a user name, a time limit per file, a failure reported by its status
// code alone. The same link is fetched once; a file this run already
// fetched is used again. Resolves Map(cue_id -> file path); cues that fail
// are reported.
async function fetchSounds(ctl, api, cues, folder, record, { localOk, hosts }, say, command) {
  const out = new Map();
  const bySource = new Map();
  const taken = new Set();
  try {
    // NFC: a Mac Extended drive lists names decomposed.
    for (const name of fs.readdirSync(folder)) taken.add(name.normalize("NFC").toLowerCase());
  } catch (e) {
    // a new folder
  }
  const reserve = premiereReserve(cues.length);
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
    if (command.remaining() < reserve + 5) {
      say(cue, "not_placed", "Not placed: there was no time left to download it. Place the run again to add the rest.");
      continue;
    }
    if (cue.bytes !== undefined && total + cue.bytes > sd.MAX_TOTAL_BYTES) {
      say(cue, "not_placed", "Not placed: the run's sounds add up to more than 2 GB. Place the rest with another run.");
      continue;
    }
    n += 1;
    const temp = path.join(folder, ".nolgia-download-" + process.pid + "-" + n);
    let finalName = sd.uniqueName(cue.safe.stem, cue.safe.ext, taken);
    let target = path.join(folder, finalName);
    try {
      if (cue.url) {
        await api.download(cue.url, temp, {
          maxBytes: sd.MAX_FILE_BYTES,
          httpsOnly: true,
          sameHost: true,
          checkLink: (url) => sd.linkProblem(url, hosts),
          quiet: true,
          limitSeconds: Math.max(5, Math.min(300, command.remaining() - reserve)),
        });
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
      // Never onto a file that is there (another name's NFD twin included).
      while (fs.existsSync(target)) {
        finalName = sd.uniqueName(cue.safe.stem, cue.safe.ext, taken);
        target = path.join(folder, finalName);
      }
      fs.renameSync(temp, target);
      out.set(cue.cue_id, target);
      bySource.set(source, target);
    } catch (err) {
      taken.delete(finalName.toLowerCase());
      let why = err && err.message ? err.message : String(err);
      if (err instanceof ApiError) {
        if (err.status === 413) why = "the file is larger than 300 MB";
        else if (err.status === 400) why = err.detail || err.title;
        else why = "the download failed (HTTP " + err.status + ")";
      }
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

function finishReport(result, order, report, record, recordPath) {
  const cues = order.map((id) => report[id]).filter(Boolean);
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
  const result = { run_id: a.run_id, sequence: record.sequence.name, folder: paths.folder, bin: record.bin.join(" / ") };
  if (!sd.placedCues(record).length && !sd.pendingCues(record).length && !sd.activeTracks(record).length && !sd.pendingTracks(record).length) {
    return Object.assign(result, { removed: 0, left: [], tracks_removed: [], tracks_kept: [], note: "This run is already out of the sequence." });
  }
  const backups = await saveAndBackUp(ctl, command, pf.path, "removing sound design " + a.run_id);
  result.backup = backups[backups.length - 1];
  if (backups.length > 1) result.backup_as_last_saved = backups[0];
  // What is on the run's tracks now (tracks a place asked for but never
  // heard back about are looked up by name); a clip is the run's only when
  // its track, start, end, in point and file all agree with the record.
  const state = allTracks(await ctl.hostOrFail("sd_state", stateArgs(record.sequence.id, record), command));
  const at = isoTime(ctl.clock());
  const pendingNow = settle(record, state, at);
  const trimmedPending = Object.keys(record.cues).filter((k) => record.cues[k].status === "left" && record.cues[k].left_at === at);
  const tracks = sd.activeTracks(record);
  const match = sd.matchRunClips(record, state);
  let outcome;
  try {
    outcome = await ctl.hostOrFail(
      "sd_remove",
      { project: pf.path, sequence: record.sequence.id, clips: match.clips, tracks: tracks.map((t) => ({ id: t.id, name: t.name })) },
      command
    );
  } finally {
    const settled = outcome || { removed: [], missing: [] };
    const missing = (settled.missing || []).map((m) => (typeof m === "string" ? m : m.key));
    sd.applyRemoval(record, Object.assign({}, settled, { missing: missing.concat(match.left.map((l) => l.key)) }), isoTime(ctl.clock()));
    writeJson(paths.record, record);
  }
  try {
    await sameProject(ctl, command, pf.path);
    const saved = await ctl.hostOrFail("save", { project: pf.path }, command);
    result.saved = { path: saved.path || pf.path, at: isoTime(ctl.clock()) };
  } catch (err) {
    result.save_note = "NOLGIA took the sounds out but did not save the project (" + err.message + "): save it with File > Save.";
  }
  const names = {};
  for (const t of record.tracks) names[String(t.id)] = t.name;
  const cueName = (key) => (record.cues[key] && record.cues[key].name) || key;
  const left = trimmedPending
    .map((key) => ({ key, name: cueName(key), reason: "it was trimmed or slipped since NOLGIA placed it, so it is the editor's now" }))
    .concat(match.left)
    .concat(
      (outcome.missing || []).map((m) => ({ key: typeof m === "string" ? m : m.key, name: cueName(typeof m === "string" ? m : m.key), reason: (m && m.reason) || "Premiere Pro no longer had it as NOLGIA placed it" }))
    );
  return Object.assign(result, {
    removed: (outcome.removed || []).length,
    left: left.map((l) => ({ cue_id: l.key, name: l.name, reason: l.reason + ", so it was left in the sequence." })),
    tracks_removed: (outcome.tracks_removed || []).map((id) => names[String(id)] || String(id)),
    tracks_kept: (outcome.tracks_kept || []).map((t) => ({ name: t.name || names[String(t.id)], reason: t.reason })).concat(
      pendingNow.tracks.kept.map((name) => ({ name, reason: "it holds clips NOLGIA did not place, so NOLGIA did not take it as its own; it stays." }))
    ),
    note:
      "The sound files stay in " + paths.folder + " and in the bin " + record.bin.join(" / ") +
      "; delete them by hand if they are not wanted.",
  });
}

module.exports = { soundDesign, readView, runsBeside, mergeCredits, packageRequestTimeout, PACKAGE_REQUEST_MIN, STILL_PREPARING };
