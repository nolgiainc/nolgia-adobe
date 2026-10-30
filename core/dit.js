// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The `dit` command kind: the NOLGIA CLI's `nolgia dit` (copy camera cards
// with verified checksums, verify a copy, inventory, rename, undo, report)
// run on this computer for the agent or the person at the panel.
//
// Safety, in the order it applies:
// - Only the NOLGIA CLI is ever started, as `nolgia --json dit <subcommand>`
//   with arguments built here from validated fields: no shell, no other
//   program, no free-form flags.
// - Anything that writes media (offload, rename --apply, undo) first runs the
//   CLI's own dry run, then shows the person the plan in the panel and waits
//   for Approve, whatever "Ask before running code" says.
// - Long work runs as a job: `start` returns at once if the work outlives
//   the command, and `status` / `cancel` follow it by job id. The CLI
//   journals every file, so a cancelled offload resumes when started again.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SUBCOMMANDS = ["offload", "verify", "manifest", "inventory", "rename", "undo", "report"];
const ACTIONS = ["start", "status", "cancel"];
const HASHES = /^(xxh64|md5|sha1)(,(xxh64|md5|sha1))*$/;
const MAX_PATH = 4096;
const MAX_LIST = 32;
// Keep a result well under the API's 1 MB.
const MAX_RESULT_CHARS = 900 * 1000;

const INSTALL_HINT =
  "The NOLGIA CLI is not installed on this computer, and DIT runs through it. Install it once, then ask again: " +
  "npm install -g @nolgia/cli (any computer with Node), or brew install nolgiainc/nolgia/nolgia (Mac), " +
  "or the installer at https://github.com/nolgiainc/nolgia-cli#installation.";

class DitError extends Error {}

function text(args, key, { required = false, max = MAX_PATH, pattern = null } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new DitError("`" + key + "` is required.");
    return null;
  }
  if (typeof v !== "string") throw new DitError("`" + key + "` must be a string.");
  // No control characters: these become command-line arguments.
  if (v.length > max || /[\u0000-\u001f]/.test(v)) throw new DitError("`" + key + "` is not a usable value.");
  if (pattern && !pattern.test(v)) throw new DitError("`" + key + "` has an unexpected format.");
  return v;
}

function list(args, key, { required = false, max = MAX_LIST, pattern = null } = {}) {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new DitError("`" + key + "` is required: a list.");
    return [];
  }
  if (!Array.isArray(v) || v.length > max) throw new DitError("`" + key + "` must be a list of at most " + max + ".");
  if (required && v.length === 0) throw new DitError("`" + key + "` needs at least one value.");
  return v.map((_, i) => text(v, i, { required: true, pattern }));
}

function flag(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new DitError("`" + key + "` must be true or false.");
  return v;
}

function absolute(p, key) {
  if (!path.isAbsolute(p) && !path.win32.isAbsolute(p)) {
    throw new DitError("`" + key + "` must be a full path (like E:\\ or /Volumes/A001), not " + JSON.stringify(p) + ".");
  }
  return p;
}

const PAIR = /^[^=]{1,200}=[^=]{1,200}$/;
const OFFSET = /^[^=]{1,200}=[+-]?(\d+[hHmM])+$/;

// Check a `dit` command's args and return the normalised form.
function validateArgs(args) {
  const out = { action: text(args, "action") || "start" };
  if (!ACTIONS.includes(out.action)) throw new DitError("`action` must be one of: " + ACTIONS.join(", ") + ".");
  if (out.action !== "start") {
    out.job_id = text(args, "job_id", { required: true, max: 64, pattern: /^[a-z0-9-]+$/ });
    return out;
  }
  out.subcommand = text(args, "subcommand", { required: true, max: 16 });
  if (!SUBCOMMANDS.includes(out.subcommand)) {
    throw new DitError("`subcommand` must be one of: " + SUBCOMMANDS.join(", ") + ".");
  }
  const s = out.subcommand;
  if (s === "offload") {
    out.sources = list(args, "sources", { required: true, max: 16 }).map((p) => absolute(p, "sources"));
    out.destinations = list(args, "destinations", { required: true, max: 3 }).map((p) => absolute(p, "destinations"));
    out.shoot = text(args, "shoot", { max: 200 });
    out.cards = list(args, "cards", { max: 16 });
    out.hash = text(args, "hash", { max: 32, pattern: HASHES });
    out.dry_run = flag(args, "dry_run");
    const mp = args.max_parallel;
    if (mp !== undefined && mp !== null) {
      if (!Number.isInteger(mp) || mp < 1 || mp > 4) throw new DitError("`max_parallel` must be 1 to 4.");
      out.max_parallel = mp;
    }
  } else {
    out.dir = absolute(text(args, "dir", { required: true }), "dir");
  }
  if (s === "verify" || s === "report") {
    out.manifest = text(args, "manifest");
    if (out.manifest) absolute(out.manifest, "manifest");
    out.only = list(args, "only");
  }
  if (s === "verify") out.record = flag(args, "record");
  if (s === "report") {
    out.verify = flag(args, "verify");
    out.out = text(args, "out");
    if (out.out) absolute(out.out, "out");
  }
  if (s === "manifest") out.hash = text(args, "hash", { max: 32, pattern: HASHES });
  if (s === "inventory" || s === "rename" || s === "report") out.clock_offsets = list(args, "clock_offsets", { pattern: OFFSET });
  if (s === "inventory") {
    out.csv = text(args, "csv");
    if (out.csv) absolute(out.csv, "csv");
    out.files = flag(args, "files");
  }
  if (s === "rename") {
    out.pattern = text(args, "pattern", { max: 300 });
    out.shoot = text(args, "shoot", { max: 200 });
    out.cameras = list(args, "cameras", { pattern: PAIR });
    out.apply = flag(args, "apply");
  }
  if (s === "rename" || s === "undo") {
    out.map = text(args, "map");
    if (out.map) absolute(out.map, "map");
  }
  return out;
}

// Does running this change media on disk (and so need the person's OK)?
function writesMedia(a) {
  return (a.subcommand === "offload" && !a.dry_run) || (a.subcommand === "rename" && a.apply) || a.subcommand === "undo";
}

// The exact argv after `nolgia`. Every value is its own argument.
function argv(a, { dryRun = false } = {}) {
  const v = ["--json", "dit", a.subcommand];
  const repeat = (name, values) => values.forEach((x) => v.push(name, x));
  const opt = (name, value) => {
    if (value !== null && value !== undefined && value !== "") v.push(name, String(value));
  };
  switch (a.subcommand) {
    case "offload":
      v.push(...a.sources);
      repeat("--to", a.destinations);
      opt("--shoot", a.shoot);
      repeat("--card", a.cards);
      opt("--hash", a.hash);
      opt("--max-parallel", a.max_parallel);
      if (a.dry_run || dryRun) v.push("--dry-run");
      break;
    case "verify":
      v.push(a.dir);
      opt("--manifest", a.manifest);
      repeat("--only", a.only);
      if (a.record) v.push("--record");
      break;
    case "manifest":
      v.push(a.dir);
      opt("--hash", a.hash);
      break;
    case "inventory":
      v.push(a.dir);
      repeat("--clock-offset", a.clock_offsets);
      opt("--csv", a.csv);
      if (a.files) v.push("--files");
      break;
    case "rename":
      v.push(a.dir);
      opt("--pattern", a.pattern);
      opt("--shoot", a.shoot);
      repeat("--camera", a.cameras);
      repeat("--clock-offset", a.clock_offsets);
      opt("--map", a.map);
      if (a.apply && !dryRun) v.push("--apply");
      break;
    case "undo":
      v.push(a.dir);
      opt("--map", a.map);
      break;
    case "report":
      v.push(a.dir);
      opt("--manifest", a.manifest);
      if (a.verify) v.push("--verify");
      repeat("--only", a.only);
      repeat("--clock-offset", a.clock_offsets);
      opt("--out", a.out);
      break;
    default:
      throw new DitError("unknown subcommand");
  }
  return v;
}

// Where the CLI may be: NOLGIA_CLI, PATH, the installers' default folders
// and npm's global package folder (whose `nolgia` on PATH is a script shim).
function locateCli(env = process.env, platform = process.platform, exists = (p) => fs.existsSync(p)) {
  if (env.NOLGIA_CLI && exists(env.NOLGIA_CLI)) return env.NOLGIA_CLI;
  const win = platform === "win32";
  const exe = win ? "nolgia.exe" : "nolgia";
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dirs = String(env.PATH || env.Path || "")
    .split(win ? ";" : ":")
    .filter(Boolean);
  const npmPkg = ["node_modules", "@nolgia", "cli", "vendor"];
  if (win) {
    if (env.APPDATA) dirs.push(path.win32.join(env.APPDATA, "npm", ...npmPkg));
    if (env.LOCALAPPDATA) dirs.push(path.win32.join(env.LOCALAPPDATA, "Programs", "nolgia"));
    dirs.push(path.win32.join(home, ".cargo", "bin"), path.win32.join(home, ".local", "bin"));
  } else {
    dirs.push(
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      path.join(home, ".cargo", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join("/opt/homebrew/lib", ...npmPkg),
      path.join("/usr/local/lib", ...npmPkg)
    );
  }
  for (const d of dirs) {
    const p = win ? path.win32.join(d, exe) : path.join(d, exe);
    if (exists(p)) return p;
  }
  return null;
}

// How to start the CLI: a real binary directly; a .js file (tests, or a
// development checkout) through this Node.
function spawnSpec(cli) {
  if (cli.endsWith(".js")) return { file: process.execPath, prefix: [cli] };
  return { file: cli, prefix: [] };
}

function runToEnd(cli, args) {
  return new Promise((resolve) => {
    const { file, prefix } = spawnSpec(cli);
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = childProcess.spawn(file, prefix.concat(args), { shell: false, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e && e.message) });
      return;
    }
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-8000)));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e && e.message) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// A size as the NOLGIA CLI writes it (human_bytes): 601.5 KB, 9.3 MB, never
// "601500 bytes" (the owner's Mac test 4).
function gb(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1e12) return (b / 1e12).toFixed(2) + " TB";
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b >= 1e3) return (b / 1e3).toFixed(1) + " KB";
  return Math.round(b) + " B";
}

// What the person approves: the CLI's own dry run, in plain lines.
// Returns { lines } to ask, or { refused } when the dry run already shows
// it cannot go ahead (a conflict at a destination, a name clash).
async function planFor(cli, a) {
  if (a.subcommand === "undo") {
    const map = a.map || path.join(a.dir, "_DIT", "rename-map.csv");
    let rows = 0;
    try {
      rows = fs.readFileSync(map, "utf8").split(/\r?\n/).filter((l) => l.startsWith("file,")).length;
    } catch (e) {
      return { refused: "There is no rename lookup sheet at " + map + ", so there is nothing to undo." };
    }
    return {
      title: "restore the original names of " + rows + " files",
      lines: ["Restore the original names of " + rows + " files in " + a.dir + ",", "from " + map + ".", "Nothing is overwritten."],
      approve: "Restore names",
    };
  }
  const dry = await runToEnd(cli, argv(a, { dryRun: true }));
  const plan = parseJson(dry.stdout);
  if (!plan) {
    return { refused: "The NOLGIA CLI could not plan this: " + (dry.stderr.trim().split(/\r?\n/).pop() || "exit " + dry.code) };
  }
  if (a.subcommand === "offload") {
    if (plan.conflicts && plan.conflicts.length) {
      const first = plan.conflicts.slice(0, 5).map((c) => c.path + ": " + c.reason);
      return {
        refused:
          "Nothing was copied. These files already exist at a destination with different content, and NOLGIA never replaces a file: " +
          first.join("; ") + (plan.conflicts.length > 5 ? " (and " + (plan.conflicts.length - 5) + " more)" : ""),
        result: plan,
      };
    }
    const lines = ["Copy " + plan.files + " files (" + gb(plan.bytes) + ") and check every copy:"];
    for (const c of plan.cards || []) lines.push("  card " + c.card + ": " + c.source + " (" + c.files + " files, " + gb(c.bytes) + ")");
    for (const d of plan.destinations || []) {
      lines.push("  to " + d.folder + (d.free_bytes ? " (" + gb(d.free_bytes) + " free)" : ""));
    }
    lines.push("The cards are only read. Nothing at a destination is replaced.");
    return { title: "copy " + plan.files + " files (" + gb(plan.bytes) + ") from camera cards", lines, approve: "Copy and verify" };
  }
  // rename
  if (dry.code !== 0) return { refused: "The rename cannot go ahead: " + (dry.stderr.trim().split(/\r?\n/).pop() || "exit " + dry.code) };
  if (!plan.to_rename) return { nothing: plan };
  const lines = ["Rename " + plan.to_rename + " files in " + a.dir + ", for example:"];
  for (const c of (plan.changes || []).slice(0, 8)) lines.push("  " + c.from + " -> " + c.to);
  lines.push("A lookup sheet and undo scripts are written to _DIT first; card-structure files keep their names.");
  return { title: "rename " + plan.to_rename + " files", lines, approve: "Rename files" };
}

// Results larger than the API takes keep their summary and the first items
// of each long list.
function trimResult(value) {
  const s = JSON.stringify(value);
  if (s.length <= MAX_RESULT_CHARS) return value;
  const copy = JSON.parse(s);
  const trim = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (Array.isArray(o[k]) && o[k].length > 50) {
        o[k + "_total"] = o[k].length;
        o[k] = o[k].slice(0, 50);
      } else trim(o[k]);
    }
  };
  trim(copy);
  copy.truncated = "Long lists were cut to their first 50 items; run the same nolgia dit command with --json for all of them.";
  return copy;
}

class Jobs {
  constructor() {
    this.jobs = new Map();
    this.seq = 0;
  }

  start(cli, args) {
    const id = "dit-" + Date.now().toString(36) + "-" + (++this.seq).toString(36);
    const { file, prefix } = spawnSpec(cli);
    const job = { id, args, started: Date.now(), stdout: "", stderr: "", code: null, done: null };
    job.done = new Promise((resolve) => {
      let child;
      try {
        child = childProcess.spawn(file, prefix.concat(args), { shell: false, windowsHide: true });
      } catch (e) {
        job.code = -1;
        job.stderr = String(e && e.message);
        resolve();
        return;
      }
      job.child = child;
      child.stdout.on("data", (b) => (job.stdout += b));
      child.stderr.on("data", (b) => (job.stderr = (job.stderr + b).slice(-8000)));
      child.on("error", (e) => {
        job.code = -1;
        job.stderr += String(e && e.message);
        resolve();
      });
      child.on("close", (code) => {
        job.code = code === null ? -1 : code;
        resolve();
      });
    });
    this.jobs.set(id, job);
    return job;
  }

  view(job) {
    const running = job.code === null;
    const last = job.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || "";
    const out = {
      job_id: job.id,
      command: "nolgia " + job.args.join(" "),
      running,
      seconds: Math.round((Date.now() - job.started) / 1000),
      progress: running ? last : undefined,
    };
    if (!running) {
      out.exit_code = job.code;
      out.meaning =
        job.code === 0 ? "finished: everything matched" :
        job.code === 68 ? "finished with a problem: a copy or file does not match, is missing, or a destination file was in the way (listed in result)" :
        job.code === 130 ? "stopped before the end; start the same command again to resume" :
        "failed";
      out.result = parseJson(job.stdout);
      if (!out.result && job.stderr) out.error = job.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    }
    return trimResult(out);
  }

  async waitOrReturn(job, seconds) {
    let timer;
    await Promise.race([job.done, new Promise((r) => (timer = setTimeout(r, Math.max(0, seconds) * 1000)))]);
    clearTimeout(timer);
    return this.view(job);
  }

  status(id) {
    const job = this.jobs.get(id);
    if (!job) throw new DitError("No DIT job " + id + " on this computer (jobs are kept while the app stays open).");
    return this.view(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new DitError("No DIT job " + id + " on this computer.");
    if (job.code === null && job.child) job.child.kill();
    return { job_id: id, cancelled: job.code === null, note: "An offload resumes where it stopped when the same command is started again." };
  }
}

module.exports = { validateArgs, writesMedia, argv, locateCli, planFor, trimResult, Jobs, DitError, INSTALL_HINT, SUBCOMMANDS, gb };
