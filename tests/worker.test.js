// SPDX-License-Identifier: GPL-3.0-or-later
// The two network loops against the mock API, with a fake app.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const support = require("./support");
const { APPS, PLUGIN_VERSION } = require("../core/index");
const { ApiClient } = require("../core/api");
const { ActivityLog, CAPABILITIES, CommandError } = require("../core/commands");
const { BridgeWorker, Status } = require("../core/worker");

const APP = APPS.AEFT;
let server;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

function makeWorker({ execute, token = support.TOKEN, snapshot = null, heartbeatInterval = 20 } = {}) {
  const statuses = [];
  const authFailures = [];
  const worker = new BridgeWorker({
    api: new ApiClient({ baseUrl: server.base, token }),
    execute: execute || (async (command) => ({ ok: true, result: { kind: command.kind } })),
    activity: new ActivityLog(),
    instanceId: "test-instance",
    snapshot:
      snapshot ||
      (() => ({ document: { name: "shot.aep", path: "C:\\shots\\shot.aep" }, app_version: "25.6x101", allow_agent: true })),
    app: APP,
    onStatus: (state, text) => statuses.push([state, text]),
    onAuthFailed: (text) => authFailures.push(text),
    heartbeatInterval,
    machineName: "test-machine\n",
  });
  worker.statuses = statuses;
  worker.authFailures = authFailures;
  return worker;
}

async function stopped(worker) {
  worker.stop();
  assert.equal(await worker.finished.wait(10), true, "worker did not finish");
}

test("registers with the full state and runs commands", async () => {
  const worker = makeWorker().start();
  await support.until(() => worker.state === Status.CONNECTED, 10, "connected");
  const st = await support.state(server);
  assert.deepEqual(st.last_heartbeat, {
    instance_id: "test-instance",
    app: "after_effects",
    app_version: "25.6x101",
    plugin_version: PLUGIN_VERSION,
    machine_name: "test-machine",
    document: { name: "shot.aep", path: "C:\\shots\\shot.aep" },
    capabilities: CAPABILITIES,
    allow_agent: true,
  });
  const id = await support.enqueue(server, "after_effects", "info");
  const done = await support.waitCommand(server, id);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { kind: "info" });
  assert.equal(worker.activity.list()[0].status, "succeeded");
  await stopped(worker);
  const after = await support.state(server);
  assert.equal(after.deleted_sessions.length, 1);
  assert.equal(worker.state, Status.OFF);
});

test("failures and bugs come back as failed with a message", async () => {
  const worker = makeWorker({
    execute: async (command) => {
      if (command.args.mode === "error") throw new CommandError("That comp does not exist.", { hint: 1 });
      throw new TypeError("oops");
    },
  }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  const a = await support.waitCommand(server, await support.enqueue(server, "after_effects", "run", { mode: "error" }));
  assert.equal(a.status, "failed");
  assert.equal(a.error, "That comp does not exist.");
  assert.deepEqual(a.result, { hint: 1 });
  const b = await support.waitCommand(server, await support.enqueue(server, "after_effects", "run", {}));
  assert.equal(b.status, "failed");
  assert.match(b.error, /hit a bug:\nTypeError: oops/);
  await stopped(worker);
});

test("a heartbeat on request carries the new document", async () => {
  let name = "a.aep";
  const worker = makeWorker({ snapshot: () => ({ document: { name }, app_version: "25.6", allow_agent: false }) }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  name = "b.aep";
  worker.requestHeartbeat();
  await support.until(async () => {
    const st = await support.state(server);
    return st.last_heartbeat.document.name === "b.aep" && st.last_heartbeat.allow_agent === false;
  }, 5, "second heartbeat");
  await stopped(worker);
});

test("registers again when NOLGIA forgets the session", async () => {
  // A mock with 1 s long polls, so the worker notices within a second.
  const quick = await support.startMock(["--poll-wait-seconds", "1"]);
  try {
    const worker = new BridgeWorker({
      api: new ApiClient({ baseUrl: quick.base, token: support.TOKEN }),
      execute: async () => ({ ok: true, result: { again: true } }),
      activity: new ActivityLog(),
      instanceId: "test-instance",
      snapshot: () => ({ document: { name: "" }, app_version: "25.6" }),
      app: APP,
    }).start();
    await support.until(() => worker.state === Status.CONNECTED, 10);
    const sid = worker.sessionId;
    await support.call(quick, "DELETE", "/v1/bridge/sessions/" + sid);
    await assert.rejects(support.enqueue(quick, "after_effects", "info"), /409/);
    // The next long poll answers 409 session_disconnected; the worker registers again.
    const live = async () => (await support.state(quick)).sessions.some((s) => s.id === sid && s.live);
    await support.until(live, 10, "registered again");
    const id = await support.enqueue(quick, "after_effects", "info");
    assert.deepEqual((await support.waitCommand(quick, id)).result, { again: true });
    worker.stop();
    assert.equal(await worker.finished.wait(10), true);
  } finally {
    quick.stop();
  }
});

test("a refused token signs out and stops", async () => {
  const worker = makeWorker({ token: "revoked" }).start();
  await support.until(() => worker.finished.isSet(), 10, "finished");
  assert.equal(worker.state, Status.SIGNED_OUT);
  assert.equal(worker.authFailures.length, 1);
});

test("a command cancelled while it runs is dropped quietly", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const worker = makeWorker({ execute: async () => (await gate, { ok: true, result: {} }) }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  const id = await support.enqueue(server, "after_effects", "run", { code: "1" });
  await support.until(() => worker.busyWith === id, 10, "running");
  await support.call(server, "POST", "/v1/bridge/commands/" + id + "/cancel");
  release();
  await support.until(() => worker.activity.list()[0].status === "cancelled", 10, "cancelled");
  await stopped(worker);
});

test("a result over 1 MB fails with a clear message", async () => {
  const worker = makeWorker({ execute: async () => ({ ok: true, result: { value: "x".repeat(1100000) } }) }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  const done = await support.waitCommand(server, await support.enqueue(server, "after_effects", "run", { code: "1" }));
  assert.equal(done.status, "failed");
  assert.match(done.error, /larger than 1 MB/);
  await stopped(worker);
});

test("switching off waits for the running command, then closes", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const worker = makeWorker({ execute: async () => (await gate, { ok: true, result: { late: true } }) }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  const id = await support.enqueue(server, "after_effects", "run", { code: "1" });
  await support.until(() => worker.busyWith === id, 10);
  worker.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(worker.finished.isSet(), false);
  release();
  assert.equal(await worker.finished.wait(10), true);
  assert.deepEqual((await support.waitCommand(server, id)).result, { late: true });
});

test("the NOLGIA Agent is refused when Allow NOLGIA Agent is off", async () => {
  const worker = makeWorker({ snapshot: () => ({ document: { name: "" }, allow_agent: false }) }).start();
  await support.until(() => worker.state === Status.CONNECTED, 10);
  await assert.rejects(support.enqueue(server, "after_effects", "info", {}, { caller: "agent" }), /403/);
  await stopped(worker);
});
