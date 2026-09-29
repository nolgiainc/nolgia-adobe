// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// HTTP client for the NOLGIA API (Node's http and https only).
//
// The bearer token is sent only to the API itself, never to the signed
// storage URLs that uploads and downloads go through.

"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const { PLUGIN_VERSION, DEFAULT_API_URL } = require("./index");

class ApiError extends Error {
  constructor(status, { title = "", detail = "", code = "", retryAfter = null, body = null } = {}) {
    super("");
    this.name = "ApiError";
    this.status = status;
    this.title = title || "";
    this.detail = detail || "";
    this.code = code || "";
    this.retryAfter = retryAfter;
    this.body = body;
    this.message = this.describe();
  }

  describe() {
    return "NOLGIA answered " + this.status + ": " + (this.detail || this.title || "no details");
  }
}

// The token is missing, expired or revoked (401).
class Unauthorized extends ApiError {
  constructor(status, fields) {
    super(status, fields);
    this.name = "Unauthorized";
  }
}

// NOLGIA could not be reached (DNS, TCP, TLS or a timeout).
class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

function normalizeBaseUrl(url) {
  url = String(url || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

function retryAfter(headers) {
  const value = headers ? headers["retry-after"] : undefined;
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? Math.max(0, n) : null;
}

function networkReason(err) {
  return (err && (err.code ? err.code + " " + (err.message || "") : err.message)) || String(err);
}

function apiError(status, headers, raw) {
  let data = {};
  try {
    data = raw && raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch (e) {
    data = {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const title = String(data.title || "");
  // The device token poll carries its OAuth error in `title` (RFC 7807);
  // other endpoints use `code`. Accept `error` too, like the CLI.
  let code = String(data.code || data.error || "");
  if (!code && title && !title.includes(" ") && title.toLowerCase() === title) code = title;
  const Cls = status === 401 ? Unauthorized : ApiError;
  return new Cls(status, {
    title,
    detail: String(data.detail || data.error_description || ""),
    code,
    retryAfter: retryAfter(headers),
    body: data,
  });
}

// One HTTP exchange. Resolves {status, headers, body: Buffer}; rejects with
// NetworkError. `body` may be a Buffer, a string, or {stream, length}.
function exchange(url, { method = "GET", headers = {}, body = null, timeout = 30, sink = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new NetworkError("bad URL " + url));
      return;
    }
    if (signal && signal.aborted) {
      reject(new NetworkError("aborted"));
      return;
    }
    const mod = target.protocol === "https:" ? https : http;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof NetworkError || err instanceof ApiError ? err : new NetworkError(networkReason(err)));
    };
    const req = mod.request(
      target,
      { method, headers, timeout: timeout * 1000 },
      (res) => {
        const chunks = [];
        let size = 0;
        let sinkError = null;
        res.on("data", (chunk) => {
          if (sinkError) return;
          if (sink && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              sink.write(chunk);
            } catch (err) {
              sinkError = err;
              fail(err);
              req.destroy();
            }
            return;
          }
          size += chunk.length;
          if (size <= 1 << 22) chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", fail);
      }
    );
    req.on("timeout", () => req.destroy(new NetworkError("timed out after " + timeout + " s")));
    req.on("error", fail);
    if (signal) {
      const onAbort = () => req.destroy(new NetworkError("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    if (body && body.stream) {
      body.stream.on("error", fail);
      body.stream.pipe(req);
    } else {
      req.end(body || undefined);
    }
  });
}

class ApiClient {
  constructor({ baseUrl = null, token = null, userAgent = null, timeout = 30 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.timeout = timeout;
    this.userAgent = userAgent || "nolgia-adobe/" + PLUGIN_VERSION;
  }

  // Send a JSON request to the API. Resolves {status, headers, body, json()};
  // rejects with Unauthorized on 401, ApiError on other 4xx/5xx and
  // NetworkError when the API cannot be reached.
  async request(method, path, body = undefined, { query = null, timeout = null, auth = true, signal = null } = {}) {
    let url = this.baseUrl + path;
    if (query) url += "?" + new URLSearchParams(query).toString();
    const headers = { Accept: "application/json", "User-Agent": this.userAgent };
    let data = null;
    if (body !== undefined && body !== null) {
      data = Buffer.from(JSON.stringify(body), "utf8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(data.length);
    } else if (method === "POST" || method === "PUT" || method === "PATCH") {
      data = Buffer.alloc(0); // Content-Length: 0; Google's front end refuses a POST without it
      headers["Content-Length"] = "0";
    }
    if (auth && this.token) headers.Authorization = "Bearer " + this.token;
    const res = await exchange(url, { method, headers, body: data, timeout: timeout || this.timeout, signal });
    if (res.status >= 400) throw apiError(res.status, res.headers, res.body);
    res.json = () => (res.body && res.body.length ? JSON.parse(res.body.toString("utf8")) : null);
    return res;
  }

  // ------------------------------------------------------------ device login

  async startDeviceAuth(clientId, scope = null) {
    const body = { client_id: clientId };
    if (scope) body.scope = scope;
    return (await this.request("POST", "/auth/device", body, { auth: false })).json();
  }

  // One poll. Resolves the token response, or rejects with an ApiError whose
  // `code` is the OAuth error (authorization_pending, slow_down, ...).
  async pollDeviceToken(clientId, deviceCode) {
    const body = { client_id: clientId, device_code: deviceCode };
    return (await this.request("POST", "/auth/device/token", body, { auth: false })).json();
  }

  async getMe() {
    return (await this.request("GET", "/me")).json() || {};
  }

  // ------------------------------------------------------------------ bridge

  async registerSession(payload) {
    return (await this.request("POST", "/bridge/sessions", payload)).json() || {};
  }

  async deleteSession(sessionId, timeout = 5) {
    await this.request("DELETE", "/bridge/sessions/" + encodeURIComponent(sessionId), undefined, { timeout });
  }

  // Long poll. Resolves the command (the API answers it bare), or null on
  // 204. 404 (unknown session) and 409 session_disconnected reject with an
  // ApiError: both mean register again.
  async nextCommand(sessionId, wait = 25, signal = null) {
    wait = Math.max(0, Math.min(25, Math.trunc(wait)));
    const res = await this.request("GET", "/bridge/sessions/" + encodeURIComponent(sessionId) + "/next", undefined, {
      query: { wait },
      timeout: wait + 20,
      signal,
    });
    if (res.status === 204 || !res.body || !res.body.length) return null;
    const data = res.json() || {};
    const command = data.command && typeof data.command === "object" ? data.command : data;
    return command.id ? command : null;
  }

  async postResult(commandId, body) {
    return this.request("POST", "/bridge/commands/" + encodeURIComponent(commandId) + "/result", body);
  }

  // ------------------------------------------------------------------ assets

  async getAsset(assetId) {
    return (await this.request("GET", "/assets/" + encodeURIComponent(assetId))).json();
  }

  // Upload a file as a NOLGIA asset. Resolves the completed asset.
  async uploadFile(filePath, contentType, { displayName = null, tags = null, filename = null } = {}) {
    const size = fs.statSync(filePath).size;
    const body = {
      filename: filename || require("path").basename(filePath),
      content_type: contentType,
      size_bytes: size,
    };
    if (displayName) body.display_name = String(displayName).slice(0, 200);
    if (tags) body.tags = tags;
    const slot = (await this.request("POST", "/assets/uploads", body)).json();
    await this.putFile(slot.upload_url, filePath, contentType, size);
    return (await this.request("POST", "/assets/uploads/" + encodeURIComponent(slot.upload_id) + "/complete")).json();
  }

  async putFile(url, filePath, contentType, size) {
    const headers = { "Content-Type": contentType, "Content-Length": String(size) };
    const res = await exchange(url, {
      method: "PUT",
      headers,
      body: { stream: fs.createReadStream(filePath), length: size },
      timeout: Math.max(this.timeout, 300),
    });
    if (res.status >= 400) {
      throw new ApiError(res.status, { title: "Upload failed", detail: res.body.toString("utf8").slice(0, 500) });
    }
  }

  // Download a signed URL to destPath (never with the bearer). Resolves the
  // file's first 64 bytes.
  async download(url, destPath, { maxBytes = null, redirects = 5 } = {}) {
    const tmp = destPath + ".part";
    let current = url;
    try {
      for (let hop = 0; ; hop++) {
        const out = fs.createWriteStream(tmp);
        let copied = 0;
        const sink = {
          write(chunk) {
            copied += chunk.length;
            if (maxBytes && copied > maxBytes) {
              throw new ApiError(413, { title: "Too large", detail: "The file is too large to import." });
            }
            out.write(chunk);
          },
        };
        let res;
        try {
          res = await exchange(current, {
            headers: { "User-Agent": this.userAgent },
            timeout: Math.max(this.timeout, 300),
            sink,
          });
        } finally {
          await new Promise((resolve) => out.end(resolve));
        }
        if (res.status >= 300 && res.status < 400 && res.headers.location && hop < redirects) {
          current = new URL(res.headers.location, current).toString();
          continue;
        }
        if (res.status >= 400) {
          throw new ApiError(res.status, { title: "Download failed", detail: res.body.toString("utf8").slice(0, 500) });
        }
        break;
      }
      fs.renameSync(tmp, destPath);
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (e) {
        // ignore
      }
    }
    const fd = fs.openSync(destPath, "r");
    try {
      const head = Buffer.alloc(64);
      const n = fs.readSync(fd, head, 0, 64, 0);
      return head.slice(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { ApiClient, ApiError, Unauthorized, NetworkError, normalizeBaseUrl, exchange };
