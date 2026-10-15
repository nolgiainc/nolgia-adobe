// SPDX-License-Identifier: GPL-3.0-or-later
// The `dit` kind: argument checks, the exact argv, finding the CLI, the
// approval gate for writes, and jobs, against a fake CLI.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dit = require("../core/dit");
const c = require("../core/commands");
const { Controller } = require("../core/controller");
const { APPS } = require("../core/index");

const FAKE = path.join(__dirname, "fixtures", "fake-nolgia.js");

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test("args are checked: full paths, at most three destinations, known hashes, no control characters", () => {
  const ok = c.validate(APPS.PPRO, "dit", {
    subcommand: "offload",
    sources: ["/Volumes/A001"],
    destinations: ["/Volumes/RAID", "D:\\Backup"],
    shoot: "Day 1",
    hash: "xxh64,md5",
  });
  assert.equal(ok.action, "start");
  assert.deepEqual(ok.destinations, ["/Volumes/RAID", "D:\\Backup"]);
  const bad = [
    { subcommand: "offload", sources: ["relative/card"], destinations: ["/d"] },
    { subcommand: "offload", sources: ["/a"], destinations: ["/1", "/2", "/3", "/4"] },
    { subcommand: "offload", sources: ["/a"], destinations: ["/d"], hash: "crc32" },
    { subcommand: "offload", sources: ["/a\nrm -rf /"], destinations: ["/d"] },
    { subcommand: "format", dir: "/a" },
    { subcommand: "rename", dir: "/a", cameras: ["no-equals-sign"] },
    { action: "status" },
  ];
  for (const args of bad) assert.throws(() => c.validate(APPS.PPRO, "dit", args), c.CommandError, JSON.stringify(args));
});

test("the argv is exactly `--json dit <subcommand>` plus one argument per value", () => {
  const a = dit.validateArgs({
    subcommand: "offload",
    sources: ["/Volumes/A 001"],
    destinations: ["/r"],
    shoot: "x; echo pwned",
    cards: ["A001"],
  });
  assert.deepEqual(dit.argv(a), ["--json", "dit", "offload", "/Volumes/A 001", "--to", "/r", "--shoot", "x; echo pwned", "--card", "A001"]);
  assert.deepEqual(dit.argv(a, { dryRun: true }).slice(-1), ["--dry-run"]);
  const r = dit.validateArgs({ subcommand: "rename", dir: "/f", shoot: "S", cameras: ["ILME-FX3A=A-FX3A"], clock_offsets: ["ILME-FX3A=-12h"], apply: true });
  assert.ok(dit.argv(r).includes("--apply"));
  assert.ok(!dit.argv(r, { dryRun: true }).includes("--apply"), "the plan run never applies");
});

test("only offload, rename --apply and undo count as writes", () => {
  const w = (args) => dit.writesMedia(dit.validateArgs(args));
  assert.equal(w({ subcommand: "offload", sources: ["/a"], destinations: ["/d"] }), true);
  assert.equal(w({ subcommand: "offload", sources: ["/a"], destinations: ["/d"], dry_run: true }), false);
  assert.equal(w({ subcommand: "rename", dir: "/a" }), false);
  assert.equal(w({ subcommand: "rename", dir: "/a", apply: true }), true);
  assert.equal(w({ subcommand: "undo", dir: "/a" }), true);
  for (const s of ["verify", "inventory", "manifest", "report"]) assert.equal(w({ subcommand: s, dir: "/a" }), false, s);
});

test("the CLI is found on PATH, in installer folders and in npm's package folder", () => {
  const seen = new Set(["C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@nolgia\\cli\\vendor\\nolgia.exe"]);
  const found = dit.locateCli({ APPDATA: "C:\\Users\\x\\AppData\\Roaming", USERPROFILE: "C:\\Users\\x", PATH: "C:\\Windows" }, "win32", (p) => seen.has(p));
  assert.equal(found, [...seen][0]);
  assert.equal(dit.locateCli({ HOME: "/Users/x", PATH: "/usr/bin" }, "darwin", (p) => p === "/opt/homebrew/bin/nolgia"), "/opt/homebrew/bin/nolgia");
  assert.equal(dit.locateCli({ HOME: "/Users/x", PATH: "" }, "darwin", () => false), null);
});

function controllerStub() {
  const ctl = Object.create(Controller.prototype);
  ctl.asked = [];
  ctl.askPerson = async (command, request) => {
    ctl.asked.push(request);
    if (ctl.deny) throw new c.CommandError("The person clicked Deny, so this did not run.");
  };
  return ctl;
}

function command(args) {
  return { args: c.validate(APPS.PPRO, "dit", args), requester: "The NOLGIA Agent", remaining: () => 30 };
}

test("an offload shows the CLI's own plan and waits for Approve before copying", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dit-")), "argv.log");
  await withEnv({ NOLGIA_CLI: FAKE, FAKE_LOG: log }, async () => {
    const ctl = controllerStub();
    const res = await Controller.prototype.do_dit.call(ctl, command({ subcommand: "offload", sources: ["/cards/A001"], destinations: ["/drives/one"], shoot: "SHOOT" }));
    assert.equal(ctl.asked.length, 1);
    assert.match(ctl.asked[0].title, /copy 2 files \(2\.00 GB\)/);
    assert.ok(ctl.asked[0].lines.some((l) => l.includes("Nothing at a destination is replaced")));
    assert.equal(res.exit_code, 0);
    assert.equal(res.result.status, "complete");
    const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(runs[0].includes("--dry-run"), "the plan comes from a dry run first");
    assert.ok(!runs[1].includes("--dry-run"), "the copy runs only after approval");
  });
});

test("a denied offload never starts the copy", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dit-")), "argv.log");
  await withEnv({ NOLGIA_CLI: FAKE, FAKE_LOG: log }, async () => {
    const ctl = controllerStub();
    ctl.deny = true;
    await assert.rejects(Controller.prototype.do_dit.call(ctl, command({ subcommand: "offload", sources: ["/c"], destinations: ["/d"] })), /Deny/);
    const runs = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(runs.length, 1, "only the dry run ran");
  });
});

test("a conflict at a destination is refused before anyone is asked", async () => {
  await withEnv({ NOLGIA_CLI: FAKE, FAKE_CONFLICT: "1", FAKE_LOG: undefined }, async () => {
    const ctl = controllerStub();
    await assert.rejects(
      Controller.prototype.do_dit.call(ctl, command({ subcommand: "offload", sources: ["/c"], destinations: ["/d"] })),
      /never replaces a file/
    );
    assert.equal(ctl.asked.length, 0);
  });
});

test("read-only work needs no approval, and a mismatch comes back with exit 68 and its meaning", async () => {
  await withEnv({ NOLGIA_CLI: FAKE, FAKE_LOG: undefined }, async () => {
    const ctl = controllerStub();
    const res = await Controller.prototype.do_dit.call(ctl, command({ subcommand: "verify", dir: "/drives/one/SHOOT/A001" }));
    assert.equal(ctl.asked.length, 0);
    assert.equal(res.exit_code, 68);
    assert.match(res.meaning, /does not match/);
  });
});

test("long work returns a job to follow with status", async () => {
  await withEnv({ NOLGIA_CLI: FAKE, FAKE_SLOW: "1500", FAKE_LOG: undefined }, async () => {
    const ctl = controllerStub();
    const cmd = command({ subcommand: "inventory", dir: "/drives/one/SHOOT" });
    cmd.remaining = () => 5.5; // waits ~0.5 s, then hands back a job
    const res = await Controller.prototype.do_dit.call(ctl, cmd);
    assert.equal(res.running, true);
    await new Promise((r) => setTimeout(r, 1800));
    const done = await Controller.prototype.do_dit.call(ctl, { args: c.validate(APPS.PPRO, "dit", { action: "status", job_id: res.job_id }), remaining: () => 30 });
    assert.equal(done.running, false);
    assert.equal(done.result.status, "ok");
  });
});

test("without the CLI the answer says how to install it", async () => {
  await withEnv({ NOLGIA_CLI: "/nope/nolgia", PATH: "", HOME: "/nonexistent-home", APPDATA: undefined, LOCALAPPDATA: undefined }, async () => {
    const ctl = controllerStub();
    await assert.rejects(Controller.prototype.do_dit.call(ctl, command({ subcommand: "verify", dir: "/x" })), /npm install -g @nolgia\/cli/);
  });
});
