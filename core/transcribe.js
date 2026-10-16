// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Transcripts of the clips in a Premiere Pro project (the `transcribe`
// command kind).
//
// Two engines:
//
// - Premiere's own Speech to Text, free and on this computer. Only
//   Premiere's UXP scripting reaches it (ExtendScript has no transcript
//   API), so a small UXP plugin, NOLGIA Transcripts (adobe/premiere-uxp),
//   does that part. It talks to this service over a local HTTP link on
//   127.0.0.1 (HelperLink below): it long-polls for a job, runs it in
//   Premiere and posts the answer back. Premiere 25.6 and later read a
//   transcript Premiere already made (Text panel > Transcribe, or
//   transcribe on import); 26.5 and later can also make one.
// - NOLGIA's transcription (POST /assets/{id}/transcription,
//   1 credit per started minute): Premiere exports the clip's audio as an
//   MP3, it is uploaded to the person's library and transcribed. Only when
//   the command says allow_credits, because it costs credits.
//
// Every transcript is saved as JSON next to the project
// (nolgia_transcripts/<clip>.json) and comes back in the result as timed
// segments.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const util = require("./util");

// The ports the helper tries, in order. The service takes the first free one.
const HELPER_PORTS = [47731, 47732, 47733];
const HELPER_PATH = "/v1/helper";
// The helper counts as connected while it polled this recently (its long
// poll lasts at most POLL_WAIT seconds).
const HELPER_STALE = 45;
const POLL_WAIT = 20;
const MAX_HELPER_BODY = 32 * 1024 * 1024;
// What one clip may cost through NOLGIA: 1 credit per started minute.
const CREDITS_PER_MINUTE = 1;
const NOLGIA_MAX_SECONDS = 3600;
// Keep a finished result well under the API's 1 MB; full transcripts are in
// the saved files.
const RESULT_BUDGET = 700 * 1000;

class TranscribeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranscribeError";
  }
}

// ------------------------------------------------------------- helper link

// The service side of the link to NOLGIA Transcripts. Jobs wait in a queue;
// the helper's poll takes the next one, and its answer settles the job.
//
// The link listens on 127.0.0.1 only, and only while NOLGIA is connected in
// Premiere. Each start makes a new secret, written with the port to
// LINK_FILE in the plugin's settings folder (readable only by the person);
// every request must carry it in X-NOLGIA-Helper, and the file goes when the
// link stops.
const LINK_FILE = "transcripts-link.json";

class HelperLink {
  constructor({ ports = HELPER_PORTS, dir = null, log = () => {}, clock = () => Date.now() / 1000 } = {}) {
    this.ports = ports;
    this.dir = dir;
    this.secret = null;
    this.log = log;
    this.clock = clock;
    this.server = null;
    this.port = null;
    this.lastSeen = 0;
    this.info = null;
    this.queue = [];
    this.pending = new Map(); // id -> job handed to the helper
    this.waiter = null; // {res, timer}: the helper's open poll
    this.seq = 0;
    this.onChange = () => {};
  }

  // Listen on the first free port. Resolves the port, or null when none is
  // free (the command then says so; nothing else breaks).
  // Listen on `host`: resolves the server, or the error code.
  listenOn(port, host) {
    const server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => {
      server.once("error", (err) => {
        try {
          server.close();
        } catch (e) {
          // never listened
        }
        resolve((err && err.code) || "error");
      });
      server.listen(port, host, () => resolve(server));
    });
  }

  // The helper reaches the link as localhost (Premiere's UXP takes network
  // permissions by host name), which macOS resolves to ::1 first: so the
  // link listens on the IPv4 and the IPv6 loopback, on the same port, and
  // nowhere else.
  async start() {
    this.secret = crypto.randomBytes(24).toString("hex");
    for (const port of this.ports) {
      const v4 = await this.listenOn(port, "127.0.0.1");
      if (typeof v4 === "string") continue;
      const actual = v4.address().port; // port 0 (tests) picks a free one
      const v6 = await this.listenOn(actual, "::1");
      if (v6 === "EADDRINUSE") {
        // Something else answers localhost on this port: try the next one.
        v4.close();
        continue;
      }
      this.server = v4;
      this.servers = typeof v6 === "string" ? [v4] : [v4, v6]; // no IPv6 here: IPv4 only
      this.port = actual;
      this.writeLinkFile();
      this.log(
        "Waiting for NOLGIA Transcripts on 127.0.0.1" + (this.servers.length > 1 ? " and [::1]" : "") + ":" + this.port + "."
      );
      return this.port;
    }
    this.log("Ports " + this.ports.join(", ") + " are all taken, so NOLGIA Transcripts cannot connect.");
    return null;
  }

  get linkFile() {
    return this.dir ? path.join(this.dir, LINK_FILE) : null;
  }

  writeLinkFile() {
    if (!this.linkFile) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.linkFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ port: this.port, secret: this.secret, pid: process.pid }), { mode: 0o600 });
    fs.renameSync(tmp, this.linkFile);
  }

  removeLinkFile() {
    if (!this.linkFile) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.linkFile, "utf8"));
      if (current.secret === this.secret) fs.unlinkSync(this.linkFile);
    } catch (e) {
      // already gone, or another Premiere's
    }
  }

  stop() {
    this.removeLinkFile();
    this.lastSeen = 0;
    if (this.waiter) this.answerPoll(null);
    for (const job of this.queue.concat(Array.from(this.pending.values()))) {
      job.reject(new TranscribeError("NOLGIA for Premiere Pro stopped before NOLGIA Transcripts answered."));
    }
    this.queue = [];
    this.pending.clear();
    for (const server of this.servers || (this.server ? [this.server] : [])) server.close();
    this.server = null;
    this.servers = [];
  }

  get connected() {
    return this.lastSeen > 0 && this.clock() - this.lastSeen < HELPER_STALE;
  }

  // What the panel and `transcribe` say about the helper.
  status() {
    if (!this.server) return { connected: false, note: "The local link for NOLGIA Transcripts is not running." };
    const out = { connected: this.connected, port: this.port };
    if (this.info) Object.assign(out, { helper_version: this.info.helper_version, premiere_version: this.info.premiere_version, can: this.info.can });
    return out;
  }

  // Run `op` in the helper. Resolves its result or rejects TranscribeError.
  call(op, args, timeoutSeconds) {
    return new Promise((resolve, reject) => {
      const id = "h" + Date.now().toString(36) + (++this.seq).toString(36) + crypto.randomBytes(4).toString("hex");
      const job = { id, op, args, resolve, reject, timer: null };
      job.timer = util.timers.setTimeout(() => {
        this.queue = this.queue.filter((j) => j !== job);
        this.pending.delete(id);
        reject(new TranscribeError("NOLGIA Transcripts did not answer within " + Math.round(timeoutSeconds) + " s."));
      }, Math.max(1, timeoutSeconds) * 1000);
      const settle = (fn) => (value) => {
        util.timers.clearTimeout(job.timer);
        fn(value);
      };
      job.resolve = settle(resolve);
      job.reject = settle(reject);
      this.queue.push(job);
      if (this.waiter) this.answerPoll(this.queue.shift());
    });
  }

  answerPoll(job) {
    const waiter = this.waiter;
    this.waiter = null;
    util.timers.clearTimeout(waiter.timer);
    if (job) this.pending.set(job.id, job);
    send(waiter.res, 200, { job: job ? { id: job.id, op: job.op, args: job.args } : null });
  }

  handle(req, res) {
    const port = this.port;
    // Only the helper: a request from a web page cannot set this header
    // without a CORS preflight (never answered), and a DNS-rebound page
    // arrives with its own Host.
    const host = String(req.headers.host || "").toLowerCase();
    if (!["127.0.0.1:", "localhost:", "[::1]:"].some((name) => host === name + port)) {
      return send(res, 403, { error: "forbidden" });
    }
    if (!this.secretMatches(req.headers["x-nolgia-helper"])) return send(res, 403, { error: "forbidden" });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    readBody(req, MAX_HELPER_BODY)
      .then((body) => {
        if (req.url === HELPER_PATH + "/poll") return this.onPoll(body, req, res);
        if (req.url === HELPER_PATH + "/result") return this.onResult(body, res);
        send(res, 404, { error: "not found" });
      })
      .catch((err) => send(res, 400, { error: String((err && err.message) || err) }));
  }

  secretMatches(given) {
    if (!this.secret || typeof given !== "string") return false;
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(this.secret, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  onPoll(body, req, res) {
    const firstContact = !this.connected;
    this.lastSeen = this.clock();
    if (body && body.info && typeof body.info === "object") this.info = body.info;
    if (firstContact) {
      this.log(
        "NOLGIA Transcripts connected (" + ((this.info && this.info.helper_version) || "?") + ", Premiere Pro " +
          ((this.info && this.info.premiere_version) || "?") + ")."
      );
      this.onChange();
    }
    if (this.waiter) this.answerPoll(null); // one poll at a time
    if (this.queue.length) {
      this.waiter = { res, timer: null };
      return this.answerPoll(this.queue.shift());
    }
    const asked = body && body.wait !== undefined && body.wait !== null ? Number(body.wait) : POLL_WAIT;
    const wait = Math.max(0, Math.min(POLL_WAIT, Number.isFinite(asked) ? asked : POLL_WAIT));
    const waiter = { res, timer: null };
    waiter.timer = util.timers.setTimeout(() => {
      if (this.waiter === waiter) this.answerPoll(null);
    }, wait * 1000);
    this.waiter = waiter;
    req.on("close", () => {
      if (this.waiter === waiter && !res.writableEnded) {
        util.timers.clearTimeout(waiter.timer);
        this.waiter = null;
      }
    });
  }

  onResult(body, res) {
    this.lastSeen = this.clock();
    const job = body && this.pending.get(body.id);
    if (!job) return send(res, 404, { error: "no such job" });
    this.pending.delete(body.id);
    send(res, 200, { ok: true });
    if (body.ok) job.resolve(body.result === undefined ? null : body.result);
    else job.reject(new TranscribeError(String(body.error || "NOLGIA Transcripts could not do this.")));
  }
}

function send(res, status, body) {
  if (res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------- normalisation

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

const TICKS_PER_SECOND = 254016000000;

// Premiere's times may come as seconds, as ticks or as {seconds}/{ticks}.
function seconds(value) {
  if (value && typeof value === "object") {
    if (num(value.seconds) !== null) return num(value.seconds);
    if (num(value.ticks) !== null) return num(value.ticks) / TICKS_PER_SECOND;
    return null;
  }
  const n = num(value);
  if (n === null) return null;
  if (Math.abs(n) > 1e9) return n / TICKS_PER_SECOND; // ticks
  return n;
}

function first(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

// Join words as text: punctuation sticks to the word before it.
function joinWords(words) {
  let text = "";
  for (const w of words) {
    const t = String(w.text || "").trim();
    if (!t) continue;
    if (!text || /^[.,!?;:%)\]}'’]/.test(t) || w.punctuation) text += t;
    else text += " " + t;
  }
  return text.trim();
}

// A transcript as Premiere's Transcript.exportToJSON hands it (a JSON
// string), as timed segments. Premiere's format is not documented, so this
// reads the shapes it has been seen in and keeps the original next to the
// result.
function normalizePremiere(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new TranscribeError("Premiere's transcript is not JSON.");
    }
  }
  if (!data || typeof data !== "object") throw new TranscribeError("Premiere's transcript is empty.");
  const speakers = new Map();
  for (const s of first(data, ["speakers", "Speakers"]) || []) {
    const id = first(s, ["id", "ID", "speakerId", "speaker_id"]);
    const name = first(s, ["name", "Name", "displayName"]);
    if (id !== undefined && name) speakers.set(String(id), String(name));
  }
  let segments = first(data, ["segments", "Segments"]);
  if (!segments && data.transcript && typeof data.transcript === "object") segments = first(data.transcript, ["segments", "Segments"]);
  if (!Array.isArray(segments)) segments = [];
  const out = [];
  const allWords = [];
  for (const seg of segments) {
    const words = [];
    for (const w of first(seg, ["words", "Words"]) || []) {
      const text = String(first(w, ["text", "Text", "word"]) || "");
      const start = seconds(first(w, ["start", "startTime", "start_time", "Start"]));
      let end = seconds(first(w, ["end", "endTime", "end_time", "End"]));
      const duration = seconds(first(w, ["duration", "Duration"]));
      if (end === null && start !== null && duration !== null) end = start + duration;
      const type = String(first(w, ["type", "Type"]) || "").toLowerCase();
      words.push({ text, start, end, punctuation: type === "punctuation", eos: w.eos === true });
    }
    let start = seconds(first(seg, ["start", "startTime", "start_time", "Start"]));
    let end = seconds(first(seg, ["end", "endTime", "end_time", "End"]));
    const duration = seconds(first(seg, ["duration", "Duration"]));
    const timed = words.filter((w) => w.start !== null);
    if (start === null && timed.length) start = timed[0].start;
    if (end === null && start !== null && duration !== null) end = start + duration;
    if (end === null && timed.length) {
      const last = timed[timed.length - 1];
      end = last.end !== null ? last.end : last.start;
    }
    const text = words.length ? joinWords(words) : String(first(seg, ["text", "Text"]) || "").trim();
    if (!text || start === null) continue;
    const entry = { start: round3(start), end: round3(end !== null ? end : start), text };
    const speaker = first(seg, ["speaker", "speakerId", "speaker_id", "Speaker"]);
    if (speaker !== undefined && speaker !== null && speaker !== "") {
      const label = speakers.get(String(speaker)) || String(speaker);
      // Premiere says "Unknown" when speaker labeling is off: that is no label.
      if (!/^unknown$/i.test(label.trim())) entry.speaker = label;
    }
    out.push(entry);
    for (const w of words) {
      if (w.start === null || !w.text.trim()) continue;
      allWords.push({
        start: round3(w.start),
        end: round3(w.end !== null ? w.end : w.start),
        text: w.text.trim(),
        punctuation: w.punctuation || undefined,
        eos: w.eos || undefined,
      });
    }
  }
  const language = first(data, ["language", "Language", "languageCode", "locale"]);
  return {
    language: language ? String(language) : null,
    timing: allWords.length ? "words" : "segments",
    segments: out,
    words: allWords.length ? allWords : null,
  };
}

// Sentences from timed words: each ends at . ! or ?, with the time of its
// first and last word. Nothing is invented: without word times there are
// no sentences.
function sentencesFrom(words, segments) {
  if (!words || !words.length) return null;
  const out = [];
  let current = [];
  const flush = () => {
    const timed = current.filter((w) => !w.punctuation);
    if (timed.length) {
      const entry = { start: timed[0].start, end: timed[timed.length - 1].end, text: joinWords(current) };
      const seg = (segments || []).find((s) => s.start <= entry.start + 0.001 && s.end >= entry.start - 0.001);
      if (seg && seg.speaker) entry.speaker = seg.speaker;
      out.push(entry);
    }
    current = [];
  };
  // A sentence ends at . ! or ?, or where Premiere marks one (eos).
  for (const w of words) {
    current.push(w);
    if (w.eos || /[.!?]["'”’)]*$/.test(w.text)) flush();
  }
  flush();
  return out;
}

// NOLGIA's transcript (AssetTranscription): segments are chunks of up to
// about 24 seconds, cut at pauses, with no word times.
function normalizeNolgia(row) {
  const segments = [];
  for (const s of (row && row.segments) || []) {
    const start = num(s.start);
    const end = num(s.end);
    const text = String(s.text || "").trim();
    if (start === null || !text) continue;
    segments.push({ start: round3(start), end: round3(end !== null ? end : start), text });
  }
  return { language: (row && row.language) || null, timing: "chunks", segments, words: null };
}

// ---------------------------------------------------------------- pricing

// What NOLGIA's transcription of these clips costs: 1 credit per started
// minute of each clip (each clip is its own audio file).
function estimate(clips) {
  let credits = 0;
  let total = 0;
  for (const c of clips) {
    const s = Math.max(0, num(c.duration) || 0);
    total += s;
    credits += Math.max(1, Math.ceil(s / 60)) * CREDITS_PER_MINUTE;
  }
  return { clips: clips.length, minutes: Math.round((total / 60) * 10) / 10, credits };
}

// ------------------------------------------------------------------ files

// Where transcripts are saved: next to the project in nolgia_transcripts,
// or Documents/NOLGIA exports/transcripts while it was never saved.
function transcriptDir(projectPath, documents) {
  if (projectPath) return path.join(path.dirname(projectPath), "nolgia_transcripts");
  return path.join(documents, "NOLGIA exports", "transcripts");
}

function saveTranscript(dir, clip, entry, raw) {
  fs.mkdirSync(dir, { recursive: true });
  const stem = util.safeFilename(path.parse(clip.name || path.basename(clip.path || "clip")).name, "clip");
  // Premiere's transcript is <clip>.json, NOLGIA's <clip>.nolgia.json, so
  // one never replaces the other.
  const file = path.join(dir, stem + (entry.engine === "nolgia" ? ".nolgia" : "") + ".json");
  const body = Object.assign({ clip: clip.name, media: clip.path || null }, entry);
  if (raw !== undefined && raw !== null) body.premiere = typeof raw === "string" ? safeParse(raw) : raw;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

// Shrink a finished result to fit: words go first, then the text of later
// segments. The saved files keep everything.
function fitResult(result) {
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size() <= RESULT_BUDGET) return result;
  for (const t of result.transcripts) delete t.words;
  if (size() <= RESULT_BUDGET) {
    result.note = "Word times are left out to keep this short; they are in each saved file.";
    return result;
  }
  for (const t of result.transcripts) {
    delete t.sentences;
  }
  for (let i = result.transcripts.length - 1; i >= 0 && size() > RESULT_BUDGET; i--) {
    const t = result.transcripts[i];
    t.segments_left_out = t.segments.length;
    t.segments = [];
  }
  result.note = "Some transcripts are only in their saved files (`file`) to keep this short; read them from there.";
  return result;
}

// ------------------------------------------------------------------- jobs

// Long transcriptions run as a job: the command comes back with a job_id
// once it has waited as long as it may, and `action: "status"` follows it.
class Jobs {
  constructor() {
    this.jobs = new Map();
    this.seq = 0;
  }

  start(run) {
    const id = "tx-" + Date.now().toString(36) + "-" + (++this.seq).toString(36);
    const job = { id, started: Date.now(), progress: "Starting.", result: null, error: null, cancelled: false, finished: false };
    job.done = Promise.resolve()
      .then(() => run(job))
      .then(
        (result) => {
          job.result = result;
        },
        (err) => {
          job.error = String((err && err.message) || err);
        }
      )
      .then(() => {
        job.finished = true;
      });
    this.jobs.set(id, job);
    return job;
  }

  view(job) {
    if (!job.finished) {
      return { job_id: job.id, running: true, seconds: Math.round((Date.now() - job.started) / 1000), progress: job.progress };
    }
    if (job.error) return { job_id: job.id, running: false, error: job.error };
    return Object.assign({ job_id: job.id, running: false }, job.result);
  }

  async waitOrReturn(job, secondsToWait) {
    let timer;
    await Promise.race([job.done, new Promise((r) => (timer = util.timers.setTimeout(r, Math.max(0, secondsToWait) * 1000)))]);
    util.timers.clearTimeout(timer);
    return this.view(job);
  }

  status(id) {
    const job = this.jobs.get(id);
    if (!job) throw new TranscribeError("No transcription job " + id + " here (jobs are kept while Premiere Pro stays open).");
    return this.view(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new TranscribeError("No transcription job " + id + " here.");
    const running = !job.finished;
    job.cancelled = true;
    return { job_id: id, cancelled: running, note: "Clips already transcribed stay saved; the rest are skipped." };
  }
}

module.exports = {
  HELPER_PORTS,
  LINK_FILE,
  HELPER_PATH,
  POLL_WAIT,
  CREDITS_PER_MINUTE,
  NOLGIA_MAX_SECONDS,
  RESULT_BUDGET,
  TranscribeError,
  HelperLink,
  Jobs,
  normalizePremiere,
  normalizeNolgia,
  sentencesFrom,
  estimate,
  transcriptDir,
  saveTranscript,
  fitResult,
  seconds,
};
