// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The few CEP calls NOLGIA needs, straight on window.__adobe_cep__ (what
// Adobe's CSInterface.js wraps), so the panel ships no Adobe code.

/* global window */
"use strict";

(function () {
  const bridge = window.__adobe_cep__;
  const STATE_EVENT = "com.nolgia.adobe.state";
  const ACTION_EVENT = "com.nolgia.adobe.action";
  const PANEL_ID = "com.nolgia.adobe.panel";

  function hostEnvironment() {
    return JSON.parse(bridge.getHostEnvironment());
  }

  // A CEP system path ("userData", "myDocuments", "extension") as a plain
  // file system path.
  function systemPath(type) {
    const url = decodeURI(bridge.getSystemPath(type));
    const isWindows = typeof process !== "undefined" ? process.platform === "win32" : /^file:\/\/\/[A-Za-z]:/.test(url);
    return isWindows ? url.replace(/^file:\/\/\//, "") : url.replace(/^file:\/\//, "");
  }

  // Run ExtendScript in the app. Resolves the answer as text.
  function evalScript(script) {
    return new Promise((resolve) => bridge.evalScript(script, resolve));
  }

  // An event to the other NOLGIA extension in this app. CEP drops events
  // whose appId and extensionId are empty.
  function dispatch(type, data) {
    bridge.dispatchEvent({
      type,
      scope: "APPLICATION",
      appId: hostEnvironment().appId,
      extensionId: bridge.getExtensionId(),
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }

  function listen(type, handler) {
    bridge.addEventListener(type, (event) => {
      let data = event && event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          // plain text
        }
      }
      handler(data, event);
    });
  }

  function openURL(url) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
      window.cep.util.openURLInDefaultBrowser(url);
    } else {
      window.open(url);
    }
  }

  function openPanel() {
    bridge.requestOpenExtension(PANEL_ID, "");
  }

  window.NolgiaCEP = {
    STATE_EVENT,
    ACTION_EVENT,
    PANEL_ID,
    hostEnvironment,
    systemPath,
    evalScript,
    dispatch,
    listen,
    openURL,
    openPanel,
  };
})();
