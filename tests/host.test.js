// SPDX-License-Identifier: GPL-3.0-or-later
// The shared ExtendScript layer (host/nolgia.jsx) run in Node's vm with the
// few ExtendScript globals it needs, and an ES3 check of every host file.
// The app adapters themselves are tested in the real apps by e2e_adobe.py.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HOST = path.join(__dirname, "..", "host");

function load() {
  const written = [];
  class File {
    constructor(p) {
      this.fsName = String(p).replace(/\//g, "\\");
      this.name = String(p).split(/[\\/]/).pop();
    }
  }
  class Folder extends File {}
  const ctx = { File, Folder, written };
  ctx.$ = { global: ctx, writeln: (t) => written.push(String(t)), write: (t) => written.push(String(t)) };
  vm.createContext(ctx);
  ctx.$.global = vm.runInContext("this", ctx);
  vm.runInContext(fs.readFileSync(path.join(HOST, "nolgia.jsx"), "utf8"), ctx, { filename: "nolgia.jsx" });
  const N = vm.runInContext("__nolgia", ctx);
  // An adapter made inside the engine, as the app files are.
  vm.runInContext(
    "__nolgia.adapter = {" +
      "echo: function (args) { return { got: args.x }; }," +
      'refuse: function () { __nolgia.fail("There is no composition named X."); },' +
      'crash: function () { throw new Error("bug"); } };',
    ctx
  );
  const call = (kind, args) => JSON.parse(N.call(kind, args || {}));
  return { N, ctx, call, written };
}

test("call answers ASCII JSON, with failures written for people", () => {
  const { call, N } = load();
  assert.deepEqual(call("echo", { x: "caf\u00e9" }), { ok: true, result: { got: "caf\u00e9" } });
  assert.match(N.call("echo", { x: "\u00e9\u2028" }), /^[\x20-\x7e]*$/);
  assert.deepEqual(call("refuse"), { ok: false, error: "There is no composition named X." });
  const crash = call("crash");
  assert.equal(crash.ok, false);
  assert.match(crash.error, /^NOLGIA's app script hit a problem: Error: bug/);
  assert.match(call("render").error, /cannot do render/);
});

test("stringify turns app values into plain JSON", () => {
  const { N, ctx } = load();
  const value = vm.runInContext(
    '({list: [1, "a", true, null], nan: 0/0, when: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), fn: function(){}, ' +
      'file: new File("C:/x/y.aep"), nested: {deep: [[{}]]}})',
    ctx
  );
  assert.deepEqual(JSON.parse(N.stringify(value)), {
    list: [1, "a", true, null],
    nan: "NaN",
    when: "2026-01-02T03:04:05Z",
    file: "C:\\x\\y.aep",
    nested: { deep: [[{}]] },
  });
  class Layer {
    constructor() {
      this.name = "Orange Solid";
    }
  }
  assert.equal(JSON.parse(N.stringify(new Layer())), "Orange Solid");
  assert.equal(N.stringify(undefined), "null");
});

test("run: result, the last expression, a top-level return, and output", () => {
  const { call, written } = load();
  assert.deepEqual(call("run", { code: "var a = 2; result = {a: a * 21};" }).result, {
    value: { a: 42 },
    stdout: "",
    stderr: "",
  });
  assert.equal(call("run", { code: "1 + 2" }).result.value, 3);
  assert.equal(call("run", { code: "if (true) { return 'early'; }\n'late'" }).result.value, "early");
  const out = call("run", {
    code: 'print("a", 1); log({b: 2}); console.log("c"); console.warn("w"); alert("hi"); $.writeln("d");',
  }).result;
  assert.equal(out.stdout, 'a 1\n{"b":2}\nc\nd\n');
  assert.equal(out.stderr, "w\nalert: hi\n");
  assert.deepEqual(written, [], "$.writeln is captured while code runs");
  load().N.run("1"); // a fresh engine is untouched
});

test("run: an error fails with the output so far", () => {
  const { call } = load();
  const res = call("run", { code: 'print("before");\nnull.foo;' });
  assert.equal(res.ok, false);
  assert.match(res.error, /TypeError/);
  assert.deepEqual(res.result, { value: null, stdout: "before\n", stderr: "" });
  const syntax = call("run", { code: "var = ;" });
  assert.equal(syntax.ok, false);
  assert.match(syntax.error, /SyntaxError/);
});

test("run cannot see NOLGIA's own variables", () => {
  const { call } = load();
  const res = call("run", { code: "[typeof out, typeof err, typeof outcome, typeof hooks, typeof code]" });
  assert.deepEqual(res.result.value, ["undefined", "undefined", "undefined", "undefined", "undefined"]);
});

// Words ES3 reserves. ExtendScript refuses them as names (V8 does not, so
// only a check like this catches them before a real app does).
const ES3_RESERVED = [
  "abstract", "boolean", "byte", "char", "class", "const", "debugger", "double", "enum", "export", "extends",
  "final", "float", "goto", "implements", "import", "int", "interface", "let", "long", "native", "package",
  "private", "protected", "public", "short", "static", "super", "synchronized", "throws", "transient",
  "volatile", "yield",
];

function stripStringsAndComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[gimy]*/g, "/r/");
}

test("host files are ES3: no reserved words, no modern syntax", () => {
  for (const name of fs.readdirSync(HOST).filter((f) => f.endsWith(".jsx"))) {
    const code = stripStringsAndComments(fs.readFileSync(path.join(HOST, name), "utf8"));
    for (const word of ES3_RESERVED) {
      assert.doesNotMatch(code, new RegExp("\\b" + word + "\\b"), name + " uses the reserved word " + word);
    }
    assert.doesNotMatch(code, /=>|`|\.\.\./, name + " uses syntax newer than ES3");
    assert.doesNotMatch(code, /,\s*[}\]]/, name + " has a trailing comma");
    new vm.Script(fs.readFileSync(path.join(HOST, name), "utf8"), { filename: name }); // parses at all
  }
});
