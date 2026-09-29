// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Small helpers with no CEP dependency.

"use strict";

const path = require("path");
// Node's own timers, not the page's: in a CEP panel with mixed context the
// global setTimeout is Chromium's, which a hidden page may throttle.
const timers = require("timers");

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:?\d{2})?$/;

// Parse an RFC 3339 timestamp (Go writes up to 9 fraction digits). Returns
// milliseconds since the epoch, or null when the value is missing or odd.
function parseTime(value) {
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Number(((frac || "0") + "000").slice(0, 3));
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (Number.isNaN(t)) return null;
  if (zone && zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "+" ? 1 : -1;
    const digits = zone.slice(1).replace(":", "");
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return t;
}

// Exponential backoff with jitter: base, 2*base, 4*base ... up to cap
// (seconds). Each delay is drawn from [delay/2, delay] so plugins that lost
// the network together do not all come back in the same second.
class Backoff {
  constructor(base = 1, cap = 60, rng = Math.random) {
    this.base = base;
    this.cap = cap;
    this.attempt = 0;
    this.rng = rng;
  }

  next() {
    const delay = Math.min(this.cap, this.base * 2 ** this.attempt);
    this.attempt += 1;
    return delay / 2 + this.rng() * (delay / 2);
  }

  reset() {
    this.attempt = 0;
  }
}

// Keep at most `limit` characters, saying how much was cut.
function cutText(text, limit, keep = "tail") {
  if (text === null || text === undefined) return "";
  text = String(text);
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  if (keep === "head") return text.slice(0, limit) + "\n[" + dropped + " more characters cut]";
  return "[" + dropped + " characters cut]\n" + text.slice(-limit);
}

// File types NOLGIA accepts through POST /assets/uploads, by extension.
const UPLOAD_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".glb": "model/gltf-binary",
};

// What an asset's MIME type means as a file on disk, for import.
const MIME_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/tiff": ".tif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "model/gltf-binary": ".glb",
  "model/gltf+json": ".gltf",
  "model/obj": ".obj",
};

const IMPORT_KINDS = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".tif": "image",
  ".tiff": "image",
  ".bmp": "image",
  ".psd": "image",
  ".svg": "vector",
  ".pdf": "vector",
  ".ai": "vector",
  ".eps": "vector",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mxf": "video",
  ".avi": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".aif": "audio",
  ".aiff": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".ogg": "audio",
  ".glb": "model",
  ".gltf": "model",
  ".obj": "model",
};

function startsWith(buf, text) {
  if (!buf || buf.length < text.length) return false;
  for (let i = 0; i < text.length; i++) {
    const want = typeof text === "string" ? text.charCodeAt(i) : text[i];
    if (buf[i] !== want) return false;
  }
  return true;
}

// Guess a file extension from its first bytes.
function sniffExtension(head) {
  if (!head || !head.length) return "";
  const ascii = (a, b) => Buffer.from(head.slice(a, b)).toString("latin1");
  if (startsWith(head, "glTF")) return ".glb";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return ".jpg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ".wav";
  if (startsWith(head, "%PDF")) return ".pdf";
  if (startsWith(head, "GIF8")) return ".gif";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand.startsWith("qt")) return ".mov";
    if (brand === "M4A " || brand === "M4B ") return ".m4a";
    return ".mp4";
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return ".webm";
  if (startsWith(head, "ID3") || (head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3))) return ".mp3";
  if (startsWith(head, "OggS")) return ".ogg";
  const text = ascii(0, Math.min(head.length, 64)).trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && ascii(0, head.length).includes("<svg"))) return ".svg";
  if (text.startsWith("{") && ascii(0, head.length).includes('"asset"')) return ".gltf";
  return "";
}

// Pick the extension to save a downloaded asset under: the name's own
// extension when it is one we can import, then the MIME type, then the
// file's first bytes.
function importExtension(displayName, mimeType, head) {
  let ext = path.extname(String(displayName || "")).toLowerCase();
  if (IMPORT_KINDS[ext]) return ext;
  ext = MIME_EXTENSIONS[String(mimeType || "").split(";")[0].trim().toLowerCase()] || "";
  if (IMPORT_KINDS[ext]) return ext;
  return sniffExtension(head);
}

const UNSAFE = /[^A-Za-z0-9._ -]+/g;

// A file name that is safe on Windows, macOS and Linux.
function safeFilename(name, fallback = "file") {
  const base = path.posix.basename(String(name || "").replace(/\\/g, "/"));
  const clean = base.replace(UNSAFE, "_").replace(/^[ .]+|[ .]+$/g, "");
  return clean.slice(0, 120) || fallback;
}

// A value as ExtendScript source: JSON is a JavaScript literal, as long as
// U+2028 and U+2029 are escaped. Everything outside ASCII is escaped too, so
// the text survives any code page on its way into the app.
function jsLiteral(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  return json.replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function sleep(ms) {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

// A promise-based Event, like Python's threading.Event.
class Signal {
  constructor() {
    this.set_ = false;
    this.waiters = [];
  }

  isSet() {
    return this.set_;
  }

  set() {
    if (this.set_) return;
    this.set_ = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(true);
  }

  clear() {
    this.set_ = false;
  }

  // Resolves true when set, false after `seconds` (null waits forever).
  wait(seconds = null) {
    if (this.set_) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (value) => {
        if (timer) timers.clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(done);
      if (seconds !== null && seconds !== undefined) {
        timer = timers.setTimeout(() => {
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, Math.max(0, seconds * 1000));
      }
    });
  }
}

module.exports = {
  parseTime,
  Backoff,
  cutText,
  UPLOAD_TYPES,
  MIME_EXTENSIONS,
  IMPORT_KINDS,
  sniffExtension,
  importExtension,
  safeFilename,
  jsLiteral,
  sleep,
  Signal,
  timers,
};
