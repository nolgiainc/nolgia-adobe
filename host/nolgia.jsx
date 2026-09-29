// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// The ExtendScript side of NOLGIA for Adobe, shared by every app.
//
// The panel calls __nolgia.call(kind, args) through CSInterface.evalScript;
// every call answers a JSON string {"ok": true, "result": ...} or
// {"ok": false, "error": "...", "result"?: ...}, ASCII only. The app side of
// each command lives in the app's own file (aeft.jsx, ppro.jsx, ilst.jsx),
// which fills in __nolgia.adapter. This layer knows nothing about CEP, so a
// later UXP port can keep the app files and replace only the transport.
//
// ExtendScript is ES3: no JSON, no Array.prototype.indexOf, no trailing
// commas, no let or const.

$.global.__nolgia = (function () {
  var N = {};
  N.version = "0.1.0";
  N.adapter = null;
  N.MAX_ITEMS = 10000;
  N.MAX_DEPTH = 32;
  N.MAX_STREAM = 256 * 1024;

  // ------------------------------------------------------------------ JSON

  function hex4(code) {
    var h = code.toString(16);
    while (h.length < 4) h = "0" + h;
    return "\\u" + h;
  }

  N.quote = function (text) {
    text = String(text);
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var code = text.charCodeAt(i);
      if (ch === '"') out.push('\\"');
      else if (ch === "\\") out.push("\\\\");
      else if (ch === "\n") out.push("\\n");
      else if (ch === "\r") out.push("\\r");
      else if (ch === "\t") out.push("\\t");
      else if (code < 32 || code > 126) out.push(hex4(code));
      else out.push(ch);
    }
    return '"' + out.join("") + '"';
  };

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function isoDate(d) {
    return (
      d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + "T" +
      pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + "Z"
    );
  }

  function className(value) {
    try {
      return value.reflect.name;
    } catch (e) {
      return "";
    }
  }

  function isPlainObject(value) {
    try {
      if (value.constructor === Object) return true;
    } catch (e) {}
    return className(value) === "Object";
  }

  // Any value as JSON text. App objects (layers, items, paths) become their
  // name when they have one, files their full path, anything else its text.
  N.stringify = function (value, depth) {
    depth = depth || 0;
    if (depth > N.MAX_DEPTH) return N.quote("[nested too deep]");
    if (value === null || value === undefined) return "null";
    var type = typeof value;
    if (type === "boolean") return value ? "true" : "false";
    if (type === "number") return isFinite(value) ? String(value) : N.quote(String(value));
    if (type === "string") return N.quote(value);
    if (type === "function") return "null";
    if (value instanceof Date) return N.quote(isoDate(value));
    if (value instanceof File || value instanceof Folder) return N.quote(value.fsName);
    var i, parts = [];
    if (value instanceof Array) {
      for (i = 0; i < value.length && i < N.MAX_ITEMS; i++) parts.push(N.stringify(value[i], depth + 1));
      return "[" + parts.join(",") + "]";
    }
    if (isPlainObject(value)) {
      for (var key in value) {
        if (!value.hasOwnProperty(key)) continue;
        var item = value[key];
        if (typeof item === "function" || item === undefined) continue;
        parts.push(N.quote(key) + ":" + N.stringify(item, depth + 1));
      }
      return "{" + parts.join(",") + "}";
    }
    // An app object: its name when it has one.
    try {
      if (typeof value.name === "string" && value.name !== "") return N.quote(value.name);
    } catch (e) {}
    try {
      return N.quote(String(value));
    } catch (e2) {
      return N.quote("[" + (className(value) || "object") + "]");
    }
  };

  // ------------------------------------------------------------- failures

  // A failure written for the person and the agent (not a bug).
  N.fail = function (message, result) {
    throw { nolgiaFail: true, message: message, result: result };
  };

  N.describeError = function (e, source, lineOffset) {
    if (e && e.nolgiaFail) return e.message;
    var name = (e && e.name) || "Error";
    var message = e && e.message !== undefined ? e.message : String(e);
    var line = e && typeof e.line === "number" ? e.line - (lineOffset || 0) : null;
    var text = name + ": " + message;
    if (source !== undefined && source !== null && line !== null && line >= 1) {
      var lines = String(source).split(/\r\n|\r|\n/);
      text = name + " on line " + line + ": " + message;
      var first = Math.max(1, line - 2);
      var last = Math.min(lines.length, line + 1);
      for (var i = first; i <= last; i++) {
        text += "\n" + (i === line ? "> " : "  ") + i + " | " + lines[i - 1];
      }
    } else if (e && e.fileName) {
      text += " (" + File(e.fileName).name + (line !== null ? " line " + line : "") + ")";
    }
    if (e && e.number) text += "\n[ExtendScript error " + e.number + "]";
    return text;
  };

  // -------------------------------------------------------------- helpers

  N.contains = function (list, value) {
    for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
    return false;
  };

  N.file = function (path) {
    return new File(String(path).replace(/\\/g, "/"));
  };

  N.folderOf = function (path) {
    var f = N.file(path).parent;
    if (f && !f.exists) f.create();
    return f;
  };

  N.round = function (value, places) {
    var m = Math.pow(10, places === undefined ? 3 : places);
    return Math.round(value * m) / m;
  };

  N.hex = function (rgb) {
    if (!rgb || rgb.length < 3) return null;
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var h = Math.max(0, Math.min(255, Math.round(rgb[i] * 255))).toString(16);
      out += (h.length < 2 ? "0" : "") + h;
    }
    return out;
  };

  // ------------------------------------------------------------------ run

  function argsText(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      parts.push(typeof args[i] === "string" ? args[i] : N.stringify(args[i]));
    }
    return parts.join(" ");
  }

  function Stream() {
    this.parts = [];
    this.size = 0;
    this.dropped = 0;
  }
  Stream.prototype.write = function (text) {
    text = String(text);
    var room = N.MAX_STREAM - this.size;
    if (room > 0) {
      var piece = text.substr(0, room);
      this.parts.push(piece);
      this.size += piece.length;
    }
    this.dropped += Math.max(0, text.length - Math.max(room, 0));
  };
  Stream.prototype.text = function () {
    var text = this.parts.join("");
    if (this.dropped) text += "\n[" + this.dropped + " more characters cut]";
    return text;
  };

  // Run the agent's code. It sees print(), log() and console.log/info/warn/
  // error (warn and error go to stderr), and alert() writes to stderr
  // instead of opening a dialog. `value` is what the code puts in `result`,
  // else the value of its last statement (or what it returns, when it uses
  // return at the top level).
  N.run = function (code) {
    var out = new Stream();
    var err = new Stream();
    var print = function () {
      out.write(argsText(arguments) + "\n");
    };
    var warn = function () {
      err.write(argsText(arguments) + "\n");
    };
    var sandbox = {
      print: print,
      console: { log: print, info: print, debug: print, warn: warn, error: warn },
      alert: function (message) {
        err.write("alert: " + message + "\n");
      }
    };
    var hooks = hookWriteln(out);
    var outcome = null;
    var lineOffset = 0;
    try {
      if (N.adapter && N.adapter.beginUndo) N.adapter.beginUndo("NOLGIA: run code");
      try {
        outcome = $.global.__nolgia_exec(code, sandbox);
      } catch (e) {
        // A top-level return is a syntax error in a program; run the code as
        // a function body instead. Nothing ran yet: the parse failed first.
        if (e instanceof SyntaxError && /return/i.test(String(e.message))) {
          lineOffset = 1;
          outcome = $.global.__nolgia_exec("(function(){\n" + code + "\n}).call(this)", sandbox);
        } else {
          throw e;
        }
      }
    } catch (e3) {
      unhook(hooks);
      if (N.adapter && N.adapter.endUndo) N.adapter.endUndo();
      return {
        ok: false,
        error: N.describeError(e3, code, lineOffset),
        result: { value: null, stdout: out.text(), stderr: err.text() }
      };
    }
    unhook(hooks);
    if (N.adapter && N.adapter.endUndo) N.adapter.endUndo();
    var value = outcome.result !== undefined ? outcome.result : outcome.last;
    return { ok: true, result: { value: new RawJSON(N.stringify(value)), stdout: out.text(), stderr: err.text() } };
  };

  // $.writeln and $.write go to the output too, while the code runs.
  function hookWriteln(stream) {
    var saved = { writeln: null, write: null };
    try {
      saved.writeln = $.writeln;
      saved.write = $.write;
      $.writeln = function () {
        stream.write(argsText(arguments) + "\n");
      };
      $.write = function () {
        stream.write(argsText(arguments));
      };
    } catch (e) {
      saved.failed = true;
    }
    return saved;
  }

  function unhook(saved) {
    if (saved.failed) return;
    try {
      if (saved.writeln) $.writeln = saved.writeln;
      if (saved.write) $.write = saved.write;
    } catch (e) {}
  }

  // Already JSON text: written as is by encode().
  function RawJSON(text) {
    this.text = text;
  }

  function encode(value, depth) {
    depth = depth || 0;
    if (value instanceof RawJSON) return value.text;
    if (value !== null && typeof value === "object" && !(value instanceof Array) && isPlainObject(value)) {
      var parts = [];
      for (var key in value) {
        if (!value.hasOwnProperty(key) || value[key] === undefined) continue;
        parts.push(N.quote(key) + ":" + encode(value[key], depth + 1));
      }
      return "{" + parts.join(",") + "}";
    }
    if (value instanceof Array) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(encode(value[i], depth + 1));
      return "[" + items.join(",") + "]";
    }
    return N.stringify(value, depth);
  }
  N.encode = encode;

  // ----------------------------------------------------------------- call

  // The one entry point. Answers JSON text.
  N.call = function (kind, args) {
    var adapter = N.adapter;
    if (!adapter) return encode({ ok: false, error: "NOLGIA's app script did not load." });
    args = args || {};
    var outcome;
    var guard = null;
    try {
      if (adapter.quiet) guard = adapter.quiet();
      if (kind === "run") {
        outcome = N.run(args.code);
      } else {
        var fn = adapter[kind];
        if (typeof fn !== "function") {
          outcome = { ok: false, error: "This NOLGIA plugin cannot do " + kind + " in this app." };
        } else {
          outcome = { ok: true, result: fn(args) };
        }
      }
    } catch (e) {
      outcome = {
        ok: false,
        error: e && e.nolgiaFail ? e.message : "NOLGIA's app script hit a problem: " + N.describeError(e),
        result: e && e.nolgiaFail ? e.result : undefined
      };
    }
    if (guard && adapter.unquiet) {
      try {
        adapter.unquiet(guard);
      } catch (e2) {}
    }
    try {
      return encode(outcome);
    } catch (e3) {
      return encode({ ok: false, error: "NOLGIA could not read the result: " + N.describeError(e3) });
    }
  };

  return N;
})();

// Runs the agent's code with as few names in scope as possible: only
// `result`, print, log, console and alert. It is a top-level function so the
// code cannot see or change NOLGIA's own variables by accident.
$.global.__nolgia_exec = function (__nolgia_src, __nolgia_sandbox) {
  var print = __nolgia_sandbox.print;
  var log = __nolgia_sandbox.print;
  var console = __nolgia_sandbox.console;
  var alert = __nolgia_sandbox.alert;
  var result;
  var __nolgia_last = eval(__nolgia_src);
  return { result: result, last: __nolgia_last };
};
