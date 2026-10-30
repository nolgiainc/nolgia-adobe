// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The plugin's version is written in six places, and they must agree:
// package.json, core/index.js (PLUGIN_VERSION, what the panel checks the app
// script against), CSXS/manifest.xml (the bundle and both extensions) and
// host/nolgia.jsx (N.version, what the app script says it is). 0.2.3 shipped
// with host/nolgia.jsx still at 0.2.2, so every app call answered "not loaded".
// tests/version.test.js and tools/build.js both refuse a mismatch.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// Every place's version, by name.
function versions() {
  const manifest = read("CSXS/manifest.xml");
  const ext = (id) => {
    const m = new RegExp('<Extension Id="' + id.replace(/\./g, "\\.") + '" Version="([^"]+)"').exec(manifest);
    return m ? m[1] : null;
  };
  const bundle = /ExtensionBundleVersion="([^"]+)"/.exec(manifest);
  const index = /const PLUGIN_VERSION = "([^"]+)";/.exec(read("core/index.js"));
  const host = /\bN\.version\s*=\s*"([^"]+)"/.exec(read("host/nolgia.jsx"));
  return {
    "package.json": JSON.parse(read("package.json")).version,
    "core/index.js PLUGIN_VERSION": index ? index[1] : null,
    "CSXS/manifest.xml ExtensionBundleVersion": bundle ? bundle[1] : null,
    "CSXS/manifest.xml com.nolgia.adobe.service": ext("com.nolgia.adobe.service"),
    "CSXS/manifest.xml com.nolgia.adobe.panel": ext("com.nolgia.adobe.panel"),
    "host/nolgia.jsx N.version": host ? host[1] : null,
  };
}

// Throws, naming every place, unless all six agree.
function checkVersions() {
  const v = versions();
  const distinct = new Set(Object.values(v));
  if (distinct.size !== 1 || distinct.has(null)) {
    throw new Error(
      "The plugin's version is not the same everywhere:\n" +
        Object.entries(v).map(([k, x]) => "  " + k + ": " + x).join("\n")
    );
  }
  return [...distinct][0];
}

module.exports = { versions, checkVersions };

if (require.main === module) {
  try {
    console.log(checkVersions());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
