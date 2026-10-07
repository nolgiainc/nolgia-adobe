// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Constants shared by the Node side of NOLGIA for Adobe.
//
// Nothing under core/ touches CEP (window.__adobe_cep__) or ExtendScript, so
// it runs, and is tested, with plain Node. The CEP glue lives in js/, the
// ExtendScript side in host/.

"use strict";

const PLUGIN_VERSION = "0.1.1";
const DEFAULT_API_URL = "https://api.nolgia.ai/v1";
const DEVICE_CLIENT_ID = "nolgia-adobe";
const DEVICE_SCOPE = "bridge assets:read assets:write";

// CEP host ids (HostEnvironment.appId) and the NOLGIA app id of each.
const APPS = {
  AEFT: {
    app: "after_effects",
    name: "After Effects",
    host: "aeft",
    projectExt: "aep",
    projectWord: "project",
    projectExts: ["aep", "aepx"],
    exportFormats: ["mp4", "png", "aep"],
  },
  PPRO: {
    app: "premiere",
    name: "Premiere Pro",
    host: "ppro",
    projectExt: "prproj",
    projectWord: "project",
    projectExts: ["prproj"],
    exportFormats: ["mp4", "png", "prproj"],
  },
  ILST: {
    app: "illustrator",
    name: "Illustrator",
    host: "ilst",
    projectExt: "ai",
    projectWord: "document",
    projectExts: ["ai"],
    exportFormats: ["png", "svg", "pdf", "ai"],
  },
};

function appInfo(hostId) {
  const info = APPS[String(hostId || "").toUpperCase()];
  if (!info) {
    throw new Error("NOLGIA for Adobe does not support the app " + hostId + ".");
  }
  return info;
}

module.exports = {
  PLUGIN_VERSION,
  DEFAULT_API_URL,
  DEVICE_CLIENT_ID,
  DEVICE_SCOPE,
  APPS,
  appInfo,
};
