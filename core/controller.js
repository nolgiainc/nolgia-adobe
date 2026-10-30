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
//
// The panel's chat with NOLGIA Agent (core/chat.js) lives here too, so a
// turn keeps going when the panel is closed.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PLUGIN_VERSION, appInfo } = require("./index");
const { ApiClient, ApiError, NetworkError, normalizeBaseUrl } = require("./api");
const { DeviceLogin, LoginCancelled, LoginError } = require("./auth");
const { ActivityLog, CommandError, STATUS_LABELS, validate, monotonic } = require("./commands");
const { leaseInstanceId } = require("./instance");
const { Settings, loadEnv, envFlag, appDir, readJson, writeJson } = require("./settings");
const { BridgeWorker, Status } = require("./worker");
const util = require("./util");
const dit = require("./dit");
const transcribe = require("./transcribe");
const { AgentChat } = require("./chat");

// Camera log variants of NOLGIA's color presets: "<slug>-<suffix>" is the same
// look for footage in that log encoding (nolgia-api render/colorgrade).
const LOG_SUFFIXES = [
  { suffix: "slog3", name: "S-Log3" },
  { suffix: "logc3", name: "LogC3" },
  { suffix: "vlog", name: "V-Log" },
  { suffix: "bmdfilm5", name: "Blackmagic Film Gen 5" },
];

// A LUT's file name as the Lumetri menus show it: letters, digits and a few
// marks kept, anything else a space.
function lutFileName(text, fallback) {
  const clean = String(text || "").replace(/[^A-Za-z0-9 ._()&+'-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[ .]+|[ .]+$/g, "");
  return clean.slice(0, 100) || fallback;
}

// Adobe's own installer (part of Creative Cloud), which installs the bundled
// NOLGIA Transcripts package when the person clicks Install transcripts.
const UPIA = {
  win32:
    "C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\" +
    "UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe",
  darwin:
    "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/" +
    "UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent",
};
const TRANSCRIPTS_PACKAGE = path.join(__dirname, "..", "transcripts", "nolgia-premiere-transcripts.ccx");

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
    // Imports while nothing is saved yet stay where the person can find them.
    this.fallbackDir = path.join(host.documents || path.join(os.homedir(), "Documents"), "NOLGIA imports");
    this.hostReady = null;
    this.chatAccepted = 0; // the panel's last send NOLGIA took (it clears the box)
    this.chat = new AgentChat(this.chatOwner(), { clock });
  }

  // What the chat needs from the plugin. The instance id is the one the
  // bridge session runs under, so a chat pinned to it reaches this window.
  chatOwner() {
    const ctl = this;
    const file = path.join(this.dir, "chat.json");
    return {
      get app() {
        return ctl.app;
      },
      get instanceId() {
        return ctl.worker && ctl.lease ? ctl.lease.instanceId : null;
      },
      get apiUrl() {
        return normalizeBaseUrl(ctl.apiUrl());
      },
      api() {
        return new ApiClient({ baseUrl: ctl.apiUrl(), token: ctl.token(), userAgent: ctl.userAgent() });
      },
      accountEmail: () => this.accountEmail(),
      // The chat each copy of the app is on, by instance id, next to the settings.
      recall: (instanceId) => readJson(file)[instanceId] || null,
      remember: (instanceId, value) => {
        const all = readJson(file);
        if (value) all[instanceId] = value;
        else delete all[instanceId];
        writeJson(file, all);
      },
      forgetAll: () => {
        try {
          fs.unlinkSync(file);
        } catch (e) {
          // nothing remembered
        }
      },
      bump: () => this.bump(),
      log: (text) => this.log(text),
      authFailed: (text) => this.authFailed(text),
    };
  }

  userAgent() {
    return "nolgia-adobe/" + PLUGIN_VERSION + " (" + this.app.name + " " + (this.snapshot.app_version || "") + "; " + os.platform() + ")";
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
        plain: p.plain,
        note: p.note,
      })),
      activity: this.activity.list().map((item) =>
        Object.assign(item, { label: STATUS_LABELS[item.status] || item.status })
      ),
      document: this.snapshot.document,
      transcripts: this.app.app === "premiere" ? this.transcriptsState() : null,
      chat: this.signedIn ? this.chat.view() : null,
      chat_blocker: this.chatBlocker(),
      chat_accepted: this.chatAccepted,
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
    const api = new ApiClient({ baseUrl: this.apiUrl(), token, userAgent: this.userAgent() });
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
      onActivity: () => this.bump(),
      onAuthFailed: (text) => this.authFailed(text),
      log: (text) => this.log(text),
    }).start();
    const worker = this.worker;
    // NOLGIA for Photoshop reads the computer's name from here (util.rememberComputerName).
    util.rememberComputerName(worker.machineName, "nolgia-adobe " + PLUGIN_VERSION, path.join(this.host.userData, "NOLGIA"));
    worker.finished.wait().then(() => this.workerDone(worker));
    this.settings.set({ connected: true });
    this.startHelper();
    if (!this.accountEmail()) this.fetchEmail(api);
    this.log("Connecting to " + api.baseUrl + " as instance " + this.lease.instanceId + ".");
    this.startSnapshots();
    this.chat.start();
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
    if (!this.wantConnect) this.stopHelper();
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
    this.chat.reset({ forget: false });
    this.disconnect();
    this.message = text;
    this.bump();
  }

  // ----------------------------------------------------------------- sign in

  signIn() {
    if (this.login) return;
    this.message = "";
    const login = new DeviceLogin(new ApiClient({ baseUrl: this.apiUrl() }), { clock: this.clock, client: this.app.app });
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
    this.chat.reset({ forget: false });
    this.connect();
  }

  signOut() {
    this.cancelSignIn();
    this.disconnect("You signed out of NOLGIA in " + this.app.name + " before this ran.");
    this.chat.reset({ forget: false });
    this.chat.owner.forgetAll(); // signing out forgets the chats on this computer
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
    } else if (kind === "install_transcripts") {
      this.installTranscripts();
    } else if (kind === "clear_activity") {
      this.activity.clear();
    } else if (kind === "chat_send") {
      this.chatSend(msg.text, msg.seq);
    } else if (kind === "chat_stop") {
      this.chat.stop();
    } else if (kind === "chat_new") {
      this.chat.newChat();
    } else if (kind === "chat_fix") {
      this.fixChatBlocker();
    } else if (kind === "chat_wake") {
      this.chat.wake();
    }
    this.bump();
  }

  // ------------------------------------------------------------------- chat

  // A message from the panel's box. `seq` is the panel's own count: once
  // NOLGIA takes the message, state().chat_accepted says so and the panel
  // clears the box (a message NOLGIA did not take stays in it).
  chatSend(text, seq) {
    if (this.chatBlocker() || this.chat.busy) return;
    this.chat.send(String(text || "")).then((sent) => {
      if (sent && Number.isFinite(Number(seq))) {
        this.chatAccepted = Number(seq);
        this.bump();
      }
    });
  }

  // Why the chat cannot send right now, with the one click that fixes it,
  // or null. NOLGIA Agent reaches this app only while it is connected and
  // Allow NOLGIA Agent is on.
  chatBlocker() {
    if (!this.signedIn || this.login) return null;
    if (!this.connected) {
      return { kind: "connect", text: "Turn on Connected so NOLGIA Agent can work in this " + this.app.name + ".", label: "Turn on Connected" };
    }
    if (!this.settings.get("allow_agent")) {
      return { kind: "allow_agent", text: "NOLGIA Agent can work here only while Allow NOLGIA Agent is on.", label: "Allow NOLGIA Agent" };
    }
    return null;
  }

  fixChatBlocker() {
    const blocker = this.chatBlocker();
    if (!blocker) return;
    if (blocker.kind === "connect") this.connect();
    else if (blocker.kind === "allow_agent") this.setSwitch("allow_agent", true);
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
      app_version: util.appVersionLabel(out.result.app_version) || this.snapshot.app_version,
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
      // A request that is not code (a DIT copy, opening a project) shows as
      // plain text with its own note, not as code that "runs in" the app.
      plain: Boolean(request.plain),
      note: request.note || null,
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

  // ---- dit

  // Camera-card DIT through the NOLGIA CLI on this computer. Writes to media
  // (offload, rename --apply, undo) always wait for the person's Approve,
  // whoever sent them and whatever "Ask before running code" says.
  async do_dit(command) {
    const a = command.args;
    if (!this.ditJobs) this.ditJobs = new dit.Jobs();
    try {
      if (a.action === "status") return this.ditJobs.status(a.job_id);
      if (a.action === "cancel") return this.ditJobs.cancel(a.job_id);
    } catch (e) {
      if (e instanceof dit.DitError) throw new CommandError(e.message);
      throw e;
    }
    const cli = dit.locateCli();
    if (!cli) throw new CommandError(dit.INSTALL_HINT);
    if (dit.writesMedia(a)) {
      const plan = await dit.planFor(cli, a);
      if (plan.refused) throw new CommandError(plan.refused, plan.result || null);
      if (plan.nothing) return { running: false, exit_code: 0, meaning: "nothing to rename", result: plan.nothing };
      await this.askPerson(command, {
        title: command.requester + " wants to " + plan.title + " on this computer",
        lines: plan.lines,
        approveLabel: plan.approve,
        plain: true,
        note: "The NOLGIA CLI does this on this computer, with your permissions, only once you approve.",
      });
    }
    const job = this.ditJobs.start(cli, dit.argv(a));
    // Short work comes back finished; long work comes back as a job to follow.
    return this.ditJobs.waitOrReturn(job, Math.min(Math.max(1, command.remaining() - 5), 100));
  }

  // ---- transcribe (Premiere Pro)

  // The local link NOLGIA Transcripts (the UXP helper) connects to. Only in
  // Premiere Pro and only while connected; NOLGIA_TRANSCRIPTS=0 leaves it
  // off, and NOLGIA_TRANSCRIPTS_PORTS (comma separated) picks other ports.
  stopHelper() {
    if (!this.helper) return;
    this.helper.stop();
    this.helper = null;
    this.bump();
  }

  startHelper() {
    if (this.app.app !== "premiere" || this.helper || envFlag(this.env, "NOLGIA_TRANSCRIPTS") === false) return;
    const ports = String(this.env.NOLGIA_TRANSCRIPTS_PORTS || "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^\d+$/.test(p))
      .map(Number);
    this.helper = new transcribe.HelperLink({ ports: ports.length ? ports : undefined, dir: this.dir, log: (t) => this.log(t) });
    this.helper.onChange = () => this.bump();
    this.helper.start().catch((e) => this.log("NOLGIA Transcripts link did not start: " + e.message));
  }

  transcriptsState() {
    const out = this.helper ? this.helper.status() : { connected: false };
    if (this.transcriptsInstall) out.install = Object.assign({}, this.transcriptsInstall);
    return out;
  }

  // Install transcripts in the panel: Adobe's installer installs the NOLGIA
  // Transcripts package that comes inside this extension. Only ever on the
  // person's click, never from a command.
  installTranscripts() {
    if (this.app.app !== "premiere") return;
    if (this.transcriptsInstall && this.transcriptsInstall.status === "running") return;
    const tool = this.env.NOLGIA_UPIA || UPIA[process.platform];
    const pkg = this.env.NOLGIA_TRANSCRIPTS_PACKAGE || TRANSCRIPTS_PACKAGE;
    const done = (status, message) => {
      this.transcriptsInstall = { status, message };
      this.log("Install transcripts: " + message);
      this.bump();
    };
    if (!fs.existsSync(pkg)) return done("failed", "This copy of NOLGIA has no NOLGIA Transcripts package.");
    if (!tool || !fs.existsSync(tool)) {
      return done("failed", "Adobe's installer (part of Creative Cloud) was not found, so NOLGIA Transcripts cannot be installed from here.");
    }
    done("running", "Installing NOLGIA Transcripts...");
    const flag = (verb) => (process.platform === "win32" ? "/" : "--") + verb;
    const installed = "Installed. It starts with Premiere Pro; if Transcripts does not say it is running within a minute, open " +
      "Window > UXP Plugins > NOLGIA Transcripts once.";
    childProcess.execFile(tool, [flag("install"), pkg], { windowsHide: true, timeout: 300000 }, (err, stdout, stderr) => {
      const text = (String(stdout || "") + "\n" + String(stderr || "")).trim();
      const last = text.split(/\r?\n/).filter(Boolean).pop() || "";
      if (/Installation Successful|already installed/i.test(text) || (!err && !/fail/i.test(text))) return done("done", installed);
      // The installer can give up waiting for Creative Cloud (-642 on macOS)
      // after the install went through: ask it what is installed before
      // calling it a failure.
      childProcess.execFile(tool, [flag("list"), "all"], { windowsHide: true, timeout: 120000 }, (err2, listed) => {
        const found = /NOLGIA Transcripts\s+(\d+(?:\.\d+)+)/.exec(String(listed || ""));
        if (found) return done("done", installed.replace("Installed.", "Installed (" + found[1] + ")."));
        done("failed", "Adobe's installer did not install NOLGIA Transcripts" + (last ? ": " + last.slice(0, 200) : "."));
      });
    });
  }

  async do_transcribe(command, api) {
    const a = command.args;
    if (!this.transcribeJobs) this.transcribeJobs = new transcribe.Jobs();
    try {
      if (a.action === "status") return this.transcribeJobs.status(a.job_id);
      if (a.action === "cancel") return this.transcribeJobs.cancel(a.job_id);
    } catch (e) {
      if (e instanceof transcribe.TranscribeError) throw new CommandError(e.message);
      throw e;
    }
    const found = await this.hostOrFail("transcribe_targets", { clips: a.clips, sequence: a.sequence }, command);
    const clips = found.clips || [];
    if (!clips.length) {
      throw new CommandError(
        (found.note || "There are no clips with media to transcribe.") +
          (found.not_found && found.not_found.length ? " Not found: " + found.not_found.join(", ") + "." : "")
      );
    }
    const helper = this.helper ? this.helper.status() : { connected: false };
    if (a.engine === "premiere" && !helper.connected) throw new CommandError(HELPER_MISSING);
    if (a.engine === "nolgia" && !a.allow_credits) {
      return {
        running: false,
        transcripts: [],
        needs_credits: Object.assign(transcribe.estimate(clips), { clip_names: clips.map((c) => c.name) }),
        note: CREDITS_NOTE,
      };
    }
    const job = this.transcribeJobs.start((j) => this.runTranscription(j, a, clips, found, api));
    return this.transcribeJobs.waitOrReturn(job, Math.min(Math.max(1, command.remaining() - 5), 100));
  }

  async runTranscription(job, a, clips, found, api) {
    const dir = transcribe.transcriptDir(
      this.snapshot.document && this.snapshot.document.path,
      this.host.documents || path.join(os.homedir(), "Documents")
    );
    const out = { transcripts: [], missing: [], folder: dir, credits_charged: 0 };
    if (found.not_found && found.not_found.length) out.not_found = found.not_found;
    const helper = this.helper && this.helper.connected ? this.helper : null;
    let rest = [];
    if (a.engine !== "nolgia" && helper) {
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if (job.cancelled) break;
        job.progress = "Premiere Speech to Text: " + clip.name + " (" + (i + 1) + " of " + clips.length + ").";
        let answer;
        try {
          answer = await helper.call(
            "transcript",
            { path: clip.path, name: clip.name, language: a.language, transcribe: true },
            900
          );
        } catch (e) {
          answer = { found: false, reason: "error", error: e.message };
        }
        if (answer && answer.found && answer.json) {
          let entry;
          try {
            entry = transcribe.normalizePremiere(answer.json);
          } catch (e) {
            rest.push({ clip, reason: "error", error: e.message });
            continue;
          }
          entry.engine = "premiere";
          if (answer.made) entry.made_now = true;
          const file = transcribe.saveTranscript(dir, clip, entry, answer.json);
          out.transcripts.push(transcriptView(clip, entry, file, a.words));
        } else {
          rest.push(Object.assign({ clip }, answer || { reason: "error" }));
        }
      }
    } else {
      rest = clips.map((clip) => ({ clip, reason: a.engine === "nolgia" ? "engine" : "no_helper" }));
    }
    if (job.cancelled) {
      out.cancelled = true;
      return transcribe.fitResult(out);
    }
    if (rest.length && a.engine !== "premiere") {
      if (!a.allow_credits) {
        out.needs_credits = Object.assign(transcribe.estimate(rest.map((r) => r.clip)), {
          clip_names: rest.map((r) => r.clip.name),
        });
        out.note = CREDITS_NOTE;
        for (const r of rest) out.missing.push(missingView(r, helper));
      } else {
        for (let i = 0; i < rest.length; i++) {
          const clip = rest[i].clip;
          if (job.cancelled) {
            out.cancelled = true;
            break;
          }
          job.progress = "NOLGIA transcription: " + clip.name + " (" + (i + 1) + " of " + rest.length + ").";
          try {
            const { row, assetId } = await this.transcribeWithNolgia(api, clip, a.language);
            const entry = transcribe.normalizeNolgia(row);
            entry.engine = "nolgia";
            entry.asset_id = assetId;
            entry.credits_charged = row.credits_charged || 0;
            out.credits_charged += entry.credits_charged;
            const file = transcribe.saveTranscript(dir, clip, entry, null);
            out.transcripts.push(transcriptView(clip, entry, file, a.words));
          } catch (e) {
            out.missing.push({ clip: clip.name, reason: "nolgia_failed", fix: String((e && e.message) || e) });
          }
        }
      }
    } else {
      for (const r of rest) out.missing.push(missingView(r, helper));
    }
    if (!out.missing.length) delete out.missing;
    out.helper = this.helper ? this.helper.status() : { connected: false };
    if (out.transcripts.some((t) => t.speakers)) {
      out.speakers_note = "Speaker names are Premiere's labels (Speaker 1, Speaker 2): ask the person who is who; never name anyone from their face.";
    }
    return transcribe.fitResult(out);
  }

  // NOLGIA's transcription of one clip: Premiere exports its audio as an MP3,
  // it is uploaded to the person's library and transcribed there.
  async transcribeWithNolgia(api, clip, language) {
    if (clip.duration && clip.duration > transcribe.NOLGIA_MAX_SECONDS) {
      throw new CommandError("NOLGIA transcribes up to 60 minutes of a clip; " + clip.name + " is longer.");
    }
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "nolgia-transcribe-"));
    try {
      const stem = util.safeFilename(path.parse(clip.name || "clip").name, "clip") + " audio";
      const out = await this.callHostTimed("transcribe_audio", { node_id: clip.node_id, path: clip.path, folder, stem }, 900);
      if (!out.ok) throw new CommandError(out.error || "Premiere Pro could not export the audio of " + clip.name + ".");
      const file = await waitForFile(out.result.path, 60);
      const asset = await this.upload(api, file, "audio/mpeg", {
        filename: path.basename(file),
        displayName: clip.name + " (audio for a transcript)",
      });
      let row;
      try {
        row = await api.transcribeAsset(asset.id, language);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw nolgiaError(err);
        row = { status: "processing" };
      }
      const until = Date.now() + 6 * 60 * 1000;
      while (row && row.status === "processing" && Date.now() < until) {
        await util.sleep(5000);
        try {
          row = await api.getTranscription(asset.id);
        } catch (err) {
          throw nolgiaError(err);
        }
      }
      if (!row || row.status !== "ready") {
        throw new CommandError("NOLGIA could not transcribe " + clip.name + (row && row.error ? ": " + row.error : "."));
      }
      return { row, assetId: asset.id };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  // A host call with its own time limit (jobs run after their command came
  // back, so there is no command deadline).
  async callHostTimed(kind, args, seconds) {
    let timer = null;
    const late = new Promise((resolve) => {
      timer = util.timers.setTimeout(() => resolve({ ok: false, error: this.app.name + " took longer than " + seconds + " s." }), seconds * 1000);
    });
    try {
      return await Promise.race([this.callHost(kind, args), late]);
    } finally {
      util.timers.clearTimeout(timer);
    }
  }

  // ---- info

  async do_info(command) {
    const result = await this.hostOrFail("info", {}, command);
    const info = Object.assign({ app: this.app.app }, result);
    // The same label as the session's check in ("26.5 (build 89)", not After Effects' own "26.5x89").
    if ("app_version" in info) info.app_version = util.appVersionLabel(info.app_version);
    return info;
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
    if (command.args.color_preset) return this.installColorPreset(command, api);
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

  // ---- color presets

  // The shared Adobe LUT folder Lumetri Color reads at start: Creative for
  // the Look menu, Technical for Basic Correction's Input LUT. Per user, so
  // no administrator rights are needed.
  lutRoot() {
    if (this.env.NOLGIA_LUT_DIR) return this.env.NOLGIA_LUT_DIR;
    if (process.platform === "win32") {
      const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
      return path.join(roaming, "Adobe", "Common", "LUTs");
    }
    return path.join(os.homedir(), "Library", "Application Support", "Adobe", "Common", "LUTs");
  }

  // Install one of NOLGIA's film stocks (GET /color-presets/{slug}/cube) as
  // a .cube LUT. A camera log variant (kodak-portra-400-slog3) converts the
  // log picture to Rec.709 before the look, so it goes in Technical and is
  // set as the Input LUT; a plain look goes in Creative, under Look.
  async installColorPreset(command, api) {
    const slug = command.args.color_preset;
    let res;
    try {
      res = await api.request("GET", "/color-presets/" + encodeURIComponent(slug) + "/cube", undefined, { timeout: 60 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new CommandError(
          "NOLGIA has no color preset named " + slug + ". The list is at " + api.baseUrl + "/color-presets; " +
            "for camera log footage add the camera's suffix: " + LOG_SUFFIXES.map((l) => "-" + l.suffix).join(", ") + "."
        );
      }
      if (err instanceof NetworkError) throw new CommandError("Could not reach NOLGIA for the color preset (" + err.message + ").");
      throw err;
    }
    const data = res.body || Buffer.alloc(0);
    if (!/^\s*LUT_3D_SIZE\s+\d+/m.test(data.slice(0, 4096).toString("utf8"))) {
      throw new CommandError("NOLGIA's answer for the color preset " + slug + " is not a .cube LUT.");
    }
    const log = LOG_SUFFIXES.find((l) => slug.endsWith("-" + l.suffix)) || null;
    const base = log ? slug.slice(0, -(log.suffix.length + 1)) : slug;
    let name = null;
    try {
      const listing = (await api.request("GET", "/color-presets", undefined, { timeout: 30 })).json() || {};
      const found = (listing.presets || []).find((p) => p && p.slug === base);
      if (found && found.name) name = String(found.name);
    } catch (err) {
      // the name is a nicety: fall back to the cube's own title
    }
    if (!name) {
      const m = /^\s*TITLE\s+"([^"]*)"/m.exec(data.slice(0, 4096).toString("utf8"));
      name = m ? m[1].replace(/^Nolgia\s+/i, "") : base;
    }
    const lut = lutFileName("NOLGIA " + name + (log ? " (" + log.name + ")" : ""), "NOLGIA " + slug);
    const folder = path.join(this.lutRoot(), log ? "Technical" : "Creative");
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, lut + ".cube");
    // Write next to it, then rename, so the app never reads half a LUT. The
    // preset replaces its own older copy.
    const temp = target + ".part-" + process.pid;
    try {
      fs.writeFileSync(temp, data);
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    const where = log ? "Lumetri Color > Basic Correction > Input LUT" : "Lumetri Color > Creative > Look";
    const result = {
      imported: [lut],
      kind: "lut",
      color_preset: slug,
      lut,
      path: target,
      menu: where,
      relaunch_needed: true,
      note:
        this.app.name + " reads its LUT folders when it starts: save, quit and reopen it, then pick " + lut +
        " in " + where + (log ? " (it converts " + log.name + " footage to Rec.709 and applies the look in one step)." : "."),
    };
    if (command.args.apply_to) {
      result.applied_to = [];
      result.apply_note =
        this.app.name + "'s scripting cannot set a LUT on clips, so the LUT is installed but not applied. " +
        "After the relaunch it is one click in " + where + ".";
    }
    return result;
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
    const currentExt = path.extname(current).slice(1).toLowerCase();
    if (!this.app.projectExts.includes(currentExt)) {
      // An image or PDF opened as a document is not a project file yet:
      // save it as one next to the source, which stays as it is.
      const target = this.freePath(
        path.dirname(current),
        args.filename ? this.stem(args.filename) : path.parse(current).name,
        ext
      );
      const saved = await this.hostOrFail("save", { path: target }, command);
      return {
        asset_id: null,
        format: this.app.projectExt,
        path: saved.path,
        filename: path.basename(saved.path),
        note:
          "The " + this.app.projectWord + " was a ." + currentExt + " file, so it is now saved as ." + this.app.projectExt +
          " next to it and stays open from that file; the ." + currentExt + " is unchanged. " + PROJECT_NOTE,
      };
    }
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
        plain: true,
      });
    }
    return this.hostOrFail("open", { path: target }, command);
  }

  // ------------------------------------------------------------------- close

  shutdown() {
    this.cancelSignIn();
    this.chat.reset({ forget: false });
    this.stopSnapshots();
    this.stopHelper();
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

const HELPER_MISSING =
  "NOLGIA Transcripts is not running in Premiere Pro, so Premiere's own Speech to Text cannot be reached. It is a " +
  "small second plugin (UXP, Premiere Pro 25.6 or later) that comes with NOLGIA for Premiere Pro: ask the person " +
  "to click Install transcripts in the NOLGIA panel (Window > Extensions > NOLGIA), or, when it is installed, to " +
  "open Window > UXP Plugins > NOLGIA Transcripts once. Or use NOLGIA's transcription (engine \"nolgia\", " +
  "1 credit per started minute).";
const CREDITS_NOTE =
  "NOLGIA's transcription costs 1 credit per started minute of each clip. Tell the person the price and, if " +
  "they agree, send the same command again with allow_credits: true.";

const MISSING_FIX = {
  no_helper: HELPER_MISSING,
  engine: "Only NOLGIA's transcription was asked for.",
  no_api:
    "This Premiere Pro has no transcript scripting (it needs 25.6 or later). Update Premiere, or use NOLGIA's transcription.",
  not_found: "NOLGIA Transcripts could not find this clip in the open project.",
  no_transcript:
    "Premiere has no transcript of this clip yet. In Premiere: select the clip, then Window > Text > Transcript > " +
    "Transcribe (free, on this computer), or turn on Preferences > Transcription > Automatically transcribe video " +
    "clips on import. Premiere Pro 26.5 and later make it without the click.",
  language_pack:
    "Premiere's speech pack for this language is not installed. Premiere downloads it the first time you click " +
    "Transcribe in the Text panel.",
  transcribe_failed: "Premiere's Speech to Text did not finish this clip.",
  error: "NOLGIA Transcripts hit an error.",
};

function missingView(r, helper) {
  const entry = { clip: r.clip.name, reason: r.reason || "error", fix: MISSING_FIX[r.reason] || MISSING_FIX.error };
  if (r.error) entry.detail = String(r.error).slice(0, 300);
  if (r.reason === "no_transcript" && r.can_transcribe) entry.fix = MISSING_FIX.transcribe_failed;
  if (r.reason === "no_helper" && helper) entry.reason = "engine";
  return entry;
}

function transcriptView(clip, entry, file, withWords) {
  const view = {
    clip: clip.name,
    media: clip.path,
    engine: entry.engine,
    language: entry.language,
    timing: entry.timing,
    segments: entry.segments,
    file,
  };
  if (clip.duration) view.duration = clip.duration;
  const speakers = Array.from(new Set(entry.segments.map((s) => s.speaker).filter(Boolean)));
  if (speakers.length) view.speakers = speakers;
  const sentences = transcribe.sentencesFrom(entry.words, entry.segments);
  if (sentences) view.sentences = sentences;
  if (withWords && entry.words) view.words = entry.words;
  if (entry.made_now) view.made_now = true;
  for (const key of ["asset_id", "credits_charged"]) if (entry[key] !== undefined) view[key] = entry[key];
  return view;
}

function nolgiaError(err) {
  if (err instanceof ApiError) {
    if (err.status === 402) return new CommandError("There are not enough NOLGIA credits for this transcription.");
    return new CommandError("NOLGIA did not transcribe it: " + (err.detail || err.title || err.status));
  }
  if (err instanceof NetworkError) return new CommandError("Could not reach NOLGIA (" + err.message + ").");
  return err;
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
