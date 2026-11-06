// SPDX-License-Identifier: GPL-3.0-or-later
// Backups and the record of NOLGIA's work (core/work.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const work = require("../core/work");

const WHEN = Date.UTC(2026, 10, 6, 1, 8, 56) / 1000;

test("a backup is a byte copy in NOLGIA backups next to the project, never over a file", () => {
  const folder = support.tempDir();
  const project = path.join(folder, "shot.aep");
  fs.writeFileSync(project, Buffer.from([0, 1, 2, 3, 250]));
  const first = work.backupProject(project, path.join(folder, "Documents"), WHEN);
  assert.equal(path.dirname(first), path.join(folder, "NOLGIA backups"));
  assert.equal(path.basename(first), "shot before NOLGIA " + work.stamp(WHEN) + ".aep");
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(project));
  // The same second again: a second file, the first untouched.
  const second = work.backupProject(project, path.join(folder, "Documents"), WHEN);
  assert.notEqual(second, first);
  assert.match(path.basename(second), / \(2\)\.aep$/);
  const labelled = work.backupProject(project, path.join(folder, "Documents"), WHEN, "with unsaved changes");
  assert.match(path.basename(labelled), /before NOLGIA .* \(with unsaved changes\)\.aep$/);
  // The project itself is never changed.
  assert.deepEqual(fs.readFileSync(project), Buffer.from([0, 1, 2, 3, 250]));
});

test("backups go to Documents/NOLGIA backups when the project's folder cannot take them", () => {
  const folder = support.tempDir();
  const project = path.join(folder, "shot.aep");
  fs.writeFileSync(project, "aep");
  fs.writeFileSync(path.join(folder, "NOLGIA backups"), "a file where the folder would go");
  const documents = path.join(folder, "Documents");
  const backup = work.backupProject(project, documents, WHEN);
  assert.equal(path.dirname(backup), path.join(documents, "NOLGIA backups"));
  assert.equal(fs.readFileSync(backup, "utf8"), "aep");
});

test("only the newest NOLGIA backups of a project are kept, and nothing else in the folder is touched", () => {
  const folder = support.tempDir();
  const project = path.join(folder, "shot.aep");
  fs.writeFileSync(project, "aep");
  const backups = path.join(folder, "NOLGIA backups");
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, "notes.txt"), "mine");
  fs.writeFileSync(path.join(backups, "other before NOLGIA 2020-01-01 00-00-00.aep"), "another project");
  const made = [];
  for (let i = 0; i < work.KEEP_BACKUPS + 3; i++) made.push(work.backupProject(project, folder, WHEN + i * 60));
  const left = fs.readdirSync(backups).filter((n) => n.startsWith("shot before NOLGIA "));
  assert.equal(left.length, work.KEEP_BACKUPS);
  assert.ok(!fs.existsSync(made[0]) && !fs.existsSync(made[2]), "the oldest went");
  assert.ok(fs.existsSync(made[made.length - 1]), "the newest stays");
  assert.ok(fs.existsSync(path.join(backups, "notes.txt")));
  assert.ok(fs.existsSync(path.join(backups, "other before NOLGIA 2020-01-01 00-00-00.aep")));
});

test("an untitled project goes into its own new file", () => {
  const folder = path.join(support.tempDir(), "NOLGIA projects");
  const first = work.untitledTarget(folder, WHEN, ".aep");
  assert.equal(first, path.join(folder, "Untitled " + work.stamp(WHEN) + ".aep"));
  fs.writeFileSync(first, "x");
  assert.notEqual(work.untitledTarget(folder, WHEN, ".aep"), first);
});

test("the record says where NOLGIA's last work is", () => {
  const folder = support.tempDir();
  const project = path.join(folder, "shot.aep");
  fs.writeFileSync(project, "aep");
  let now = WHEN;
  const record = new work.WorkRecord(path.join(folder, "work.json"), () => now);
  assert.equal(record.summary(project), null);
  const backup = work.backupProject(project, folder, now);
  record.noteBackup(project, backup);
  now += 5;
  record.noteStep(project, { kind: "run", ok: true, code: "app.project.items.addComp('x', 4, 4, 1, 1, 24);" });
  record.noteSave(project, "after run");
  now += 5;
  record.noteStep(project, { kind: "run", ok: false, error: "TypeError", saved: false });
  const s = record.summary(project);
  assert.equal(s.project, project);
  assert.equal(s.open_now, true);
  assert.equal(s.saved_at, WHEN + 5);
  assert.deepEqual(s.backups.map((b) => b.path), [backup]);
  assert.equal(s.steps, 2);
  assert.equal(s.unsaved_steps, 1);
  assert.equal(record.summary(path.join(folder, "shot_1.aep")).open_now, false, "a crash copy is not the project");
  const saved = JSON.parse(fs.readFileSync(path.join(folder, "work.json"), "utf8"));
  assert.match(Object.values(saved.projects)[0].steps[0].code, /addComp/);
});
