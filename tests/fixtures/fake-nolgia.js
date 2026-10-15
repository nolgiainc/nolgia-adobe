// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for the NOLGIA CLI: records its argv and answers like `nolgia --json dit ...`.
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\n");
const has = (x) => args.includes(x);
const out = (obj, code = 0) => {
  process.stdout.write(JSON.stringify(obj));
  process.exitCode = code;
};
const go = () => {
  if (has("offload") && has("--dry-run")) {
    if (process.env.FAKE_CONFLICT) {
      return out({ files: 2, bytes: 2000, cards: [], destinations: [], conflicts: [{ path: "/d/S/A/C0001.MP4", reason: "already exists with different content" }] }, 68);
    }
    return out({ files: 2, bytes: 2000000000, cards: [{ card: "A001", source: "/cards/A001", files: 2, bytes: 2000000000 }], destinations: [{ folder: "/drives/one/SHOOT", free_bytes: 5e12 }], conflicts: [] });
  }
  if (has("offload")) {
    process.stderr.write("offload: 1/2 files, 1.0 GB of 2.0 GB, 500 MB/s\n");
    return out({ status: "complete", files_verified: 2 });
  }
  if (has("rename") && !has("--apply")) return out({ status: "dry-run", to_rename: 1, changes: [{ from: "C0001.MP4", to: "S_20261012_1301_A_C0001.MP4" }] });
  if (has("rename")) return out({ status: "applied", to_rename: 1 });
  if (has("verify")) return out({ status: "failed", mismatched: [{ path: "x", detail: "differs" }] }, 68);
  return out({ status: "ok" });
};
if (process.env.FAKE_SLOW) setTimeout(go, Number(process.env.FAKE_SLOW));
else go();
