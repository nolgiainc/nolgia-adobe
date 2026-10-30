// SPDX-License-Identifier: GPL-3.0-or-later
// The plugin's version agrees everywhere it is written, and the real app
// script (host/nolgia.jsx) answers the panel's own call snippet instead of
// "not loaded". 0.2.3 shipped with host/nolgia.jsx at 0.2.2: every info and
// run in every app answered __NOLGIA_NOT_LOADED__.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { versions, checkVersions } = require("../tools/versions");
const { PLUGIN_VERSION } = require("../core/index");
const hostcall = require("../core/hostcall");

const HOST = path.join(__dirname, "..", "host");

test("the version is the same in package.json, core/index.js, the manifest and host/nolgia.jsx", () => {
  const v = versions();
  for (const [where, value] of Object.entries(v)) assert.equal(value, PLUGIN_VERSION, where);
  assert.equal(checkVersions(), PLUGIN_VERSION);
});

// The real host/nolgia.jsx in Node's vm, with the ExtendScript globals it
// needs, and an adapter as the app files make one.
function appWithHostScript() {
  class File {
    constructor(p) {
      this.fsName = String(p);
      this.name = String(p).split(/[\\/]/).pop();
    }
  }
  const ctx = { File, Folder: File };
  ctx.$ = { writeln() {}, write() {} };
  vm.createContext(ctx);
  ctx.$.global = vm.runInContext("this", ctx);
  vm.runInContext(fs.readFileSync(path.join(HOST, "nolgia.jsx"), "utf8"), ctx, { filename: "nolgia.jsx" });
  vm.runInContext("__nolgia.adapter = { info: function () { return { app_version: \"26.5x89\" }; } };", ctx);
  return ctx;
}

test("the real app script answers the panel's call snippet for this version", () => {
  const ctx = appWithHostScript();
  const answer = vm.runInContext(hostcall.callScript("info", {}, PLUGIN_VERSION), ctx);
  assert.notEqual(answer, hostcall.NOT_LOADED, "host/nolgia.jsx does not say it is " + PLUGIN_VERSION);
  assert.deepEqual(JSON.parse(answer), { ok: true, result: { app_version: "26.5x89" } });
  assert.equal(hostcall.hostScriptVersion(fs.readFileSync(path.join(HOST, "nolgia.jsx"), "utf8")), PLUGIN_VERSION);
});

test("an app still holding another version's script, or none, is told to load it again", () => {
  const ctx = appWithHostScript();
  assert.equal(vm.runInContext(hostcall.callScript("info", {}, "0.0.1"), ctx), hostcall.NOT_LOADED);
  const empty = {};
  vm.createContext(empty);
  assert.equal(vm.runInContext(hostcall.callScript("info", {}, PLUGIN_VERSION), empty), hostcall.NOT_LOADED);
});
