// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The network side of the plugin: two async loops.
//
// - heartbeat: POST /bridge/sessions every 20 s (and at once when asked, e.g.
//   after a document is opened or saved), which registers the session the
//   first time and keeps it live after that.
// - poll: GET /bridge/sessions/{id}/next long poll; each command goes to
//   `execute` (which runs it in the app), and its result goes back with
//   POST /bridge/commands/{id}/result.
//
// Neither loop talks to the app. What they need to know about it (open
// document, app version, Allow NOLGIA Agent) comes from `snapshot()`, a plain
// object the controller keeps up to date.

"use strict";

const os = require("os");

const { PLUGIN_VERSION } = require("./index");
const { ApiError, NetworkError, Unauthorized } = require("./api");
const { CAPABILITIES, Command, CommandError, resultBody, monotonic } = require("./commands");
const { Backoff, Signal, timers } = require("./util");

// The API's limits on POST /bridge/sessions fields (characters).
const MAX_VERSION = 64;
const MAX_MACHINE_NAME = 128;
const MAX_DOCUMENT_NAME = 512;
const MAX_DOCUMENT_PATH = 4096;

function oneLine(value, limit) {
  // eslint-disable-next-line no-control-regex
  return String(value === null || value === undefined ? "" : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, limit);
}

// 404 (unknown session) or 409 session_disconnected: register again.
function sessionGone(err) {
  return err.status === 404 || (err.status === 409 && (err.code === "session_disconnected" || err.code === ""));
}

const Status = {
  OFF: "off",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RETRYING: "retrying",
  SIGNED_OUT: "signed_out",
};

class BridgeWorker {
  constructor({
    api,
    execute,
    activity,
    instanceId,
    snapshot,
    app,
    onStatus = null,
    onAuthFailed = null,
    log = null,
    heartbeatInterval = 20,
    machineName = null,
  }) {
    this.api = api;
    this.execute = execute; // async (command) => {ok, result, error}
    this.activity = activity;
    this.instanceId = instanceId;
    this.snapshot = snapshot;
    this.app = app; // an entry of index.APPS
    this.onStatus = onStatus || (() => {});
    this.onAuthFailed = onAuthFailed || (() => {});
    this.log = log || (() => {});
    this.heartbeatInterval = heartbeatInterval;
    this.machineName = machineName !== null ? machineName : os.hostname();

    this.sessionId = null;
    this.pollWait = 25;
    this.state = Status.OFF;
    this.statusText = "Switched off.";

    this.stopSignal = new Signal();
    this.killSignal = new Signal();
    this.wake = new Signal();
    this.sessionReady = new Signal();
    this.heartbeatDone = new Signal();
    this.finished = new Signal();
    this.inFlight = null;
    this.deleted = false;
    this.authDead = false;
    this.loops = [];
    this.pollAbort = null;
  }

  // ------------------------------------------------------------------ control

  start() {
    this.setStatus(Status.CONNECTING, "Connecting to NOLGIA...");
    this.loops = [this.heartbeatLoop(), this.pollLoop()];
    return this;
  }

  // Stop taking commands. A command already running still reports its
  // result; then the session is closed (DELETE) and `finished` is set.
  stop() {
    this.stopSignal.set();
    this.wake.set();
    this.sessionReady.set();
    if (this.pollAbort) this.pollAbort.abort();
  }

  // Stop at once, e.g. when the app quits. No more retries.
  kill() {
    this.stop();
    this.killSignal.set();
  }

  requestHeartbeat() {
    this.wake.set();
  }

  get stopping() {
    return this.stopSignal.isSet();
  }

  get busyWith() {
    return this.inFlight;
  }

  async join(seconds = null) {
    const all = Promise.all(this.loops);
    if (seconds === null) return all;
    return Promise.race([all, new Promise((r) => timers.setTimeout(r, seconds * 1000))]);
  }

  // ---------------------------------------------------------------- internals

  setStatus(state, text) {
    this.state = state;
    this.statusText = text;
    try {
      this.onStatus(state, text);
    } catch (e) {
      // the panel's problem, not ours
    }
  }

  // Sleep that ends early on stop. Resolves true when stopping.
  pause(seconds) {
    return this.stopSignal.wait(seconds);
  }

  // The full state, every time: the API resets fields left out.
  payload() {
    const snap = this.snapshot() || {};
    const doc = snap.document || {};
    const document = { name: String(doc.name || "").slice(0, MAX_DOCUMENT_NAME) };
    if (doc.path && String(doc.path).length <= MAX_DOCUMENT_PATH) document.path = String(doc.path);
    return {
      instance_id: this.instanceId,
      app: this.app.app,
      app_version: oneLine(snap.app_version, MAX_VERSION),
      plugin_version: PLUGIN_VERSION,
      machine_name: oneLine(this.machineName, MAX_MACHINE_NAME),
      document,
      capabilities: CAPABILITIES.slice(),
      allow_agent: snap.allow_agent === undefined ? true : Boolean(snap.allow_agent),
    };
  }

  authFailed(err) {
    this.authDead = true;
    const text = "NOLGIA did not accept your sign in. Sign in again.";
    this.setStatus(Status.SIGNED_OUT, text);
    this.log(text + " (" + err.message + ")");
    try {
      this.onAuthFailed(text);
    } catch (e) {
      // ignore
    }
    this.stop();
  }

  retryText(err, delay) {
    let why;
    if (err instanceof NetworkError) why = "Cannot reach NOLGIA (" + err.message + ").";
    else if (err.status === 429) why = "NOLGIA asked us to slow down.";
    else if (err.status >= 500) why = "NOLGIA is having trouble (" + err.status + ").";
    else why = "NOLGIA refused the connection: " + (err.detail || err.title || err.status);
    return why + " Trying again in " + Math.max(1, Math.round(delay)) + " s.";
  }

  connectedText() {
    return "Connected. NOLGIA can work in this " + this.app.name + ".";
  }

  async heartbeatLoop() {
    const backoff = new Backoff(1, 60);
    try {
      while (!this.stopping) {
        let data;
        try {
          data = await this.api.registerSession(this.payload());
        } catch (err) {
          if (err instanceof Unauthorized) {
            this.authFailed(err);
            break;
          }
          if (!(err instanceof ApiError) && !(err instanceof NetworkError)) throw err;
          const delay = err.retryAfter || backoff.next();
          this.setStatus(Status.RETRYING, this.retryText(err, delay));
          this.log(this.statusText);
          await this.pause(delay);
          continue;
        }
        // The API answers the session itself; accept {"session": {...}} too.
        const session = data && data.id ? data : data && data.session;
        const sessionId = session && typeof session === "object" ? session.id : null;
        if (!sessionId) {
          const delay = backoff.next();
          this.setStatus(
            Status.RETRYING,
            "NOLGIA answered without a session. Trying again in " + Math.round(delay) + " s."
          );
          await this.pause(delay);
          continue;
        }
        backoff.reset();
        let wait = Number(data.poll_wait_seconds || session.poll_wait_seconds || 25);
        wait = Number.isFinite(wait) ? Math.max(1, Math.min(25, Math.trunc(wait))) : 25;
        const first = this.sessionId !== sessionId;
        this.sessionId = sessionId;
        this.pollWait = wait;
        this.sessionReady.set();
        if (first || this.state !== Status.CONNECTED) {
          this.setStatus(Status.CONNECTED, this.connectedText());
          this.log("Connected to NOLGIA (session " + sessionId + ").");
        }
        await this.wake.wait(this.heartbeatInterval);
        this.wake.clear();
      }
    } catch (err) {
      this.log("The heartbeat stopped on a bug: " + (err && err.stack ? err.stack : err));
    } finally {
      this.heartbeatDone.set();
      await this.closeIfIdle();
    }
  }

  sessionLost(sessionId) {
    if (this.sessionId === sessionId) {
      this.sessionId = null;
      this.sessionReady.clear();
    }
    this.wake.set();
  }

  async pollLoop() {
    const backoff = new Backoff(1, 60);
    try {
      while (!this.stopping) {
        if (!(await this.sessionReady.wait(0.5))) continue;
        const sessionId = this.sessionId;
        const wait = this.pollWait;
        if (this.stopping || !sessionId) {
          if (!sessionId) this.sessionReady.clear();
          continue;
        }
        let data;
        this.pollAbort = new AbortController();
        try {
          data = await this.api.nextCommand(sessionId, wait, this.pollAbort.signal);
        } catch (err) {
          if (this.stopping) break;
          if (err instanceof Unauthorized) {
            this.authFailed(err);
            break;
          }
          if (err instanceof ApiError) {
            if (sessionGone(err)) {
              this.log("NOLGIA closed this session; registering again.");
              this.sessionLost(sessionId);
              continue;
            }
            const delay = err.retryAfter || backoff.next();
            this.setStatus(Status.RETRYING, this.retryText(err, delay));
            await this.pause(delay);
            continue;
          }
          if (err instanceof NetworkError) {
            const delay = backoff.next();
            this.setStatus(Status.RETRYING, this.retryText(err, delay));
            await this.pause(delay);
            this.wake.set(); // re-check the session as soon as we are back
            continue;
          }
          throw err;
        } finally {
          this.pollAbort = null;
        }
        backoff.reset();
        if (this.state === Status.RETRYING) this.setStatus(Status.CONNECTED, this.connectedText());
        if (data) await this.handle(new Command(data));
      }
    } catch (err) {
      this.log("The command loop stopped on a bug: " + (err && err.stack ? err.stack : err));
    } finally {
      await this.closeIfIdle();
    }
  }

  async handle(command) {
    this.inFlight = command.id;
    this.activity.add(command.id, command.kind, command.caller);
    this.log("Command " + command.kind + " (" + command.id + ") from " + command.callerLabel + ".");
    try {
      let outcome;
      if (this.stopping) {
        outcome = { ok: false, result: null, error: "NOLGIA was switched off in " + this.app.name + " before this command ran." };
      } else {
        outcome = await this.run(command);
      }
      await this.post(command, outcome.ok, outcome.result, outcome.error);
    } finally {
      this.inFlight = null;
      await this.closeIfIdle();
    }
  }

  async run(command) {
    try {
      const outcome = await this.execute(command, this.killSignal);
      return { ok: Boolean(outcome.ok), result: outcome.result, error: outcome.error };
    } catch (err) {
      if (err instanceof CommandError) return { ok: false, result: err.result, error: err.message };
      if (err instanceof Unauthorized) return { ok: false, result: null, error: "NOLGIA did not accept the sign in while moving files." };
      if (err instanceof NetworkError) {
        return { ok: false, result: null, error: "Could not reach NOLGIA while moving files (" + err.message + ")." };
      }
      if (err instanceof ApiError) return { ok: false, result: null, error: err.message };
      return { ok: false, result: null, error: "The NOLGIA plugin hit a bug:\n" + (err && err.stack ? err.stack : err) };
    }
  }

  async post(command, ok, result, error) {
    const body = resultBody(ok, result, error);
    const backoff = new Backoff(1, 30);
    // The API refuses a result at or after expires_at, so retrying past that
    // is pointless (a few seconds of slack for the clocks).
    const giveUpAt = command.expires + 5;
    for (;;) {
      let delay;
      try {
        await this.api.postResult(command.id, body);
        this.activity.update(command.id, body.status, body.error || "");
        this.log("Command " + command.kind + " " + body.status + ".");
        return;
      } catch (err) {
        if (err instanceof Unauthorized) {
          this.activity.update(command.id, "failed", "Sign in no longer accepted");
          this.authFailed(err);
          return;
        }
        if (err instanceof ApiError) {
          if (err.status === 409) {
            // command_not_running: drop the outcome
            const status = (err.detail || "").includes("expired") ? "expired" : "cancelled";
            this.activity.update(command.id, status, err.detail || "Stopped on NOLGIA");
            this.log("NOLGIA no longer wanted the result of " + command.kind + " (" + (err.detail || err.code) + ").");
            return;
          }
          if (err.status === 413) {
            // the API already marked it failed
            this.activity.update(command.id, "failed", "Result over 1 MB");
            this.log("The result of " + command.kind + " was over 1 MB; NOLGIA marked it failed.");
            return;
          }
          if (err.status === 404) {
            this.activity.update(command.id, "expired", "NOLGIA no longer has this command");
            return;
          }
          if (err.status !== 429 && err.status < 500) {
            this.activity.update(command.id, "failed", err.message);
            this.log("NOLGIA refused the result of " + command.kind + ": " + err.message);
            return;
          }
          delay = err.retryAfter || backoff.next();
        } else if (err instanceof NetworkError) {
          delay = backoff.next();
        } else {
          throw err;
        }
      }
      if (monotonic() + delay > giveUpAt) {
        this.activity.update(command.id, "failed", "Could not send the result to NOLGIA");
        this.log("Gave up sending the result of " + command.kind + ".");
        return;
      }
      if (await this.killSignal.wait(delay)) return;
    }
  }

  // After stop: close the session once nothing is running and the heartbeat
  // loop is done, then set `finished`.
  async closeIfIdle() {
    if (!this.stopping || !this.heartbeatDone.isSet()) return;
    if (this.inFlight || this.finished.isSet() || this.closing) return;
    this.closing = true;
    const sessionId = this.deleted || this.authDead ? null : this.sessionId;
    this.deleted = true;
    if (sessionId) {
      try {
        await this.api.deleteSession(sessionId, 5);
        this.log("Disconnected from NOLGIA.");
      } catch (err) {
        this.log("Could not tell NOLGIA we disconnected (" + err.message + ").");
      }
    }
    if (this.state !== Status.SIGNED_OUT) this.setStatus(Status.OFF, "Switched off.");
    this.finished.set();
  }
}

module.exports = { BridgeWorker, Status, sessionGone };
