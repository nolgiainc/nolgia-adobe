// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { APPS } = require("../core/index");
const c = require("../core/commands");

const AE = APPS.AEFT;
const PR = APPS.PPRO;
const AI = APPS.ILST;

test("every app advertises the seven command kinds", () => {
  assert.deepEqual(c.CAPABILITIES, ["info", "run", "preview", "import_asset", "export", "save", "open"]);
});

test("run takes ExtendScript only", () => {
  assert.deepEqual(c.validate(AE, "run", { code: "1+1" }), { language: "extendscript", code: "1+1" });
  assert.deepEqual(c.validate(PR, "run", { code: "x", language: "ExtendScript", timeout_seconds: 5 }), {
    language: "extendscript",
    code: "x",
    timeout_seconds: 5,
  });
  assert.throws(() => c.validate(AI, "run", { code: "x", language: "python" }), /Illustrator runs ExtendScript only/);
  assert.throws(() => c.validate(AE, "run", { code: "  " }), /`code` is required/);
  assert.throws(() => c.validate(AE, "run", { code: "x", timeout_seconds: 0 }), /positive number/);
  assert.throws(() => c.validate(AE, "run", { code: "x", timeout_seconds: true }), /positive number/);
});

test("unknown kinds and bad args say what is possible", () => {
  assert.throws(() => c.validate(AE, "render_farm", {}), /cannot do "render_farm". It can do: info, run/);
  assert.throws(() => c.validate(AE, "info", []), /`args` must be an object/);
});

test("preview takes the app's own name for what it shows, or camera", () => {
  assert.deepEqual(c.validate(AE, "preview", { comp: "Main", frame: 12, width: 640 }), {
    target: "Main",
    frame: 12,
    width: 640,
  });
  assert.equal(c.validate(AE, "preview", { camera: "Shot 010" }).target, "Shot 010");
  assert.equal(c.validate(PR, "preview", { sequence: "Edit" }).target, "Edit");
  assert.equal(c.validate(AI, "preview", { artboard: 2 }).target, 2);
  assert.equal(c.validate(AI, "preview", {}).target, null);
  assert.throws(() => c.validate(AE, "preview", { comp: 3 }), /name of a composition/);
  assert.throws(() => c.validate(AI, "preview", { artboard: 0 }), /its number \(1 is the first\)/);
  assert.throws(() => c.validate(AE, "preview", { width: 4000 }), /at most 1920/);
  assert.throws(() => c.validate(AE, "preview", { width: 8 }), /at least 16/);
  assert.throws(() => c.validate(AE, "preview", { frame: 1.5 }), /whole number/);
});

test("import_asset checks `as` per app", () => {
  assert.deepEqual(c.validate(AE, "import_asset", { asset_id: "a", as: "layer" }), { asset_id: "a", as: "layer" });
  assert.equal(c.validate(AI, "import_asset", { asset_id: "a", as: "link" }).as, "link");
  assert.throws(() => c.validate(PR, "import_asset", { asset_id: "a", as: "layer" }), /must be one of: clip/);
  assert.throws(() => c.validate(AE, "import_asset", {}), /`asset_id` is required/);
});

test("export formats per app, and frames", () => {
  assert.deepEqual(c.validate(AE, "export", { format: "MP4", frames: "0-47" }), {
    format: "mp4",
    frames: [0, 47],
    filename: null,
    target: null,
  });
  assert.equal(c.validate(AE, "export", { format: "aep" }).format, "aep");
  assert.equal(c.validate(PR, "export", { format: ".prproj" }).format, "prproj");
  for (const fmt of ["png", "svg", "pdf", "ai"]) assert.equal(c.validate(AI, "export", { format: fmt }).format, fmt);
  assert.throws(() => c.validate(AI, "export", { format: "mp4" }), /one of: png, svg, pdf, ai/);
  assert.throws(() => c.validate(PR, "export", { format: "glb" }), /one of: mp4, png, prproj/);
  assert.throws(() => c.validate(AE, "export", {}), /`format` is required/);
});

test("parseFrames reads every form the agent may send", () => {
  assert.deepEqual(c.parseFrames(12), [12, 12]);
  assert.deepEqual(c.parseFrames("12"), [12, 12]);
  assert.deepEqual(c.parseFrames(" 0 - 120 "), [0, 120]);
  assert.deepEqual(c.parseFrames([1, 5]), [1, 5]);
  assert.deepEqual(c.parseFrames({ start: 3 }), [3, 3]);
  assert.equal(c.parseFrames(null), null);
  assert.throws(() => c.parseFrames("5-1"), /ends before it starts/);
  assert.throws(() => c.parseFrames("a-b"), /frame number or a range/);
  assert.throws(() => c.parseFrames(true), /frame number or a range/);
  assert.throws(() => c.parseFrames(1.5), /frame number or a range/);
});

test("save and open", () => {
  assert.deepEqual(c.validate(AE, "save", {}), { path: null });
  assert.deepEqual(c.validate(AE, "open", { path: "C:/x.aep" }), { path: "C:/x.aep" });
  assert.throws(() => c.validate(AE, "open", {}), /`path` is required/);
});

test("resultBody keeps results under the API's 1 MB", () => {
  assert.deepEqual(c.resultBody(true, { a: 1 }), { status: "succeeded", result: { a: 1 } });
  assert.deepEqual(c.resultBody(true, null), { status: "succeeded", result: {} });
  assert.deepEqual(c.resultBody(false, null, "bad"), { status: "failed", error: "bad" });
  assert.deepEqual(c.resultBody(false, { stdout: "x" }, null), {
    status: "failed",
    error: "The command failed.",
    result: { stdout: "x" },
  });
  const big = c.resultBody(true, { value: 1, stdout: "x".repeat(2e6), stderr: "" });
  assert.equal(big.status, "succeeded");
  assert.ok(big.result.stdout.length < 20000 && big.result.stdout.startsWith("["));
  const huge = c.resultBody(true, { value: "y".repeat(2e6) });
  assert.equal(huge.status, "failed");
  assert.match(huge.error, /larger than 1 MB/);
  // <, > and & count six bytes each, as Go writes them.
  assert.equal(c.jsonSize({ a: "<>&" }), JSON.stringify({ a: "<>&" }).length + 15);
  assert.ok(c.resultBody(false, null, "e".repeat(100000)).error.length < 70000);
});

test("Command times use the server's clock", () => {
  const cmd = new c.Command(
    {
      id: "x",
      kind: "run",
      caller: "agent",
      args: { code: "1" },
      created_at: "2026-01-01T00:00:00Z",
      claimed_at: "2026-01-01T00:00:10Z",
      expires_at: "2026-01-01T00:02:10Z",
    },
    100
  );
  assert.equal(cmd.timeout, 120);
  assert.equal(cmd.expires, 220);
  assert.equal(cmd.deadline, 217);
  assert.equal(cmd.remaining(200), 17);
  assert.equal(cmd.callerLabel, "NOLGIA Agent");
  assert.equal(new c.Command({ id: "y", timeout_seconds: 30 }).timeout, 30);
  assert.equal(new c.Command({ id: "z" }).timeout, 120);
  assert.equal(new c.Command({ id: "z", caller: "user" }).callerLabel, "you");
  assert.deepEqual(new c.Command({ id: "z", args: [1] }).args, {});
});

test("ActivityLog keeps the last 20, newest first", () => {
  let t = 0;
  const log = new c.ActivityLog(20, () => ++t);
  for (let i = 0; i < 25; i++) log.add("c" + i, "info");
  const items = log.list();
  assert.equal(items.length, 20);
  assert.equal(items[0].id, "c24");
  log.update("c24", "failed", "line one\nline two");
  assert.equal(log.list()[0].detail, "line two");
  const v = log.version;
  log.update("missing", "failed");
  assert.equal(log.version, v);
  log.clear();
  assert.equal(log.list().length, 0);
});
