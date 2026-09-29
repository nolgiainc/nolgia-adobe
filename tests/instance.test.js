// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { leaseInstanceId } = require("../core/instance");
const settings = require("../core/settings");

test("the instance id is stable, and a second copy gets its own slot", () => {
  const dir = support.tempDir();
  const first = leaseInstanceId(dir);
  const second = leaseInstanceId(dir);
  assert.match(first.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(second.instanceId, first.instanceId + "-2");
  first.release();
  second.release();
  const again = leaseInstanceId(dir);
  assert.equal(again.instanceId, first.instanceId);
  again.release();
  assert.equal(leaseInstanceId(dir, "farm-7").instanceId, "farm-7");
});

test("a slot left by a copy that crashed is taken over", () => {
  const dir = support.tempDir();
  const base = leaseInstanceId(dir);
  base.release();
  fs.writeFileSync(path.join(dir, "slot-1.lock"), "999999999");
  const lease = leaseInstanceId(dir);
  assert.equal(lease.instanceId, base.instanceId);
  lease.release();
  assert.equal(fs.existsSync(path.join(dir, "slot-1.lock")), false);
});

test("settings are saved per app and read back", () => {
  const userData = support.tempDir();
  const dir = settings.appDir(userData, "premiere");
  const s = new settings.Settings(dir);
  assert.equal(s.get("allow_agent"), true);
  assert.equal(s.get("connected"), false);
  assert.equal(s.set({ token: "t", connected: true }), true);
  assert.equal(s.set({ token: "t" }), false);
  const back = new settings.Settings(dir);
  assert.equal(back.get("token"), "t");
  assert.equal(back.get("connected"), true);
  assert.throws(() => s.set({ nope: 1 }), /unknown setting/);
  fs.writeFileSync(path.join(dir, "settings.json"), "{broken");
  assert.equal(new settings.Settings(dir).get("token"), "");
});

test("NOLGIA_* variables: the environment wins over env.json", () => {
  const userData = support.tempDir();
  fs.mkdirSync(settings.rootDir(userData), { recursive: true });
  fs.writeFileSync(
    path.join(settings.rootDir(userData), "env.json"),
    JSON.stringify({ NOLGIA_TOKEN: "from-file", NOLGIA_BRIDGE_AUTOCONNECT: "1", OTHER: "x" })
  );
  const env = settings.loadEnv(userData, { NOLGIA_TOKEN: "from-env", NOLGIA_ASK_BEFORE_RUN: "0" });
  assert.deepEqual(env, { NOLGIA_TOKEN: "from-env", NOLGIA_BRIDGE_AUTOCONNECT: "1", NOLGIA_ASK_BEFORE_RUN: "0" });
  assert.equal(settings.envFlag(env, "NOLGIA_BRIDGE_AUTOCONNECT"), true);
  assert.equal(settings.envFlag(env, "NOLGIA_ASK_BEFORE_RUN"), false);
  assert.equal(settings.envFlag(env, "NOLGIA_ALLOW_AGENT"), null);
  assert.deepEqual(settings.loadEnv(support.tempDir(), {}), {});
});
