// SPDX-License-Identifier: GPL-3.0-or-later
// Device login against the mock API.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const support = require("./support");
const { ApiClient } = require("../core/api");
const { DeviceLogin, LoginError, LoginCancelled } = require("../core/auth");

let server;

test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

function login(clock) {
  return new DeviceLogin(new ApiClient({ baseUrl: server.base }), clock ? { clock } : {});
}

test("sign in: code, approve in the browser, token", async () => {
  const flow = login();
  const prompt = await flow.start();
  assert.match(prompt.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.ok(prompt.openUrl.includes("user_code=" + prompt.userCode));
  setTimeout(() => support.call(server, "POST", "/mock/device/approve", { user_code: prompt.userCode }, { token: null }), 300);
  const token = await flow.waitForToken(prompt);
  assert.match(token.accessToken, /^nol_mock_/);
  assert.ok(token.expiresAt > Date.now() / 1000 + 29 * 86400);
  const me = await new ApiClient({ baseUrl: server.base, token: token.accessToken }).getMe();
  assert.equal(me.email, "test@nolgia.ai");
});

test("declined in the browser", async () => {
  const flow = login();
  const prompt = await flow.start();
  setTimeout(() => support.call(server, "POST", "/mock/device/deny", { user_code: prompt.userCode }, { token: null }), 300);
  await assert.rejects(flow.waitForToken(prompt), (err) => err instanceof LoginError && /declined/.test(err.message));
});

test("cancel stops waiting at once", async () => {
  const flow = login();
  const prompt = await flow.start();
  setTimeout(() => flow.cancel(), 100);
  await assert.rejects(flow.waitForToken(prompt), LoginCancelled);
});

test("an expired code says to sign in again", async () => {
  let now = 1000;
  const flow = login(() => (now += 400)); // time runs out after a couple of polls
  const prompt = await flow.start();
  await assert.rejects(flow.waitForToken(prompt), /expired/);
});

test("polling too fast slows down, like the CLI", async () => {
  const flow = login();
  const prompt = await flow.start();
  prompt.interval = 0.05; // faster than the mock's 1 s interval
  const waiting = flow.waitForToken(prompt);
  await support.until(() => flow.interval > 1, 5, "slow_down");
  flow.cancel();
  await assert.rejects(waiting, LoginCancelled);
});

test("no server to sign in with", async () => {
  const flow = new DeviceLogin(new ApiClient({ baseUrl: "http://127.0.0.1:9/v1", timeout: 3 }));
  await assert.rejects(flow.start(), /Could not reach NOLGIA/);
});
