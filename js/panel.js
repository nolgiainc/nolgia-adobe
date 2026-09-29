// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The NOLGIA panel (Window > Extensions > NOLGIA). It only shows what the
// invisible NOLGIA service reports and sends it the buttons you press; the
// connection keeps running when the panel is closed.

/* global window, document */
"use strict";

(function () {
  const CEP = window.NolgiaCEP;
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
      main.appendChild(card);
    }

    if (s.login) {
      main.appendChild(
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
      main.appendChild(el("div", { style: "margin-bottom:12px" }, [button("Sign in", () => send("sign_in"), "primary wide")]));
      main.appendChild(
        el("div", {
          class: "message",
          text: "Sign in to let your agent work in this " + s.app_name + " through NOLGIA. Your browser opens a NOLGIA page to approve it.",
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

    const foot = el("div", { class: "foot" }, [el("span", { text: "NOLGIA for " + s.app_name + " " + s.plugin_version })]);
    if (s.signed_in) foot.appendChild(button("Sign out", () => send("sign_out"), "small quiet"));
    main.appendChild(foot);
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
