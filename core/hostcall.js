// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The two ExtendScript snippets the panel sends to the app with
// CSInterface.evalScript (js/service.js): one loads NOLGIA's host files, the
// other runs one call. The call first checks that the loaded __nolgia is THIS
// plugin's (its version) and answers NOT_LOADED otherwise, so an app that
// dropped the script, or still holds an older plugin's, gets it loaded again.
// Kept here, out of the browser-only file, so the tests can run the very same
// snippet against the real host/nolgia.jsx.

"use strict";

const { jsLiteral } = require("./util");

const NOT_LOADED = "__NOLGIA_NOT_LOADED__";
const SCRIPT_ERROR = "__NOLGIA_ERROR__";

// Load the given host files (forward-slash paths). Answers "ok" or "error: ...".
function loadScript(files) {
  return (
    "(function(){try{" +
    files.map((f) => "$.evalFile(new File(" + jsLiteral(f) + "));").join("") +
    'return "ok";}catch(e){return "error: "+e+" (line "+e.line+(e.fileName?" in "+e.fileName:"")+")";}})()'
  );
}

// Run __nolgia.call(kind, args) if the loaded script is version `version`.
function callScript(kind, args, version) {
  return (
    "(function(){try{" +
    'if(typeof __nolgia!=="object"||!__nolgia||__nolgia.version!==' + jsLiteral(version) +
    "||!__nolgia.adapter)return " + jsLiteral(NOT_LOADED) + ";" +
    "return __nolgia.call(" + jsLiteral(kind) + "," + jsLiteral(args || {}) + ");" +
    "}catch(e){return " + jsLiteral(SCRIPT_ERROR) + '+e+" (line "+e.line+")";}})()'
  );
}

// The version host/nolgia.jsx declares (N.version = "x.y.z"), read from its text.
function hostScriptVersion(text) {
  const m = /\bN\.version\s*=\s*"([^"]+)"/.exec(String(text));
  return m ? m[1] : null;
}

module.exports = { NOT_LOADED, SCRIPT_ERROR, loadScript, callScript, hostScriptVersion };
