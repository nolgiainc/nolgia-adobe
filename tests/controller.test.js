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

function controllerFor(host, env = {}, clock = undefined) {
  return new Controller(host, {
    environ: Object.assign({ NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_BRIDGE_AUTOCONNECT: "1" }, env),
    clock,
  });
}

// An After Effects project as the plugin sees it: a file on disk (or none
// yet), what is in memory, and whether that is saved. save without a path
// saves in place; with a path it is Save As (the open project moves).
// `code` is what a run makes the project hold; "boom" fails after changing it.
function aeProject(file, { dirty = false, onDisk = "as saved", inMemory = null } = {}) {
  const p = { file, dirty, memory: inMemory || onDisk, saves: [] };
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, onDisk);
  }
  p.handlers = {
    snapshot: () => ({ document: p.file ? { name: path.basename(p.file), path: p.file } : { name: "" }, dirty: p.dirty }),
    project_file: () => ({ path: p.file, dirty: p.dirty }),
    info: () => ({ app_version: "25.6x101", document: p.file ? { name: path.basename(p.file), path: p.file, dirty: p.dirty } : { name: "" } }),
    save: (args) => {
      if (args.path) p.file = args.path;
      if (!p.file) throw new Error("This project has never been saved");
      fs.writeFileSync(p.file, p.memory);
      p.dirty = false;
      p.saves.push(args.path ? "save as " + path.basename(args.path) : "in place");
      return { path: p.file };
    },
    run: async (args) => {
      if (args.code.startsWith("slow:")) await new Promise((r) => setTimeout(r, Number(args.code.slice(5))));
      p.memory = args.code;
      p.dirty = true;
      if (args.code === "boom") {
        const err = new Error("TypeError on line 1: boom");
        err.result = { value: null, stdout: "", stderr: "" };
        throw err;
      }
      return { value: 1, stdout: "", stderr: "" };
    },
  };
  return p;
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
  // After Effects says "25.6x101"; the info result reads it the same way the session does.
  // nolgia_work: where NOLGIA's saved work and backups are (nothing yet).
  assert.deepEqual(cmd.result, {
    app: "after_effects",
    app_version: "25.6 (build 101)",
    comps: [],
    nolgia_work: { save_after_change: true, last: null },
  });
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

test("the panel is told when a command finishes, not only when the next one starts", async () => {
  const host = fakeHost({ save: () => ({ path: "C:\\shots\\shot.aep" }), project_file: () => ({ path: "C:\\shots\\shot.aep", dirty: true }) });
  const ctl = await connected(controllerFor(host, { NOLGIA_ASK_BEFORE_RUN: "0" }));
  // A real network takes longer to accept the result than the panel's 50 ms
  // repaint delay; slow the mock down the same way.
  const api = ctl.worker.api;
  const postResult = api.postResult.bind(api);
  api.postResult = async (...a) => {
    await new Promise((r) => setTimeout(r, 400));
    return postResult(...a);
  };
  try {
    const cmd = await command("save", {});
    assert.equal(cmd.status, "succeeded");
    // What the panel last received, not what ctl.state() would say if asked:
    // it must show Done and drop "Working on save..." without another command.
    const last = () => host.states[host.states.length - 1];
    await support.until(() => last() && last().activity[0] && last().activity[0].label === "Done", 10, "broadcast done");
    assert.ok(!/Working on/.test(last().status), last().status);
  } finally {
    await finish(ctl);
  }
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
  // (Saving after a change has its own tests below.)
  const ctl = await connected(controllerFor(host, { NOLGIA_SAVE_AFTER_CHANGE: "0" }));
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
    assert.equal(p.plain, false, "code shows as code");
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

test("import_asset brings a keep-me render's matte in as its own layer in After Effects", async () => {
  const host = fakeHost({
    snapshot: (args, h) => ({ document: { name: "shot.aep", path: path.join(h.documents, "shot.aep") }, dirty: false }),
    import: (args) => ({ imported: [path.basename(args.path)], item_id: 9, layer: args.name, layer_index: 1 }),
  });
  const ctl = await connected(controllerFor(host));
  const mp4 = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.from(bytes)]);
  const matte = await support.call(server, "POST", "/mock/assets?filename=Walk%20matte.mp4&content_type=video/mp4", mp4("the grey matte"), { token: null });
  const result = await support.call(server, "POST",
    "/mock/assets?filename=Walk.mp4&content_type=video/mp4&matte_layer_asset_id=" + matte.body.id, mp4("the composite"), { token: null });
  const done = await command("import_asset", { asset_id: result.body.id, as: "layer" });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.result.matte.asset_id, matte.body.id);
  const imports = host.calls.filter(([k]) => k === "import").map(([, a]) => a);
  assert.equal(imports.length, 2);
  assert.equal(imports[1].matte_for, 1, "the matte goes right above the result the same import added");
  assert.equal(imports[1].name, "Walk matte");
  assert.ok(fs.readFileSync(imports[1].path).includes("the grey matte"));
  // Asked without it: only the result.
  host.calls.length = 0;
  const alone = await command("import_asset", { asset_id: result.body.id, as: "layer", with_matte: false });
  assert.equal(alone.result.matte, undefined);
  assert.equal(host.calls.filter(([k]) => k === "import").length, 1);
  await finish(ctl);
});

test("import_asset brings a 4:4:4 original in as its H.264 copy, and an HEVC original as it is", async () => {
  const host = fakeHost({
    snapshot: (args, h) => ({ document: { name: "cut.prproj", path: path.join(h.documents, "cut.prproj") }, dirty: false }),
    import: (args) => ({ imported: [path.basename(args.path)], item_id: 7 }),
  });
  const ctl = await connected(controllerFor(host));
  const qt = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  "), Buffer.from(bytes)]);
  const mp4 = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.from(bytes)]);
  // Seedance 2.5's 720p original: H.264 High 4:4:4 in a QuickTime file.
  const four = await support.call(server, "POST",
    "/mock/assets?filename=" + encodeURIComponent("Runner.mov") + "&content_type=video/quicktime&original_pix_fmt=yuv444p&playback=" +
      encodeURIComponent("AAAAftypisomthe H.264 copy"),
    qt("the 4:4:4 original"), { token: null });
  const done = await command("import_asset", { asset_id: four.body.id });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.result.kind, "video");
  assert.equal(done.result.compatible_copy, true);
  assert.equal(path.extname(done.result.path), ".mp4");
  assert.ok(fs.readFileSync(done.result.path).includes("the H.264 copy"), "the copy, not the 4:4:4 original, is imported");
  // An HEVC 10-bit original imports as the model made it.
  const hevc = await support.call(server, "POST",
    "/mock/assets?filename=" + encodeURIComponent("Kitchen.mp4") + "&content_type=video/mp4&original_codec=hevc&original_pix_fmt=yuv420p10le&playback=AAAAftypisomcopy",
    mp4("the HEVC original"), { token: null });
  const kept = await command("import_asset", { asset_id: hevc.body.id });
  assert.equal(kept.status, "succeeded", JSON.stringify(kept));
  assert.equal(kept.result.compatible_copy, undefined);
  assert.ok(fs.readFileSync(kept.result.path).includes("the HEVC original"));
  await finish(ctl);
});

test("import_asset installs a color preset where Lumetri finds it: looks in Creative, log variants in Technical", async () => {
  const host = fakeHost();
  const luts = path.join(host.root, "LUTs");
  const ctl = await connected(controllerFor(host, { NOLGIA_LUT_DIR: luts }));
  try {
    const look = await command("import_asset", { color_preset: "kodak-portra-400" });
    assert.equal(look.status, "succeeded", look.error);
    assert.equal(look.result.kind, "lut");
    assert.equal(look.result.lut, "NOLGIA Kodak Portra 400");
    assert.equal(look.result.path, path.join(luts, "Creative", "NOLGIA Kodak Portra 400.cube"));
    assert.equal(look.result.menu, "Lumetri Color > Creative > Look");
    assert.equal(look.result.relaunch_needed, true);
    assert.match(fs.readFileSync(look.result.path, "utf8"), /^TITLE "Nolgia Kodak Portra 400"\nLUT_3D_SIZE 5/);

    const log = await command("import_asset", { color_preset: "kodak-portra-400-slog3", apply_to: "all" });
    assert.equal(log.status, "succeeded", log.error);
    assert.equal(log.result.path, path.join(luts, "Technical", "NOLGIA Kodak Portra 400 (S-Log3).cube"));
    assert.equal(log.result.menu, "Lumetri Color > Basic Correction > Input LUT");
    assert.match(log.result.note, /converts S-Log3 footage to Rec.709/);
    // Not applied: Premiere's scripting cannot set a LUT on clips, and it says so.
    assert.deepEqual(log.result.applied_to, []);
    assert.match(log.result.apply_note, /installed but not applied/);

    // Again: the preset replaces its own copy, no second file.
    const again = await command("import_asset", { color_preset: "kodak-portra-400" });
    assert.equal(again.status, "succeeded");
    assert.deepEqual(fs.readdirSync(path.join(luts, "Creative")), ["NOLGIA Kodak Portra 400.cube"]);

    const missing = await command("import_asset", { color_preset: "no-such-stock" });
    assert.equal(missing.status, "failed");
    assert.match(missing.error, /no color preset named no-such-stock.*-slog3/s);
    // Nothing was handed to the app: installing a LUT is a file in a folder.
    assert.equal(host.calls.filter(([k]) => k === "import").length, 0);
  } finally {
    await finish(ctl);
  }
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
  const project = aeProject(path.join(folder, "shot.aep"), { dirty: true });
  const host = fakeHost(
    Object.assign(project.handlers, {
      open_check: () => ({ loses_changes: true }),
      open: (args) => ({ path: args.path }),
    })
  );
  const ctl = await connected(controllerFor(host));
  assert.equal((await command("save", {})).result.path, path.join(folder, "shot.aep"));
  const v2 = (await command("save", { path: "v2" })).result;
  assert.equal(v2.path, path.join(folder, "shot.aep"), "the project stays on its own file");
  assert.equal(v2.copy, path.join(folder, "v2.aep"));
  const pending = command("open", { path: other });
  await support.until(() => ctl.approvals.length === 1, 10, "approval");
  assert.equal(ctl.approvals[0].approveLabel, "Open and lose changes");
  assert.equal(ctl.state().approvals[0].plain, true, "opening a project is not code");
  ctl.action({ action: "approve", id: ctl.approvals[0].id });
  assert.equal((await pending).result.path, other);
  const nothing = await command("open", { path: path.join(folder, "nope.aep") });
  assert.match(nothing.error, /There is no file at/);
  await finish(ctl);
});

test("every answer and every ignored click from the panel is logged with its request", async () => {
  // The panel's buttons answer only a deliberate click (js/panel.js, the
  // owner's Mac test 3); the service logs what it was sent.
  const host = fakeHost({ run: () => ({ value: 1 }) });
  const lines = [];
  host.log = (text) => lines.push(text);
  const ctl = await connected(controllerFor(host, { NOLGIA_ASK_BEFORE_RUN: "1" }));
  const pending = command("run", { code: "1" });
  await support.until(() => ctl.approvals.length === 1, 10, "approval");
  const id = ctl.approvals[0].id;
  ctl.action({ action: "ignored_click", id, label: "Run code", why: "it came before the request's buttons were on" });
  assert.equal(ctl.approvals.length, 1, "an ignored click answers nothing");
  ctl.action({ action: "approve", id: "some-other-request", label: "Run code" });
  assert.equal(ctl.approvals.length, 1, "an answer for another request answers nothing");
  ctl.action({ action: "approve", id, label: "Run code" });
  assert.equal((await pending).status, "succeeded");
  assert.ok(lines.includes("NOLGIA: Ignored a click on Run code for request " + id + ": it came before the request's buttons were on."), lines);
  assert.ok(lines.includes("NOLGIA: The person clicked Run code for request some-other-request, which was no longer waiting."), lines);
  assert.ok(lines.includes("NOLGIA: The person clicked Run code for request " + id + "."), lines);
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

test("a change backs the project up first and saves it in place after, never Save As", async () => {
  const folder = support.tempDir();
  const file = path.join(folder, "shot.aep");
  const project = aeProject(file);
  const host = fakeHost(project.handlers);
  let now = Date.UTC(2026, 10, 6, 1, 4, 41) / 1000;
  const ctl = await connected(controllerFor(host, {}, () => now));
  try {
    const first = await command("run", { code: "keyed" });
    assert.equal(first.status, "succeeded", first.error);
    assert.equal(first.result.value, 1);
    assert.equal(first.result.saved.path, file);
    assert.equal(first.result.backups.length, 1);
    const backup = first.result.backups[0];
    assert.equal(path.dirname(backup), path.join(folder, "NOLGIA backups"));
    assert.equal(fs.readFileSync(backup, "utf8"), "as saved", "the backup is the project before NOLGIA's change");
    assert.equal(fs.readFileSync(file, "utf8"), "keyed", "the change is saved in the person's own file");
    assert.deepEqual(project.saves, ["in place"]);

    // The same stretch of work: saved again, no second backup.
    now += 60;
    const second = await command("run", { code: "graded" });
    assert.equal(second.result.backups, undefined);
    assert.equal(fs.readFileSync(file, "utf8"), "graded");
    // A failed run may have changed things before it failed: saved too.
    now += 60;
    const failed = await command("run", { code: "boom" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "TypeError on line 1: boom");
    assert.equal(failed.result.saved.path, file);
    assert.equal(fs.readFileSync(file, "utf8"), "boom");
    assert.deepEqual(project.saves, ["in place", "in place", "in place"]);
    assert.ok(!project.saves.some((s) => s.startsWith("save as")), "never Save As");

    // After ten quiet minutes the next change makes a new backup.
    now += 11 * 60;
    const later = await command("run", { code: "later" });
    assert.equal(later.result.backups.length, 1);
    assert.equal(fs.readFileSync(later.result.backups[0], "utf8"), "boom");

    // Where the work is, for the agent and for the panel.
    const info = await command("info");
    const w = info.result.nolgia_work;
    assert.equal(w.save_after_change, true);
    assert.equal(w.last.project, file);
    assert.equal(w.last.open_now, true);
    assert.equal(w.last.backups[0].path, later.result.backups[0]);
    assert.equal(w.last.steps, 4);
    const panel = ctl.state().work;
    assert.equal(panel.last.name, "shot.aep");
    assert.equal(panel.last.backup, later.result.backups[0]);
  } finally {
    await finish(ctl);
  }
});

test("unsaved changes from before NOLGIA are saved and kept in a second backup", async () => {
  const folder = support.tempDir();
  const file = path.join(folder, "shot.aep");
  const project = aeProject(file, { dirty: true, onDisk: "as saved", inMemory: "his own edit" });
  const ctl = await connected(controllerFor(fakeHost(project.handlers)));
  try {
    const done = await command("run", { code: "keyed" });
    assert.equal(done.status, "succeeded", done.error);
    const [asSaved, withEdits] = done.result.backups;
    assert.equal(fs.readFileSync(asSaved, "utf8"), "as saved");
    assert.match(path.basename(withEdits), /\(with unsaved changes\)\.aep$/);
    assert.equal(fs.readFileSync(withEdits, "utf8"), "his own edit");
    assert.equal(fs.readFileSync(file, "utf8"), "keyed");
  } finally {
    await finish(ctl);
  }
});

test("a project that was never saved is saved into NOLGIA projects, and the person is told", async () => {
  const project = aeProject(null);
  const host = fakeHost(project.handlers);
  const ctl = await connected(controllerFor(host));
  try {
    const done = await command("run", { code: "a comp" });
    assert.equal(done.status, "succeeded", done.error);
    const folder = path.join(host.documents, "NOLGIA projects");
    assert.equal(path.dirname(done.result.saved.path), folder);
    assert.match(path.basename(done.result.saved.path), /^Untitled \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.aep$/);
    assert.equal(fs.readFileSync(done.result.saved.path, "utf8"), "a comp");
    assert.match(done.result.notes[0], /had never been saved: NOLGIA saved it as .*NOLGIA projects/);
    assert.match(ctl.state().work.notice.text, /saved it as .*Untitled/);
    assert.deepEqual(project.saves, [project.saves[0], "in place"]);
    assert.match(project.saves[0], /^save as Untitled /);
  } finally {
    await finish(ctl);
  }
});

test("with Save after NOLGIA's changes off nothing is saved or backed up", async () => {
  const folder = support.tempDir();
  const project = aeProject(path.join(folder, "shot.aep"));
  const ctl = await connected(controllerFor(fakeHost(project.handlers), { NOLGIA_SAVE_AFTER_CHANGE: "0" }));
  try {
    const done = await command("run", { code: "keyed" });
    assert.equal(done.status, "succeeded");
    assert.equal(done.result.saved, undefined);
    assert.deepEqual(project.saves, []);
    assert.ok(!fs.existsSync(path.join(folder, "NOLGIA backups")));
    assert.equal(ctl.state().work.save_after_change, false);
  } finally {
    await finish(ctl);
  }
});

test("when no backup can be made, NOLGIA does not save over the project", async () => {
  const folder = support.tempDir();
  const project = aeProject(path.join(folder, "shot.aep"));
  const host = fakeHost(project.handlers);
  // Files where both backup folders would go.
  fs.writeFileSync(path.join(folder, "NOLGIA backups"), "x");
  fs.writeFileSync(path.join(host.documents, "NOLGIA backups"), "x");
  const ctl = await connected(controllerFor(host));
  try {
    const done = await command("run", { code: "keyed" });
    assert.equal(done.status, "succeeded", "the change itself still runs");
    assert.match(done.result.notes[0], /could not back up shot\.aep .* does not save over it/);
    assert.deepEqual(project.saves, []);
    assert.equal(fs.readFileSync(path.join(folder, "shot.aep"), "utf8"), "as saved");
    assert.equal(ctl.state().work.notice.problem, true);
  } finally {
    await finish(ctl);
  }
});

test("save with a path writes a copy and keeps the project on its file; save_as moves it", async () => {
  const folder = support.tempDir();
  const file = path.join(folder, "shot.aep");
  const project = aeProject(file, { dirty: true, inMemory: "current" });
  const ctl = await connected(controllerFor(fakeHost(project.handlers)));
  try {
    const copy = (await command("save", { path: path.join(folder, "safety") })).result;
    assert.equal(copy.path, file);
    assert.equal(copy.copy, path.join(folder, "safety.aep"));
    assert.equal(fs.readFileSync(copy.copy, "utf8"), "current");
    assert.equal(project.file, file, "the open project did not move");
    const again = (await command("save", { path: path.join(folder, "safety.aep") })).result;
    assert.equal(again.copy, path.join(folder, "safety (2).aep"), "never over a file");
    assert.match(again.note, /already exists, so it is not replaced/);
    const same = (await command("save", { path: file })).result;
    assert.equal(same.path, file);
    assert.equal(same.copy, undefined);
    // Save As by name, over an existing file: that file is backed up first.
    fs.writeFileSync(path.join(folder, "v2.aep"), "someone's v2");
    const moved = (await command("save", { path: path.join(folder, "v2"), save_as: true })).result;
    assert.equal(moved.path, path.join(folder, "v2.aep"));
    assert.equal(project.file, path.join(folder, "v2.aep"));
    assert.equal(fs.readFileSync(moved.backup_of_replaced, "utf8"), "someone's v2");
    assert.match(moved.note, /now open from that file/);
    assert.ok(!project.saves.slice(0, -1).some((s) => s.startsWith("save as")), "only the save_as moved it");
  } finally {
    await finish(ctl);
  }
});

test("save with nothing saved yet puts the project in NOLGIA projects", async () => {
  const project = aeProject(null);
  const host = fakeHost(project.handlers);
  const ctl = await connected(controllerFor(host, { NOLGIA_SAVE_AFTER_CHANGE: "0" }));
  try {
    const done = await command("save", {});
    assert.equal(done.status, "succeeded", done.error);
    assert.equal(path.dirname(done.result.path), path.join(host.documents, "NOLGIA projects"));
    assert.match(done.result.note, /never been saved/);
  } finally {
    await finish(ctl);
  }
});

test("a preview says how big the app rendered it", async () => {
  const host = fakeHost({
    preview: (args) => {
      const file = path.join(args.folder, "frame.png");
      fs.writeFileSync(file, support.png(1280, 720));
      return { path: file, width: 3840, height: 2160, frame: 4, comp: "Main", label: "Main", resolution_factor: 3 };
    },
  });
  const ctl = await connected(controllerFor(host));
  try {
    const shot = await command("preview", {});
    assert.equal(shot.status, "succeeded", shot.error);
    assert.deepEqual(shot.result.rendered, { width: 1280, height: 720, resolution_factor: 3 });
    assert.equal(host.calls.find(([k]) => k === "preview")[1].width, null, "the app picks the factor for the default width");
  } finally {
    await finish(ctl);
  }
});

test("a command waits for code NOLGIA stopped waiting for, instead of piling up behind it, and the save follows", async () => {
  const folder = support.tempDir();
  const file = path.join(folder, "shot.aep");
  const project = aeProject(file);
  const times = {};
  const handlers = Object.assign({}, project.handlers, {
    preview: (args) => {
      times.preview = Date.now();
      const out = path.join(args.folder, "frame.png");
      fs.writeFileSync(out, support.png(64, 36));
      return { path: out, width: 64, height: 36, frame: 0, comp: "Main", label: "Main" };
    },
  });
  const run = handlers.run;
  handlers.run = async (args) => {
    try {
      return await run(args);
    } finally {
      times.runEnded = Date.now();
    }
  };
  const ctl = await connected(controllerFor(fakeHost(handlers)));
  try {
    const slow = await command("run", { code: "slow:2500", timeout_seconds: 1 });
    assert.equal(slow.status, "failed");
    assert.match(slow.error, /still running after 1 s/);
    assert.match(slow.result.notes.join(" "), /saves the project as soon as it ends/);
    const shot = await command("preview", {});
    assert.equal(shot.status, "succeeded", shot.error);
    assert.ok(times.preview >= times.runEnded, "the preview started only once the code had ended");
    await support.until(() => project.saves.includes("in place"), 10, "saved after the code ended");
    assert.equal(fs.readFileSync(file, "utf8"), "slow:2500");
  } finally {
    await finish(ctl);
  }
});
