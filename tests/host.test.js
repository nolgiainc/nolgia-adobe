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

// An adapter with undo groups, as After Effects has: every call is logged.
function withUndo(ctx) {
  vm.runInContext(
    "var undoLog = [];" +
      "__nolgia.adapter = {" +
      'beginUndo: function (name) { undoLog.push("begin " + name); },' +
      'endUndo: function () { undoLog.push("end"); },' +
      'openUndo: function (name) { undoLog.push("open " + name); },' +
      'closeUndo: function () { undoLog.push("close"); } };',
    ctx
  );
  return () => JSON.parse(vm.runInContext("JSON.stringify(undoLog.splice(0, undoLog.length))", ctx));
}

test("run closes the undo groups the code left open, so later steps are not folded into them", () => {
  const { call, ctx } = load();
  const log = withUndo(ctx);
  const failed = call("run", { code: 'app.beginUndoGroup("Key it");\nnull.foo;' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /TypeError/);
  assert.deepEqual(log(), ["begin NOLGIA: run code", "open Key it", "close", "end"]);
  assert.equal(failed.result.stderr, "[NOLGIA] The code left 1 undo group open; NOLGIA closed it.\n");
  // Balanced groups: nothing extra, nothing said.
  const ok = call("run", { code: 'app.beginUndoGroup("a");\napp.endUndoGroup();\n7' });
  assert.equal(ok.result.value, 7);
  assert.equal(ok.result.stderr, "");
  assert.deepEqual(log(), ["begin NOLGIA: run code", "open a", "close", "end"]);
  // An end the code did not begin cannot close NOLGIA's own group.
  call("run", { code: "app.endUndoGroup(); app.endUndoGroup(); 1" });
  assert.deepEqual(log(), ["begin NOLGIA: run code", "end"]);
  // Two left open, one of them in a top-level-return program.
  const two = call("run", { code: 'app.beginUndoGroup("x"); app.beginUndoGroup("y");\nif (true) { return 1; }' });
  assert.equal(two.ok, true);
  assert.deepEqual(log(), ["begin NOLGIA: run code", "open x", "open y", "close", "close", "end"]);
  assert.match(two.result.stderr, /left 2 undo groups open; NOLGIA closed them/);
});

test("only app.beginUndoGroup and app.endUndoGroup calls are counted, line by line", () => {
  const { N } = load();
  assert.equal(N.countUndoGroups("app.beginUndoGroup('a');"), "__nolgia_undo.begin('a');");
  assert.equal(N.countUndoGroups("x = 1;\n  app . endUndoGroup ();"), "x = 1;\n  __nolgia_undo.end();");
  assert.equal(N.countUndoGroups("$.global.app.beginUndoGroup('a')"), "$.global.app.beginUndoGroup('a')");
  assert.equal(N.countUndoGroups("myapp.beginUndoGroup('a')"), "myapp.beginUndoGroup('a')");
  const code = "a();\napp.beginUndoGroup('b');\nc();";
  assert.equal(N.countUndoGroups(code).split("\n").length, 3);
});

test("an app without undo groups runs the code as it is", () => {
  const { call } = load();
  // The test adapter has no openUndo (Premiere Pro and Illustrator have no undo groups).
  const res = call("run", { code: "var app = {beginUndoGroup: function () { return 'its own'; }};\napp.beginUndoGroup('z')" });
  assert.equal(res.result.value, "its own");
});

test("previews render at the lowest resolution that still covers the width asked", () => {
  const { N } = load();
  assert.equal(N.previewFactor(3840, 1280), 3);
  assert.equal(N.previewFactor(3840, null), 3, "1280 when no width is asked");
  assert.equal(N.previewFactor(3840, 768), 5);
  assert.equal(N.previewFactor(3840, 1920), 2);
  assert.equal(N.previewFactor(1920, 640), 3);
  assert.equal(N.previewFactor(1280, 1920), 1, "never above Full");
  assert.equal(N.previewFactor(64, 1280), 1);
  assert.equal(N.previewFactor(100000, 16), 8, "at most an eighth");
});

test("a Premiere Pro sequence through Dynamic Link is recognised by its .prproj", () => {
  const { N } = load();
  assert.equal(N.premiereLinked("Edit.prproj", ""), true);
  assert.equal(N.premiereLinked("", "Sequence 01/Edit.PRPROJ"), true);
  assert.equal(N.premiereLinked("clip.mov", "clip.mov"), false);
  assert.equal(N.premiereLinked(null, undefined), false);
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
    // After Effects 25.6 evaluates `true ? 4 : x ? y : 1` as 1: a conditional
    // inside a conditional needs parentheses.
    assert.doesNotMatch(code, /\?[^?:;,(){}]*:[^?;,(){}]*\?/, name + " nests a conditional without parentheses");
    assert.doesNotMatch(code, /\?[^?:;,(){}]*\?/, name + " nests a conditional without parentheses");
    new vm.Script(fs.readFileSync(path.join(HOST, name), "utf8"), { filename: name }); // parses at all
  }
});
