// SPDX-License-Identifier: GPL-3.0-or-later
// The protocol client against the mock API (tools/mock_bridge_server.py).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { PLUGIN_VERSION } = require("../core/index");
const { ApiClient, ApiError, NetworkError, Unauthorized, normalizeBaseUrl } = require("../core/api");
const { CAPABILITIES } = require("../core/commands");

function registerBody(instanceId = "inst-1", extra = {}) {
  return Object.assign(
    {
      instance_id: instanceId,
      app: "after_effects",
      app_version: "25.6x101",
      plugin_version: PLUGIN_VERSION,
      machine_name: "test-machine",
      document: { name: "" },
      capabilities: CAPABILITIES.slice(),
      allow_agent: true,
    },
    extra
  );
}

let server;
let api;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(async () => {
  await support.reset(server);
  api = new ApiClient({ baseUrl: server.base, token: support.TOKEN });
});

test("base URL always ends in /v1", () => {
  assert.equal(normalizeBaseUrl("https://api.nolgia.ai"), "https://api.nolgia.ai/v1");
  assert.equal(normalizeBaseUrl("https://api.nolgia.ai/v1/"), "https://api.nolgia.ai/v1");
  assert.equal(normalizeBaseUrl(null), "https://api.nolgia.ai/v1");
});

test("register answers the session at top level and upserts by instance", async () => {
  const first = await api.registerSession(registerBody());
  assert.equal(first.poll_wait_seconds, 25);
  assert.equal(first.app, "after_effects");
  assert.deepEqual(first.capabilities, CAPABILITIES);
  const again = await api.registerSession(registerBody("inst-1", { document: { name: "shot.aep", path: "C:/x/shot.aep" } }));
  assert.equal(again.id, first.id);
  assert.deepEqual(again.document, { name: "shot.aep", path: "C:/x/shot.aep" });
  const other = await api.registerSession(registerBody("inst-2", { app: "illustrator" }));
  assert.notEqual(other.id, first.id);
});

test("the API refuses bad registrations the way the real one does", async () => {
  for (const [body, detail] of [
    [registerBody("x".repeat(129)), "instance_id must be one line"],
    [registerBody("inst", { app: "maya" }), "app must be one of"],
    [registerBody("inst", { capabilities: ["Preview"] }), "capabilities"],
    [registerBody("inst", { document: { name: "a", size: 1 } }), "unknown field"],
  ]) {
    await assert.rejects(api.registerSession(body), (err) => err instanceof ApiError && err.status === 400 && err.detail.includes(detail));
  }
});

test("long poll: empty, then a command, then its result", async () => {
  const sid = (await api.registerSession(registerBody()))["id"];
  assert.equal(await api.nextCommand(sid, 0), null);
  const cid = await support.enqueue(server, "after_effects", "info");
  const cmd = await api.nextCommand(sid, 5);
  assert.equal(cmd.id, cid);
  assert.equal(cmd.status, "running");
  assert.ok(cmd.expires_at && cmd.claimed_at);
  await api.postResult(cid, { status: "succeeded", result: { ok: 1 } });
  const done = await support.waitCommand(server, cid);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { ok: 1 });
});

test("a long poll can be aborted", async () => {
  const sid = (await api.registerSession(registerBody()))["id"];
  const ctrl = new AbortController();
  const started = Date.now();
  setTimeout(() => ctrl.abort(), 200);
  await assert.rejects(api.nextCommand(sid, 25, ctrl.signal), NetworkError);
  assert.ok(Date.now() - started < 5000);
});

test("a deleted session answers 409 session_disconnected", async () => {
  const sid = (await api.registerSession(registerBody()))["id"];
  await api.deleteSession(sid);
  await assert.rejects(api.nextCommand(sid, 0), (err) => err.status === 409 && err.code === "session_disconnected");
});

test("401 is Unauthorized; no server is a NetworkError", async () => {
  const bad = new ApiClient({ baseUrl: server.base, token: "nope" });
  await assert.rejects(bad.getMe(), Unauthorized);
  const gone = new ApiClient({ baseUrl: "http://127.0.0.1:9/v1", token: "x", timeout: 3 });
  await assert.rejects(gone.getMe(), NetworkError);
});

test("uploads go to the signed URL without the bearer, and download back", async () => {
  const dir = support.tempDir();
  const file = path.join(dir, "still.png");
  const png = support.png(8, 4);
  fs.writeFileSync(file, png);
  const asset = await api.uploadFile(file, "image/png", { displayName: "Still", tags: ["after-effects"], filename: "still.png" });
  assert.equal(asset.status, "ready");
  assert.equal(asset.display_name, "Still");
  assert.deepEqual(asset.tags, ["after-effects"]);
  assert.deepEqual(await support.assetBytes(server, asset.id), png);
  const st = await support.state(server);
  const puts = st.requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].auth, false);
  const again = await api.getAsset(asset.id);
  const dest = path.join(dir, "back.png");
  const head = await api.download(again.signed_url, dest);
  assert.deepEqual(fs.readFileSync(dest), png);
  assert.equal(head.slice(0, 4).toString("latin1"), "\x89PNG");
  await assert.rejects(api.download(again.signed_url, path.join(dir, "small.png"), { maxBytes: 10 }), /too large/);
  assert.equal(fs.existsSync(path.join(dir, "small.png.part")), false);
});

test("uploads of types the API does not take are refused", async () => {
  const dir = support.tempDir();
  const file = path.join(dir, "art.svg");
  fs.writeFileSync(file, "<svg/>");
  await assert.rejects(api.uploadFile(file, "image/svg+xml"), (err) => err.status === 400);
});
