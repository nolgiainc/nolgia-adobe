// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The UXP glue of NOLGIA Transcripts: starts the helper (helper.js) when
// Premiere Pro starts, and shows its state in the panel.

"use strict";

(function () {
  const uxp = require("uxp");
  const ppro = require("premierepro");
  const HelperClass = typeof Helper !== "undefined" ? Helper : require("./helper.js").Helper;

  function render(status) {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("status", status.text);
    const dot = document.getElementById("dot");
    if (dot) dot.className = status.connected ? "dot on" : "dot";
    const can = helper.info().can;
    set(
      "can",
      can.make
        ? "Premiere makes and reads transcripts here."
        : can.read
          ? "Premiere reads the transcripts it has (Text panel > Transcribe)."
          : "This Premiere Pro has no transcript scripting (25.6 or later)."
    );
    if (status.last) set("last", "Last: " + status.last);
  }

  let version = "";
  try {
    version = String(uxp.host && uxp.host.version) || "";
  } catch (e) {
    version = "";
  }

  // The link file NOLGIA for Premiere Pro writes while it is connected:
  // %APPDATA%\NOLGIA\adobe\premiere (Windows) or ~/Library/Application
  // Support/NOLGIA/adobe/premiere (macOS).
  async function appDataFolder() {
    const lfs = uxp.storage.localFileSystem;
    try {
      const os = require("os");
      const home = String(os.homedir()).replace(/\\/g, "/").replace(/\/$/, "");
      if (home) return os.platform() === "darwin" ? home + "/Library/Application Support" : home + "/AppData/Roaming";
    } catch (e) {
      // no os module: use where UXP keeps this plugin's data, inside the same folder
    }
    const data = String((await lfs.getDataFolder()).nativePath).replace(/\\/g, "/");
    const at = data.indexOf("/Adobe/UXP/");
    if (at < 0) throw new Error("cannot find the app data folder from " + data);
    return data.slice(0, at);
  }

  async function readLink() {
    const file = (await appDataFolder()) + "/NOLGIA/adobe/premiere/transcripts-link.json";
    const lfs = uxp.storage.localFileSystem;
    const entry = await lfs.getEntryWithUrl("file:" + (file.startsWith("/") ? "" : "/") + file);
    return JSON.parse(await entry.read());
  }

  const helper = new HelperClass({
    ppro,
    fetch: (url, options) => fetch(url, options),
    readLink,
    premiereVersion: version,
    log: (text) => console.log("NOLGIA Transcripts: " + text),
    onStatus: render,
  });

  try {
    uxp.entrypoints.setup({
      panels: {
        transcripts: {
          show() {
            render(helper.status);
          },
        },
      },
    });
  } catch (e) {
    console.log("NOLGIA Transcripts: panel setup: " + e.message);
  }

  render(helper.status);
  helper.loop();
})();
