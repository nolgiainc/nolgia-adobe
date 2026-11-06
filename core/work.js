// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Keeping NOLGIA's changes safe in After Effects, so a crash never loses
// them and never loses the person's own work:
//
// - before NOLGIA's first change to a project (and again after 10 minutes
//   without one), a byte copy of the project file as it is on disk goes into
//   "NOLGIA backups" next to it; when the project had changes not saved yet,
//   it is saved in place and copied again, so the backup is exactly the
//   project before NOLGIA touched it;
// - a project that was never saved is saved into Documents/NOLGIA projects
//   before NOLGIA changes it, and the person is told where;
// - after each change NOLGIA makes, the project is saved in place (never
//   Save As: the open project stays on its own file);
// - work.json, next to the settings, records where NOLGIA's last saved work
//   and backups are, and each step NOLGIA took, so after a crash the panel
//   and the agent can say which file holds it.
//
// The project is never written over without a backup made first in this
// stretch of work; when no backup can be made, NOLGIA does not save over the
// file and says so.

"use strict";

const fs = require("fs");
const path = require("path");

const { readJson, writeJson } = require("./settings");

const BACKUP_FOLDER = "NOLGIA backups";
const PROJECTS_FOLDER = "NOLGIA projects";
const QUIET_GAP = 10 * 60; // seconds without a NOLGIA change before the next one makes a new backup
const KEEP_BACKUPS = 20; // per project: older NOLGIA backups of it are removed
const KEEP_STEPS = 100;
const KEEP_PROJECTS = 30;
const STEP_CODE_CHARS = 8000;

// "2026-11-06 01-08-56" in local time: sorts by time and is safe in file names.
function stamp(seconds) {
  const d = new Date(seconds * 1000);
  const two = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " +
    two(d.getHours()) + "-" + two(d.getMinutes()) + "-" + two(d.getSeconds())
  );
}

// A path in `folder` for `base` + `ext` that does not exist yet.
function freePath(folder, base, ext) {
  let target = path.join(folder, base + ext);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, base + " (" + n + ")" + ext);
  return target;
}

// Copy `source` to a new file at `target`, never over one. Resolves the
// path written.
function copyNew(source, target) {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const want = fs.statSync(source).size;
  const got = fs.statSync(target).size;
  if (want !== got) {
    throw new Error("the copy has " + got + " bytes, the project " + want);
  }
  return target;
}

class WorkRecord {
  constructor(file, clock) {
    this.file = file;
    this.clock = clock;
  }

  read() {
    const data = readJson(this.file);
    if (!data || typeof data !== "object" || !data.projects || typeof data.projects !== "object") {
      return { projects: {}, last: null };
    }
    return data;
  }

  write(data) {
    // The newest projects only.
    const names = Object.keys(data.projects);
    if (names.length > KEEP_PROJECTS) {
      names
        .sort((a, b) => (data.projects[b].touched_at || 0) - (data.projects[a].touched_at || 0))
        .slice(KEEP_PROJECTS)
        .forEach((name) => delete data.projects[name]);
    }
    try {
      writeJson(this.file, data);
    } catch (e) {
      // the record is a help, not a condition for saving
    }
  }

  project(data, file) {
    const key = pathKey(file);
    if (!data.projects[key]) data.projects[key] = { path: path.normalize(file), backups: [], steps: [] };
    const entry = data.projects[key];
    entry.touched_at = this.clock();
    data.last = key;
    return entry;
  }

  noteBackup(file, backup) {
    const data = this.read();
    const entry = this.project(data, file);
    entry.backups.push({ path: backup, at: this.clock() });
    entry.backups = entry.backups.slice(-KEEP_BACKUPS);
    this.write(data);
  }

  noteSave(file, how) {
    const data = this.read();
    const entry = this.project(data, file);
    entry.saved_at = this.clock();
    entry.saved_how = how;
    this.write(data);
  }

  noteStep(file, step) {
    const data = this.read();
    const entry = this.project(data, file);
    const item = { at: this.clock(), kind: step.kind, ok: Boolean(step.ok) };
    if (step.code) item.code = String(step.code).slice(0, STEP_CODE_CHARS);
    if (step.asset_id) item.asset_id = step.asset_id;
    if (step.error) item.error = String(step.error).slice(0, 300);
    if (step.saved === false) item.saved = false;
    entry.steps.push(item);
    entry.steps = entry.steps.slice(-KEEP_STEPS);
    this.write(data);
  }

  // Where NOLGIA's last work is: the project it last changed, when NOLGIA
  // last saved it, and its newest backups. `open` is the project open now.
  summary(open) {
    const data = this.read();
    const key = data.last;
    const entry = key ? data.projects[key] : null;
    if (!entry) return null;
    const out = {
      project: entry.path || key,
      saved_at: entry.saved_at || null,
      backups: (entry.backups || []).slice(-3).reverse().filter((b) => fs.existsSync(b.path)),
      steps: (entry.steps || []).length,
      last_step_at: entry.steps && entry.steps.length ? entry.steps[entry.steps.length - 1].at : null,
      exists: fs.existsSync(entry.path || key),
    };
    if (open !== undefined) out.open_now = Boolean(open) && pathKey(open) === key;
    const unsaved = (entry.steps || []).filter((s) => s.saved === false && (!entry.saved_at || s.at > entry.saved_at));
    if (unsaved.length) out.unsaved_steps = unsaved.length;
    return out;
  }
}

// Remove the oldest NOLGIA backups of one project beyond KEEP_BACKUPS. Only
// files NOLGIA named for this project in its own backup folder.
function pruneBackups(folder, stem, ext) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch (e) {
    return;
  }
  // Newest first by the time in the name (a copy keeps the project's own
  // modified time, so the file's dates do not say when it was made).
  const prefix = stem + " before NOLGIA ";
  const ours = names
    .filter((n) => n.startsWith(prefix) && /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d/.test(n.slice(prefix.length)))
    .filter((n) => n.toLowerCase().endsWith(ext.toLowerCase()))
    .sort()
    .reverse();
  for (const old of ours.slice(KEEP_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(folder, old));
    } catch (e) {
      // left as it is
    }
  }
}

// The folder a project's backups go into: "NOLGIA backups" next to it, or
// Documents/NOLGIA backups when that cannot be written.
function backupFolder(projectFile, documents) {
  const near = path.join(path.dirname(projectFile), BACKUP_FOLDER);
  try {
    fs.mkdirSync(near, { recursive: true });
    fs.accessSync(near, fs.constants.W_OK);
    return near;
  } catch (e) {
    const far = path.join(documents, BACKUP_FOLDER);
    fs.mkdirSync(far, { recursive: true });
    return far;
  }
}

// Byte copy of the project file into its backup folder. `label` is added to
// the name ("with unsaved changes"). Resolves the backup's path.
function backupProject(projectFile, documents, when, label = "") {
  const ext = path.extname(projectFile);
  const stem = path.basename(projectFile, ext);
  const folder = backupFolder(projectFile, documents);
  const base = stem + " before NOLGIA " + stamp(when) + (label ? " (" + label + ")" : "");
  const target = copyNew(projectFile, freePath(folder, base, ext));
  pruneBackups(folder, stem, ext);
  return target;
}

// Where a project that was never saved goes: "Untitled <date> <time>" in
// `folder` (Documents/NOLGIA projects).
function untitledTarget(folder, when, ext) {
  fs.mkdirSync(folder, { recursive: true });
  return freePath(folder, "Untitled " + stamp(when), ext);
}

// The same file? Windows and macOS file names ignore case.
function pathKey(file) {
  const p = path.normalize(String(file || ""));
  return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

module.exports = {
  WorkRecord,
  backupProject,
  untitledTarget,
  pathKey,
  freePath,
  copyNew,
  stamp,
  BACKUP_FOLDER,
  PROJECTS_FOLDER,
  QUIET_GAP,
  KEEP_BACKUPS,
};
