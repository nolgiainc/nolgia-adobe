// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Where the plugin keeps its sign in and switches, and the NOLGIA_*
// variables that override them.
//
// Each app keeps its own file, <user data>/NOLGIA/adobe/<app>/settings.json
// (%APPDATA% on Windows, ~/Library/Application Support on macOS), readable
// only by you, like the app's own preferences. The token in it lasts 30
// days; Sign out empties it.
//
// Variables come from the environment, or, for apps started from a launcher
// that does not pass the environment on, from <user data>/NOLGIA/adobe/env.json
// ({"NOLGIA_TOKEN": "...", ...}). The environment wins.

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  token: "",
  account_email: "",
  token_expires_at: 0,
  connected: false,
  allow_agent: true,
  ask_before_run: false,
};

const ENV_KEYS = [
  "NOLGIA_TOKEN",
  "NOLGIA_API_URL",
  "NOLGIA_BRIDGE_AUTOCONNECT",
  "NOLGIA_ASK_BEFORE_RUN",
  "NOLGIA_ALLOW_AGENT",
  "NOLGIA_INSTANCE_ID",
  "NOLGIA_EXPORT_DIR",
  "NOLGIA_PREVIEW_MAX_BYTES",
];

const TRUE = ["1", "true", "yes", "on"];

function rootDir(userData) {
  return path.join(userData, "NOLGIA", "adobe");
}

function appDir(userData, app) {
  return path.join(rootDir(userData), app);
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

class Settings {
  constructor(directory) {
    this.file = path.join(directory, "settings.json");
    this.values = Object.assign({}, DEFAULTS, pick(readJson(this.file)));
  }

  get(name) {
    return this.values[name];
  }

  // Set one or more values and save. Returns true when something changed.
  set(changes) {
    let changed = false;
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in DEFAULTS)) throw new Error("unknown setting " + key);
      if (this.values[key] !== value) {
        this.values[key] = value;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  save() {
    writeJson(this.file, this.values);
  }
}

function pick(data) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in data && typeof data[key] === typeof DEFAULTS[key]) out[key] = data[key];
  }
  return out;
}

// The NOLGIA_* variables: the environment first, then env.json.
function loadEnv(userData, environ = process.env) {
  const file = readJson(path.join(rootDir(userData), "env.json"));
  const out = {};
  for (const key of ENV_KEYS) {
    const value = environ[key] !== undefined && environ[key] !== "" ? environ[key] : file[key];
    if (value !== undefined && value !== null && value !== "") out[key] = String(value);
  }
  return out;
}

// "1", "true", "yes", "on" are true; other values false; unset is null.
function envFlag(env, name) {
  const value = env[name];
  if (value === undefined || value === null || value === "") return null;
  return TRUE.includes(String(value).trim().toLowerCase());
}

module.exports = { Settings, DEFAULTS, ENV_KEYS, loadEnv, envFlag, rootDir, appDir, readJson, writeJson };
