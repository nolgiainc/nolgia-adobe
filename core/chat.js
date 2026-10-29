// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The chat in the NOLGIA panel: what the person types goes to their NOLGIA
// Agent, which works in this app (After Effects, Premiere Pro or
// Illustrator) through the plugin, and its replies come back here.
//
// It lives in the invisible part (the Controller), like the connection, so
// a turn keeps going when the panel is closed; the panel shows view() and
// sends the buttons. It uses the routes nolgia.ai's own chat uses (POST
// /agent/messages, then the pending reply row read until it settles), so a
// chat started here is the same chat on nolgia.ai/agent. One chat per app
// copy (instance id): its session id is remembered, "New chat" starts
// another. The session is pinned to this app (`app` on POST /agent/sessions:
// the app and the instance id its bridge session uses), so every turn tells
// the Agent the conversation is about this window. A pin cannot be added
// later, so a session without this instance's pin is never used here.
//
// The same chat as NOLGIA for Photoshop's (core/chat.js there), with the
// app named by the owner and Node's timers.
//
// One message is one turn: while the Agent works, the box waits (Stop ends
// the turn). A message sent mid-turn would either reach the running turn or
// become a turn of its own, billed on its own, depending on the Agent's
// pod, and the person could not tell which before sending.
"use strict";

const { ApiError, Unauthorized, NetworkError } = require("./api");
const { AGENT_URL, BILLING_URL } = require("./index");
const { timers } = require("./util");

// The line under the chat box: NOLGIA Agent first (the work never needs to
// leave NOLGIA), with what a turn costs on the person's own model (GET
// /agent/models for the Agent's brain), or the lowest rate when NOLGIA does
// not say; then the familiar agents NOLGIA connects to (Claude, Cursor and
// Codex; nolgia.ai/mcp has the setup).
const COST_LINE = "NOLGIA Agent works right here, each turn from 10 credits. You can also use Claude, Cursor, Codex or another agent with NOLGIA connected.";
const COST_LINE_RATE = "NOLGIA Agent works right here, each turn from {credits} credits on your model. You can also use Claude, Cursor, Codex or another agent with NOLGIA connected.";

const MAX_CHARS = 8000; // SubmitAgentMessageRequest.content
const SESSION_NAME_MAX = 80;
const ROWS_SHOWN = 40;
const WAKE_EVERY = 10 * 60; // seconds between wake calls, like the site's chat

/** How long to wait before the next read of a pending reply: quick at
 *  first, slower once a turn has run for a while. */
function pollDelay(pendingFor) {
  if (pendingFor < 30) return 1500;
  if (pendingFor < 120) return 3000;
  return 5000;
}

/** The session's name in the chat list on nolgia.ai: the app's name
 *  ("Premiere Pro: ") and the message's first six words. */
function sessionName(text, appName) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  const name = appName + ": " + (words || "New chat");
  return name.length > SESSION_NAME_MAX ? name.slice(0, SESSION_NAME_MAX - 3).trimEnd() + "..." : name;
}

/** An RFC 3339 time as a string that sorts in time order, to the
 *  microsecond the API serves (Date keeps only milliseconds, and "...01Z"
 *  sorts after "...01.5Z" as plain text). */
function timeKey(stamp) {
  const m = /^(.*?T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(stamp || ""));
  if (!m) return "0".repeat(21);
  const seconds = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(seconds)) return "0".repeat(21);
  return String(seconds).padStart(15, "0") + ((m[2] || "") + "000000").slice(0, 6);
}

function byTime(a, b) {
  const ka = timeKey(a.created_at);
  const kb = timeKey(b.created_at);
  if (ka === kb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return ka < kb ? -1 : 1;
}

/** What one turn costs on the Agent's brain: its catalogue rate (the
 *  default brain's when none is chosen), or null when unknown. */
function turnRate(agent, models) {
  if (!agent || !Array.isArray(models)) return null;
  const chosen = agent.model ? models.find((m) => m && m.model === agent.model) : models.find((m) => m && m.default);
  const credits = chosen && chosen.turn_credits;
  return Number.isInteger(credits) && credits > 0 ? credits : null;
}

/** The cost line under the box. */
function costLine(rate) {
  return rate ? COST_LINE_RATE.replace("{credits}", String(rate)) : COST_LINE;
}

/** A failed or stopped reply, in words for the panel. */
function failureText(row) {
  if (row.status === "interrupted") return "Stopped.";
  const detail = String(row.error || "").trim();
  switch (row.error_code) {
    case "insufficient_credits":
      return "You are out of credits for NOLGIA Agent. Add credits on nolgia.ai to keep going.";
    case "timeout":
      return "NOLGIA Agent ran out of time on this one." + (detail ? " " + detail : "");
    case "access_denied":
      return detail || "Your account cannot use NOLGIA Agent for this.";
    default:
      return "NOLGIA Agent could not finish this." + (detail ? " " + detail : "");
  }
}

// --------------------------------------------------------- reply formatting

const LINK_RE = /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** One line of a reply as text pieces: plain, bold, or a link. Markdown
 *  emphasis and code marks are dropped; only https links become links. */
function inlineParts(line) {
  const parts = [];
  const pushText = (text) => {
    if (!text) return;
    const pieces = text.split(/(\*\*[^*]+\*\*)/g);
    for (const piece of pieces) {
      if (!piece) continue;
      const bold = /^\*\*[^*]+\*\*$/.test(piece);
      const clean = (bold ? piece.slice(2, -2) : piece).replace(/`/g, "").replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$)/g, "$1$2");
      if (clean) parts.push(bold ? { text: clean, bold: true } : { text: clean });
    }
  };
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(line))) {
    pushText(line.slice(last, m.index));
    if (m[2]) parts.push({ text: m[1], href: m[2] });
    else parts.push({ text: m[3], href: m[3] });
    last = m.index + m[0].length;
  }
  pushText(line.slice(last));
  return parts;
}

/** A reply as blocks the panel draws: paragraphs and list items. */
function formatReply(text) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", parts: inlineParts(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^(-{3,}|\*{3,})$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "p", parts: [{ text: heading[1].replace(/\*\*/g, ""), bold: true }] });
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      blocks.push({ type: "li", parts: inlineParts(item[1]) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------ the chat

class AgentChat {
  /** `owner` (the Controller gives one, chatOwner()): app {app, name},
   *  api(), instanceId (the bridge session's, null while not connected),
   *  apiUrl, accountEmail(), recall(instanceId), remember(instanceId, value),
   *  bump(), log(),
   *  authFailed(text). */
  // Node's timers (core/util.js): a CEP page may throttle the page's own.
  constructor(owner, { clock = () => Date.now() / 1000, schedule = (fn, ms) => timers.setTimeout(fn, ms), cancel = (t) => timers.clearTimeout(t) } = {}) {
    this.owner = owner;
    this.clock = clock;
    this._schedule = schedule;
    this._cancel = cancel;
    this._clear();
  }

  _clear() {
    this.sessionId = null;
    this.rows = new Map(); // id -> AgentMessage
    this.sending = false;
    this.stopping = false;
    this.notice = null; // {kind, text, action: {label, url}|null}
    this.agent = undefined; // GET /agent: undefined unread, null none
    this.rate = null; // credits a turn costs on the Agent's brain, when known
    this.loaded = false;
    this.instanceId = null; // the instance this chat was read for
    this._generation = (this._generation || 0) + 1;
    this._timer = null;
    this._pendingSince = {};
    this._lastWake = 0;
    this._loading = null;
  }

  // ------------------------------------------------------------ lifecycle

  /** Connected: read the remembered chat (if it is this account's and this
   *  instance's) and what the Agent is up to. Again for another instance
   *  (a second copy of the app holds its own). */
  start() {
    if (this._loading && this.instanceId === this.owner.instanceId) return this._loading;
    if (this._loading) this.reset({ forget: false });
    const gen = this._generation;
    this.instanceId = this.owner.instanceId;
    this._loading = (async () => {
      const saved = this._recall();
      if (saved && saved.id) this.sessionId = await this._pinnedHere(saved.id);
      if (gen !== this._generation) return;
      await this._readAgent(gen);
      if (this.sessionId) await this._loadTranscript(gen);
      if (gen !== this._generation) return;
      this.loaded = true;
      this._afterRead(gen);
      this.owner.bump();
    })().catch((err) => this._readFailed(err, gen));
    return this._loading;
  }

  /** Signed out, or the sign in changed: forget this chat on this computer. */
  reset({ forget = true } = {}) {
    this._stopTimer();
    if (forget) this._remember(null);
    this._clear();
    this.owner.bump();
  }

  /** "New chat": the next message starts a fresh session. */
  newChat() {
    this._stopTimer();
    this._remember(null);
    const agent = this.agent;
    const rate = this.rate;
    const instanceId = this.instanceId;
    this._clear();
    this.agent = agent;
    this.rate = rate;
    this.instanceId = instanceId;
    this._loading = Promise.resolve();
    this.loaded = true;
    this.owner.bump();
  }

  _recall() {
    let saved = null;
    try {
      saved = this.instanceId ? this.owner.recall(this.instanceId) : null;
    } catch (err) {
      saved = null;
    }
    if (!saved || typeof saved !== "object" || !saved.id) return null;
    if (saved.api && saved.api !== this.owner.apiUrl) return null;
    const email = this.owner.accountEmail();
    if (saved.email && email && saved.email !== email) return null;
    return saved;
  }

  /** The remembered session's id when it is still there and pinned to this
   *  install, else null (and forgotten). */
  async _pinnedHere(id) {
    let session;
    try {
      session = await this.owner.api().getAgentSession(id);
    } catch (err) {
      if (err instanceof ApiError && !(err instanceof Unauthorized) && (err.status === 404 || err.status === 400)) {
        this._remember(null);
        return null;
      }
      throw err;
    }
    const pin = session && session.app;
    // The instance read at start(), not the live one: a connection that
    // drops meanwhile must not make a good chat look foreign.
    if (!pin || pin.app !== this.owner.app.app || pin.instance_id !== this.instanceId || session.archived_at) {
      this._remember(null);
      return null;
    }
    return session.id;
  }

  _remember(id) {
    try {
      if (this.instanceId) this.owner.remember(this.instanceId, id ? { id, api: this.owner.apiUrl, email: this.owner.accountEmail() || "" } : null);
    } catch (err) {
      // a convenience only
    }
  }

  // ---------------------------------------------------------------- reads

  async _readAgent(gen) {
    const api = this.owner.api();
    try {
      const agent = await api.getAgent();
      if (gen === this._generation) this.agent = agent;
    } catch (err) {
      if (err instanceof Unauthorized) throw err;
      // the chat still works; this only names a sleeping agent
    }
    if (!this.agent) return;
    try {
      const rate = turnRate(this.agent, await api.listAgentModels());
      if (gen === this._generation) this.rate = rate;
    } catch (err) {
      // the cost line falls back to the site's words
    }
  }

  async _loadTranscript(gen) {
    const api = this.owner.api();
    let since = null;
    for (let page = 0; page < 20; page++) {
      let rows;
      try {
        rows = await api.listAgentMessages(this.sessionId, { since, limit: 200 });
      } catch (err) {
        if (err instanceof ApiError && !(err instanceof Unauthorized) && (err.status === 404 || err.status === 400)) {
          // The remembered chat is gone (deleted on nolgia.ai): start a new one.
          if (gen === this._generation) {
            this.sessionId = null;
            this._remember(null);
          }
          return;
        }
        throw err;
      }
      if (gen !== this._generation) return;
      this._merge(rows);
      if (rows.length < 200) return;
      since = rows[rows.length - 1].created_at;
    }
  }

  /** Rows from NOLGIA, or (`local`) the ones a send just made, shown until
   *  NOLGIA's own copies replace them. Only NOLGIA's times are read back as
   *  `since`, so this computer's clock never hides a row. */
  _merge(rows, { local = false } = {}) {
    for (const row of rows || []) {
      if (!row || !row.id) continue;
      if (this.sessionId && row.session_id && row.session_id !== this.sessionId) continue;
      const was = this.rows.get(row.id);
      this.rows.set(row.id, Object.assign({}, was || {}, row, { local }));
      if (row.status === "pending" && !this._pendingSince[row.id]) this._pendingSince[row.id] = this.clock();
      if (row.status !== "pending") delete this._pendingSince[row.id];
    }
  }

  _readFailed(err, gen) {
    if (gen !== this._generation) return;
    this.loaded = true;
    if (err instanceof Unauthorized) {
      this.owner.authFailed("Your NOLGIA sign in expired. Sign in again.");
      return;
    }
    this.notice = { kind: "error", text: this._errorText(err), action: null };
    this.owner.log("Chat: " + (err && err.message));
    this.owner.bump();
  }

  // -------------------------------------------------------------- polling

  /** The newest time NOLGIA served, for `since`. */
  _since() {
    let best = null;
    for (const row of this.rows.values()) {
      if (row.local) continue;
      if (best === null || timeKey(row.created_at) > timeKey(best)) best = row.created_at;
    }
    return best;
  }

  /** The newest rows, oldest first. */
  messages() {
    return Array.from(this.rows.values()).sort(byTime);
  }

  pending() {
    return this.messages().filter((r) => r.role === "agent" && r.status === "pending");
  }

  get busy() {
    return this.sending || this.pending().length > 0;
  }

  _stopTimer() {
    if (this._timer) this._cancel(this._timer);
    this._timer = null;
  }

  _afterRead(gen) {
    if (gen !== this._generation) return;
    this._stopTimer();
    if (!this.sessionId || !this.pending().length) return;
    const oldest = Math.min(...Object.values(this._pendingSince).concat([this.clock()]));
    this._timer = this._schedule(() => this._tick(gen), pollDelay(this.clock() - oldest));
  }

  async _tick(gen) {
    this._timer = null;
    if (gen !== this._generation || !this.sessionId) return;
    const api = this.owner.api();
    // New rows, then each pending reply on its own, so one failed read
    // never keeps a finished reply off the panel.
    const reads = [async () => this._merge(await api.listAgentMessages(this.sessionId, { since: this._since(), limit: 200 }))];
    for (const row of this.pending()) reads.push(async () => this._merge([await api.getAgentMessage(row.id)]));
    let failure = null;
    for (const read of reads) {
      try {
        await read();
      } catch (err) {
        if (gen !== this._generation) return;
        if (err instanceof Unauthorized) {
          this.owner.authFailed("Your NOLGIA sign in expired. Sign in again.");
          return;
        }
        failure = failure || err;
      }
      if (gen !== this._generation) return;
    }
    try {
      if (this.pending().length && this._agentSleeping()) await this._readAgent(gen);
    } catch (err) {
      // only names a sleeping agent
    }
    if (gen !== this._generation) return;
    if (failure) this.notice = { kind: "network", text: this._errorText(failure), action: null };
    else if (this.notice && this.notice.kind === "network") this.notice = null;
    this.owner.bump();
    this._afterRead(gen);
  }


  _agentSleeping() {
    return Boolean(this.agent && (this.agent.sleep_state === "asleep" || this.agent.sleep_state === "waking"));
  }

  /** Called when the person starts typing: wake a sleeping agent early, so
   *  it is ready by the time they send (the site's chat does the same). */
  async wake() {
    if (!this._agentSleeping() || this.clock() - this._lastWake < WAKE_EVERY) return;
    this._lastWake = this.clock();
    try {
      const agent = await this.owner.api().wakeAgent();
      if (agent) this.agent = agent;
      this.owner.bump();
    } catch (err) {
      // the message wakes it anyway
    }
  }

  // ----------------------------------------------------------------- send

  /** Send a message. Resolves true when NOLGIA took it (the panel then
   *  clears the box), false when it did not (the text stays). */
  async send(text) {
    const content = String(text || "").trim();
    if (!content || this.busy) return false;
    if (content.length > MAX_CHARS) {
      this.notice = { kind: "error", text: "That message is too long. Keep it under " + MAX_CHARS + " characters.", action: null };
      this.owner.bump();
      return false;
    }
    const gen = this._generation;
    this.sending = true;
    this.notice = null;
    this.owner.bump();
    try {
      // No NOLGIA Agent on the account (read at start; read again, it may
      // have been set up on nolgia.ai since): say so before starting a chat.
      if (this.agent === null) await this._readAgent(gen);
      if (gen !== this._generation) return false;
      if (this.agent === null) {
        this.sending = false;
        this.notice = this._submitNotice(new ApiError(404, { title: "Not Found", detail: "no agent is provisioned for this account" }));
        this.owner.bump();
        return false;
      }
      const accepted = await this._submit(content);
      if (gen !== this._generation) return true;
      if (accepted.session_id && accepted.session_id !== this.sessionId) {
        this.sessionId = accepted.session_id;
        this._remember(this.sessionId);
      }
      const at = new Date(this.clock() * 1000).toISOString();
      const local = { local: true };
      this._merge([{ id: accepted.user_message_id, role: "user", content, status: "complete", session_id: this.sessionId, created_at: at }], local);
      if (accepted.agent_message_id) {
        this._merge([{ id: accepted.agent_message_id, role: "agent", content: "", status: "pending", session_id: this.sessionId, created_at: at, user_message_id: accepted.user_message_id }], local);
      }
      this.loaded = true;
      this.sending = false;
      this.owner.bump();
      this._stopTimer();
      this._timer = this._schedule(() => this._tick(gen), 400);
      return true;
    } catch (err) {
      if (gen !== this._generation) return false;
      this.sending = false;
      if (err instanceof Unauthorized) {
        this.owner.authFailed("Your NOLGIA sign in expired. Sign in again.");
        return false;
      }
      // A turn started elsewhere (this chat on nolgia.ai) is still running:
      // follow it, so the box waits for it like for its own.
      const pendingId = err instanceof ApiError && err.status === 409 && err.body ? err.body.pending_agent_message_id : null;
      if (pendingId && this.sessionId) {
        this._merge([{ id: pendingId, role: "agent", content: "", status: "pending", session_id: this.sessionId, created_at: new Date(this.clock() * 1000).toISOString() }], { local: true });
        this._stopTimer();
        this._timer = this._schedule(() => this._tick(gen), 300);
      }
      this.notice = this._submitNotice(err);
      this.owner.log("Chat: could not send (" + (err && err.message) + ").");
      this.owner.bump();
      return false;
    }
  }

  async _submit(content) {
    const api = this.owner.api();
    if (this.sessionId) {
      try {
        return await api.submitAgentMessage({ content, session_id: this.sessionId });
      } catch (err) {
        // The remembered chat was deleted on nolgia.ai: carry on in a new one.
        if (!(err instanceof ApiError && err.status === 404 && /session/i.test(err.detail))) throw err;
        this.sessionId = null;
        this._remember(null);
        this.rows = new Map();
      }
    }
    // A new chat: the session first, pinned to this app (the pin rides
    // only on POST /agent/sessions), then the message into it.
    const app = this.owner.app;
    if (!this.owner.instanceId) throw new Error("this " + app.name + " is not connected to NOLGIA yet; turn on Connected and try again");
    this.instanceId = this.owner.instanceId; // the chat is remembered for the instance it is pinned to
    const session = await api.createAgentSession({ name: sessionName(content, app.name), app: { app: app.app, instance_id: this.owner.instanceId } });
    const pin = session && session.app;
    if (!session || !session.id || !pin || pin.app !== app.app || pin.instance_id !== this.owner.instanceId) {
      // Never chat in a session that is not pinned here: the pin cannot be added later.
      throw new ApiError(500, { title: "NOLGIA did not pin the new chat to this " + app.name, detail: "Update NOLGIA for " + app.name + ", or try again later." });
    }
    this.sessionId = session.id;
    this._remember(this.sessionId);
    return await api.submitAgentMessage({ content, session_id: session.id });
  }

  _submitNotice(err) {
    if (err instanceof ApiError) {
      const detail = String(err.detail || "");
      if (err.status === 404 && /no agent/i.test(detail)) {
        return {
          kind: "no_agent",
          text: "Your NOLGIA Agent is not set up yet. Open NOLGIA Agent on nolgia.ai once to start it, then come back here.",
          action: { label: "Open NOLGIA Agent", url: AGENT_URL },
        };
      }
      if (err.status === 402 || err.code === "insufficient_credits") {
        return {
          kind: "credits",
          text: "You are out of credits for NOLGIA Agent. Add credits on nolgia.ai to keep going.",
          action: { label: "Add credits", url: BILLING_URL },
        };
      }
      if (err.status === 429) {
        return { kind: "error", text: "NOLGIA Agent has too many turns waiting. Try again when one finishes.", action: null };
      }
      if (err.status === 409) {
        return { kind: "error", text: "NOLGIA Agent is still working on this chat. Wait for it, or press Stop.", action: null };
      }
      if (err.status === 403) {
        return { kind: "error", text: detail || "Your account cannot use NOLGIA Agent here.", action: { label: "Open NOLGIA Agent", url: AGENT_URL } };
      }
    }
    return { kind: "error", text: this._errorText(err), action: null };
  }

  _errorText(err) {
    if (err instanceof NetworkError) return "NOLGIA could not be reached (" + err.message + "). Check your connection and try again.";
    if (err instanceof ApiError) return "NOLGIA answered: " + (err.detail || err.title || "error " + err.status) + ".";
    return "Something went wrong: " + ((err && err.message) || err) + ".";
  }

  // ----------------------------------------------------------------- stop

  /** Stop the turn that is running. Generations it already started keep
   *  running on NOLGIA, as on nolgia.ai. */
  async stop() {
    if (!this.sessionId || this.stopping) return;
    const gen = this._generation;
    this.stopping = true;
    this.owner.bump();
    try {
      await this.owner.api().interruptAgentSession(this.sessionId);
    } catch (err) {
      if (gen === this._generation) this.notice = { kind: "error", text: this._errorText(err), action: null };
    }
    if (gen !== this._generation) return;
    this.stopping = false;
    this.owner.bump();
    this._stopTimer();
    this._timer = this._schedule(() => this._tick(gen), 300);
  }

  // ----------------------------------------------------------------- view

  /** What the panel draws. */
  view() {
    const all = this.messages();
    // The newest reply failed for want of credits: say it once, in the
    // notice card with Add credits, not again as a reply in the thread.
    const newest = all[all.length - 1];
    const outOfCredits = Boolean(newest && newest.role === "agent" && newest.status === "failed" && newest.error_code === "insufficient_credits");
    const shown = outOfCredits ? all.slice(0, -1) : all;
    const rows = shown.slice(-ROWS_SHOWN).map((row) => {
      const out = {
        id: row.id,
        role: row.role,
        status: row.status,
        background: row.origin === "background",
        queued: Boolean(row.queued),
        text: row.content || "",
        blocks: row.role === "agent" && row.status !== "failed" ? formatReply(row.content) : null,
        failure: row.role === "agent" && (row.status === "failed" || row.status === "interrupted") ? failureText(row) : null,
        question: row.role === "agent" && row.status === "complete" && row.question && Array.isArray(row.question.options) ? row.question : null,
        credits: row.cost && typeof row.cost.credits === "number" ? row.cost.credits : null,
      };
      return out;
    });
    // Only the newest reply's question takes answers.
    const last = rows[rows.length - 1];
    for (const row of rows) if (row !== last) row.question = null;
    let working = null;
    const pending = this.pending();
    if (this.sending) working = "Sending...";
    else if (pending.length) {
      const row = pending[pending.length - 1];
      if (row.queued) working = "Waiting for its turn. Your other NOLGIA Agent chats are still running.";
      else if (this._agentSleeping()) working = "Waking up NOLGIA Agent. This takes about a minute.";
      else working = "NOLGIA Agent is working. What it does in " + this.owner.app.name + " shows in Activity below.";
    }
    return {
      loaded: this.loaded,
      empty: all.length === 0,
      hidden: Math.max(0, shown.length - rows.length),
      rows,
      working,
      busy: this.busy,
      canStop: Boolean(this.sessionId && pending.length && !this.stopping),
      notice: this.notice || (outOfCredits ? { kind: "credits", text: failureText(newest), action: { label: "Add credits", url: BILLING_URL } } : null),
      sessionUrl: this.sessionId && all.length ? AGENT_URL + "/" + this.sessionId : null,
      costLine: costLine(this.rate),
    };
  }
}

module.exports = { AgentChat, formatReply, inlineParts, sessionName, failureText, pollDelay, timeKey, turnRate, costLine, MAX_CHARS, COST_LINE, COST_LINE_RATE };
