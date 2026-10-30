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
const util = require("../core/util");
const { ApiError } = require("../core/api");

const APP = APPS.AEFT;
let server;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));
// A test that fails before it stops its worker must not leave it running:
// it would take the next test's commands and keep the run from ending.
const workers = [];
test.afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.kill();
    await worker.finished.wait(10);
  }
});

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
  workers.push(worker);
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
  // The worker marks it done once NOLGIA has answered the result, a moment
  // after NOLGIA stored it.
  await support.until(() => worker.activity.list()[0].status === "succeeded", 10, "activity succeeded");
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
    workers.push(worker);
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

test("the payload names the operating system", () => {
  const worker = makeWorker();
  assert.equal(worker.payload().os, util.osName() || undefined);
});

// An API from before sessions carried the OS refuses the field as unknown;
// the plugin then stops sending it instead of failing to connect.
test("an API without the os field still connects", async () => {
  const bodies = [];
  const api = {
    async registerSession(body) {
      bodies.push(body);
      if ("os" in body) throw new ApiError(400, { title: "Bad Request", detail: 'invalid JSON request body: json: unknown field "os"' });
      return { id: "s-1", poll_wait_seconds: 1 };
    },
    async nextCommand() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    },
    async deleteSession() {},
  };
  const worker = new BridgeWorker({
    api, execute: async () => ({ ok: true, result: {} }), activity: new ActivityLog(), instanceId: "i", app: APP,
    snapshot: () => ({ document: { name: "" }, app_version: "26.5x89", allow_agent: true }), machineName: "m",
  });
  workers.push(worker);
  if (!worker.sendOs) return; // an operating system NOLGIA does not name: nothing to fall back from
  worker.start();
  await support.until(() => worker.state === Status.CONNECTED, 10, "connected");
  assert.ok("os" in bodies[0]);
  assert.ok(!("os" in bodies[bodies.length - 1]));
  assert.equal(worker.sendOs, false);
});

// ---- reconnecting (the owner's Mac test 4: a broken socket, then 5 minutes silent)

const net = require("node:net");

/** A TCP relay in front of the mock that can break every open connection
 *  ("EPIPE"/"ECONNRESET" on the plugin's side) or refuse new ones (an outage). */
function relay(target) {
  const url = new URL(target.root);
  const sockets = new Set();
  let refusing = false;
  const srv = net.createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(url.port), url.hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
    }
    client.pipe(upstream).pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const base = "http://127.0.0.1:" + srv.address().port + "/v1";
      resolve({
        base,
        breakAll: () => {
          for (const s of sockets) s.destroy();
        },
        outage: (on) => {
          refusing = on;
          if (on) for (const s of sockets) s.destroy();
        },
        close: () => {
          for (const s of sockets) s.destroy();
          srv.close();
        },
      });
    });
  });
}

function relayedWorker(base, networkRetryMax) {
  const logs = [];
  const worker = new BridgeWorker({
    api: new ApiClient({ baseUrl: base, token: support.TOKEN }),
    execute: async (command) => ({ ok: true, result: { kind: command.kind } }),
    activity: new ActivityLog(),
    instanceId: "relay-instance",
    snapshot: () => ({ document: { name: "" }, app_version: "26.5x89", allow_agent: true }),
    app: APP,
    log: (text) => logs.push(text),
    networkRetryMax,
    machineName: "test-machine",
  });
  worker.logs = logs;
  workers.push(worker);
  return worker;
}

test("a connection that breaks mid-request is tried again at once", async () => {
  const r = await relay(server);
  try {
    const worker = relayedWorker(r.base, 10).start();
    await support.until(() => worker.state === Status.CONNECTED, 10, "connected");
    const sid = worker.sessionId;
    r.breakAll(); // the long poll and any heartbeat in flight break
    const t0 = Date.now();
    const id = await support.enqueue(server, "after_effects", "info");
    const done = await support.waitCommand(server, id);
    assert.equal(done.status, "succeeded");
    assert.ok(Date.now() - t0 < 4000, "took " + (Date.now() - t0) + " ms");
    assert.equal(worker.sessionId, sid);
    await stopped(worker);
  } finally {
    r.close();
  }
});

test("back within the retry limit once an outage ends, however long it was", async () => {
  const r = await relay(server);
  try {
    const worker = relayedWorker(r.base, 2).start();
    await support.until(() => worker.state === Status.CONNECTED, 10, "connected");
    r.outage(true);
    await support.until(() => worker.state === Status.RETRYING, 10, "retrying");
    await util.sleep(9000); // long enough for the backoff to reach its limit (and well past 2 s without one)
    r.outage(false);
    const t0 = Date.now();
    await support.until(() => worker.state === Status.CONNECTED, 10, "connected again");
    const back = Date.now() - t0;
    assert.ok(back <= 3500, "back after " + back + " ms");
    const id = await support.enqueue(server, "after_effects", "info");
    assert.equal((await support.waitCommand(server, id)).status, "succeeded");
    assert.ok(worker.logs.some((l) => /Trying again in [12] s\./.test(l)), worker.logs.join("\n"));
    await stopped(worker);
  } finally {
    r.close();
  }
});

test("a heartbeat that is due goes out when a poll comes back, even if its timer is late", async () => {
  const quick = await support.startMock(["--poll-wait-seconds", "1"]);
  try {
    const worker = new BridgeWorker({
      api: new ApiClient({ baseUrl: quick.base, token: support.TOKEN }),
      execute: async () => ({ ok: true, result: {} }),
      activity: new ActivityLog(),
      instanceId: "late-timer",
      snapshot: () => ({ document: { name: "" }, app_version: "1", allow_agent: true }),
      app: APP,
      heartbeatInterval: 1000, // a timer that, as under App Nap, does not come in time
      machineName: "m",
    });
    workers.push(worker);
    worker.start();
    await support.until(() => worker.state === Status.CONNECTED, 10, "connected");
    const first = worker.lastHeartbeatAt;
    worker.heartbeatInterval = 2; // due after 2 s; only a poll's answer can wake it now
    await support.until(() => worker.lastHeartbeatAt > first, 8, "a heartbeat from a poll");
    await stopped(worker);
  } finally {
    quick.stop();
  }
});
