// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// NOLGIA Transcripts: the part of NOLGIA for Premiere Pro that reaches
// Premiere's own Speech to Text. Premiere's transcripts are only in its UXP
// scripting, and NOLGIA for Premiere Pro is a CEP extension, so this small
// UXP plugin does that one job for it: it long-polls the NOLGIA service on
// 127.0.0.1 (core/transcribe.js, HelperLink) for a job, runs it in Premiere
// and posts the answer back. It never talks to anything else. The port and
// the session's secret come from the link file the service writes while it
// is connected (readLink); without it, nothing is sent.
//
// The logic is here, apart from the UXP glue in main.js, so it runs under
// Node in the tests with a stand-in for require("premierepro").

"use strict";

const HELPER_VERSION = "0.1.4";
const PORTS = [47731, 47732, 47733];
const POLL_PATH = "/v1/helper/poll";
const RESULT_PATH = "/v1/helper/result";
const POLL_WAIT = 20;

function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function has(obj, name) {
  return Boolean(obj) && typeof obj[name] === "function";
}

class Helper {
  constructor({ ppro, fetch, readLink, premiereVersion = "", sleep = null, log = () => {}, onStatus = () => {} }) {
    this.ppro = ppro;
    this.readLink = readLink;
    this.link = null;
    this.fetch = fetch;
    this.premiereVersion = premiereVersion;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = log;
    this.onStatus = onStatus;
    this.anyPort = false; // tests: the link may be on any port
    this.stopped = false;
    this.status = { connected: false, text: "Looking for NOLGIA for Premiere Pro...", last: "" };
  }

  // What this Premiere can do with transcripts.
  info() {
    const T = this.ppro && this.ppro.Transcript;
    return {
      helper_version: HELPER_VERSION,
      premiere_version: this.premiereVersion,
      can: {
        read: has(T, "exportToJSON"),
        check: has(T, "hasTranscript"),
        make: has(T, "transcribeClipProjectItem"),
      },
    };
  }

  setStatus(fields) {
    Object.assign(this.status, fields);
    try {
      this.onStatus(Object.assign({}, this.status));
    } catch (e) {
      // the panel may be closed
    }
  }

  // ------------------------------------------------------------ the link

  async post(link, urlPath, body) {
    const res = await this.fetch("http://127.0.0.1:" + link.port + urlPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-NOLGIA-Helper": link.secret },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // The port and secret the service wrote, or null. Only ports this plugin
  // may reach (manifest.json) are used.
  async currentLink() {
    let link = null;
    try {
      link = await this.readLink();
    } catch (e) {
      link = null;
    }
    if (!link || (!PORTS.includes(Number(link.port)) && !this.anyPort)) return null;
    if (typeof link.secret !== "string" || link.secret.length < 16) return null;
    return { port: Number(link.port), secret: link.secret };
  }

  // Poll forever: take a job, run it, answer, poll again.
  async loop() {
    let misses = 0;
    while (!this.stopped) {
      let answered = false;
      const link = this.link || (await this.currentLink());
      if (link) {
        let reply;
        try {
          reply = await this.post(link, POLL_PATH, { info: this.info(), wait: POLL_WAIT });
          answered = true;
        } catch (e) {
          this.link = null; // read the file again: a new session has a new secret
        }
        if (answered) {
          this.link = link;
          misses = 0;
          if (!this.status.connected) this.setStatus({ connected: true, text: "Connected to NOLGIA for Premiere Pro." });
          if (reply && reply.job) {
            const answer = await this.handle(reply.job);
            try {
              await this.post(link, RESULT_PATH, Object.assign({ id: reply.job.id }, answer));
            } catch (e) {
              this.log("Could not send the answer: " + e.message);
            }
          }
        }
      }
      if (!answered) {
        misses += 1;
        if (this.status.connected || misses === 1) {
          this.setStatus({
            connected: false,
            text: "Waiting for NOLGIA for Premiere Pro to be connected (Window > Extensions > NOLGIA).",
          });
        }
        await this.sleep(Math.min(10000, 2000 * misses));
      }
    }
  }

  async handle(job) {
    try {
      if (job.op === "probe") return { ok: true, result: this.info() };
      if (job.op === "transcript") {
        const result = await this.transcript(job.args || {});
        this.setStatus({ last: (job.args && job.args.name) + ": " + (result.found ? "transcript read" : result.reason) });
        return { ok: true, result };
      }
      return { ok: false, error: "NOLGIA Transcripts does not know " + job.op + "." };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // --------------------------------------------------------- transcripts

  // The ClipProjectItem whose media is `mediaPath` (named `name` when
  // several share it, as subclips do).
  async findClip(mediaPath, name) {
    const ppro = this.ppro;
    const project = await ppro.Project.getActiveProject();
    if (!project) return null;
    const want = normPath(mediaPath);
    const matches = [];
    const walk = async (folder, depth) => {
      const items = await folder.getItems();
      for (const item of items || []) {
        if (item.type === ppro.ProjectItem.TYPE_BIN) {
          if (depth < 12) await walk(ppro.FolderItem.cast(item), depth + 1);
          continue;
        }
        if (item.type !== ppro.ProjectItem.TYPE_CLIP && item.type !== ppro.ProjectItem.TYPE_FILE) continue;
        const clip = ppro.ClipProjectItem.cast(item);
        if (!clip) continue;
        let file = "";
        try {
          file = await clip.getMediaFilePath();
        } catch (e) {
          continue;
        }
        if (normPath(file) !== want) continue;
        try {
          if (await clip.isSequence()) continue;
        } catch (e) {
          // not a sequence
        }
        matches.push({ clip, name: item.name });
      }
    };
    await walk(await project.getRootItem(), 0);
    if (!matches.length) return null;
    const named = matches.find((m) => m.name === name);
    return (named || matches[0]).clip;
  }

  // The language Premiere's Speech to Text calls `language` ("en"), as
  // querySupportedLanguages lists it.
  pickLanguage(language) {
    const T = this.ppro.Transcript;
    if (!has(T, "querySupportedLanguages")) return null;
    let list = [];
    try {
      list = T.querySupportedLanguages() || [];
    } catch (e) {
      return null;
    }
    const want = String(language || "en").toLowerCase();
    const matching = list.filter((l) => {
      const code = String(l.languageCode || l.locale || "").toLowerCase();
      return code === want || code.startsWith(want + "-") || code.startsWith(want + "_");
    });
    return matching.find((l) => /us/i.test(String(l.languageCode || l.locale))) || matching[0] || null;
  }

  // Read the clip's transcript, making it first when Premiere can (26.5+)
  // and `transcribe` allows it. Answers {found, json} or {found: false,
  // reason}.
  async transcript({ path: mediaPath, name, language, transcribe }) {
    const T = this.ppro.Transcript;
    if (!has(T, "exportToJSON")) return { found: false, reason: "no_api" };
    const clip = await this.findClip(mediaPath, name);
    if (!clip) return { found: false, reason: "not_found" };
    let exists = null;
    if (has(T, "hasTranscript")) {
      try {
        exists = Boolean(await T.hasTranscript(clip));
      } catch (e) {
        exists = null;
      }
    }
    let made = false;
    if (exists === false && transcribe && has(T, "transcribeClipProjectItem")) {
      const lang = this.pickLanguage(language);
      const code = lang ? lang.languageCode || lang.locale : null;
      if (lang && has(T, "isLanguagePackAvailable")) {
        let ready = true;
        try {
          ready = Boolean(T.isLanguagePackAvailable(lang.locale || lang.languageCode));
        } catch (e) {
          ready = true;
        }
        if (!ready) return { found: false, reason: "language_pack", can_transcribe: true };
      }
      let ok = false;
      try {
        ok = await T.transcribeClipProjectItem(clip, code ? { languageCode: code } : undefined);
      } catch (e) {
        return { found: false, reason: "transcribe_failed", can_transcribe: true, error: String((e && e.message) || e) };
      }
      if (!ok) return { found: false, reason: "transcribe_failed", can_transcribe: true };
      made = true;
      exists = true;
    }
    if (exists === false) return { found: false, reason: "no_transcript", can_transcribe: has(T, "transcribeClipProjectItem") };
    let json = null;
    try {
      json = await T.exportToJSON(clip);
    } catch (e) {
      // Without hasTranscript (Premiere before 26.3) a clip with no
      // transcript ends up here.
      if (exists === null) return { found: false, reason: "no_transcript", can_transcribe: false };
      return { found: false, reason: "error", error: String((e && e.message) || e) };
    }
    if (!json || (typeof json === "string" && !json.trim())) {
      return { found: false, reason: "no_transcript", can_transcribe: has(T, "transcribeClipProjectItem") };
    }
    return { found: true, made, json };
  }
}

if (typeof module !== "undefined") {
  module.exports = { Helper, HELPER_VERSION, PORTS, POLL_PATH, RESULT_PATH, normPath };
}
