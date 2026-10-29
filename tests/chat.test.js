// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The chat in the NOLGIA panel, against the mock API's agent routes: the
// chat itself (core/chat.js) and how the controller gives it to the panel.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const support = require("./support");
const { ApiClient, normalizeBaseUrl } = require("../core/api");
const { AgentChat, formatReply, sessionName, timeKey, failureText, turnRate, MAX_CHARS, COST_LINE } = require("../core/chat");
const { Controller } = require("../core/controller");
const { AGENT_URL, BILLING_URL, APPS } = require("../core/index");

let server;
test.before(async () => {
  server = await support.startMock();
});
test.after(() => server.stop());
test.beforeEach(() => support.reset(server));

// A failed test must not leave a chat polling (it would keep Node running).
const made = [];
function newChat(o) {
  const chat = new AgentChat(o);
  made.push(chat);
  return chat;
}
test.afterEach(() => {
  for (const chat of made.splice(0)) chat.reset({ forget: false });
});

/** The parts of the controller the chat uses, for Premiere Pro. */
function owner({ token = support.TOKEN, store = {}, instanceId = "unit-instance", app = APPS.PPRO } = {}) {
  const o = {
    app,
    instanceId,
    apiUrl: normalizeBaseUrl(server.base),
    store,
    authFailures: [],
    bumps: 0,
    api: () => new ApiClient({ baseUrl: server.base, token }),
    accountEmail: () => "test@nolgia.ai",
    recall: (id) => o.store[id] || null,
    remember: (id, value) => {
      if (value) o.store[id] = value;
      else delete o.store[id];
    },
    bump() {
      o.bumps += 1;
    },
    log() {},
    authFailed(text) {
      o.authFailures.push(text);
    },
  };
  return o;
}

const mockAgent = (body) => support.call(server, "POST", "/mock/agent", body, { token: null });
const reply = (body = {}) => support.call(server, "POST", "/mock/agent/reply", body, { token: null });

async function settled(chat) {
  await support.until(() => !chat.busy && chat.loaded, 15, "the reply");
}

test("replies are drawn as paragraphs, list items, bold text and https links only", () => {
  const blocks = formatReply(
    "## Done\n\nI put **NOLGIA clip 3** at the end of `Sequence 01`.\n\n- Imported\n2. Placed at 00:01:12:04\n\nSee [your library](https://nolgia.ai/library) or https://nolgia.ai/agent. Not http://x.test or [this](javascript:alert(1))."
  );
  assert.deepEqual(blocks[0], { type: "p", parts: [{ text: "Done", bold: true }] });
  assert.deepEqual(blocks[1].parts, [{ text: "I put " }, { text: "NOLGIA clip 3", bold: true }, { text: " at the end of Sequence 01." }]);
  assert.deepEqual(blocks[2], { type: "li", parts: [{ text: "Imported" }] });
  const links = blocks[4].parts.filter((p) => p.href);
  assert.deepEqual(links, [
    { text: "your library", href: "https://nolgia.ai/library" },
    { text: "https://nolgia.ai/agent", href: "https://nolgia.ai/agent" },
  ]);
});

test("a chat's name on nolgia.ai says which app it came from", () => {
  assert.equal(sessionName("Put my newest NOLGIA clip at the end of my timeline", "Premiere Pro"), "Premiere Pro: Put my newest NOLGIA clip at");
  assert.equal(sessionName("   ", "Illustrator"), "Illustrator: New chat");
  assert.ok(sessionName("x".repeat(200), "After Effects").length <= 80);
});

test("times sort to the microsecond, whatever their fraction", () => {
  const order = ["2026-10-29T00:15:01Z", "2026-10-29T00:15:01.000001Z", "2026-10-29T00:15:01.5Z", "2026-10-29T00:15:02Z"];
  assert.deepEqual(order.slice().sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : 1)), order);
});

test("the first message starts a chat pinned to this app and instance; the reply comes back", async () => {
  const o = owner();
  const chat = newChat(o);
  await chat.start();
  assert.equal(chat.view().empty, true);
  assert.equal(await chat.send("Put my newest NOLGIA clip at the end of my timeline."), true);
  assert.equal(chat.view().busy, true);
  assert.match(chat.view().working, /What it does in Premiere Pro shows in Activity/);
  let st = await support.state(server);
  assert.deepEqual(st.agent_creates, [{ name: "Premiere Pro: Put my newest NOLGIA clip at", app: { app: "premiere", instance_id: "unit-instance" } }]);
  assert.deepEqual(st.agent_submits[0], { content: "Put my newest NOLGIA clip at the end of my timeline.", session_id: st.agent_sessions[0].id });
  assert.deepEqual(o.store["unit-instance"], { id: st.agent_sessions[0].id, api: normalizeBaseUrl(server.base), email: "test@nolgia.ai" });
  await reply({ content: "I put **NOLGIA clip 3** at the end of Sequence 01." });
  await settled(chat);
  const view = chat.view();
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[1].status, "complete");
  assert.equal(view.rows[1].credits, 10);
  assert.equal(view.sessionUrl, AGENT_URL + "/" + st.agent_sessions[0].id);

  // The next message goes to the same chat, as a plain turn (no steering).
  assert.equal(await chat.send("Now add a 12 frame cross dissolve before it."), true);
  st = await support.state(server);
  assert.equal(st.agent_creates.length, 1);
  assert.deepEqual(st.agent_submits[1], { content: "Now add a 12 frame cross dissolve before it.", session_id: st.agent_sessions[0].id });
  await reply({ content: "Added." });
  await settled(chat);
  assert.equal(chat.view().rows.length, 4);
});

test("an API without the app pin: the panel never chats unpinned", async () => {
  await mockAgent({ app_pin: false });
  const o = owner();
  const chat = newChat(o);
  assert.equal(await chat.send("hello"), false);
  const st = await support.state(server);
  assert.equal(st.agent_creates.length, 1, "no second try without the pin");
  assert.equal(st.agent_submits.length, 0);
  assert.equal(chat.sessionId, null);
  assert.deepEqual(o.store, {});
  assert.match(chat.notice.text, /unknown field/);
});

test("not connected: no instance id, no chat is started", async () => {
  const chat = newChat(owner({ instanceId: null }));
  assert.equal(await chat.send("hello"), false);
  assert.match(chat.notice.text, /not connected to NOLGIA yet/);
  assert.equal((await support.state(server)).agent_creates.length, 0);
});

test("one message is one turn: the box waits while the Agent works, and follows a turn started on nolgia.ai", async () => {
  const chat = newChat(owner());
  await chat.send("first");
  assert.equal(chat.busy, true);
  assert.equal(await chat.send("and one more thing"), false, "held while the turn runs");
  assert.equal((await support.state(server)).agent_submits.length, 1);
  await reply({ content: "First done." });
  await settled(chat);

  const web = await support.call(server, "POST", "/v1/agent/messages", { content: "from the website", session_id: chat.sessionId });
  assert.equal(web.status, 202);
  assert.equal(await chat.send("from the panel"), false);
  assert.match(chat.notice.text, /still working on this chat/);
  assert.equal(chat.busy, true, "the panel follows the running turn");
  await reply({ content: "Website turn done." });
  await settled(chat);
  assert.deepEqual(chat.messages().map((r) => r.role + ":" + (r.content || "")), [
    "user:first",
    "agent:First done.",
    "user:from the website",
    "agent:Website turn done.",
  ]);
  assert.equal(await chat.send("now the panel"), true);
});

test("no NOLGIA Agent yet: the panel says how to start one", async () => {
  await mockAgent({ provisioned: false });
  const chat = newChat(owner());
  await chat.start();
  assert.equal(chat.agent, null);
  assert.equal(await chat.send("hi"), false);
  assert.equal(chat.notice.kind, "no_agent");
  assert.deepEqual(chat.notice.action, { label: "Open NOLGIA Agent", url: AGENT_URL });
  assert.equal((await support.state(server)).agent_creates.length, 0, "no empty chat is left on nolgia.ai");
  await mockAgent({ provisioned: true });
  assert.equal(await chat.send("hi again"), true);
});

test("out of credits, on the send or on the turn, offers Add credits once", async () => {
  await mockAgent({ submit_error: { status: 402, title: "Payment Required", detail: "not enough credits", code: "insufficient_credits" } });
  let chat = newChat(owner());
  assert.equal(await chat.send("hi"), false);
  assert.deepEqual(chat.notice.action, { label: "Add credits", url: BILLING_URL });
  chat.reset();

  await mockAgent({ submit_error: null });
  chat = newChat(owner());
  await chat.send("hi");
  await reply({ status: "failed", error: "The wallet cannot pay for the turn.", error_code: "insufficient_credits" });
  await settled(chat);
  const view = chat.view();
  assert.equal(view.rows.length, 1, "the failed reply is not drawn in the thread as well");
  assert.deepEqual(view.notice, {
    kind: "credits",
    text: failureText({ status: "failed", error_code: "insufficient_credits" }),
    action: { label: "Add credits", url: BILLING_URL },
  });
});

test("each copy of the app keeps its own chat; a chat deleted on nolgia.ai or pinned elsewhere is not used", async () => {
  const store = {};
  let chat = newChat(owner({ store }));
  await chat.send("remember me");
  await reply({ content: "Got it." });
  await settled(chat);
  const id = chat.sessionId;
  chat.reset({ forget: false });

  chat = newChat(owner({ store }));
  await chat.start();
  assert.equal(chat.sessionId, id);
  assert.deepEqual(chat.messages().map((r) => r.content), ["remember me", "Got it."]);
  chat.reset({ forget: false });

  // A second copy of the app (another instance slot) starts its own chat.
  chat = newChat(owner({ store, instanceId: "unit-instance-2" }));
  await chat.start();
  assert.equal(chat.sessionId, null);
  chat.reset({ forget: false });

  // A remembered chat pinned to another instance is forgotten, never used.
  store["unit-instance-3"] = store["unit-instance"];
  chat = newChat(owner({ store, instanceId: "unit-instance-3" }));
  await chat.start();
  assert.equal(chat.sessionId, null);
  assert.equal(store["unit-instance-3"], undefined);
  chat.reset({ forget: false });

  store["unit-instance"] = { id: "00000000-0000-4000-8000-000000000000", api: normalizeBaseUrl(server.base), email: "test@nolgia.ai" };
  chat = newChat(owner({ store }));
  await chat.start();
  assert.equal(chat.sessionId, null, "a chat deleted on nolgia.ai is forgotten");
  assert.equal(store["unit-instance"], undefined);
});

test("Stop ends the running turn; only the newest reply's question takes answers", async () => {
  let chat = newChat(owner());
  await chat.send("cut something long");
  await support.until(() => chat.view().canStop, 10, "Stop");
  await chat.stop();
  await settled(chat);
  assert.equal(chat.view().rows[1].failure, "Stopped.");
  chat.reset();

  chat = newChat(owner());
  await chat.send("make a title");
  await reply({ content: "In After Effects or as a new image?", question: { text: "Which?", options: [{ label: "In After Effects" }, { label: "A new image on NOLGIA" }] } });
  await settled(chat);
  assert.deepEqual(chat.view().rows[1].question.options.map((o) => o.label), ["In After Effects", "A new image on NOLGIA"]);
  await chat.send("In After Effects");
  await reply({ content: "On it." });
  await settled(chat);
  assert.equal(chat.view().rows[1].question, null);
});

test("the cost line puts NOLGIA Agent first, with this account's own turn rate", async () => {
  let chat = newChat(owner());
  await chat.start();
  assert.equal(chat.view().costLine, "NOLGIA Agent works right here, each turn from 10 credits on your model. You can also use Claude Code, Cursor, Codex or another agent with NOLGIA connected.");
  await mockAgent({ model: "claude-opus-5-5" });
  chat = newChat(owner());
  await chat.start();
  assert.match(chat.view().costLine, /^NOLGIA Agent works right here, each turn from 70 credits on your model\./);
  chat.newChat();
  assert.match(chat.view().costLine, /from 70 credits on your model/);
  await mockAgent({ models_error: true });
  chat = newChat(owner());
  await chat.start();
  assert.equal(chat.view().costLine, COST_LINE);
  assert.equal(turnRate({ model: "retired-brain" }, [{ model: "claude-opus-5-5", turn_credits: 70, default: false }]), null);
  for (const line of [COST_LINE, chat.view().costLine]) {
    assert.doesNotMatch(line, /free/i);
    assert.doesNotMatch(line, /[–—]/);
  }
});

test("a refused sign in goes back to the controller; a long message stays in the box", async () => {
  const o = owner({ token: "not-a-token" });
  const chat = newChat(o);
  assert.equal(await chat.send("hi"), false);
  assert.deepEqual(o.authFailures, ["Your NOLGIA sign in expired. Sign in again."]);
  const ok = newChat(owner());
  assert.equal(await ok.send("x".repeat(MAX_CHARS + 1)), false);
  assert.match(ok.notice.text, /too long/);
});

// ------------------------------------------------------- through the controller

function fakeHost(hostId = "PPRO") {
  const root = support.tempDir();
  const host = {
    hostId,
    userData: path.join(root, "userData"),
    documents: path.join(root, "Documents"),
    states: [],
    opened: [],
    async call(kind) {
      if (kind === "snapshot") return { ok: true, result: { document: { name: "Cut.prproj" }, dirty: false, app_version: "26.2" } };
      return { ok: false, error: "no handler for " + kind };
    },
    async convertImage() {
      return { width: 1, height: 1 };
    },
    openURL(url) {
      this.opened.push(url);
    },
    openPanel() {},
    broadcast(state) {
      this.states.push(state);
    },
    log() {},
  };
  fs.mkdirSync(host.documents, { recursive: true });
  return host;
}

test("the panel's chat goes through the controller: blockers, a send, the box cleared, sign out forgets", async () => {
  const host = fakeHost();
  const ctl = new Controller(host, {
    environ: { NOLGIA_TOKEN: support.TOKEN, NOLGIA_API_URL: server.base, NOLGIA_INSTANCE_ID: "ppro-unit" },
  });
  ctl.start();
  try {
    let st = ctl.state();
    assert.equal(st.chat_blocker.kind, "connect");
    assert.match(st.chat_blocker.text, /this Premiere Pro/);
    ctl.action({ action: "chat_fix" });
    await support.until(() => ctl.worker && ctl.worker.state === "connected", 10, "connected");
    assert.equal(ctl.state().chat_blocker, null);
    ctl.action({ action: "set", name: "allow_agent", value: false });
    assert.equal(ctl.state().chat_blocker.kind, "allow_agent");
    ctl.action({ action: "chat_fix" });
    assert.equal(ctl.settings.get("allow_agent"), true);

    ctl.action({ action: "chat_send", text: "Put my newest NOLGIA clip at the end of my timeline.", seq: 7 });
    await support.until(() => ctl.state().chat_accepted === 7, 10, "accepted");
    st = await support.state(server);
    assert.deepEqual(st.agent_creates[0].app, { app: "premiere", instance_id: "ppro-unit" });
    assert.equal(ctl.state().chat.busy, true);
    // The panel hears it: the last broadcast carries the chat.
    await support.until(() => {
      const last = host.states[host.states.length - 1];
      return last && last.chat && last.chat.rows.length === 2;
    }, 10, "broadcast");
    // Held while the turn runs.
    ctl.action({ action: "chat_send", text: "and more", seq: 8 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await support.state(server)).agent_submits.length, 1);
    await reply({ content: "Done: NOLGIA clip 3 is at the end of Sequence 01." });
    await support.until(() => !ctl.state().chat.busy, 15, "settled");
    assert.ok(fs.existsSync(path.join(ctl.dir, "chat.json")));
  } finally {
    const worker = ctl.worker;
    ctl.disconnect();
    if (worker) await worker.finished.wait(10);
    ctl.signOut();
  }
  assert.equal(fs.existsSync(path.join(ctl.dir, "chat.json")), false, "signing out forgets the chats on this computer");
  assert.equal(ctl.state().chat, null);
});
