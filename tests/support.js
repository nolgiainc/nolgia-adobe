// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Shared setup for the unit tests: the mock NOLGIA API from
// tools/mock_bridge_server.py (the same one the Blender tests use), started
// once per test file on a free port, and the caller side of the Bridge.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const TOKEN = "unit-token";

function python() {
  return process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
}

// Start the mock. Resolves {root, base, stop()}.
function startMock(extra = []) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(
      python(),
      [path.join(REPO, "tools", "mock_bridge_server.py"), "--port", "0", "--token", TOKEN, "--device-interval", "1", ...extra],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const m = /listening on (http:\/\/[^\s]+)\/v1/.exec(buffer);
      if (m) {
        proc.stdout.off("data", onData);
        proc.stdout.resume();
        resolve({
          root: m[1],
          base: m[1] + "/v1",
          stop: () => proc.kill(),
        });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("error", reject);
    proc.on("exit", (code) => reject(new Error("mock exited " + code)));
  });
}

// One HTTP call to the mock, as the MCP server would make it.
function call(server, method, urlPath, body = undefined, { token = TOKEN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(server.root + urlPath);
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: Object.assign(
          token ? { Authorization: "Bearer " + token } : {},
          data && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {},
          data ? { "Content-Length": data.length } : { "Content-Length": 0 },
          headers
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          if (raw.length && /json/.test(res.headers["content-type"] || "")) json = JSON.parse(raw.toString());
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    req.end(data || undefined);
  });
}

async function reset(server) {
  await call(server, "POST", "/mock/reset", undefined, { token: null });
}

async function state(server) {
  return (await call(server, "GET", "/mock/state", undefined, { token: null })).body;
}

// Queue a command for `app`. caller "agent" sends the header the API reads
// as the NOLGIA Agent.
async function enqueue(server, app, kind, args = {}, { timeout = 120, caller = null } = {}) {
  const headers = caller === "agent" ? { "X-Nolgia-Surface": "hermes" } : {};
  const res = await call(server, "POST", "/v1/bridge/commands", { app, kind, args, timeout_seconds: timeout }, { headers });
  if (res.status !== 201) throw new Error("enqueue " + kind + ": " + res.status + " " + JSON.stringify(res.body));
  return res.body.id;
}

async function waitCommand(server, id, wait = 10) {
  const res = await call(server, "GET", "/v1/bridge/commands/" + id + "?wait=" + wait);
  if (res.status !== 200) throw new Error("get command: " + res.status);
  return res.body;
}

async function seedAsset(server, filename, contentType, data) {
  const res = await call(
    server,
    "POST",
    "/mock/assets?filename=" + encodeURIComponent(filename) + "&content_type=" + encodeURIComponent(contentType),
    data,
    { token: null }
  );
  return res.body;
}

async function assetBytes(server, id) {
  return (await call(server, "GET", "/mock/assets/" + id + "/bytes", undefined, { token: null })).raw;
}

function tempDir(prefix = "nolgia-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function until(fn, seconds = 10, label = "condition") {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting for " + label);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// A tiny valid PNG (a red block).
function png(width = 4, height = 2) {
  const zlib = require("zlib");
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([230, 40, 40]))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(require("zlib").crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = {
  REPO,
  TOKEN,
  startMock,
  call,
  reset,
  state,
  enqueue,
  waitCommand,
  seedAsset,
  assetBytes,
  tempDir,
  until,
  png,
};
