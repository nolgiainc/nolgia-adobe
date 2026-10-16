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

  const helper = new HelperClass({
    ppro,
    fetch: (url, options) => fetch(url, options),
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
