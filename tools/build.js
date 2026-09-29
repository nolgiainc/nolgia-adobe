#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Build the signed installer: adobe/dist/nolgia-adobe-<version>.zxp.
//
//   node adobe/tools/build.js --zxpsigncmd /path/to/ZXPSignCmd[.exe]
//
// It copies the extension's files into a staging folder, signs them with
// Adobe's ZXPSignCmd (github.com/Adobe-CEP/CEP-Resources, ZXPSignCMD) and
// verifies the result. Without --cert it makes a self-signed certificate
// once and keeps it (and its password) in adobe/dist, which git ignores.
// From WSL it runs a Windows ZXPSignCmd.exe with Windows paths. Adobe asks
// to sign on the platform the package is installed on.
//
// Options (or the environment variable in brackets):
//   --zxpsigncmd PATH   [ZXPSIGNCMD]          Adobe's signing tool
//   --cert FILE.p12     [NOLGIA_ZXP_CERT]     certificate to sign with
//   --password TEXT     [NOLGIA_ZXP_PASSWORD] its password
//   --tsa URL           [NOLGIA_ZXP_TSA]      timestamp server (optional)
//   --out FILE          the .zxp to write
//   --stage DIR         staging folder (must be readable by ZXPSignCmd)
//   --debug             development build: adds a .debug file that opens
//                       Chrome DevTools ports (service: AEFT 8092, PPRO 8093,
//                       ILST 8094; panel: 8095, 8096, 8097). Never ship it.

"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ADOBE = path.resolve(__dirname, "..");
const { PLUGIN_VERSION } = require(path.join(ADOBE, "core", "index.js"));

// What goes into the package, relative to adobe/.
const INCLUDE = ["CSXS", "core", "host", "js", "css", "fonts", "icons", "panel.html", "service.html", "LICENSE"];

const FLAGS = ["debug"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error("unexpected argument " + arg);
    if (FLAGS.includes(arg.slice(2))) {
      out[arg.slice(2)] = true;
      continue;
    }
    out[arg.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const DEBUG_FILE = `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.nolgia.adobe.service">
    <HostList><Host Name="AEFT" Port="8092"/><Host Name="PPRO" Port="8093"/><Host Name="ILST" Port="8094"/></HostList>
  </Extension>
  <Extension Id="com.nolgia.adobe.panel">
    <HostList><Host Name="AEFT" Port="8095"/><Host Name="PPRO" Port="8096"/><Host Name="ILST" Port="8097"/></HostList>
  </Extension>
</ExtensionList>
`;

const isWsl = (() => {
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch (e) {
    return false;
  }
})();

function toTool(tool, p) {
  if (isWsl && /\.exe$/i.test(tool)) return childProcess.execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
  return p;
}

// ZXPSignCmd.exe cannot read a WSL folder (\\wsl.localhost\...), so from WSL
// the staging folder and the unsigned output live in the Windows temp folder.
function windowsTemp() {
  const win = childProcess.execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim();
  return childProcess.execFileSync("wslpath", ["-u", win], { encoding: "utf8" }).trim();
}

function copyTree(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) throw new Error("symbolic links break ZXP signatures: " + src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src).sort()) {
      if (name === ".DS_Store" || name.startsWith(".") || name === "__pycache__") continue;
      copyTree(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ZXPSignCmd (OpenSSL) leaves a .rnd seed file in its working folder, so it
// runs in the build's own temp folder, never in the repository.
let toolCwd = null;

function run(tool, args) {
  const res = childProcess.spawnSync(tool, args, { encoding: "utf8", cwd: toolCwd || undefined });
  const text = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(path.basename(tool) + " " + args[0] + " failed (" + res.status + "): " + text);
  return text;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tool = opts.zxpsigncmd || process.env.ZXPSIGNCMD;
  if (!tool || !fs.existsSync(tool)) {
    throw new Error("Pass --zxpsigncmd (or ZXPSIGNCMD): the path to Adobe's ZXPSignCmd.");
  }
  const dist = path.join(ADOBE, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const out = path.resolve(opts.out || path.join(dist, "nolgia-adobe-" + PLUGIN_VERSION + ".zxp"));
  const viaWindows = isWsl && /\.exe$/i.test(tool);
  const work = viaWindows ? path.join(windowsTemp(), "nolgia-zxp-" + process.pid) : dist;
  const stage = path.resolve(opts.stage || path.join(work, "stage"));
  const signed = viaWindows ? path.join(work, path.basename(out)) : out;

  // Certificate: given, or a self-signed one made once.
  let cert = opts.cert || process.env.NOLGIA_ZXP_CERT;
  fs.mkdirSync(work, { recursive: true });
  toolCwd = work;
  let password = opts.password || process.env.NOLGIA_ZXP_PASSWORD;
  if (!cert) {
    cert = path.join(dist, "nolgia-selfsigned.p12");
    const passFile = cert + ".password";
    if (!fs.existsSync(cert)) {
      password = password || crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "");
      console.log("Making a self-signed certificate: " + cert);
      const made = path.join(work, "nolgia-selfsigned.p12");
      run(tool, [
        "-selfSignedCert", "US", "CA", "NOLGIA Inc", "NOLGIA", password, toTool(tool, made),
        "-validityDays", "3650",
      ]);
      if (made !== cert) fs.copyFileSync(made, cert);
      fs.writeFileSync(passFile, password + "\n", { mode: 0o600 });
    } else if (!password) {
      password = fs.readFileSync(passFile, "utf8").trim();
    }
  }
  if (!password) throw new Error("Pass --password (or NOLGIA_ZXP_PASSWORD) for " + cert + ".");

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const name of INCLUDE) copyTree(path.join(ADOBE, name), path.join(stage, name));
  if (opts.debug) {
    fs.writeFileSync(path.join(stage, ".debug"), DEBUG_FILE);
    console.log("Development build: DevTools ports open (.debug). Do not ship this one.");
  }
  fs.rmSync(out, { force: true });

  let certForTool = cert;
  if (viaWindows && !cert.startsWith("/mnt/")) {
    certForTool = path.join(work, "cert.p12");
    fs.copyFileSync(cert, certForTool);
  }
  fs.rmSync(signed, { force: true });
  const sign = ["-sign", toTool(tool, stage), toTool(tool, signed), toTool(tool, certForTool), password];
  const tsa = opts.tsa || process.env.NOLGIA_ZXP_TSA;
  if (tsa) sign.push("-tsa", tsa);
  console.log(run(tool, sign));
  console.log(run(tool, ["-verify", toTool(tool, signed)]));
  if (signed !== out) fs.copyFileSync(signed, out);
  fs.rmSync(viaWindows ? work : stage, { recursive: true, force: true });
  console.log("Wrote " + out + " (" + fs.statSync(out).size + " bytes)");
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
