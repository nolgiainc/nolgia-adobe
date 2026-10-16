// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Command kinds, argument checks, result shaping and the activity list.
//
// The wire format is the one in nolgia-api docs/design/bridge.md.

"use strict";

const { parseTime, cutText } = require("./util");

// Every kind this plugin implements, in the order the spec lists them. The
// plugin advertises these in `capabilities`, plus the kinds only some apps
// have (APP_KINDS).
const CAPABILITIES = ["info", "run", "preview", "import_asset", "export", "save", "open", "dit"];
const APP_KINDS = { premiere: ["transcribe"] };

// The kinds `app` (an entry of index.APPS) advertises.
function capabilitiesFor(app) {
  return CAPABILITIES.concat(APP_KINDS[app && app.app] || []);
}

const DEFAULT_TIMEOUT = 120;
// The API takes at most 1 MB (2**20 bytes) of result JSON, measured after it
// re-encodes the result. Stay a little under so a result never lands at 413.
const MAX_RESULT_BYTES = 1000 * 1000;
const MAX_ERROR_CHARS = 64 * 1024;
// The API refuses a result that arrives at or after expires_at, so the plugin
// stops waiting (for approval, or for code to finish) a little before that.
const RESULT_MARGIN = 3;

// What `preview` and `export` call the thing they show, per app. `camera`
// is accepted everywhere too, because the MCP preview tool sends that name.
const VIEW_ARG = { after_effects: "comp", premiere: "sequence", illustrator: "artboard" };
const IMPORT_AS = { after_effects: ["footage", "layer"], premiere: ["clip"], illustrator: ["embed", "link"] };
// Apps whose Lumetri Color reads the shared Adobe LUT folders, so
// import_asset can install a NOLGIA color preset as a .cube there.
const LUT_APPS = ["premiere", "after_effects"];
const PRESET_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APPLY_TO = ["current", "selected", "current_track", "all"];
const TRANSCRIBE_CLIPS = ["selected", "sequence"];
const TRANSCRIBE_ENGINES = ["auto", "premiere", "nolgia"];
const MAX_TRANSCRIBE_CLIPS = 200;

// A command failed. The message is shown to the agent and the person.
class CommandError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

class Command {
  constructor(data, receivedAt = null) {
    this.raw = data;
    this.id = String(data.id || "");
    this.kind = String(data.kind || "");
    this.args = data.args && typeof data.args === "object" && !Array.isArray(data.args) ? data.args : {};
    this.caller = String(data.caller || "");
    this.receivedAt = receivedAt !== null ? receivedAt : monotonic();
    this.timeout = Command.timeoutOf(data);
  }

  // Seconds this command may take, measured from when we got it. Uses the
  // server's own clock (expires_at minus claimed_at or created_at) so a
  // skewed clock on this computer does not matter.
  static timeoutOf(data) {
    const expires = parseTime(data.expires_at);
    const start = parseTime(data.claimed_at) || parseTime(data.created_at);
    if (expires !== null && start !== null) {
      const seconds = (expires - start) / 1000;
      if (seconds > 0) return seconds;
    }
    const seconds = data.timeout_seconds;
    if (typeof seconds === "number" && seconds > 0) return seconds;
    return DEFAULT_TIMEOUT;
  }

  // When the API stops accepting a result, on our monotonic clock (seconds).
  get expires() {
    return this.receivedAt + this.timeout;
  }

  // When to give up so the failure still reaches the API in time.
  get deadline() {
    return this.expires - Math.min(RESULT_MARGIN, this.timeout * 0.25);
  }

  remaining(now = null) {
    return this.deadline - (now === null ? monotonic() : now);
  }

  get callerLabel() {
    return { agent: "NOLGIA Agent", user: "you" }[this.caller] || this.caller || "NOLGIA";
  }

  // Who is asking, at the start of a sentence: "Your agent wants to ...".
  get requester() {
    return { agent: "Your NOLGIA Agent", user: "Your agent" }[this.caller] || "NOLGIA";
  }
}

function monotonic() {
  const [s, ns] = process.hrtime();
  return s + ns / 1e9;
}

function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}

function intArg(args, key, { low = null, high = null, required = false } = {}) {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new CommandError("`" + key + "` is required.");
    return null;
  }
  if (typeof value === "boolean" || !isInt(value)) throw new CommandError("`" + key + "` must be a whole number.");
  if (low !== null && value < low) throw new CommandError("`" + key + "` must be at least " + low + ".");
  if (high !== null && value > high) throw new CommandError("`" + key + "` must be at most " + high + ".");
  return value;
}

function strArg(args, key, { required = false, choices = null } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new CommandError("`" + key + "` is required.");
    return null;
  }
  if (typeof value !== "string") throw new CommandError("`" + key + "` must be text.");
  if (choices && !choices.includes(value)) {
    throw new CommandError("`" + key + "` must be one of: " + choices.join(", ") + ".");
  }
  return value;
}

const FRAMES_HELP = '`frames` must be a frame number or a range like "0-120".';

// `frames` for export: 12, "12", "0-120", [0, 120] or {"start":0,"end":120}.
// Returns [start, end] or null.
function parseFrames(value) {
  if (value === undefined || value === null || value === "") return null;
  let start = null;
  let end = null;
  if (typeof value === "boolean") throw new CommandError(FRAMES_HELP);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new CommandError(FRAMES_HELP);
    start = end = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    const m = /^(-?\d+)\s*(?:-\s*(-?\d+))?$/.exec(text);
    if (!m) throw new CommandError(FRAMES_HELP);
    start = Number(m[1]);
    end = m[2] !== undefined ? Number(m[2]) : start;
  } else if (Array.isArray(value) && (value.length === 1 || value.length === 2)) {
    start = Number(value[0]);
    end = Number(value[value.length - 1]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new CommandError(FRAMES_HELP);
  } else if (value && typeof value === "object" && "start" in value) {
    start = Number(value.start);
    end = "end" in value ? Number(value.end) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new CommandError(FRAMES_HELP);
  } else {
    throw new CommandError(FRAMES_HELP);
  }
  if (end < start) throw new CommandError("`frames` ends before it starts.");
  return [start, end];
}

// Check and normalise a command's args for `app` (an entry of index.APPS).
// Throws CommandError.
function validate(app, kind, args) {
  const kinds = capabilitiesFor(app);
  if (!kinds.includes(kind)) {
    throw new CommandError(
      "This NOLGIA plugin for " + app.name + ' cannot do "' + kind + '". It can do: ' + kinds.join(", ") +
        ". Updating the plugin may add it."
    );
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new CommandError("`args` must be an object.");
  const out = {};
  const view = VIEW_ARG[app.app];
  if (kind === "run") {
    const language = String(strArg(args, "language") || "extendscript").toLowerCase();
    if (language !== "extendscript") {
      throw new CommandError(app.name + " runs ExtendScript only; this command asked for " + language + ".");
    }
    const code = args.code;
    if (typeof code !== "string" || !code.trim()) {
      throw new CommandError("`code` is required: the ExtendScript to run in " + app.name + ".");
    }
    out.language = "extendscript";
    out.code = code;
    const timeout = args.timeout_seconds;
    if (timeout !== undefined && timeout !== null) {
      if (typeof timeout === "boolean" || typeof timeout !== "number" || !(timeout > 0)) {
        throw new CommandError("`timeout_seconds` must be a positive number.");
      }
      out.timeout_seconds = timeout;
    }
  } else if (kind === "preview") {
    out.target = viewArg(args, view);
    out.frame = intArg(args, "frame");
    out.width = intArg(args, "width", { low: 16, high: 1920 });
  } else if (kind === "import_asset") {
    out.asset_id = strArg(args, "asset_id");
    const preset = strArg(args, "color_preset");
    if (preset !== null) {
      if (!LUT_APPS.includes(app.app)) {
        throw new CommandError(
          app.name + " has no LUT folder to install a color preset into. `color_preset` works in Premiere Pro and After Effects."
        );
      }
      if (out.asset_id !== null) throw new CommandError("Pass `asset_id` or `color_preset`, not both.");
      if (!PRESET_SLUG.test(preset)) {
        throw new CommandError("`color_preset` must be a NOLGIA color preset slug such as kodak-portra-400 (GET /color-presets).");
      }
      out.color_preset = preset;
      out.apply_to = strArg(args, "apply_to", { choices: APPLY_TO });
    } else if (out.asset_id === null) {
      throw new CommandError("`asset_id` is required, or `color_preset` for one of NOLGIA's film stocks.");
    }
    out.as = strArg(args, "as", { choices: IMPORT_AS[app.app] });
  } else if (kind === "export") {
    out.format = String(strArg(args, "format", { required: true }) || "").toLowerCase().replace(/^\./, "");
    if (!app.exportFormats.includes(out.format)) {
      throw new CommandError("`format` must be one of: " + app.exportFormats.join(", ") + ".");
    }
    out.frames = parseFrames(args.frames);
    out.filename = strArg(args, "filename");
    out.target = viewArg(args, view);
  } else if (kind === "save") {
    out.path = strArg(args, "path");
  } else if (kind === "open") {
    out.path = strArg(args, "path", { required: true });
  } else if (kind === "transcribe") {
    return validateTranscribe(args);
  } else if (kind === "dit") {
    // Required here so the app-side kinds above load without it.
    const dit = require("./dit");
    try {
      return dit.validateArgs(args);
    } catch (e) {
      if (e instanceof dit.DitError) throw new CommandError(e.message);
      throw e;
    }
  }
  return out;
}

function boolArg(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new CommandError("`" + key + "` must be true or false.");
  return value;
}

// `transcribe` (Premiere Pro): which clips, which engine, and whether
// NOLGIA's transcription (credits) may be used. `action` follows a job.
function validateTranscribe(args) {
  const action = strArg(args, "action", { choices: ["start", "status", "cancel"] }) || "start";
  if (action !== "start") {
    return { action, job_id: strArg(args, "job_id", { required: true }) };
  }
  const out = { action };
  const clips = args.clips;
  if (clips === undefined || clips === null || clips === "") out.clips = "selected";
  else if (typeof clips === "string") {
    if (!TRANSCRIBE_CLIPS.includes(clips)) {
      throw new CommandError("`clips` must be \"selected\", \"sequence\" or a list of clip names or media paths.");
    }
    out.clips = clips;
  } else if (Array.isArray(clips)) {
    if (!clips.length) throw new CommandError("`clips` is an empty list.");
    if (clips.length > MAX_TRANSCRIBE_CLIPS) throw new CommandError("`clips` lists at most " + MAX_TRANSCRIBE_CLIPS + " clips.");
    for (const c of clips) {
      if (typeof c !== "string" || !c.trim()) throw new CommandError("Each entry of `clips` must be a clip name or a media path.");
    }
    out.clips = clips.map((c) => c.trim());
  } else {
    throw new CommandError("`clips` must be \"selected\", \"sequence\" or a list of clip names or media paths.");
  }
  out.sequence = strArg(args, "sequence");
  out.engine = strArg(args, "engine", { choices: TRANSCRIBE_ENGINES }) || "auto";
  out.allow_credits = boolArg(args, "allow_credits");
  out.words = boolArg(args, "words");
  const language = strArg(args, "language");
  if (language !== null && !/^[a-z]{2}$/.test(language)) {
    throw new CommandError("`language` must be a two-letter language code such as en.");
  }
  out.language = language || "en";
  return out;
}

// The comp, sequence or artboard a preview or export is about: its own name
// for the app, or `camera`. Artboards may be given by number (1 is the first).
function viewArg(args, view) {
  for (const key of [view, "camera"]) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string") return value;
    if (view === "artboard" && isInt(value) && value >= 1) return value;
    throw new CommandError(
      "`" + key + "` must be the name of a " + (view === "comp" ? "composition" : view) +
        (view === "artboard" ? " or its number (1 is the first)." : ".")
    );
  }
  return null;
}

// Bytes of the body as the API measures it. Go's encoder writes <, > and &
// as < and friends, five bytes more each.
function jsonSize(body) {
  const text = JSON.stringify(body);
  let extra = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 60 || c === 62 || c === 38) extra += 5;
  }
  return Buffer.byteLength(text, "utf8") + extra;
}

// The body for POST /bridge/commands/{id}/result, kept under 1 MB.
function resultBody(ok, result = null, error = null) {
  let body;
  if (ok) {
    body = { status: "succeeded", result: result !== null && result !== undefined ? result : {} };
  } else {
    body = { status: "failed", error: cutText(error || "The command failed.", MAX_ERROR_CHARS) };
    if (result !== null && result !== undefined) body.result = result;
  }
  if (jsonSize(body) <= MAX_RESULT_BYTES) return body;
  // Too big: shorten captured output first, then give up on the value.
  if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
    const res = Object.assign({}, body.result);
    for (const key of ["stdout", "stderr"]) {
      if (typeof res[key] === "string") res[key] = cutText(res[key], 16 * 1024);
    }
    body.result = res;
    if (jsonSize(body) <= MAX_RESULT_BYTES) return body;
  }
  return {
    status: "failed",
    error:
      "The result is larger than 1 MB, the most NOLGIA accepts. " +
      "Return less data, or write it to a file and export that.",
  };
}

const STATUS_LABELS = {
  received: "Received",
  running: "Running",
  approval: "Waiting for you",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

// The last 20 commands for the panel.
class ActivityLog {
  constructor(size = 20, clock = () => Date.now() / 1000) {
    this.items = new Map();
    this.size = size;
    this.clock = clock;
    this.version = 0;
  }

  add(id, kind, caller = "") {
    this.items.delete(id);
    this.items.set(id, { id, kind, caller, status: "received", time: this.clock(), detail: "" });
    while (this.items.size > this.size) this.items.delete(this.items.keys().next().value);
    this.version += 1;
  }

  update(id, status, detail = "") {
    const item = this.items.get(id);
    if (!item) return;
    item.status = status;
    if (detail) {
      const lines = String(detail).trim().split(/\r?\n/);
      item.detail = lines[lines.length - 1].slice(0, 200);
    }
    this.version += 1;
  }

  // Newest first.
  list() {
    return Array.from(this.items.values()).reverse().map((item) => Object.assign({}, item));
  }

  clear() {
    this.items.clear();
    this.version += 1;
  }
}

module.exports = {
  CAPABILITIES,
  APP_KINDS,
  capabilitiesFor,
  DEFAULT_TIMEOUT,
  MAX_RESULT_BYTES,
  RESULT_MARGIN,
  VIEW_ARG,
  IMPORT_AS,
  LUT_APPS,
  APPLY_TO,
  STATUS_LABELS,
  CommandError,
  Command,
  ActivityLog,
  parseFrames,
  validate,
  resultBody,
  jsonSize,
  monotonic,
};
