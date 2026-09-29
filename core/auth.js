// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Device login, the same flow the NOLGIA CLI and the Blender plugin use.
//
// 1. POST /auth/device gives a user code and a page to approve it on.
// 2. The person approves the code in their browser.
// 3. We poll POST /auth/device/token every `interval` seconds; the API answers
//    400 authorization_pending until then, 400 slow_down when we poll too fast
//    (we add 5 s to the interval, like the CLI), 400 expired_token when the
//    code ran out, and 403 access_denied when the person said no.
//
// Device tokens last 30 days and come without a refresh token, so there is
// no refresh step: when the API stops accepting the token, the plugin asks
// the person to sign in again.

"use strict";

const { DEVICE_CLIENT_ID, DEVICE_SCOPE } = require("./index");
const { ApiError, NetworkError } = require("./api");
const { Signal } = require("./util");

// Sign in did not finish. The message is written for the person.
class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
}

class LoginCancelled extends LoginError {
  constructor(message = "Sign in cancelled.") {
    super(message);
    this.name = "LoginCancelled";
  }
}

class DevicePrompt {
  constructor(data) {
    this.deviceCode = data.device_code;
    this.userCode = data.user_code;
    this.verificationUri = data.verification_uri;
    this.verificationUriComplete = data.verification_uri_complete || null;
    this.expiresIn = Number(data.expires_in) || 900;
    this.interval = Math.max(1, Number(data.interval) || 5);
  }

  get openUrl() {
    return this.verificationUriComplete || this.verificationUri;
  }
}

class DeviceLogin {
  constructor(api, { clientId = DEVICE_CLIENT_ID, scope = DEVICE_SCOPE, clock = () => Date.now() / 1000 } = {}) {
    this.api = api;
    this.clientId = clientId;
    this.scope = scope;
    this.clock = clock;
    this.cancelled = new Signal();
    this.interval = null;
  }

  async start() {
    let data;
    try {
      data = await this.api.startDeviceAuth(this.clientId, this.scope);
    } catch (err) {
      if (err instanceof NetworkError) throw new LoginError("Could not reach NOLGIA to sign in (" + err.message + ").");
      if (err instanceof ApiError) throw new LoginError("NOLGIA did not start the sign in: " + (err.detail || err.title));
      throw err;
    }
    const prompt = new DevicePrompt(data || {});
    this.interval = prompt.interval;
    return prompt;
  }

  cancel() {
    this.cancelled.set();
  }

  async sleep(seconds) {
    if (await this.cancelled.wait(seconds)) throw new LoginCancelled();
  }

  // Poll until the person approves. Resolves {accessToken, expiresAt, email, userId}.
  async waitForToken(prompt) {
    const deadline = this.clock() + prompt.expiresIn;
    this.interval = prompt.interval;
    let networkFailures = 0;
    for (;;) {
      if (this.clock() >= deadline) throw new LoginError("The sign in code expired. Click Sign in to get a new one.");
      await this.sleep(this.interval);
      let data;
      try {
        data = await this.api.pollDeviceToken(this.clientId, prompt.deviceCode);
      } catch (err) {
        if (err instanceof NetworkError) {
          networkFailures += 1;
          await this.sleep(Math.min(30, 2 * networkFailures));
          continue;
        }
        if (!(err instanceof ApiError)) throw err;
        networkFailures = 0;
        const code = err.code || err.title;
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          this.interval += 5;
          continue;
        }
        if (code === "expired_token") throw new LoginError("The sign in code expired. Click Sign in to get a new one.");
        if (code === "access_denied") throw new LoginError("Sign in was declined in the browser.");
        if (err.status === 403) continue;
        throw new LoginError("Sign in failed: " + (err.detail || err.title || err.status));
      }
      const token = data && data.access_token;
      if (!token) throw new LoginError("NOLGIA answered without a token. Try signing in again.");
      const expiresAt = data.expires_in ? this.clock() + Number(data.expires_in) : null;
      return { accessToken: token, expiresAt, email: data.email || null, userId: data.user_id || null };
    }
  }
}

module.exports = { DeviceLogin, DevicePrompt, LoginError, LoginCancelled };
