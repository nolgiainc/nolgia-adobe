// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const util = require("../core/util");

test("parseTime reads Go's RFC 3339 with up to 9 fraction digits", () => {
  assert.equal(util.parseTime("2026-09-29T12:00:00Z"), Date.UTC(2026, 8, 29, 12, 0, 0));
  assert.equal(util.parseTime("2026-09-29T12:00:00.123456789Z"), Date.UTC(2026, 8, 29, 12, 0, 0, 123));
  assert.equal(util.parseTime("2026-09-29T14:00:00+02:00"), Date.UTC(2026, 8, 29, 12, 0, 0));
  assert.equal(util.parseTime("2026-09-29T12:00:00.5-0130"), Date.UTC(2026, 8, 29, 13, 30, 0, 500));
  assert.equal(util.parseTime("yesterday"), null);
  assert.equal(util.parseTime(null), null);
});

test("Backoff doubles up to the cap with jitter in the upper half", () => {
  const b = new util.Backoff(1, 8, () => 1);
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next()], [1, 2, 4, 8, 8]);
  b.reset();
  assert.equal(b.next(), 1);
  const low = new util.Backoff(2, 60, () => 0);
  assert.equal(low.next(), 1);
});

test("cutText says how much it cut", () => {
  assert.equal(util.cutText("abcdef", 10), "abcdef");
  assert.equal(util.cutText("abcdef", 2), "[4 characters cut]\nef");
  assert.equal(util.cutText("abcdef", 2, "head"), "ab\n[4 more characters cut]");
  assert.equal(util.cutText(null, 2), "");
});

test("sniffExtension and importExtension", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(util.sniffExtension(png), ".png");
  assert.equal(util.sniffExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
  assert.equal(util.sniffExtension(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), ".webp");
  assert.equal(util.sniffExtension(Buffer.from("\0\0\0\x18ftypisom")), ".mp4");
  assert.equal(util.sniffExtension(Buffer.from("\0\0\0\x14ftypqt  ")), ".mov");
  assert.equal(util.sniffExtension(Buffer.from("%PDF-1.7")), ".pdf");
  assert.equal(util.sniffExtension(Buffer.from('<?xml version="1.0"?><svg xmlns=')), ".svg");
  assert.equal(util.sniffExtension(Buffer.from("glTF")), ".glb");
  assert.equal(util.sniffExtension(Buffer.from("hello")), "");
  // The name wins, then the MIME type, then the bytes.
  assert.equal(util.importExtension("plate.JPG", "image/png", png), ".jpg");
  assert.equal(util.importExtension("plate", "image/png", Buffer.alloc(0)), ".png");
  assert.equal(util.importExtension("clip.bin", "video/quicktime", png), ".mov");
  assert.equal(util.importExtension("x", "application/octet-stream", png), ".png");
});

test("safeFilename keeps names safe on every system", () => {
  assert.equal(util.safeFilename("C:\\a\\b\\My Shot?.aep"), "My Shot_.aep");
  assert.equal(util.safeFilename("../../etc/passwd"), "passwd");
  assert.equal(util.safeFilename("  ..  "), "file");
  assert.equal(util.safeFilename("", "untitled"), "untitled");
  assert.equal(util.safeFilename("x".repeat(300)).length, 120);
});

test("jsLiteral is valid ExtendScript source, ASCII only", () => {
  const value = { text: "a\u2028b\u00e9\"\\\n", n: 1.5, list: [true, null] };
  const lit = util.jsLiteral(value);
  assert.match(lit, /^[\x20-\x7e]*$/);
  assert.ok(lit.includes("\\u2028") && lit.includes("\\u00e9"));
  assert.deepEqual(JSON.parse(lit), value);
  // eslint-disable-next-line no-eval
  assert.deepEqual(eval("(" + lit + ")"), value);
  assert.equal(util.jsLiteral(undefined), "null");
});

test("Signal waits, times out and wakes", async () => {
  const s = new util.Signal();
  assert.equal(await s.wait(0.02), false);
  setTimeout(() => s.set(), 10);
  assert.equal(await s.wait(5), true);
  assert.equal(s.isSet(), true);
  s.clear();
  assert.equal(s.isSet(), false);
});

// The owner's Mac test (2026-10-29): Photoshop said "louieknows's Mac", the
// other plugins "Louies-MacBook-Pro.local"; the Mac is "Louie's MacBook Pro".
test("computerName reads a Mac's Computer Name, else the network name without .local", () => {
  const name = util.computerName({ platform: "darwin", scutil: () => "Louie’s MacBook Pro", hostname: () => "Louies-MacBook-Pro.local" });
  assert.equal(name, "Louie’s MacBook Pro");
  assert.equal(util.computerName({ platform: "darwin", scutil: () => "", hostname: () => "Louies-MacBook-Pro.local" }), "Louies-MacBook-Pro");
  assert.equal(util.computerName({ platform: "win32", scutil: () => "never asked", hostname: () => "DESKTOP-ABC123" }), "DESKTOP-ABC123");
});

test("osName names the operating system the way the API does", () => {
  assert.deepEqual(["darwin", "win32", "linux", "aix"].map(util.osName), ["macos", "windows", "linux", ""]);
});

test("appVersionLabel reads After Effects' 26.5x89 as 26.5 (build 89)", () => {
  assert.equal(util.appVersionLabel("26.5x89"), "26.5 (build 89)");
  assert.equal(util.appVersionLabel("26.5.2"), "26.5.2");
  assert.equal(util.appVersionLabel("30.8.2"), "30.8.2");
  assert.equal(util.appVersionLabel(""), "");
  assert.equal(util.appVersionLabel(undefined), "");
});

test("rememberComputerName keeps the name for NOLGIA for Photoshop", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "nolgia-name-"));
  try {
    assert.equal(util.rememberComputerName("Ada's MacBook Pro", "nolgia-adobe 0.2.2", folder), true);
    const data = JSON.parse(fs.readFileSync(path.join(folder, "computer.json"), "utf8"));
    assert.equal(data.name, "Ada's MacBook Pro");
    assert.equal(data.written_by, "nolgia-adobe 0.2.2");
    assert.equal(data.os, util.osName());
    assert.equal(util.rememberComputerName("", "nolgia-adobe 0.2.2", folder), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
