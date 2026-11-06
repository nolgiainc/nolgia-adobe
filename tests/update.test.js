// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The update line (core/update.js): the version compare, when the line shows
// and hides, and the controller reading the catalog from the mock API.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { UpdateCheck, compareVersions, noticeFor, SITE_PLUGINS_URL, EVERY, PANEL_GAP } = require("../core/update");
const { Controller } = require("../core/controller");
const { PLUGIN_VERSION } = require("../core/index");

// ------------------------------------------------------------ compare

test("compareVersions orders releases the way the tags do", () => {
  assert.equal(compareVersions("0.3.1", "0.3.0"), 1);
  assert.equal(compareVersions("0.3.0", "0.3.1"), -1);
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1, "numbers, not text");
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.3", "0.3.0"), 0, "a missing part is 0");
  assert.equal(compareVersions("0.3.0.1", "0.3.0"), 1);
  assert.equal(compareVersions("v0.3.1", "0.3.1"), 0, "a tag's v is allowed");
  assert.equal(compareVersions(" 0.3.1 ", "0.3.1"), 0);
  assert.equal(compareVersions("0.3.1+build.7", "0.3.1"), 0, "build metadata does not count");
});

test("compareVersions puts a pre-release before its release", () => {
  assert.equal(compareVersions("0.4.0-beta.1", "0.4.0"), -1);
  assert.equal(compareVersions("0.4.0", "0.4.0-beta.1"), 1);
  assert.equal(compareVersions("0.4.0-beta.1", "0.3.9"), 1);
  assert.equal(compareVersions("0.4.0-beta.2", "0.4.0-beta.10"), -1);
  assert.equal(compareVersions("0.4.0-alpha", "0.4.0-beta"), -1);
  assert.equal(compareVersions("0.4.0-1", "0.4.0-alpha"), -1, "numbers before words");
  assert.equal(compareVersions("0.4.0-beta", "0.4.0-beta.1"), -1);
});

test("compareVersions refuses what is not a version", () => {
  for (const bad of ["", null, undefined, "latest", "0.3.x", "0..3", ".3.1", "0.3.1-", "nolgia-adobe/0.3.0", 3]) {
    assert.equal(compareVersions(bad, "0.3.0"), null, String(bad));
    assert.equal(compareVersions("0.3.0", bad), null, String(bad));
  }
});

// ------------------------------------------------------------ the line

function catalog(version, extra = {}) {
  const row = (id, slug) => Object.assign({ id, name: id, status: "available", plugin_version: version, page_slug: slug }, extra);
  return {
    apps: [
      { id: "blender", status: "available", plugin_version: "9.9.9", page_slug: "blender" },
      row("after_effects", "after-effects"),
      row("premiere", "premiere"),
      row("illustrator", "illustrator"),
    ],
  };
}

test("noticeFor shows a newer version of this app's plugin, with its page", () => {
  const n = noticeFor(catalog("0.3.1", { release_note: "  The panel says   when a newer version is out. " }), { app: "after_effects", running: "0.3.0" });
  assert.deepEqual(n, {
    version: "0.3.1",
    text: "NOLGIA for Adobe 0.3.1 is out.",
    note: "The panel says when a newer version is out.",
    url: "https://nolgia.ai/plugins/after-effects",
  });
  assert.equal(noticeFor(catalog("0.3.1"), { app: "premiere", running: "0.3.0" }).url, "https://nolgia.ai/plugins/premiere");
  assert.equal(noticeFor(catalog("0.3.1"), { app: "illustrator", running: "0.3.0" }).note, "", "no note when the catalog has none");
});

test("noticeFor stays quiet for the same or an older version, or a catalog it cannot read", () => {
  assert.equal(noticeFor(catalog("0.3.0"), { app: "after_effects", running: "0.3.0" }), null);
  assert.equal(noticeFor(catalog("0.2.7"), { app: "after_effects", running: "0.3.0" }), null);
  assert.equal(noticeFor(catalog("0.3.1", { status: "coming_soon" }), { app: "after_effects", running: "0.3.0" }), null);
  assert.equal(noticeFor(catalog(""), { app: "after_effects", running: "0.3.0" }), null);
  assert.equal(noticeFor(catalog("next"), { app: "after_effects", running: "0.3.0" }), null);
  assert.equal(noticeFor(catalog("0.3.1"), { app: "photoshop", running: "0.3.0" }), null, "another app's row never counts");
  assert.equal(noticeFor({ apps: [{ id: "after_effects", status: "available", plugin_version: 31 }] }, { app: "after_effects", running: "0.3.0" }), null);
  for (const junk of [null, undefined, {}, { apps: null }, { apps: "x" }, [], "text"]) {
    assert.equal(noticeFor(junk, { app: "after_effects", running: "0.3.0" }), null);
  }
});

test("noticeFor: Not now hides the line until a newer version than that one", () => {
  const at = (latest, dismissed) => noticeFor(catalog(latest), { app: "after_effects", running: "0.3.0", dismissed });
  assert.equal(at("0.3.1", "0.3.1"), null);
  assert.equal(at("0.3.1", "0.3.2"), null, "a newer dismissal covers it too");
  assert.equal(at("0.3.2", "0.3.1").version, "0.3.2");
  assert.equal(at("0.3.1", "garbage").version, "0.3.1", "a damaged setting does not hide it");
});

test("noticeFor keeps a page link it can trust and a short note", () => {
  const odd = noticeFor(catalog("0.3.1", { page_slug: "https://elsewhere.example/x" }), { app: "after_effects", running: "0.3.0" });
  assert.equal(odd.url, SITE_PLUGINS_URL, "a slug that is not a slug: the plugins page");
  const none = noticeFor(catalog("0.3.1", { page_slug: undefined }), { app: "after_effects", running: "0.3.0" });
  assert.equal(none.url, SITE_PLUGINS_URL);
  const long = noticeFor(catalog("0.3.1", { release_note: "word ".repeat(100) }), { app: "after_effects", running: "0.3.0" });
  assert.ok(long.note.length <= 200 && long.note.endsWith("..."), long.note);
  assert.equal(noticeFor(catalog("0.3.1", { release_note: 7 }), { app: "after_effects", running: "0.3.0" }).note, "");
});

// ---------------------------------------------------------- the check

/** An UpdateCheck with a fake owner and a clock and timers the test moves. */
function checker({ answer = () => catalog("0.3.1"), running = "0.3.0", app = "after_effects" } = {}) {
  const fake = {
    now: 1000,
    timers: [],
    reads: 0,
    dismissed: "",
    opened: [],
    bumps: 0,
    answer,
  };
  const owner = {
    app,
    running,
    catalog: async () => {
      fake.reads += 1;
      return fake.answer();
    },
    dismissed: () => fake.dismissed,
    dismiss: (v) => {
      fake.dismissed = v;
    },
    openURL: (url) => fake.opened.push(url),
    bump: () => {
      fake.bumps += 1;
    },
    log() {},
  };
  const check = new UpdateCheck(owner, {
    clock: () => fake.now,
    schedule: (fn, ms) => {
      const t = { fn, ms };
      fake.timers.push(t);
      return t;
    },
    cancel: (t) => {
      fake.timers = fake.timers.filter((x) => x !== t);
    },
    random: () => 0.5,
  });
  return { check, fake };
}

test("UpdateCheck reads at start, then about every 6 hours", async () => {
  const { check, fake } = checker();
  check.start();
  await check.check();
  assert.equal(fake.reads, 1);
  assert.equal(check.view().version, "0.3.1");
  assert.equal(fake.timers.length, 1);
  assert.equal(fake.timers[0].ms, EVERY * 1000);
  fake.now += EVERY;
  fake.answer = () => catalog("0.3.2", { release_note: "Faster." });
  const t = fake.timers.shift();
  t.fn();
  await check.check();
  assert.equal(fake.reads, 2);
  assert.equal(check.view().version, "0.3.2");
  assert.equal(check.view().note, "Faster.");
  assert.equal(fake.timers.length, 1, "the next check is set");
  check.stop();
  assert.equal(fake.timers.length, 0);
});

test("UpdateCheck: opening the panel reads again, but not every hello", async () => {
  const { check, fake } = checker();
  check.panelOpened();
  check.panelOpened(); // the panel says hello a few times while it starts
  await check.check();
  assert.equal(fake.reads, 1);
  fake.now += PANEL_GAP - 1;
  check.panelOpened();
  assert.equal(fake.reads, 1, "opened again a moment later: nothing new to read");
  fake.now += 2;
  check.panelOpened();
  await check.check();
  assert.equal(fake.reads, 2);
});

test("UpdateCheck says nothing offline or on any error, and keeps what it knew", async () => {
  const { check, fake } = checker({ answer: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.nolgia.ai")) });
  await check.check();
  assert.equal(check.view(), null);
  assert.equal(fake.bumps, 0, "nothing to redraw");
  fake.answer = () => catalog("0.3.1");
  await check.check();
  assert.equal(check.view().version, "0.3.1");
  fake.answer = () => {
    throw new Error("500");
  };
  await check.check();
  assert.equal(check.view().version, "0.3.1", "a failed read later does not take the line away");
  fake.answer = () => "<html>proxy login</html>";
  await check.check();
  assert.equal(check.view(), null, "an answer that is not the catalog shows nothing");
});

test("UpdateCheck: Not now hides the line until the next version; Update opens the page", async () => {
  const { check, fake } = checker();
  await check.check();
  check.open();
  assert.deepEqual(fake.opened, ["https://nolgia.ai/plugins/after-effects"]);
  assert.equal(check.view().version, "0.3.1", "Update does not hide it: nothing is installed yet");
  check.dismiss();
  assert.equal(fake.dismissed, "0.3.1");
  assert.equal(check.view(), null);
  await check.check();
  assert.equal(check.view(), null, "the same version stays hidden");
  fake.answer = () => catalog("0.3.2");
  await check.check();
  assert.equal(check.view().version, "0.3.2", "a newer one shows again");
  check.open();
  check.dismiss();
  check.dismiss(); // nothing to dismiss: no change
  assert.equal(fake.dismissed, "0.3.2");
});

test("UpdateCheck on the newest version shows nothing", async () => {
  const { check } = checker({ running: "0.3.1" });
  await check.check();
  assert.equal(check.view(), null);
  check.open();
  check.dismiss();
});

// ------------------------------------------------ with the controller

let server;
test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

function host(hostId = "AEFT") {
  const root = support.tempDir();
  return {
    hostId,
    userData: path.join(root, "userData"),
    documents: path.join(root, "Documents"),
    opened: [],
    states: [],
    async call(kind) {
      if (kind === "snapshot") return { ok: true, result: { document: { name: "" }, dirty: false, app_version: "26.5x89" } };
      return { ok: false, error: "no handler for " + kind };
    },
    openURL(url) {
      this.opened.push(url);
    },
    openPanel() {},
    broadcast(state) {
      this.states.push(state);
    },
    log() {},
  };
}

function newer() {
  const [a, b, c] = PLUGIN_VERSION.split(".").map(Number);
  return [a, b, c + 1].join(".");
}

test("the controller shows the catalog's newer version in every Adobe app, signed out too", async () => {
  const version = newer();
  await support.call(server, "POST", "/mock/desktop-apps", { plugin_version: version, release_note: "Shows when a newer version is out." }, { token: null });
  for (const [hostId, slug] of [["AEFT", "after-effects"], ["PPRO", "premiere"], ["ILST", "illustrator"]]) {
    const h = host(hostId);
    const ctl = new Controller(h, { environ: { NOLGIA_API_URL: server.base } });
    assert.equal(ctl.state().update, null, "nothing before the catalog is read");
    ctl.panelOpened();
    await ctl.updates.check();
    assert.deepEqual(ctl.state().update, {
      version,
      text: "NOLGIA for Adobe " + version + " is out.",
      note: "Shows when a newer version is out.",
      url: "https://nolgia.ai/plugins/" + slug,
    });
    ctl.action({ action: "update_open" });
    assert.deepEqual(h.opened, ["https://nolgia.ai/plugins/" + slug]);
    ctl.action({ action: "update_dismiss" });
    assert.equal(ctl.state().update, null);
    ctl.shutdown();
    // Not now is kept with the app's settings.
    const again = new Controller(h, { environ: { NOLGIA_API_URL: server.base } });
    assert.equal(again.settings.get("update_dismissed"), version);
    await again.updates.check();
    assert.equal(again.state().update, null, "still hidden after a restart");
    again.shutdown();
  }
  const reads = (await support.state(server)).requests.filter((r) => r.path === "/v1/desktop-apps");
  assert.ok(reads.length >= 6);
  for (const r of reads) {
    assert.equal(r.auth, false, "the catalog is read without the sign in");
    assert.match(r.user_agent, new RegExp("^nolgia-adobe/" + PLUGIN_VERSION.replace(/\./g, "\\.") + " \\("));
  }
});

test("the controller says nothing when the catalog is missing, failing or not newer", async () => {
  const h = host();
  const ctl = new Controller(h, { environ: { NOLGIA_API_URL: server.base } });
  await ctl.updates.check(); // the mock answers 404 before a version is set
  assert.equal(ctl.state().update, null);
  await support.call(server, "POST", "/mock/desktop-apps", { error: 500 }, { token: null });
  await ctl.updates.check();
  assert.equal(ctl.state().update, null);
  await support.call(server, "POST", "/mock/desktop-apps", { plugin_version: PLUGIN_VERSION }, { token: null });
  await ctl.updates.check();
  assert.equal(ctl.state().update, null);
  await support.call(server, "POST", "/mock/desktop-apps", { plugin_version: newer(), status: "coming_soon" }, { token: null });
  await ctl.updates.check();
  assert.equal(ctl.state().update, null);
  assert.equal(ctl.state().status, "Not signed in.", "the panel reads as it did");
  ctl.shutdown();
  // An address nothing answers on: still nothing, and no error anywhere.
  const off = new Controller(host(), { environ: { NOLGIA_API_URL: "http://127.0.0.1:9/v1" } });
  await off.updates.check();
  assert.equal(off.state().update, null);
  off.shutdown();
});

test("NOLGIA_UPDATE_CHECK=0 turns the check off", async () => {
  await support.call(server, "POST", "/mock/desktop-apps", { plugin_version: newer() }, { token: null });
  const ctl = new Controller(host(), { environ: { NOLGIA_API_URL: server.base, NOLGIA_UPDATE_CHECK: "0" } });
  ctl.start();
  ctl.panelOpened();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ctl.state().update, null);
  const reads = (await support.state(server)).requests.filter((r) => r.path === "/v1/desktop-apps");
  assert.equal(reads.length, 0);
  ctl.shutdown();
});

test("a damaged settings file does not lose the line", async () => {
  await support.call(server, "POST", "/mock/desktop-apps", { plugin_version: newer() }, { token: null });
  const h = host();
  const dir = path.join(h.userData, "NOLGIA", "adobe", "after_effects");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ update_dismissed: 7 }));
  const ctl = new Controller(h, { environ: { NOLGIA_API_URL: server.base } });
  await ctl.updates.check();
  assert.equal(ctl.state().update.version, newer());
  ctl.shutdown();
});
