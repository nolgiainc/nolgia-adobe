// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The NOLGIA panel (Window > Extensions > NOLGIA). It only shows what the
// invisible NOLGIA service reports and sends it the buttons you press; the
// connection, and a chat turn NOLGIA Agent is working on, keep running when
// the panel is closed.

/* global window, document */
"use strict";

(function () {
  const CEP = window.NolgiaCEP;
  const top = document.getElementById("top");
  const main = document.getElementById("main");
  const statusText = document.getElementById("status");
  const dot = document.getElementById("dot");
  const appLabel = document.getElementById("app");
  let state = null;
  const expanded = new Set();

  function send(action, extra) {
    CEP.dispatch(CEP.ACTION_EVENT, Object.assign({ action }, extra || {}));
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  function button(label, onclick, cls) {
    return el("button", { class: "button " + (cls || ""), text: label, onclick });
  }

  function toggle(label, hint, on, name) {
    return el("div", { class: "switch", role: "switch", "aria-checked": String(on), onclick: () => send("set", { name, value: !on }) }, [
      el("span", { class: "text" }, [el("span", { text: label }), hint ? el("span", { class: "hint", text: hint }) : null]),
      el("span", { class: "toggle" + (on ? " on" : "") }),
    ]);
  }

  function copy(text) {
    const area = el("textarea", {});
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      // the code is on screen anyway
    }
    area.remove();
  }

  function clock(seconds) {
    const d = new Date(seconds * 1000);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function dotClass(s) {
    if (s.approvals.length) return "busy";
    if (s.state === "connected") return "connected";
    if (s.state === "connecting" || s.state === "retrying" || s.login) return "busy";
    if (s.state === "signed_out" && s.signed_in === false && s.status.indexOf("did not accept") >= 0) return "problem";
    return "";
  }

  function render() {
    const s = state;
    if (!s) return;
    appLabel.textContent = s.app_name;
    statusText.textContent = s.status;
    dot.className = "dot " + dotClass(s);
    // The panel redraws on every change: keep where the person scrolled
    // Activity to (the page keeps its own place).
    const oldList = main.querySelector(".activity");
    const listTop = oldList ? oldList.scrollTop : 0;
    top.textContent = "";
    main.textContent = "";

    for (const pending of s.approvals) {
      const full = expanded.has(pending.id);
      const lines = full ? pending.lines : pending.lines.slice(0, 12);
      const card = el("div", { class: "card approval" }, [
        el("div", { class: "title", text: pending.title }),
        el("pre", { class: full ? "full" : "", text: lines.join("\n") }),
        pending.lines.length > 12 && !full
          ? el("div", {
              class: "more",
              text: "Show all " + pending.lines.length + " lines",
              onclick: () => {
                expanded.add(pending.id);
                render();
              },
            })
          : null,
        el("div", { class: "note", text: "Code runs in " + s.app_name + " on this computer, with your permissions." }),
        el("div", { class: "row" }, [
          button(pending.approve_label, () => send("approve", { id: pending.id }), "primary"),
          button("Deny", () => send("deny", { id: pending.id })),
        ]),
      ]);
      top.appendChild(card);
    }

    if (s.login) {
      top.appendChild(
        el("div", { class: "card" }, [
          el("div", { class: "label", text: "Your code" }),
          el("div", { class: "code", text: s.login.user_code || "..." }),
          el("div", { class: "label", text: "Approve it in the browser page that opened. Check that the code matches." }),
          el("div", { class: "row", style: "margin-top:10px" }, [
            button("Open page again", () => send("open_sign_in_page")),
            button("Copy code", () => copy(s.login.user_code)),
          ]),
          el("div", { style: "margin-top:8px" }, [button("Cancel", () => send("cancel_sign_in"), "wide quiet")]),
        ])
      );
    } else if (!s.signed_in) {
      top.appendChild(el("div", { style: "margin-bottom:12px" }, [button("Sign in", () => send("sign_in"), "primary wide")]));
      top.appendChild(
        el("div", {
          class: "message",
          text: "Sign in to tell NOLGIA Agent what to do in this " + s.app_name + ". Your browser opens a NOLGIA page to approve it.",
        })
      );
    } else {
      const who = s.email ? s.email : s.env_token ? "a NOLGIA_TOKEN" : "your NOLGIA account";
      main.appendChild(el("div", { class: "account" }, [document.createTextNode("Signed in as "), el("strong", { text: who })]));
      main.appendChild(
        el("div", { class: "card", style: "padding:4px 12px" }, [
          toggle("Connected", "NOLGIA can send commands only while this is on.", s.connected, "connected"),
          toggle("Allow NOLGIA Agent", "Let your NOLGIA Agent in the cloud work here too.", s.allow_agent, "allow_agent"),
          toggle("Ask before running code", "Show each script and wait for your OK.", s.ask_before_run, "ask_before_run"),
        ])
      );
      if (s.transcripts) {
        const t = s.transcripts;
        const line = t.connected
          ? t.can && t.can.make
            ? "Transcripts: Premiere's Speech to Text, made and read here."
            : "Transcripts: reads the transcripts Premiere has."
          : "Transcripts: NOLGIA Transcripts is not running in Premiere.";
        main.appendChild(el("div", { class: "account", text: line }));
        const busy = t.install && t.install.status === "running";
        if (!t.connected) {
          main.appendChild(
            el("div", { style: "margin-bottom:8px" }, [
              button(busy ? "Installing..." : "Install transcripts", () => send("install_transcripts"), "small"),
            ])
          );
        }
        if (t.install && t.install.message) main.appendChild(el("div", { class: "message", text: t.install.message }));
      }
    }

    const head = el("div", { class: "activity-head" }, [el("span", { class: "heading", text: "Activity" })]);
    if (s.signed_in) {
      head.appendChild(button(s.connected ? "Pause" : "Resume", () => send("pause"), "small"));
    }
    main.appendChild(head);
    const list = el("ul", { class: "activity" });
    if (!s.activity.length) list.appendChild(el("li", { class: "empty", text: "Nothing yet." }));
    for (const item of s.activity) {
      const who = item.caller === "agent" ? "Agent" : "";
      list.appendChild(
        el("li", { title: item.detail || "" }, [
          el("span", { class: "time", text: clock(item.time) }),
          el("span", { class: "kind" }, [document.createTextNode(item.kind), who ? el("small", { text: who }) : null]),
          el("span", { class: "state " + item.status }, [el("i", {}), document.createTextNode(item.label)]),
        ])
      );
    }
    main.appendChild(list);
    list.scrollTop = listTop;

    const foot = el("div", { class: "foot" }, [el("span", { text: "NOLGIA for " + s.app_name + " " + s.plugin_version })]);
    if (s.signed_in) foot.appendChild(button("Sign out", () => send("sign_out"), "small quiet"));
    main.appendChild(foot);

    renderChat(s);
  }

  // ------------------------------------------------------------------ chat

  // What the chat suggests before the first message: things this plugin and
  // NOLGIA's workflows for the app do. A click puts one in the box.
  const EXAMPLES = {
    premiere: [
      "Put my newest NOLGIA clip at the end of my timeline.",
      "Sort the clips in my project into bins by camera and scene.",
      "Install the Kodak Portra 400 look so I can pick it in Lumetri Color.",
    ],
    after_effects: [
      "Add my newest NOLGIA image to this comp as a layer.",
      "Make a new 1080p comp, 10 seconds long, with a centered title that says Coming Soon.",
      "Export a still of the current frame to my NOLGIA library.",
    ],
    illustrator: [
      "Vectorize my newest NOLGIA image into clean paths on a new artboard.",
      "Make an abstract poster on a new artboard with shapes in my swatch colors.",
      "Export this artboard as a PNG to my NOLGIA library.",
    ],
  };

  const chatCard = document.getElementById("chat");
  const input = document.getElementById("chat-input");
  const thread = document.getElementById("chat-thread");
  const $ = (id) => document.getElementById(id);
  const showIf = (node, on) => node.classList.toggle("hidden", !on);
  let sendSeq = 0;
  let sentText = null; // {seq, text}: cleared from the box once NOLGIA takes it
  let shownThread = null;
  let shownExamples = null;
  // The thread follows new rows unless the person scrolled it themselves:
  // `threadAuto` is where the panel last put it, `followNext` asks to follow
  // after the person sends (as in NOLGIA for Photoshop).
  let threadAuto = null;
  let followNext = false;

  function openLink(url) {
    if (/^https:\/\//.test(String(url || ""))) CEP.openURL(url);
  }

  function chatState() {
    return (state && state.chat) || null;
  }

  function sendFromBox() {
    const view = chatState();
    if (!view || state.chat_blocker || view.busy) return;
    const text = String(input.value || "");
    if (!text.trim()) return;
    sendSeq += 1;
    sentText = { seq: sendSeq, text };
    followNext = true;
    send("chat_send", { text, seq: sendSeq });
  }

  $("chat-send").addEventListener("click", sendFromBox);
  $("chat-stop").addEventListener("click", () => send("chat_stop"));
  $("chat-new").addEventListener("click", () => send("chat_new"));
  $("chat-fix").addEventListener("click", () => send("chat_fix"));
  $("chat-open-web").addEventListener("click", () => {
    const view = chatState();
    if (view && view.sessionUrl) openLink(view.sessionUrl);
  });
  $("chat-notice-action").addEventListener("click", () => {
    const view = chatState();
    if (view && view.notice && view.notice.action) openLink(view.notice.action.url);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendFromBox();
    }
  });
  input.addEventListener("focus", () => send("chat_wake"));

  function renderExamples(app) {
    if (shownExamples === app) return;
    shownExamples = app;
    const box = $("chat-examples");
    box.textContent = "";
    for (const text of EXAMPLES[app] || []) {
      box.appendChild(
        el("div", {
          class: "example",
          text,
          onclick: () => {
            input.value = text;
            input.focus();
          },
        })
      );
    }
  }

  // One piece of a reply: text, bold text or a link.
  function part(p) {
    const node = el("span", { text: p.text });
    if (p.bold) node.className = "bold";
    if (p.href) {
      node.className = "href";
      node.title = p.href;
      node.addEventListener("click", () => openLink(p.href));
    }
    return node;
  }

  function messageNode(row, view) {
    const box = el("div", { class: "msg " + (row.role === "user" ? "user" : "agent") });
    box.appendChild(el("div", { class: "who", text: row.role === "user" ? (row.background ? "Background work finished" : "You") : "NOLGIA Agent" }));
    if (row.role === "user") {
      box.appendChild(el("div", { class: "text", text: row.text }));
      return box;
    }
    if (row.status === "pending") {
      box.appendChild(el("div", { class: "text muted", text: row.queued ? "Waiting for its turn..." : "Working..." }));
      return box;
    }
    for (const block of row.blocks || []) {
      const node = el("div", { class: block.type === "li" ? "li" : "para" });
      if (block.type === "li") node.appendChild(part({ text: "\u2022 " }));
      for (const p of block.parts) node.appendChild(part(p));
      box.appendChild(node);
    }
    if (row.failure) box.appendChild(el("div", { class: "para failure", text: row.failure }));
    if (row.question && row.question.options.length) {
      const options = el("div", { class: "options" });
      for (const option of row.question.options) {
        options.appendChild(
          button(
            option.label,
            () => {
              if (!state.chat_blocker && !(chatState() || {}).busy) {
                followNext = true;
                send("chat_send", { text: option.label });
              }
            },
            "small"
          )
        );
      }
      box.appendChild(options);
    }
    if (row.credits !== null && row.status === "complete") box.appendChild(el("div", { class: "meta", text: row.credits + " credits" }));
    return box;
  }

  // A finished reply is read from its start, anything else from the end; a
  // person who scrolled the thread up stays where they are until they send.
  function renderThread(view) {
    const signature = JSON.stringify([view.hidden, view.rows]);
    if (signature === shownThread) return;
    const before = thread.scrollTop;
    const atEnd = before + thread.clientHeight >= thread.scrollHeight - 24;
    const personScrolled = threadAuto !== null && Math.abs(before - threadAuto) > 4 && !atEnd;
    const follow = followNext || !personScrolled;
    followNext = false;
    thread.textContent = "";
    if (view.hidden) thread.appendChild(el("div", { class: "label", text: "Earlier messages are on nolgia.ai." }));
    for (const row of view.rows) thread.appendChild(messageNode(row, view));
    shownThread = signature;
    if (!follow) {
      thread.scrollTop = before;
      return;
    }
    const newest = view.rows[view.rows.length - 1];
    const fromStart = Boolean(newest && newest.role === "agent" && newest.status !== "pending");
    if (fromStart && thread.lastChild) {
      thread.scrollTop += thread.lastChild.getBoundingClientRect().top - thread.getBoundingClientRect().top - 6;
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
    threadAuto = thread.scrollTop;
  }

  function renderChat(s) {
    const view = s.chat;
    showIf(chatCard, Boolean(s.signed_in && !s.login && view));
    if (!view || !s.signed_in || s.login) return;
    const blocker = s.chat_blocker;
    $("chat-lead").textContent = "Tell NOLGIA Agent what to do in this " + s.app_name + ". It works right here.";
    renderExamples(s.app);
    input.placeholder = "Ask NOLGIA Agent to make or change something in " + s.app_name;
    showIf($("chat-intro"), view.empty && (view.loaded || Boolean(blocker)));
    showIf($("chat-new"), !view.empty);
    renderThread(view);
    showIf(thread, view.rows.length > 0);

    showIf($("chat-working"), Boolean(view.working));
    $("chat-working").textContent = view.working || "";

    const notice = view.notice;
    showIf($("chat-notice"), Boolean(notice));
    $("chat-notice-text").textContent = notice ? notice.text : "";
    showIf($("chat-notice-action"), Boolean(notice && notice.action));
    $("chat-notice-action").textContent = notice && notice.action ? notice.action.label : "";

    showIf($("chat-blocker"), Boolean(blocker));
    $("chat-blocker-text").textContent = blocker ? blocker.text : "";
    $("chat-fix").textContent = blocker ? blocker.label : "";

    // One message is one turn: the box waits while the Agent works.
    const canSend = !blocker && !view.busy;
    $("chat-send").disabled = !canSend;
    $("chat-send").textContent = view.working === "Sending..." ? "Sending..." : "Send";
    showIf($("chat-stop"), view.canStop);
    showIf($("chat-open-web"), Boolean(view.sessionUrl));
    $("chat-cost").textContent = view.costLine;

    if (sentText && s.chat_accepted >= sentText.seq) {
      if (input.value === sentText.text) input.value = "";
      sentText = null;
    }
  }

  CEP.listen(CEP.STATE_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    state = data;
    render();
  });

  // Ask the service for the state until it answers (it may still be starting).
  let tries = 0;
  const hello = () => {
    if (state || tries++ > 40) return;
    send("hello");
    setTimeout(hello, 500);
  };
  hello();
})();
