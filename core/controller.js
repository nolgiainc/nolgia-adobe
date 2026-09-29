// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Ties the pieces together for one app: settings and sign in, the worker,
// approvals, and what each command does on the Node side (downloads,
// resizing, uploads) around the ExtendScript that does the app side.
//
// Everything that touches CEP comes in through `host`, so this file runs
// under plain Node with a fake host in the tests:
//
//   host.hostId               "AEFT", "PPRO" or "ILST"
//   host.userData             the user's app data folder (%APPDATA%)
//   host.documents            the user's Documents folder
//   host.call(kind, args)     run __nolgia.call(kind, args) in the app;
//                             resolves {ok, result, error}
//   host.convertImage(src, dest, {width, format, quality, background})
//                             resolves {width, height}
//   host.openURL(url), host.openPanel(), host.broadcast(state), host.log(text)

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { PLUGIN_VERSION, appInfo } = require("./index");
const { ApiClient, ApiError, NetworkError } = require("./api");
const { DeviceLogin, LoginCancelled, LoginError } = require("./auth");
const { ActivityLog, CommandError, STATUS_LABELS, validate, monotonic } = require("./commands");
const { leaseInstanceId } = require("./instance");
const { Settings, loadEnv, envFlag, appDir } = require("./settings");
const { BridgeWorker, Status } = require("./worker");
const util = require("./util");

// The MCP preview tool shows a still inline only up to 3,750,000 bytes.
const PREVIEW_MAX_BYTES = 3600000;
const PREVIEW_JPEG_QUALITIES = [0.9, 0.8, 0.65, 0.5];
const PREVIEW_DEFAULT_WIDTH = 1280;
const SNAPSHOT_EVERY = 3; // seconds between checks of the open document
const UPLOAD_TAGS = { after_effects: ["after-effects"], premiere: ["premiere"], illustrator: ["illustrator"] };
const PROJECT_NOTE =
  "Project files (aep, prproj, ai) stay on this computer; NOLGIA stores previews, renders and images.";
const LOCAL_ONLY_NOTE =
  "NOLGIA's library does not take %s files yet, so this one stays on this computer.";

class Controller {
  constructor(host, { environ = process.env, clock = () => Date.now() / 1000 } = {}) {
    this.host = host;
    this.app = appInfo(host.hostId);
    this.clock = clock;
    this.dir = appDir(host.userData, this.app.app);
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = new Settings(this.dir);
    this.env = loadEnv(host.userData, environ);
    this.envToken = this.env.NOLGIA_TOKEN || null;
    this.envEmail = "";
    this.activity = new ActivityLog(20, clock);
    this.approvals = [];
    this.worker = null;
    this.lease = null;
    this.login = null; // {login, prompt}
    this.message = "";
    this.snapshot = { document: { name: "" }, allow_agent: this.settings.get("allow_agent"), app_version: "" };
    this.wantConnect = false;
    this.hostBusy = 0;
    this.version = 0;
    this.broadcastTimer = null;
    this.snapshotTimer = null;
    this.closedReason = null;
    this.fallbackDir = path.join(this.dir, "downloads");
    this.hostReady = null;
  }

  log(text) {
    try {
      this.host.log("NOLGIA: " + text);
    } catch (e) {
      // ignore
    }
  }

  apiUrl() {
    return this.env.NOLGIA_API_URL || null;
  }

  // ---------------------------------------------------------------- settings

  token() {
    return this.envToken || this.settings.get("token") || null;
  }

  get signedIn() {
    return Boolean(this.token());
  }

  get connected() {
    return this.worker !== null && !this.worker.stopping;
  }

  applyEnv() {
    for (const [env, key] of [
      ["NOLGIA_ASK_BEFORE_RUN", "ask_before_run"],
      ["NOLGIA_ALLOW_AGENT", "allow_agent"],
    ]) {
      const flag = envFlag(this.env, env);
      if (flag !== null) this.settings.set({ [key]: flag });
    }
  }

  bump() {
    this.version += 1;
    if (this.broadcastTimer) return;
    this.broadcastTimer = util.timers.setTimeout(() => {
      this.broadcastTimer = null;
      try {
        this.host.broadcast(this.state());
      } catch (e) {
        // the panel is closed
      }
    }, 50);
  }

  accountEmail() {
    return this.envToken ? this.envEmail : this.settings.get("account_email");
  }

  // Everything the panel shows.
  state() {
    const login = this.login && this.login.prompt
      ? { user_code: this.login.prompt.userCode, url: this.login.prompt.openUrl }
      : this.login
        ? { user_code: "", url: "" }
        : null;
    return {
      app: this.app.app,
      app_name: this.app.name,
      plugin_version: PLUGIN_VERSION,
      status: this.statusLine(),
      state: this.worker ? this.worker.state : this.signedIn ? "off" : "signed_out",
      signed_in: this.signedIn,
      email: this.accountEmail() || "",
      env_token: Boolean(this.envToken),
      login,
      connected: this.settings.get("connected"),
      allow_agent: this.settings.get("allow_agent"),
      ask_before_run: this.settings.get("ask_before_run"),
      approvals: this.approvals.map((p) => ({
        id: p.id,
        title: p.title,
        lines: p.lines,
        approve_label: p.approveLabel,
      })),
      activity: this.activity.list().map((item) =>
        Object.assign(item, { label: STATUS_LABELS[item.status] || item.status })
      ),
      document: this.snapshot.document,
    };
  }

  statusLine() {
    if (this.login) {
      if (this.login.prompt) return "Enter code " + this.login.prompt.userCode + " in your browser to sign in.";
      return "Starting sign in...";
    }
    if (this.approvals.length) return "Waiting for you to approve a request.";
    if (this.worker) {
      const busy = this.worker.busyWith;
      if (busy && this.worker.state === Status.CONNECTED) {
        const item = this.activity.list().find((i) => i.id === busy);
        if (item) return "Working on " + item.kind + "...";
      }
      if (this.worker.stopping) return "Switching off...";
      return this.worker.statusText;
    }
    if (this.message) return this.message;
    if (!this.signedIn) return "Not signed in.";
    return "Switched off. Turn on Connected to let NOLGIA work in this " + this.app.name + ".";
  }

  // ------------------------------------------------------------------ start

  // After the app starts: reconnect when the person left it on.
  start() {
    this.applyEnv();
    const wanted = envFlag(this.env, "NOLGIA_BRIDGE_AUTOCONNECT") || this.settings.get("connected");
    if (wanted && this.signedIn) this.connect();
    else if (this.settings.get("connected")) this.settings.set({ connected: false });
    this.bump();
  }

  // ------------------------------------------------------- connect/disconnect

  connect() {
    this.message = "";
    if (this.worker) {
      if (this.worker.stopping) this.wantConnect = true; // start again once the old one is done
      return true;
    }
    const token = this.token();
    if (!token) {
      this.message = "Sign in to NOLGIA first.";
      this.settings.set({ connected: false });
      this.bump();
      return false;
    }
    const expires = this.settings.get("token_expires_at");
    if (!this.envToken && expires > 0 && expires < this.clock()) {
      this.settings.set({ token: "", connected: false });
      this.message = "Your NOLGIA sign in expired. Sign in again.";
      this.bump();
      return false;
    }
    this.lease = leaseInstanceId(this.dir, this.env.NOLGIA_INSTANCE_ID || null);
    const api = new ApiClient({
      baseUrl: this.apiUrl(),
      token,
      userAgent:
        "nolgia-adobe/" + PLUGIN_VERSION + " (" + this.app.name + " " + (this.snapshot.app_version || "") + "; " +
        os.platform() + ")",
    });
    this.api = api;
    this.closedReason = null;
    this.updateSnapshotSoon();
    this.worker = new BridgeWorker({
      api,
      execute: (command, killed) => this.execute(command, api, killed),
      activity: this.activity,
      instanceId: this.lease.instanceId,
      snapshot: () => this.snapshot,
      app: this.app,
      onStatus: () => this.bump(),
      onAuthFailed: (text) => this.authFailed(text),
      log: (text) => this.log(text),
    }).start();
    const worker = this.worker;
    worker.finished.wait().then(() => this.workerDone(worker));
    this.settings.set({ connected: true });
    if (!this.accountEmail()) this.fetchEmail(api);
    this.log("Connecting to " + api.baseUrl + " as instance " + this.lease.instanceId + ".");
    this.startSnapshots();
    this.bump();
    return true;
  }

  // GET /me for "Signed in as". Failures are ignored: a refused token shows
  // up through the worker anyway.
  fetchEmail(api) {
    const token = api.token;
    api
      .getMe()
      .then((me) => {
        const email = (me && me.email) || "";
        if (!email || token !== this.token()) return;
        if (this.envToken) this.envEmail = email;
        else this.settings.set({ account_email: email });
        this.log("Signed in as " + email + ".");
        this.bump();
      })
      .catch(() => {});
  }

  disconnect(reason = null) {
    reason = reason || "NOLGIA was switched off in " + this.app.name + " before this ran.";
    this.wantConnect = false;
    this.settings.set({ connected: false });
    if (this.worker && !this.worker.stopping) {
      this.closedReason = reason;
      for (const pending of this.approvals.slice()) pending.settle("closed", reason);
      this.worker.stop();
      this.log("Switching off.");
    }
    this.bump();
  }

  workerDone(worker) {
    if (this.worker !== worker) return;
    if (this.lease) {
      this.lease.release();
      this.lease = null;
    }
    this.worker = null;
    this.stopSnapshots();
    this.bump();
    if (this.wantConnect) {
      this.wantConnect = false;
      this.connect();
    }
  }

  authFailed(text) {
    if (this.envToken) this.envToken = null;
    else this.settings.set({ token: "", account_email: "" });
    this.disconnect();
    this.message = text;
    this.bump();
  }

  // ----------------------------------------------------------------- sign in

  signIn() {
    if (this.login) return;
    this.message = "";
    const login = new DeviceLogin(new ApiClient({ baseUrl: this.apiUrl() }), { clock: this.clock });
    const state = { login, prompt: null };
    this.login = state;
    this.bump();
    (async () => {
      try {
        const prompt = await login.start();
        state.prompt = prompt;
        this.bump();
        try {
          this.host.openURL(prompt.openUrl);
        } catch (e) {
          // the person can click Open page again
        }
        const token = await login.waitForToken(prompt);
        if (!token.email) {
          try {
            const me = await new ApiClient({ baseUrl: this.apiUrl(), token: token.accessToken }).getMe();
            token.email = me.email || null;
          } catch (e) {
            // shown as signed in without an address
          }
        }
        this.signedInWith(state, token);
      } catch (err) {
        if (err instanceof LoginCancelled) this.loginOver(state, "");
        else if (err instanceof LoginError) this.loginOver(state, err.message);
        else this.loginOver(state, "Sign in failed: " + (err && err.message ? err.message : err));
      }
    })();
  }

  cancelSignIn() {
    if (this.login) {
      this.login.login.cancel();
      this.login = null;
      this.bump();
    }
  }

  loginOver(state, message) {
    if (this.login === state) this.login = null;
    this.message = message;
    this.bump();
  }

  signedInWith(state, token) {
    if (this.login !== state) return; // cancelled meanwhile
    this.login = null;
    this.envToken = null;
    this.envEmail = "";
    this.settings.set({
      token: token.accessToken,
      account_email: token.email || "",
      token_expires_at: Number(token.expiresAt || 0),
    });
    this.log("Signed in" + (token.email ? " as " + token.email : "") + ".");
    this.connect();
  }

  signOut() {
    this.cancelSignIn();
    this.disconnect("You signed out of NOLGIA in " + this.app.name + " before this ran.");
    this.envToken = null;
    this.settings.set({ token: "", account_email: "", token_expires_at: 0 });
    this.message = "Signed out.";
    this.bump();
  }

  // Actions from the panel.
  action(msg) {
    const kind = msg && msg.action;
    if (kind === "sign_in") this.signIn();
    else if (kind === "cancel_sign_in") this.cancelSignIn();
    else if (kind === "open_sign_in_page") {
      if (this.login && this.login.prompt) this.host.openURL(this.login.prompt.openUrl);
    } else if (kind === "sign_out") this.signOut();
    else if (kind === "set") this.setSwitch(msg.name, Boolean(msg.value));
    else if (kind === "pause") this.setSwitch("connected", !this.settings.get("connected"));
    else if (kind === "approve" || kind === "deny") {
      const pending = this.approvals.find((p) => p.id === msg.id);
      if (pending) pending.settle(kind === "approve" ? "approved" : "denied");
    } else if (kind === "clear_activity") {
      this.activity.clear();
    }
    this.bump();
  }

  setSwitch(name, value) {
    if (name === "connected") {
      if (value) this.connect();
      else this.disconnect();
    } else if (name === "allow_agent" || name === "ask_before_run") {
      this.settings.set({ [name]: value });
      if (name === "allow_agent") {
        this.snapshot.allow_agent = value;
        if (this.worker) this.worker.requestHeartbeat();
      }
    }
  }

  // --------------------------------------------------------------- snapshots

  startSnapshots() {
    this.stopSnapshots();
    const tick = async () => {
      this.snapshotTimer = null;
      if (!this.worker) return;
      await this.updateSnapshot();
      if (this.worker) this.snapshotTimer = util.timers.setTimeout(tick, SNAPSHOT_EVERY * 1000);
    };
    this.snapshotTimer = util.timers.setTimeout(tick, SNAPSHOT_EVERY * 1000);
  }

  stopSnapshots() {
    if (this.snapshotTimer) util.timers.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  updateSnapshotSoon() {
    this.updateSnapshot().catch(() => {});
  }

  // Ask the app what is open. Skipped while a command is running in it: the
  // app does one thing at a time, and the command refreshes it afterwards.
  async updateSnapshot(force = false) {
    if (this.hostBusy && !force) return;
    let out;
    try {
      out = await this.callHost("snapshot", {});
    } catch (e) {
      return;
    }
    if (!out.ok || !out.result) return;
    const snap = {
      document: out.result.document || { name: "" },
      dirty: out.result.dirty,
      app_version: out.result.app_version || this.snapshot.app_version,
      allow_agent: this.settings.get("allow_agent"),
    };
    const before = JSON.stringify([this.snapshot.document, this.snapshot.allow_agent]);
    this.snapshot = snap;
    if (before !== JSON.stringify([snap.document, snap.allow_agent])) {
      if (this.worker) this.worker.requestHeartbeat();
      this.bump();
    }
  }

  // Run __nolgia.call in the app, one at a time.
  async callHost(kind, args) {
    this.hostBusy += 1;
    try {
      return await this.host.call(kind, args);
    } finally {
      this.hostBusy -= 1;
    }
  }

  // ----------------------------------------------------------------- commands

  // The worker's `execute`: resolves {ok, result, error} or throws.
  async execute(command, api, killed) {
    if (this.closedReason) throw new CommandError(this.closedReason);
    command.args = validate(this.app, command.kind, command.args);
    this.activity.update(command.id, "running");
    this.bump();
    try {
      const runner = this["do_" + command.kind];
      const result = await runner.call(this, command, api, killed);
      return { ok: true, result };
    } finally {
      this.updateSnapshot(true).catch(() => {});
      this.bump();
    }
  }

  // App side of a command. Throws CommandError with the app's message.
  async hostOrFail(kind, args, command, { waitFor = null } = {}) {
    const deadline = command ? command.deadline : null;
    const call = this.callHost(kind, args);
    let out;
    if (deadline !== null) {
      let timer = null;
      const late = new Promise((resolve) => {
        timer = util.timers.setTimeout(
          () => resolve({ late: true }),
          Math.max(1, deadline - monotonic()) * 1000
        );
      });
      out = await Promise.race([call, late]);
      util.timers.clearTimeout(timer);
      if (out && out.late) {
        throw new CommandError(
          this.app.name + " is still busy with this after " + Math.round(command.timeout) +
            " s, so NOLGIA stopped waiting. It may still finish in " + this.app.name +
            "; the next command runs when it does." + (waitFor ? " " + waitFor : "")
        );
      }
    } else {
      out = await call;
    }
    if (!out.ok) throw new CommandError(out.error || this.app.name + " could not do this.", out.result || null);
    return out.result || {};
  }

  // ---- approvals

  // Wait for the person to approve in the panel. Resolves when approved;
  // throws CommandError on deny, time out or switch off.
  async askPerson(command, request) {
    let settle;
    const decided = new Promise((resolve) => {
      settle = resolve;
    });
    const pending = {
      id: command.id,
      title: request.title,
      lines: request.lines,
      approveLabel: request.approveLabel || "Approve",
      settle: (decision, reason) => settle({ decision, reason }),
    };
    this.approvals.push(pending);
    this.activity.update(command.id, "approval");
    this.bump();
    try {
      this.host.openPanel();
    } catch (e) {
      // the person can open Window > Extensions > NOLGIA
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = util.timers.setTimeout(() => resolve({ decision: "timeout" }), Math.max(0, command.remaining()) * 1000);
    });
    let outcome;
    try {
      outcome = await Promise.race([decided, timeout]);
    } finally {
      util.timers.clearTimeout(timer);
      this.approvals = this.approvals.filter((p) => p !== pending);
      this.bump();
    }
    if (outcome.decision === "approved") {
      this.activity.update(command.id, "running");
      return;
    }
    if (outcome.decision === "denied") {
      throw new CommandError("The person at " + this.app.name + " clicked Deny, so this did not run.");
    }
    if (outcome.decision === "closed") throw new CommandError(outcome.reason);
    throw new CommandError("Nobody approved this in " + this.app.name + " in time, so it did not run.");
  }

  // ---- info

  async do_info(command) {
    const result = await this.hostOrFail("info", {}, command);
    return Object.assign({ app: this.app.app }, result);
  }

  // ---- run

  async do_run(command) {
    const args = command.args;
    if (this.settings.get("ask_before_run")) {
      const lines = args.code.split(/\r?\n/);
      await this.askPerson(command, {
        title: command.requester + " wants to run ExtendScript in " + this.app.name,
        lines,
        approveLabel: "Run code",
      });
    }
    const out = await this.callHostWithDeadline("run", { code: args.code }, command, args.timeout_seconds);
    const res = out.result || {};
    const result = {
      value: res.value === undefined ? null : res.value,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
    if (!out.ok) throw new CommandError(out.error || "The code failed.", result);
    return result;
  }

  // The host's own {ok, result, error} for run, or a CommandError when the
  // code outlives its time. ExtendScript cannot be stopped from outside, so
  // this stops waiting; the app finishes the code on its own.
  async callHostWithDeadline(kind, args, command, timeoutSeconds) {
    let seconds = Math.max(1, command.remaining());
    if (timeoutSeconds) seconds = Math.min(seconds, timeoutSeconds);
    const call = this.callHost(kind, args);
    let timer = null;
    const late = new Promise((resolve) => {
      timer = util.timers.setTimeout(() => resolve({ late: true }), seconds * 1000);
    });
    const out = await Promise.race([call, late]);
    util.timers.clearTimeout(timer);
    if (out && out.late) {
      throw new CommandError(
        "The code was still running after " + Math.round(seconds) + " s, so NOLGIA stopped waiting. " +
          this.app.name + " cannot stop ExtendScript from outside, so it may still finish there; " +
          "the next command runs when it does. Split long work into smaller steps."
      );
    }
    return out;
  }

  // ---- preview

  maxPreviewBytes() {
    return Number(this.env.NOLGIA_PREVIEW_MAX_BYTES) || PREVIEW_MAX_BYTES;
  }

  async do_preview(command, api) {
    const args = command.args;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "nolgia-preview-"));
    try {
      const shot = await this.hostOrFail(
        "preview",
        { target: args.target, frame: args.frame, folder, width: args.width },
        command
      );
      const source = await waitForFile(shot.path, Math.max(5, command.remaining()));
      const width = args.width || Math.min(PREVIEW_DEFAULT_WIDTH, shot.width || PREVIEW_DEFAULT_WIDTH);
      const small = await this.fitImage(source, folder, "preview", width, shot.background);
      const stem = util.safeFilename(path.parse(this.snapshot.document.name || "untitled").name, "untitled");
      const label = shot.label || "";
      const asset = await this.upload(api, small.path, small.mime, {
        filename: stem + "-preview" + (shot.frame !== undefined && shot.frame !== null ? "-" + String(shot.frame).padStart(4, "0") : "") + small.ext,
        displayName: this.app.name + " preview" + (label ? ", " + label : "") +
          (shot.frame !== undefined && shot.frame !== null ? " frame " + shot.frame : ""),
      });
      const out = { asset_id: asset.id, width: small.width, height: small.height, mime_type: small.mime };
      for (const key of ["comp", "sequence", "artboard", "frame", "time", "source"]) {
        if (shot[key] !== undefined && shot[key] !== null) out[key] = shot[key];
      }
      return out;
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  // Scale an image to `width` as a PNG; when that is over the preview limit,
  // a JPEG, lowering the quality until it fits.
  async fitImage(source, folder, stem, width, background) {
    const max = this.maxPreviewBytes();
    const png = path.join(folder, stem + "-small.png");
    const size = await this.host.convertImage(source, png, { width, format: "png", background });
    if (fs.statSync(png).size <= max) {
      return { path: png, mime: "image/png", ext: ".png", width: size.width, height: size.height };
    }
    const jpg = path.join(folder, stem + "-small.jpg");
    for (const quality of PREVIEW_JPEG_QUALITIES) {
      await this.host.convertImage(source, jpg, { width, format: "jpeg", quality, background: background || "#000000" });
      if (fs.statSync(jpg).size <= max) {
        return { path: jpg, mime: "image/jpeg", ext: ".jpg", width: size.width, height: size.height };
      }
    }
    throw new CommandError("The preview image is too large even as a JPEG. Ask for a smaller width.");
  }

  async upload(api, filePath, contentType, { filename, displayName }) {
    try {
      return await api.uploadFile(filePath, contentType, {
        displayName,
        filename,
        tags: UPLOAD_TAGS[this.app.app],
      });
    } catch (err) {
      if (err instanceof ApiError) {
        throw new CommandError("NOLGIA did not take the file: " + (err.detail || err.title || err.status));
      }
      if (err instanceof NetworkError) throw new CommandError("Could not upload the file to NOLGIA (" + err.message + ").");
      throw err;
    }
  }

  // ---- import

  downloadDir() {
    const docPath = this.snapshot.document && this.snapshot.document.path;
    if (docPath) return path.join(path.dirname(docPath), "nolgia_assets");
    return this.fallbackDir;
  }

  async do_import_asset(command, api) {
    const assetId = command.args.asset_id;
    let asset;
    try {
      asset = await api.getAsset(assetId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new CommandError("NOLGIA has no asset " + assetId + " in this account.");
      }
      throw err;
    }
    const url = asset && asset.signed_url;
    if (!url) throw new CommandError("NOLGIA did not give a download link for asset " + assetId + ".");
    const name = asset.display_name || assetId;
    const folder = path.join(this.downloadDir(), util.safeFilename(assetId));
    fs.mkdirSync(folder, { recursive: true });
    const temp = path.join(folder, "download.part-" + process.pid);
    let finalPath;
    try {
      let head;
      try {
        head = await api.download(url, temp);
      } catch (err) {
        if (err instanceof NetworkError) throw new CommandError("Could not download the asset from NOLGIA (" + err.message + ").");
        throw err;
      }
      let ext = util.importExtension(name, asset.mime_type, head);
      if (!ext) {
        throw new CommandError(
          this.app.name + " cannot import this file type (" + (asset.mime_type || "unknown") + ")."
        );
      }
      const base = util.safeFilename(path.parse(name).name, assetId);
      finalPath = path.join(folder, base + ext);
      if (ext === ".webp") {
        // Adobe's apps do not read WebP; convert it to PNG here.
        finalPath = path.join(folder, base + ".png");
        await this.host.convertImage(temp, finalPath, { format: "png" });
        fs.rmSync(temp, { force: true });
        ext = ".png";
      } else {
        fs.renameSync(temp, finalPath);
      }
      const kind = util.IMPORT_KINDS[ext];
      const result = await this.hostOrFail(
        "import",
        { path: finalPath, kind, as: command.args.as, name: base, asset_id: assetId },
        command
      );
      return Object.assign({ kind, path: finalPath }, result);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  // ---- export

  exportDir() {
    let folder = this.env.NOLGIA_EXPORT_DIR;
    if (!folder) {
      const docs = this.host.documents || path.join(os.homedir(), "Documents");
      folder = path.join(fs.existsSync(docs) ? docs : os.homedir(), "NOLGIA exports");
    }
    return folder;
  }

  // A path in `folder` for `base` + ext that does not exist yet.
  freePath(folder, base, ext) {
    let target = path.join(folder, base + ext);
    if (!fs.existsSync(target)) return target;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    target = path.join(folder, base + "-" + stamp + ext);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, base + "-" + stamp + "-" + n + ext);
    return target;
  }

  stem(filename) {
    if (filename) return util.safeFilename(path.parse(path.basename(filename)).name, "untitled");
    return util.safeFilename(path.parse(this.snapshot.document.name || "untitled").name, "untitled");
  }

  async do_export(command, api) {
    const args = command.args;
    const fmt = args.format;
    if (fmt === this.app.projectExt) return this.exportProjectCopy(command);
    if (this.app.app === "illustrator" && (fmt === "svg" || fmt === "pdf")) {
      return this.exportLocal(command, fmt);
    }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "nolgia-export-"));
    try {
      const stem = this.stem(args.filename);
      const out = await this.hostOrFail(
        "export",
        { format: fmt, frames: args.frames, target: args.target, folder, stem },
        command
      );
      const file = await waitForFile(out.path, Math.max(5, command.remaining()));
      const ext = path.extname(file).toLowerCase();
      const contentType = util.UPLOAD_TYPES[ext];
      if (!contentType) throw new CommandError(this.app.name + " wrote a " + ext + " file, which NOLGIA does not take.");
      const asset = await this.upload(api, file, contentType, {
        filename: path.basename(file),
        displayName: path.basename(file),
      });
      const result = { asset_id: asset.id, format: fmt, filename: path.basename(file) };
      for (const key of ["comp", "sequence", "artboard", "frames", "width", "height", "duration"]) {
        if (out[key] !== undefined && out[key] !== null) result[key] = out[key];
      }
      return result;
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  // SVG and PDF from Illustrator: written next to the document (or in
  // Documents/NOLGIA exports), never over another file, not uploaded.
  async exportLocal(command, fmt) {
    const args = command.args;
    const docPath = this.snapshot.document.path;
    const folder = docPath ? path.dirname(docPath) : this.exportDir();
    fs.mkdirSync(folder, { recursive: true });
    const target = this.freePath(folder, this.stem(args.filename), "." + fmt);
    const out = await this.hostOrFail("export", { format: fmt, target: args.target, file: target }, command);
    const file = await waitForFile(out.path || target, Math.max(5, command.remaining()));
    return {
      asset_id: null,
      format: fmt,
      path: file,
      filename: path.basename(file),
      note: LOCAL_ONLY_NOTE.replace("%s", fmt.toUpperCase()),
    };
  }

  // aep, prproj, ai: a copy of the project on this computer, never over a
  // file. The copy is the project as last saved; an untitled project is
  // saved into Documents/NOLGIA exports first.
  async exportProjectCopy(command) {
    const args = command.args;
    const ext = "." + this.app.projectExt;
    const info = await this.hostOrFail("project_file", {}, command);
    if (!info.path) {
      const folder = this.exportDir();
      fs.mkdirSync(folder, { recursive: true });
      const target = this.freePath(folder, args.filename ? this.stem(args.filename) : "untitled", ext);
      const saved = await this.hostOrFail("save", { path: target }, command);
      return {
        asset_id: null,
        format: this.app.projectExt,
        path: saved.path,
        filename: path.basename(saved.path),
        note:
          "The " + this.app.projectWord + " had never been saved, so it is now saved here and stays open from this file. " +
          PROJECT_NOTE,
      };
    }
    const current = info.path;
    const folder = path.dirname(current);
    const base = args.filename ? this.stem(args.filename) : path.parse(current).name + "-copy";
    const target = this.freePath(folder, base, ext);
    fs.copyFileSync(current, target, fs.constants.COPYFILE_EXCL);
    const out = {
      asset_id: null,
      format: this.app.projectExt,
      path: target,
      filename: path.basename(target),
      note: PROJECT_NOTE,
    };
    if (info.dirty) {
      out.note =
        "This copies the " + this.app.projectWord +
        " as last saved; the changes not saved yet are not in it (save first to include them). " +
        PROJECT_NOTE;
    }
    return out;
  }

  // ---- save and open

  // An absolute path for save and open. Relative paths are next to the
  // open document.
  resolvePath(p, mustExist = false) {
    let target = String(p).trim();
    if (target.startsWith("~")) target = path.join(os.homedir(), target.slice(1));
    if (!path.isAbsolute(target)) {
      const docPath = this.snapshot.document.path;
      if (!docPath) {
        throw new CommandError(
          "Use a full path, for example C:/Projects/shot." + this.app.projectExt + " or /Users/me/shot." +
            this.app.projectExt + "."
        );
      }
      target = path.join(path.dirname(docPath), target);
    }
    target = path.normalize(target);
    if (mustExist && !fs.existsSync(target)) throw new CommandError("There is no file at " + target + ".");
    return target;
  }

  async do_save(command) {
    const p = command.args.path;
    if (!p) return this.hostOrFail("save", {}, command);
    let target = this.resolvePath(p);
    const ext = path.extname(target).slice(1).toLowerCase();
    if (!this.app.projectExts.includes(ext)) target += "." + this.app.projectExt;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      throw new CommandError(target + " is a folder. Give a file name ending in ." + this.app.projectExt + ".");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return this.hostOrFail("save", { path: target }, command);
  }

  async do_open(command) {
    const target = this.resolvePath(command.args.path, true);
    const check = await this.hostOrFail("open_check", { path: target }, command);
    if (check.error) throw new CommandError(check.error);
    if (check.loses_changes) {
      await this.askPerson(command, {
        title: command.requester + " wants to open another " + this.app.projectWord,
        lines: [
          "Open: " + target,
          "This " + this.app.projectWord + " has unsaved changes. Opening the other one closes it and loses them.",
        ],
        approveLabel: "Open and lose changes",
      });
    }
    return this.hostOrFail("open", { path: target }, command);
  }

  // ------------------------------------------------------------------- close

  shutdown() {
    this.cancelSignIn();
    this.stopSnapshots();
    const worker = this.worker;
    if (worker) {
      this.closedReason = this.app.name + " is closing.";
      for (const pending of this.approvals.slice()) pending.settle("closed", this.closedReason);
      worker.kill();
    }
    if (this.lease) {
      this.lease.release();
      this.lease = null;
    }
  }
}

// Some app exports finish writing a moment after the script returns; wait
// until the file exists and its size holds still. Resolves the path.
async function waitForFile(file, seconds) {
  if (!file) throw new CommandError("The app did not say where it wrote the file.");
  const end = monotonic() + seconds;
  let last = -1;
  let steady = 0;
  for (;;) {
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      size = -1;
    }
    if (size > 0 && size === last) {
      steady += 1;
      if (steady >= 2) return file;
    } else {
      steady = 0;
    }
    last = size;
    if (monotonic() > end) {
      if (size > 0) return file;
      throw new CommandError("The app did not write " + path.basename(file) + " in time.");
    }
    await util.sleep(150);
  }
}

module.exports = { Controller, waitForFile, PREVIEW_MAX_BYTES };
