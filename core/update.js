// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// "A newer NOLGIA for Adobe is out": the panel's quiet update line.
//
// The published version is NOLGIA's plugins catalog (GET /desktop-apps,
// public, the list nolgia.ai/plugins shows): this app's row, its
// plugin_version and the one line on what changed (release_note). It is read
// when the panel opens (at most every few minutes) and about every 6 hours
// while the app runs. Nothing is installed from here: Update opens the
// plugin's page on nolgia.ai, which has the download and the steps, and Not
// now hides the line until a newer version than that one is out. Offline, a
// catalog that does not answer, or anything else unexpected: no line, no
// message, and the panel works as it did.

"use strict";

const { timers } = require("./util");

const SITE_PLUGINS_URL = "https://nolgia.ai/plugins";
const EVERY = 6 * 60 * 60; // seconds between checks while the app runs
const JITTER = 10 * 60; // spread the checks of many computers over 20 minutes
const PANEL_GAP = 10 * 60; // opening the panel again sooner reads nothing new
const MAX_NOTE = 200;

const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as numbers and a pre-release tag, or null when it is not one. */
function parseVersion(text) {
  if (typeof text !== "string") return null;
  const m = VERSION_RE.exec(text.trim());
  if (!m) return null;
  return { parts: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : null };
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` ("0.3.1"
 *  against "0.3.0"; missing parts are 0, so "0.3" is "0.3.0"; a pre-release
 *  such as "0.4.0-beta.1" is older than "0.4.0"), or null when either is not a
 *  version. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/** The line to show for one catalog answer, or null. `running` is this
 *  plugin's version, `dismissed` the version Not now was pressed for. */
function noticeFor(catalog, { app, running, dismissed = "" }) {
  const apps = catalog && Array.isArray(catalog.apps) ? catalog.apps : [];
  const row = apps.find((a) => a && a.id === app);
  if (!row || row.status !== "available" || typeof row.plugin_version !== "string") return null;
  const latest = row.plugin_version.trim();
  if (compareVersions(latest, running) !== 1) return null;
  // Not now covers that version and older ones; a setting that is not a
  // version hides nothing.
  if (parseVersion(dismissed) && compareVersions(latest, dismissed) !== 1) return null;
  const slug = typeof row.page_slug === "string" && /^[a-z0-9-]{1,64}$/.test(row.page_slug) ? row.page_slug : "";
  let note = typeof row.release_note === "string" ? row.release_note.replace(/\s+/g, " ").trim() : "";
  if (note.length > MAX_NOTE) note = note.slice(0, MAX_NOTE - 3).trimEnd() + "...";
  return {
    version: latest,
    text: "NOLGIA for Adobe " + latest + " is out.",
    note,
    url: slug ? SITE_PLUGINS_URL + "/" + slug : SITE_PLUGINS_URL,
  };
}

class UpdateCheck {
  /** `owner`: app (the NOLGIA app id), running (this plugin's version),
   *  catalog() (resolves GET /desktop-apps), dismissed() and dismiss(version)
   *  (the Not now setting), openURL(url), bump(), log(text). */
  constructor(owner, { clock = () => Date.now() / 1000, schedule = (fn, ms) => timers.setTimeout(fn, ms), cancel = (t) => timers.clearTimeout(t), random = Math.random } = {}) {
    this.owner = owner;
    this.clock = clock;
    this._schedule = schedule;
    this._cancel = cancel;
    this._random = random;
    this.notice = null;
    this.lastTry = 0; // when the catalog was last asked
    this._reading = null;
    this._timer = null;
    this._stopped = false;
  }

  /** The app started: read now (unless the panel just did), then about
   *  every 6 hours. */
  start() {
    this._stopped = false;
    this.panelOpened();
    this._next();
  }

  stop() {
    this._stopped = true;
    if (this._timer) this._cancel(this._timer);
    this._timer = null;
  }

  /** The panel opened: read again unless it was asked a moment ago (the
   *  panel says hello a few times while it starts). */
  panelOpened() {
    if (this._reading || this.clock() - this.lastTry >= PANEL_GAP) this.check();
  }

  _next() {
    if (this._stopped) return;
    if (this._timer) this._cancel(this._timer);
    const wait = EVERY + (this._random() * 2 - 1) * JITTER;
    this._timer = this._schedule(() => {
      this._timer = null;
      this.check();
      this._next();
    }, Math.round(wait * 1000));
    if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
  }

  /** One read of the catalog. Never rejects; an error only keeps what was
   *  known (or nothing). */
  check() {
    if (this._reading) return this._reading;
    this.lastTry = this.clock();
    this._reading = (async () => {
      try {
        const catalog = await this.owner.catalog();
        const notice = noticeFor(catalog, { app: this.owner.app, running: this.owner.running, dismissed: this._dismissed() });
        const changed = JSON.stringify(notice) !== JSON.stringify(this.notice);
        this.notice = notice;
        if (changed) {
          if (notice) this._log("NOLGIA for Adobe " + notice.version + " is out (this is " + this.owner.running + ").");
          this._bump();
        }
      } catch (err) {
        // offline, or the catalog did not answer: say nothing
      } finally {
        this._reading = null;
      }
    })();
    return this._reading;
  }

  /** Not now: hide the line until a newer version than this one is out. */
  dismiss() {
    if (!this.notice) return;
    try {
      this.owner.dismiss(this.notice.version);
      this._log("Update: Not now for " + this.notice.version + ".");
    } catch (err) {
      // hidden for this session anyway
    }
    this.notice = null;
    this._bump();
  }

  /** Update: the plugin's page on nolgia.ai (the download and the steps). */
  open() {
    if (!this.notice) return;
    try {
      this.owner.openURL(this.notice.url);
      this._log("Update: opened " + this.notice.url + ".");
    } catch (err) {
      // the line stays; the page is on nolgia.ai/plugins
    }
  }

  view() {
    return this.notice ? Object.assign({}, this.notice) : null;
  }

  _dismissed() {
    try {
      return String(this.owner.dismissed() || "");
    } catch (err) {
      return "";
    }
  }

  _bump() {
    try {
      this.owner.bump();
    } catch (err) {
      // the panel is closed
    }
  }

  _log(text) {
    try {
      this.owner.log(text);
    } catch (err) {
      // logging never matters here
    }
  }
}

module.exports = { UpdateCheck, compareVersions, parseVersion, noticeFor, SITE_PLUGINS_URL, EVERY, PANEL_GAP };
