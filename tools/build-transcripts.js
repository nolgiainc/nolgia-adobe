#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Build NOLGIA Transcripts, the UXP part of NOLGIA for Premiere Pro:
// dist/nolgia-premiere-transcripts-<version>.ccx.
//
//   node tools/build-transcripts.js [--out FILE]
//
// A .ccx is a zip of the plugin folder with manifest.json at its root; Adobe's
// installer takes it (double click, or UnifiedPluginInstallerAgent
// /install). It checks that the manifest's version matches helper.js and
// that every script parses.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ADOBE = path.resolve(__dirname, "..");
const SRC = path.join(ADOBE, "premiere-uxp");
const FILES = ["manifest.json", "index.html", "helper.js", "main.js", "LICENSE"];

function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A zip of `entries` ([{name, data}]), deflated, with fixed times so the
// same sources make the same file.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

function build(out = null) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  const helperVersion = /HELPER_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(SRC, "helper.js"), "utf8"));
  if (!helperVersion || helperVersion[1] !== manifest.version) {
    throw new Error("manifest.json version " + manifest.version + " != helper.js HELPER_VERSION " + (helperVersion && helperVersion[1]));
  }
  for (const name of FILES) {
    if (!name.endsWith(".js")) continue;
    const res = childProcess.spawnSync(process.execPath, ["--check", path.join(SRC, name)], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(name + " does not parse:\n" + res.stderr);
  }
  const entries = FILES.map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }));
  const file = out || path.join(ADOBE, "dist", "nolgia-premiere-transcripts-" + manifest.version + ".ccx");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip(entries));
  return file;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const file = build(i >= 0 ? path.resolve(args[i + 1]) : null);
  console.log(file);
}

module.exports = { build, zip, crc32 };
