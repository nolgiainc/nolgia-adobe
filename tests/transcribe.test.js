// SPDX-License-Identifier: GPL-3.0-or-later
// Transcripts in Premiere Pro (`transcribe`): the transcript readers, the
// local link to NOLGIA Transcripts with the real helper code against a
// stand-in for Premiere's UXP API, and the command end to end against the
// mock API (NOLGIA's transcription as the fallback).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const support = require("./support");
const tx = require("../core/transcribe");
const c = require("../core/commands");
const { APPS } = require("../core/index");
const { Controller } = require("../core/controller");
const { Helper } = require("../premiere-uxp/helper");

// Premiere's transcript JSON in the shape it has been reported in: segments
// with words (punctuation as its own entries) and a speaker list.
const PREMIERE_JSON = JSON.stringify({
  language: "en-us",
  segments: [
    {
      start: 0.5,
      duration: 3.1,
      speaker: "s1",
      words: [
        { text: "The", start: 0.5, duration: 0.2, type: "word" },
        { text: "days", start: 0.7, duration: 0.3, type: "word" },
        { text: "are", start: 1.0, duration: 0.2, type: "word" },
        { text: "gone", start: 1.2, duration: 0.4, type: "word" },
        { text: ".", start: 1.6, duration: 0, type: "punctuation" },
        { text: "Here", start: 2.4, duration: 0.3, type: "word" },
        { text: ",", start: 2.7, duration: 0, type: "punctuation" },
        { text: "look", start: 2.8, duration: 0.4, type: "word" },
        { text: "!", start: 3.2, duration: 0, type: "punctuation" },
      ],
    },
    { start: 5.0, duration: 1.0, speaker: "s2", words: [{ text: "Okay.", start: 5.0, duration: 0.6, type: "word" }] },
  ],
  speakers: [
    { id: "s1", name: "Speaker 1" },
    { id: "s2", name: "Speaker 2" },
  ],
});

test("Premiere's transcript becomes timed segments, sentences and words", () => {
  const t = tx.normalizePremiere(PREMIERE_JSON);
  assert.equal(t.timing, "words");
  assert.equal(t.language, "en-us");
  assert.deepEqual(t.segments, [
    { start: 0.5, end: 3.6, text: "The days are gone. Here, look!", speaker: "Speaker 1" },
    { start: 5, end: 6, text: "Okay.", speaker: "Speaker 2" },
  ]);
  const sentences = tx.sentencesFrom(t.words, t.segments);
  assert.deepEqual(sentences, [
    { start: 0.5, end: 1.6, text: "The days are gone.", speaker: "Speaker 1" },
    { start: 2.4, end: 3.2, text: "Here, look!", speaker: "Speaker 1" },
    { start: 5, end: 5.6, text: "Okay.", speaker: "Speaker 2" },
  ]);
});

test("times in ticks and plain text segments are read too", () => {
  const ticks = 254016000000;
  const t = tx.normalizePremiere({ segments: [{ startTime: 2 * ticks, endTime: 4.5 * ticks, text: "Hello there." }] });
  assert.deepEqual(t.segments, [{ start: 2, end: 4.5, text: "Hello there." }]);
  assert.equal(t.timing, "segments");
  assert.equal(tx.sentencesFrom(t.words, t.segments), null, "no word times, no invented sentence times");
  assert.throws(() => tx.normalizePremiere("not json"), tx.TranscribeError);
});

test("NOLGIA's transcript and the price", () => {
  const t = tx.normalizeNolgia({ language: "en", segments: [{ start: 0, end: 23.9, text: " Long chunk. " }, { start: 1, text: "" }] });
  assert.deepEqual(t, { language: "en", timing: "chunks", segments: [{ start: 0, end: 23.9, text: "Long chunk." }], words: null });
  // 1 credit per started minute of each clip, at least 1.
  assert.deepEqual(tx.estimate([{ duration: 22 }, { duration: 61 }, { duration: null }]), { clips: 3, minutes: 1.4, credits: 4 });
});

test("transcribe arguments", () => {
  const PR = APPS.PPRO;
  assert.deepEqual(c.validate(PR, "transcribe", {}), {
    action: "start", clips: "selected", sequence: null, engine: "auto", allow_credits: false, words: false, language: "en",
  });
  assert.deepEqual(c.validate(PR, "transcribe", { action: "status", job_id: "tx-1" }), { action: "status", job_id: "tx-1" });
  const named = c.validate(PR, "transcribe", { clips: [" C0001.MP4 "], engine: "nolgia", allow_credits: true, language: "de" });
  assert.deepEqual([named.clips, named.engine, named.allow_credits, named.language], [["C0001.MP4"], "nolgia", true, "de"]);
  for (const bad of [{ clips: "all" }, { clips: [] }, { clips: [3] }, { engine: "whisper" }, { allow_credits: "yes" }, { language: "eng" }, { action: "status" }]) {
    assert.throws(() => c.validate(PR, "transcribe", bad), c.CommandError, JSON.stringify(bad));
  }
  assert.throws(() => c.validate(APPS.AEFT, "transcribe", {}), /cannot do "transcribe"/);
  assert.ok(c.capabilitiesFor(PR).includes("transcribe"));
  assert.ok(!c.capabilitiesFor(APPS.AEFT).includes("transcribe"));
});

// ---------------------------------------------------- a stand-in Premiere

// require("premierepro") as NOLGIA Transcripts uses it: a project with a bin
// holding `clips` ({name, path, transcript?}); `api` picks which transcript
// calls this Premiere has (25.6: read; 26.3: + check; 26.5: + make).
function fakePremiere(clips, api = "26.5") {
  const TYPE = { TYPE_CLIP: 1, TYPE_BIN: 2, TYPE_ROOT: 3, TYPE_FILE: 4 };
  const made = [];
  const item = (clip) => ({
    type: TYPE.TYPE_CLIP,
    name: clip.name,
    clip,
    async getMediaFilePath() {
      return clip.path;
    },
    async isSequence() {
      return false;
    },
  });
  const bin = { type: TYPE.TYPE_BIN, name: "Footage", async getItems() { return clips.map(item); } };
  const root = { async getItems() { return [bin]; } };
  const Transcript = {
    async exportToJSON(clipItem) {
      if (!clipItem.clip.transcript) throw new Error("no transcript");
      return clipItem.clip.transcript;
    },
  };
  if (api >= "26.3") {
    Transcript.hasTranscript = (clipItem) => Boolean(clipItem.clip.transcript);
    Transcript.querySupportedLanguages = () => [
      { displayString: "English (UK)", languageCode: "en-GB", locale: "en-GB" },
      { displayString: "English", languageCode: "en-US", locale: "en-US" },
    ];
  }
  if (api >= "26.5") {
    Transcript.isLanguagePackAvailable = (code) => code === "en-US";
    Transcript.transcribeClipProjectItem = async (clipItem, options) => {
      made.push([clipItem.clip.name, options]);
      clipItem.clip.transcript = PREMIERE_JSON;
      return true;
    };
  }
  return {
    made,
    ProjectItem: TYPE,
    Project: { async getActiveProject() { return { async getRootItem() { return root; } }; } },
    FolderItem: { cast: (x) => x },
    ClipProjectItem: { cast: (x) => x },
    Transcript,
  };
}

async function linkWithHelper(ppro, { premiereVersion = "26.5.0" } = {}) {
  const link = new tx.HelperLink({ ports: [0] });
  const port = await link.start();
  const helper = new Helper({ ppro, fetch: (url, o) => fetch(url, o), premiereVersion, ports: [port], sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  helper.loop();
  await support.until(() => link.connected, 5, "helper connected");
  return { link, helper, port, stop: () => { helper.stopped = true; link.stop(); } };
}

test("NOLGIA Transcripts reads, and on 26.5 makes, Premiere's transcripts over the local link", async () => {
  const ppro = fakePremiere([
    { name: "A.mp4", path: "C:\\Shoot\\A.mp4", transcript: PREMIERE_JSON },
    { name: "B.mp4", path: "C:\\Shoot\\B.mp4" },
  ]);
  const h = await linkWithHelper(ppro);
  try {
    assert.equal(h.link.status().connected, true);
    assert.deepEqual(h.link.status().can, { read: true, check: true, make: true });
    const a = await h.link.call("transcript", { path: "c:/shoot/a.MP4", name: "A.mp4", language: "en", transcribe: true }, 10);
    assert.deepEqual([a.found, a.made, a.json], [true, false, PREMIERE_JSON]);
    const b = await h.link.call("transcript", { path: "C:\\Shoot\\B.mp4", name: "B.mp4", language: "en", transcribe: true }, 10);
    assert.deepEqual([b.found, b.made], [true, true]);
    assert.deepEqual(ppro.made, [["B.mp4", { languageCode: "en-US" }]], "the en-US pack, the one installed");
    const gone = await h.link.call("transcript", { path: "C:\\Shoot\\Z.mp4", name: "Z.mp4", transcribe: true }, 10);
    assert.deepEqual(gone, { found: false, reason: "not_found" });
    await assert.rejects(h.link.call("nonsense", {}, 10), /does not know nonsense/);
  } finally {
    h.stop();
  }
});

test("before 26.5 Premiere's transcripts are read, not made", async () => {
  const ppro = fakePremiere([{ name: "B.mp4", path: "/S/B.mp4" }], "26.3");
  const h = await linkWithHelper(ppro, { premiereVersion: "26.3.0" });
  try {
    const b = await h.link.call("transcript", { path: "/S/B.mp4", name: "B.mp4", transcribe: true }, 10);
    assert.deepEqual(b, { found: false, reason: "no_transcript", can_transcribe: false });
  } finally {
    h.stop();
  }
  // 25.6 to 26.2 cannot ask first: a failed export means no transcript.
  const old = fakePremiere([{ name: "B.mp4", path: "/S/B.mp4" }], "26.2");
  const h2 = await linkWithHelper(old, { premiereVersion: "26.2.0" });
  try {
    const b = await h2.link.call("transcript", { path: "/S/B.mp4", name: "B.mp4", transcribe: true }, 10);
    assert.deepEqual(b, { found: false, reason: "no_transcript", can_transcribe: false });
  } finally {
    h2.stop();
  }
});

function raw(port, { host, header = "1", body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: tx.HELPER_PATH + "/poll", method: "POST", headers: Object.assign({ Host: host || "127.0.0.1:" + port }, header ? { "X-NOLGIA-Helper": header } : {}) },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("the local link answers only the helper", async () => {
  const link = new tx.HelperLink({ ports: [0] });
  const port = await link.start();
  try {
    assert.equal(await raw(port, { header: null }), 403, "a web page cannot set the header without a preflight");
    assert.equal(await raw(port, { host: "evil.example:" + port }), 403, "a DNS-rebound page has its own Host");
    assert.equal(link.connected, false);
  } finally {
    link.stop();
  }
});

// ------------------------------------------------------- the whole command

let server;
test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());

function premiereHost(clips) {
  const root = support.tempDir();
  const host = {
    hostId: "PPRO",
    userData: path.join(root, "userData"),
    documents: path.join(root, "Documents"),
    calls: [],
    async call(kind, args) {
      this.calls.push([kind, args]);
      if (kind === "snapshot") return { ok: true, result: { document: { name: "" }, dirty: false, app_version: "26.2.0" } };
      if (kind === "transcribe_targets") {
        const picked = Array.isArray(args.clips) ? clips.filter((x) => args.clips.includes(x.name)) : clips;
        return { ok: true, result: { clips: picked, note: "" } };
      }
      if (kind === "transcribe_audio") {
        const file = path.join(args.folder, args.stem + ".mp3");
        fs.writeFileSync(file, Buffer.alloc(61500, 1)); // 61.5 s at the mock's 1,000 bytes a second
        return { ok: true, result: { path: file, clip: "B.mp4", duration: 61.5 } };
      }
      return { ok: false, error: "no handler for " + kind };
    },
    async convertImage() {},
    openURL() {},
    openPanel() {},
    broadcast() {},
    log() {},
  };
  fs.mkdirSync(host.documents, { recursive: true });
  return host;
}

function command(args) {
  return { args: c.validate(APPS.PPRO, "transcribe", args), requester: "Your agent", remaining: () => 60, deadline: Number.POSITIVE_INFINITY, timeout: 60 };
}

test("transcribe: Premiere's transcript where it has one, NOLGIA's for the rest once credits are allowed", async () => {
  await support.reset(server);
  const clips = [
    { name: "A.mp4", path: "/S/A.mp4", node_id: "1", duration: 22 },
    { name: "B.mp4", path: "/S/B.mp4", node_id: "2", duration: 61.5 },
  ];
  const ppro = fakePremiere([{ name: "A.mp4", path: "/S/A.mp4", transcript: PREMIERE_JSON }, { name: "B.mp4", path: "/S/B.mp4" }], "26.3");
  const host = premiereHost(clips);
  const ctl = new Controller(host, { environ: { NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_TRANSCRIPTS_PORTS: "0" } });
  ctl.start();
  await support.until(() => ctl.helper && ctl.helper.port, 5, "link up");
  const helper = new Helper({ ppro, fetch: (url, o) => fetch(url, o), premiereVersion: "26.3.0", ports: [ctl.helper.port] });
  helper.loop();
  const { ApiClient } = require("../core/api");
  const api = new ApiClient({ baseUrl: server.base, token: support.TOKEN });
  try {
    await support.until(() => ctl.helper.connected, 5, "helper connected");
    assert.equal(ctl.state().transcripts.connected, true);

    // Without allow_credits: Premiere's transcript of A, the price of B.
    const first = await ctl.do_transcribe(command({ clips: ["A.mp4", "B.mp4"] }), api);
    assert.equal(first.running, false);
    assert.deepEqual(first.transcripts.map((t) => [t.clip, t.engine, t.timing]), [["A.mp4", "premiere", "words"]]);
    assert.deepEqual(first.transcripts[0].speakers, ["Speaker 1", "Speaker 2"]);
    assert.equal(first.transcripts[0].sentences.length, 3);
    assert.equal(first.transcripts[0].words, undefined, "words only when asked");
    assert.deepEqual(first.needs_credits, { clips: 1, minutes: 1, credits: 2, clip_names: ["B.mp4"] });
    assert.equal(first.missing[0].reason, "no_transcript");
    assert.match(first.missing[0].fix, /Text > Transcript > Transcribe/);
    assert.match(first.speakers_note, /ask the person who is who/);
    const saved = JSON.parse(fs.readFileSync(first.transcripts[0].file, "utf8"));
    assert.equal(saved.clip, "A.mp4");
    assert.ok(saved.premiere.segments, "Premiere's own JSON is kept in the file");
    assert.equal(path.dirname(first.transcripts[0].file), path.join(host.documents, "NOLGIA exports", "transcripts"));
    assert.equal((await support.state(server)).transcripts.length, 0, "nothing was charged");

    // With allow_credits: B goes through NOLGIA.
    const second = await ctl.do_transcribe(command({ clips: ["A.mp4", "B.mp4"], allow_credits: true }), api);
    assert.deepEqual(second.transcripts.map((t) => [t.clip, t.engine]), [["A.mp4", "premiere"], ["B.mp4", "nolgia"]]);
    const b = second.transcripts[1];
    assert.equal(b.timing, "chunks");
    assert.equal(b.segments.length, 2);
    assert.equal(b.credits_charged, 2);
    assert.equal(second.credits_charged, 2);
    assert.equal(second.missing, undefined);
    const st = await support.state(server);
    assert.deepEqual(st.transcripts.map((t) => [t.language, t.credits]), [["en", 2]]);
    const upload = st.uploads.find((u) => u.content_type === "audio/mpeg");
    assert.ok(upload, "the clip's audio went up as an MP3");
    const audioCall = host.calls.find(([kind]) => kind === "transcribe_audio");
    assert.equal(audioCall[1].node_id, "2");
    assert.ok(!fs.existsSync(audioCall[1].folder), "the local MP3 is removed");

    // engine "nolgia" without allow_credits: only the price.
    const priced = await ctl.do_transcribe(command({ clips: ["A.mp4"], engine: "nolgia" }), api);
    assert.deepEqual(priced.needs_credits, { clips: 1, minutes: 0.4, credits: 1, clip_names: ["A.mp4"] });
    assert.deepEqual(priced.transcripts, []);
  } finally {
    helper.stopped = true;
    ctl.shutdown();
  }
});

test("transcribe: engine premiere needs NOLGIA Transcripts", async () => {
  const host = premiereHost([{ name: "A.mp4", path: "/S/A.mp4", node_id: "1", duration: 5 }]);
  const ctl = new Controller(host, { environ: { NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_TRANSCRIPTS: "0" } });
  ctl.start();
  try {
    await assert.rejects(ctl.do_transcribe(command({ engine: "premiere" }), null), /NOLGIA Transcripts is not running/);
    // auto without the helper and without credits: the price and how to get the helper.
    const res = await ctl.do_transcribe(command({}), null);
    assert.equal(res.needs_credits.credits, 1);
    assert.match(res.missing[0].fix, /nolgia-premiere-transcripts/);
  } finally {
    ctl.shutdown();
  }
});
