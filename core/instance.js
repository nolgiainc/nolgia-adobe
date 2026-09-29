// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The stable `instance_id` the API keys sessions by.
//
// One id per app per install, kept in a file. When a second copy of the same
// app is open (After Effects can run twice), it would otherwise share the
// first one's session, so each running copy holds a numbered slot: the first
// uses the id as is, the second "<id>-2", and so on. A slot is a lock file
// holding the process id; a slot whose process is gone is free again. The
// ids stay the same across restarts, so the API does not collect a new
// session every launch.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_SLOTS = 16;

function readOrCreate(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value) return value;
  } catch (e) {
    // create it
  }
  const value = crypto.randomUUID();
  try {
    fs.writeFileSync(file, value + "\n", "utf8");
  } catch (e) {
    // a read-only folder: the id still works for this run
  }
  return value;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Returns "locked", "held" or "unsupported".
function tryLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return "locked";
    } catch (err) {
      if (err.code !== "EEXIST") return "unsupported";
    }
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(file, "utf8").trim());
    } catch (e) {
      return "unsupported";
    }
    if (alive(pid)) return "held";
    try {
      fs.unlinkSync(file); // left behind by a copy that crashed
    } catch (e) {
      return "unsupported";
    }
  }
  return "held";
}

class InstanceLease {
  constructor(instanceId, lockFile) {
    this.instanceId = instanceId;
    this.lockFile = lockFile;
  }

  release() {
    const file = this.lockFile;
    this.lockFile = null;
    if (!file) return;
    try {
      if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) fs.unlinkSync(file);
    } catch (e) {
      // already gone
    }
  }
}

// Returns an InstanceLease; call release() when disconnecting.
function leaseInstanceId(directory, override = null) {
  if (override) return new InstanceLease(override, null);
  fs.mkdirSync(directory, { recursive: true });
  const base = readOrCreate(path.join(directory, "instance_id"));
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const file = path.join(directory, "slot-" + slot + ".lock");
    const id = slot === 1 ? base : base + "-" + slot;
    const why = tryLock(file);
    if (why === "locked") return new InstanceLease(id, file);
    if (why === "unsupported") return new InstanceLease(id, null); // keep the plain id stable
  }
  return new InstanceLease(base + "-" + crypto.randomBytes(4).toString("hex"), null);
}

module.exports = { leaseInstanceId, InstanceLease, MAX_SLOTS };
