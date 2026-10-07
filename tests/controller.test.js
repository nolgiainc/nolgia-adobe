// SPDX-License-Identifier: GPL-3.0-or-later
// The controller end to end against the mock API, with a fake app standing
// in for After Effects (the ExtendScript side is tested in the real apps by
// e2e_adobe.py).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { Controller } = require("../core/controller");
const settings = require("../core/settings");

let server;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

// A stand-in for the app: `handlers[kind](args)` answers __nolgia.call.
function fakeHost(handlers = {}, hostId = "AEFT") {
  const root = support.tempDir();
  const host = {
    hostId,
    userData: path.join(root, "userData"),
    documents: path.join(root, "Documents"),
    root,
    calls: [],
    opened: [],
    panels: 0,
    states: [],
    converted: [],
    async call(kind, args) {
      this.calls.push([kind, args]);
      const fn = handlers[kind];
      if (!fn) {
        if (kind === "snapshot") return { ok: true, result: { document: { name: "" }, dirty: false, app_version: "25.6x101" } };
        return { ok: false, error: "no handler for " + kind };
      }
      try {
        return { ok: true, result: await fn(args, this) };
      } catch (err) {
        return { ok: false, error: err.message, result: err.result };
      }
    },
    async convertImage(src, dest, opts) {
      this.converted.push(opts);
      // Pretend to scale: PNGs keep their size, JPEGs shrink with quality.
      const data = fs.readFileSync(src);
      const size = opts.format === "jpeg" ? Math.floor(data.length * (opts.quality || 0.9) * 0.5) : data.length;
      fs.writeFileSync(dest, Buffer.alloc(Math.max(1, size), 7));
      return { width: opts.width || 640, height: Math.round(((opts.width || 640) * 9) / 16) };
    },
    openURL(url) {
      this.opened.push(url);
    },
    openPanel() {
      this.panels += 1;
    },
    broadcast(state) {
      this.states.push(state);
    },
    log() {},
  };
  fs.mkdirSync(host.documents, { recursive: true });
  return host;
}

function controllerFor(host, env = {}) {
  return new Controller(host, {
    environ: Object.assign({ NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_BRIDGE_AUTOCONNECT: "1" }, env),
  });
}

async function connected(ctl) {
  ctl.start();
  await support.until(() => ctl.worker && ctl.worker.state === "connected", 10, "connected");
  return ctl;
}

async function finish(ctl) {
  const worker = ctl.worker;
  ctl.disconnect();
  if (worker) await worker.finished.wait(10);
}

async function command(kind, args, opts) {
  const id = await support.enqueue(server, "after_effects", kind, args, opts);
  for (;;) {
    const cmd = await support.waitCommand(server, id, 10);
    if (cmd.status !== "queued" && cmd.status !== "running") return cmd;
  }
}

test("starts connected from NOLGIA_TOKEN and answers info", async () => {
  const host = fakeHost({ info: () => ({ app_version: "25.6x101", comps: [] }) });
  const ctl = await connected(controllerFor(host, { NOLGIA_ASK_BEFORE_RUN: "0", NOLGIA_ALLOW_AGENT: "0" }));
  assert.equal(ctl.settings.get("allow_agent"), false);
  const cmd = await command("info");
  assert.equal(cmd.status, "succeeded");
  assert.deepEqual(cmd.result, { app: "after_effects", app_version: "25.6x101", comps: [] });
  // The activity says Done once NOLGIA has answered the result, a moment after it stored it.
  await support.until(() => ctl.state().activity[0].label === "Done", 10, "activity done");
  const st = ctl.state();
  assert.equal(st.signed_in, true);
  assert.equal(st.env_token, true);
  assert.equal(st.activity[0].kind, "info");
  await finish(ctl);
  // The environment's token is never saved.
  assert.equal(ctl.settings.get("token"), "");
});

test("run returns value and output, and code errors come back with them", async () => {
  const host = fakeHost({
    run: (args) => {
      if (args.code === "boom") {
        const err = new Error("TypeError on line 1: boom");
        err.result = { value: null, stdout: "before\n", stderr: "" };
        throw err;
      }
      return { value: { n: 2 }, stdout: "hi\n", stderr: "" };
    },
  });
  const ctl = await connected(controllerFor(host));
  const ok = await command("run", { code: "1+1" });
  assert.deepEqual(ok.result, { value: { n: 2 }, stdout: "hi\n", stderr: "" });
  const bad = await command("run", { code: "boom" });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "TypeError on line 1: boom");
  assert.deepEqual(bad.result, { value: null, stdout: "before\n", stderr: "" });
  const python = await command("run", { code: "x", language: "python" });
  assert.match(python.error, /After Effects runs ExtendScript only/);
  await finish(ctl);
});

test("Ask before running code: approve, deny, and nobody there", async () => {
  const host = fakeHost({ run: () => ({ value: 1, stdout: "", stderr: "" }) });
  const ctl = await connected(controllerFor(host, { NOLGIA_ASK_BEFORE_RUN: "1" }));
  const approveOne = async (decision) => {
    const pending = command("run", { code: "app.project.save();\nresult = 1;" }, { caller: "agent" });
    await support.until(() => ctl.approvals.length === 1, 10, "approval");
    const p = ctl.state().approvals[0];
    assert.equal(p.title, "Your NOLGIA Agent wants to run ExtendScript in After Effects");
    assert.deepEqual(p.lines, ["app.project.save();", "result = 1;"]);
    assert.equal(ctl.statusLine(), "Waiting for you to approve a request.");
    ctl.action({ action: decision, id: p.id });
    return pending;
  };
  assert.equal((await approveOne("approve")).status, "succeeded");
  assert.ok(host.panels >= 1, "the panel was opened to ask");
  const denied = await approveOne("deny");
  assert.equal(denied.status, "failed");
  assert.equal(denied.error, "The person at After Effects clicked Deny, so this did not run.");
  const late = await command("run", { code: "1" }, { timeout: 5 });
  assert.equal(late.status, "failed");
  assert.equal(late.error, "Nobody approved this in After Effects in time, so it did not run.");
  assert.equal(host.calls.filter(([k]) => k === "run").length, 1);
  await finish(ctl);
});

test("preview uploads a PNG, or a JPEG when the PNG is too big", async () => {
  const host = fakeHost({
    preview: (args) => {
      const file = path.join(args.folder, "frame.png");
      fs.writeFileSync(file, Buffer.alloc(args.width === 99 ? 5000 : 800, 1));
      return { path: file, width: 1920, height: 1080, frame: 12, comp: "Main", label: "Main", background: "#101010" };
    },
  });
  const ctl = await connected(controllerFor(host, { NOLGIA_PREVIEW_MAX_BYTES: "3000" }));
  const small = await command("preview", { comp: "Main", frame: 12 });
  assert.equal(small.status, "succeeded");
  assert.equal(small.result.mime_type, "image/png");
  assert.equal(small.result.comp, "Main");
  assert.equal(small.result.frame, 12);
  assert.equal(host.converted[0].width, 1280); // default width: at most 1280
  assert.equal(host.converted[0].background, "#101010");
  const big = await command("preview", { width: 99 });
  assert.equal(big.result.mime_type, "image/jpeg");
  const bytes = await support.assetBytes(server, big.result.asset_id);
  assert.ok(bytes.length <= 3000);
  const st = await support.state(server);
  assert.ok(st.uploads.some((u) => u.filename.endsWith("-preview-0012.png")));
  await finish(ctl);
});

test("import_asset downloads next to the project and converts WebP to PNG", async () => {
  const host = fakeHost({
    snapshot: (args, h) => ({ document: { name: "shot.aep", path: path.join(h.documents, "shot.aep") }, dirty: false }),
    import: (args) => {
      assert.ok(fs.existsSync(args.path), "file is on disk before the app imports it");
      return { imported: [path.basename(args.path)], item_id: 5 };
    },
  });
  const ctl = await connected(controllerFor(host));
  const png = await support.seedAsset(server, "plate.png", "image/png", support.png());
  const done = await command("import_asset", { asset_id: png.id, as: "layer" });
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.kind, "image");
  assert.equal(done.result.path, path.join(host.documents, "nolgia_assets", png.id, "plate.png"));
  const webp = await support.seedAsset(server, "sky.webp", "image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 data"));
  const w = await command("import_asset", { asset_id: webp.id });
  assert.equal(path.extname(w.result.path), ".png");
  assert.equal(host.converted.pop().format, "png");
  const missing = await command("import_asset", { asset_id: "3f1c2d10-0000-4000-8000-000000000000" });
  assert.match(missing.error, /no asset/);
  const importCall = host.calls.find(([k]) => k === "import");
  assert.equal(importCall[1].as, "layer");
  await finish(ctl);
});

test("export renders, uploads and cleans up; project files stay local", async () => {
  const project = path.join(support.tempDir(), "shot.aep");
  fs.writeFileSync(project, "aep bytes");
  const host = fakeHost({
    snapshot: () => ({ document: { name: "shot.aep", path: project }, dirty: true }),
    export: (args) => {
      const file = path.join(args.folder, args.stem + "." + args.format);
      fs.writeFileSync(file, "video");
      return { path: file, comp: "Main", frames: args.frames || [0, 47] };
    },
    project_file: () => ({ path: project, dirty: true }),
  });
  const ctl = await connected(controllerFor(host));
  const mp4 = await command("export", { format: "mp4", frames: "0-47" });
  assert.equal(mp4.status, "succeeded");
  assert.equal(mp4.result.filename, "shot.mp4");
  assert.deepEqual(mp4.result.frames, [0, 47]);
  assert.equal((await support.assetBytes(server, mp4.result.asset_id)).toString(), "video");
  const exportCall = host.calls.find(([k]) => k === "export");
  assert.equal(fs.existsSync(exportCall[1].folder), false, "temp folder removed");
  const aep = await command("export", { format: "aep" });
  assert.equal(aep.result.asset_id, null);
  assert.equal(aep.result.path, path.join(path.dirname(project), "shot-copy.aep"));
  assert.match(aep.result.note, /as last saved/);
  const again = await command("export", { format: "aep" });
  assert.notEqual(again.result.path, aep.result.path, "never over an existing file");
  assert.equal(fs.readFileSync(again.result.path, "utf8"), "aep bytes");
  await finish(ctl);
});

test("an image opened as a document is saved as .ai next to it, not copied", async () => {
  const folder = support.tempDir();
  const image = path.join(folder, "poster.png");
  fs.writeFileSync(image, support.png());
  const host = fakeHost(
    {
      snapshot: () => ({ document: { name: "poster.png", path: image }, dirty: false }),
      project_file: () => ({ path: image, dirty: false }),
      save: (args) => ({ path: args.path }),
    },
    "ILST"
  );
  const ctl = new Controller(host, {
    environ: { NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_BRIDGE_AUTOCONNECT: "1" },
  });
  ctl.start();
  await support.until(() => ctl.worker && ctl.worker.state === "connected", 10, "connected");
  const id = await support.enqueue(server, "illustrator", "export", { format: "ai" });
  let cmd;
  do cmd = await support.waitCommand(server, id, 10);
  while (cmd.status === "queued" || cmd.status === "running");
  assert.equal(cmd.status, "succeeded", cmd.error);
  assert.equal(cmd.result.path, path.join(folder, "poster.ai"));
  assert.match(cmd.result.note, /was a \.png file, so it is now saved as \.ai next to it/);
  assert.deepEqual(fs.readdirSync(folder), ["poster.png"], "the image is not copied");
  await finish(ctl);
});

test("save resolves paths next to the project; open over unsaved changes asks first", async () => {
  const folder = support.tempDir();
  const other = path.join(folder, "other.aep");
  fs.writeFileSync(other, "x");
  const host = fakeHost({
    snapshot: () => ({ document: { name: "shot.aep", path: path.join(folder, "shot.aep") }, dirty: true }),
    save: (args) => ({ path: args.path || path.join(folder, "shot.aep") }),
    open_check: () => ({ loses_changes: true }),
    open: (args) => ({ path: args.path }),
  });
  const ctl = await connected(controllerFor(host));
  assert.equal((await command("save", {})).result.path, path.join(folder, "shot.aep"));
  assert.equal((await command("save", { path: "v2" })).result.path, path.join(folder, "v2.aep"));
  const pending = command("open", { path: other });
  await support.until(() => ctl.approvals.length === 1, 10, "approval");
  assert.equal(ctl.approvals[0].approveLabel, "Open and lose changes");
  ctl.action({ action: "approve", id: ctl.approvals[0].id });
  assert.equal((await pending).result.path, other);
  const nothing = await command("open", { path: path.join(folder, "nope.aep") });
  assert.match(nothing.error, /There is no file at/);
  await finish(ctl);
});

test("sign in with the device flow, then sign out", async () => {
  const host = fakeHost({}, "ILST");
  const ctl = new Controller(host, { environ: { NOLGIA_API_URL: server.base } });
  ctl.start();
  assert.equal(ctl.statusLine(), "Not signed in.");
  ctl.action({ action: "sign_in" });
  await support.until(() => host.opened.length === 1, 10, "browser opened");
  const code = ctl.state().login.user_code;
  assert.ok(host.opened[0].includes(code));
  assert.match(ctl.statusLine(), /Enter code .* in your browser/);
  await support.call(server, "POST", "/mock/device/approve", { user_code: code }, { token: null });
  await support.until(() => ctl.worker && ctl.worker.state === "connected", 15, "connected");
  const saved = new settings.Settings(settings.appDir(host.userData, "illustrator"));
  assert.match(saved.get("token"), /^nol_mock_/);
  assert.equal(saved.get("connected"), true);
  await support.until(() => ctl.accountEmail() === "test@nolgia.ai", 5, "email");
  const worker = ctl.worker;
  ctl.action({ action: "sign_out" });
  await worker.finished.wait(10);
  assert.equal(ctl.settings.get("token"), "");
  assert.equal(ctl.settings.get("connected"), false);
  assert.equal(ctl.statusLine(), "Signed out.");
  const st = await support.state(server);
  assert.equal(st.deleted_sessions.length, 1);
});

test("Pause switches off and on; a refused token signs out", async () => {
  const host = fakeHost({});
  const ctl = await connected(controllerFor(host));
  const worker = ctl.worker;
  ctl.action({ action: "pause" });
  await worker.finished.wait(10);
  assert.equal(ctl.connected, false);
  assert.match(ctl.statusLine(), /Switched off/);
  ctl.action({ action: "pause" });
  await support.until(() => ctl.worker && ctl.worker.state === "connected", 10, "resumed");
  await finish(ctl);
  const bad = controllerFor(fakeHost({}), { NOLGIA_TOKEN: "revoked" });
  bad.start();
  await support.until(() => !bad.worker && bad.message, 10, "signed out");
  assert.equal(bad.message, "NOLGIA did not accept your sign in. Sign in again.");
  assert.equal(bad.signedIn, false);
});
