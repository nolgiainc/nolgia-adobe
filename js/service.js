// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The invisible part of NOLGIA for Adobe. It starts with the app (no panel
// needs to be open), keeps the connection to NOLGIA, runs commands in the
// app through ExtendScript, and tells the NOLGIA panel what is going on.

/* global window */
"use strict";

(function () {
  const fs = require("fs");
  const path = require("path");
  const CEP = window.NolgiaCEP;

  const root = CEP.systemPath("extension");
  const core = (name) => require(path.join(root, "core", name));
  const { PLUGIN_VERSION, appInfo } = core("index.js");
  const { Controller } = core("controller.js");
  const { jsLiteral } = core("util.js");
  const { appDir } = core("settings.js");

  const env = CEP.hostEnvironment();
  const app = appInfo(env.appId);
  const userData = CEP.systemPath("userData");
  const logFile = path.join(appDir(userData, app.app), "nolgia.log");

  function log(text) {
    const line = new Date().toISOString() + " " + text + "\n";
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1 << 20) {
        fs.renameSync(logFile, logFile + ".1");
      }
      fs.appendFileSync(logFile, line);
    } catch (e) {
      // logging must never break the plugin
    }
  }

  // --------------------------------------------------------- ExtendScript

  const NOT_LOADED = "__NOLGIA_NOT_LOADED__";
  let loading = null;

  function hostFiles() {
    return ["nolgia.jsx", app.host + ".jsx"].map((name) => path.join(root, "host", name).replace(/\\/g, "/"));
  }

  // Load NOLGIA's ExtendScript into the app (again, if the app dropped it).
  function loadHost() {
    if (!loading) {
      const script =
        "(function(){try{" +
        hostFiles().map((f) => "$.evalFile(new File(" + jsLiteral(f) + "));").join("") +
        'return "ok";}catch(e){return "error: "+e+" (line "+e.line+(e.fileName?" in "+e.fileName:"")+")";}})()';
      loading = CEP.evalScript(script).then((answer) => {
        loading = null;
        if (answer !== "ok") log("Could not load NOLGIA's app script: " + answer);
        return answer;
      });
    }
    return loading;
  }

  function callScript(kind, args) {
    return (
      "(function(){try{" +
      'if(typeof __nolgia!=="object"||!__nolgia||__nolgia.version!==' + jsLiteral(PLUGIN_VERSION) +
      '||!__nolgia.adapter)return ' + jsLiteral(NOT_LOADED) + ";" +
      "return __nolgia.call(" + jsLiteral(kind) + "," + jsLiteral(args || {}) + ");" +
      '}catch(e){return "__NOLGIA_ERROR__"+e+" (line "+e.line+")";}})()'
    );
  }

  // Run one NOLGIA call in the app. Resolves {ok, result, error}.
  async function call(kind, args) {
    let answer = await CEP.evalScript(callScript(kind, args));
    if (answer === NOT_LOADED) {
      const loaded = await loadHost();
      if (loaded !== "ok") return { ok: false, error: "NOLGIA's app script did not load in " + app.name + ": " + loaded };
      answer = await CEP.evalScript(callScript(kind, args));
    }
    if (typeof answer !== "string") return { ok: false, error: app.name + " gave no answer." };
    if (answer.indexOf("__NOLGIA_ERROR__") === 0) {
      return { ok: false, error: "NOLGIA's app script failed: " + answer.slice(16) };
    }
    if (answer === "EvalScript error.") {
      return { ok: false, error: app.name + " could not run NOLGIA's script (EvalScript error)." };
    }
    try {
      return JSON.parse(answer);
    } catch (e) {
      return { ok: false, error: app.name + " answered something NOLGIA could not read: " + answer.slice(0, 300) };
    }
  }

  // ----------------------------------------------------------- controller

  const controller = new Controller({
    hostId: env.appId,
    userData,
    documents: CEP.systemPath("myDocuments"),
    call,
    convertImage: (src, dest, options) => window.NolgiaImaging.convertImage(src, dest, options),
    openURL: CEP.openURL,
    openPanel: CEP.openPanel,
    broadcast: (state) => CEP.dispatch(CEP.STATE_EVENT, state),
    log,
  });

  CEP.listen(CEP.ACTION_EVENT, (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.action === "hello") {
      controller.bump();
      return;
    }
    try {
      controller.action(msg);
    } catch (err) {
      log("Panel action " + msg.action + " failed: " + (err && err.stack ? err.stack : err));
    }
  });

  // Documents opened, saved or switched: tell NOLGIA soon, not in 3 s.
  for (const type of [
    "documentAfterActivate",
    "documentAfterSave",
    "com.adobe.csxs.events.documentAfterActivate",
    "com.adobe.csxs.events.documentAfterSave",
  ]) {
    CEP.listen(type, () => controller.updateSnapshot().catch(() => {}));
  }

  const stop = () => {
    try {
      controller.shutdown();
    } catch (e) {
      // closing anyway
    }
  };
  window.addEventListener("beforeunload", stop);
  CEP.listen("com.adobe.csxs.events.ApplicationBeforeQuit", stop);

  window.nolgia = controller; // for the curious, in the CEP debugger
  log("NOLGIA " + PLUGIN_VERSION + " started in " + app.name + " " + env.appVersion + ".");
  loadHost().then(() => {
    controller.updateSnapshot().finally(() => controller.start());
  });
})();
