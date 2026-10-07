// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// NOLGIA for Premiere Pro: the app side of each command.
//
// Frames count from 0 at a sequence's first frame, at the sequence's own
// frame rate. Premiere's times are "ticks": 254016000000 per second.

(function (N) {
  var A = {};
  var TICKS = 254016000000;
  var BIN_NAME = "NOLGIA imports";
  var H264_PRESETS = [
    "MediaIO/systempresets/4E49434B_48323634/00 - Match Source - High bitrate.epr",
    "MediaIO/systempresets/4E49434B_48323634/01 - Match Source - High bitrate.epr",
    "MediaIO/systempresets/4E49434B_48323634/00 - Match Source - Medium bitrate.epr"
  ];

  function project() {
    if (!app.project || !app.project.rootItem) N.fail("Premiere Pro has no project open. Open or create one first.");
    return app.project;
  }

  function hasProject() {
    try {
      return Boolean(app.project && app.project.rootItem && app.project.path);
    } catch (e) {
      return false;
    }
  }

  function dirty() {
    try {
      if (typeof app.project.isDirty === "function") return Boolean(app.project.isDirty());
    } catch (e) {}
    try {
      if (typeof app.project.dirty === "boolean") return app.project.dirty;
    } catch (e2) {}
    return null;
  }

  function documentInfo() {
    if (!hasProject()) return { name: "" };
    var path = String(app.project.path);
    return { name: String(app.project.name), path: path };
  }

  function ticksPerFrame(seq) {
    var tb = Number(seq.timebase);
    return tb > 0 ? tb : TICKS / 30;
  }

  function fps(seq) {
    return TICKS / ticksPerFrame(seq);
  }

  function frameOfTicks(seq, ticks) {
    return Math.round(Number(ticks) / ticksPerFrame(seq));
  }

  function frameCount(seq) {
    return frameOfTicks(seq, seq.end);
  }

  function sequences() {
    var out = [];
    var list = project().sequences;
    for (var i = 0; i < list.numSequences; i++) out.push(list[i]);
    return out;
  }

  function findSequence(target, required) {
    var list = sequences();
    if (target !== null && target !== undefined && target !== "") {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === String(target) || String(list[i].sequenceID) === String(target)) return list[i];
      }
      var names = [];
      for (var j = 0; j < list.length && j < 30; j++) names.push(list[j].name);
      N.fail("There is no sequence named " + target + ". Sequences: " + (names.join(", ") || "none") + ".");
    }
    if (app.project.activeSequence) return app.project.activeSequence;
    if (list.length === 1) return list[0];
    if (!required) return null;
    if (!list.length) N.fail("This project has no sequence. Make one first.");
    N.fail("No sequence is open. Open one in the Timeline, or name it (sequence).");
  }

  // Make `seq` the active sequence (the Program Monitor shows it). Returns
  // the sequence that was active before.
  function activate(seq) {
    var before = app.project.activeSequence;
    if (!before || before.sequenceID !== seq.sequenceID) {
      app.project.openSequence(seq.sequenceID);
      app.project.activeSequence = seq;
    }
    return before;
  }

  function trackInfo(track, index, seq) {
    var info = { index: index + 1, name: track.name, clips: track.clips.numItems };
    try {
      info.muted = track.isMuted();
    } catch (e) {}
    return info;
  }

  function clipInfo(seq, clip, trackKind, trackIndex) {
    var info = {
      name: clip.name,
      track: trackKind + (trackIndex + 1),
      start_frame: frameOfTicks(seq, clip.start.ticks),
      end_frame: frameOfTicks(seq, clip.end.ticks)
    };
    try {
      if (clip.projectItem) info.source = clip.projectItem.name;
    } catch (e) {}
    return info;
  }

  function sequenceInfo(seq, detailed) {
    var info = {
      name: seq.name,
      id: String(seq.sequenceID),
      width: seq.frameSizeHorizontal,
      height: seq.frameSizeVertical,
      fps: N.round(fps(seq), 3),
      frames: frameCount(seq),
      duration: N.round(Number(seq.end) / TICKS, 3),
      video_tracks: seq.videoTracks.numTracks,
      audio_tracks: seq.audioTracks.numTracks
    };
    if (!detailed) return info;
    try {
      info.current_frame = frameOfTicks(seq, seq.getPlayerPosition().ticks);
    } catch (e) {}
    try {
      // Without in and out points Premiere answers a large negative time.
      var inTicks = Number(seq.getInPointAsTime().ticks);
      var outTicks = Number(seq.getOutPointAsTime().ticks);
      info.in_frame = inTicks >= 0 ? frameOfTicks(seq, inTicks) : null;
      info.out_frame = outTicks >= 0 ? frameOfTicks(seq, outTicks) : null;
    } catch (e2) {}
    try {
      info.timecode_start = seq.getZeroPoint ? frameOfTicks(seq, seq.getZeroPoint()) : 0;
    } catch (e3) {}
    var v = [];
    var a = [];
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) v.push(trackInfo(seq.videoTracks[i], i, seq));
    for (i = 0; i < seq.audioTracks.numTracks; i++) a.push(trackInfo(seq.audioTracks[i], i, seq));
    info.video_track_list = v;
    info.audio_track_list = a;
    var selected = [];
    try {
      var sel = seq.getSelection();
      for (i = 0; i < sel.length && i < 100; i++) selected.push(sel[i].name);
    } catch (e4) {}
    info.selected_clips = selected;
    return info;
  }

  var TYPE_NAMES = { 1: "clip", 2: "bin", 3: "root", 4: "file" };

  // Bins with their item counts, a few levels deep.
  function binTree(item, depth, path, out, counts) {
    for (var i = 0; i < item.children.numItems; i++) {
      var child = item.children[i];
      if (child.type === ProjectItemType.BIN) {
        var p = path ? path + "/" + child.name : child.name;
        out.push({ path: p, items: child.children.numItems });
        counts.bins++;
        if (depth < 4) binTree(child, depth + 1, p, out, counts);
      } else if (child.type === ProjectItemType.CLIP || child.type === ProjectItemType.FILE) {
        var isSeq = false;
        try {
          isSeq = child.isSequence();
        } catch (e) {}
        if (isSeq) counts.sequences++;
        else counts.clips++;
      }
    }
  }

  // ------------------------------------------------------------- commands

  A.snapshot = function () {
    return { document: documentInfo(), dirty: hasProject() ? dirty() : false, app_version: String(app.version) };
  };

  A.info = function () {
    var p = project();
    var doc = documentInfo();
    doc.dirty = dirty();
    var bins = [];
    var counts = { bins: 0, clips: 0, sequences: 0 };
    binTree(p.rootItem, 0, "", bins, counts);
    var list = sequences();
    var brief = [];
    for (var i = 0; i < list.length && i < 200; i++) brief.push(sequenceInfo(list[i], false));
    var selection = [];
    try {
      var sel = app.getCurrentProjectViewSelection();
      for (i = 0; sel && i < sel.length && i < 100; i++) selection.push(sel[i].name);
    } catch (e) {}
    var active = app.project.activeSequence;
    return {
      app_version: String(app.version),
      document: doc,
      project: { root_items: p.rootItem.children.numItems, bins: counts.bins, clips: counts.clips, sequences: counts.sequences },
      active_sequence: active ? sequenceInfo(active, true) : null,
      sequences: brief,
      bins: bins.slice(0, 300),
      selected_items: selection
    };
  };

  // A still of `seq` at `frame` through the QE DOM (the one Premiere call
  // that writes a frame). Writes <base>.png; returns its path.
  function exportFrame(seq, frame, base) {
    app.enableQE();
    var before = activate(seq);
    var position = seq.getPlayerPosition();
    var tpf = ticksPerFrame(seq);
    var q = qe.project.getActiveSequence();
    if (!q) N.fail("Premiere Pro could not open " + seq.name + " for a still.");
    var file = N.file(base + ".png");
    try {
      if (frame !== null && frame !== undefined) seq.setPlayerPosition(String(Math.round(frame * tpf)));
      var timecode = q.CTI.timecode;
      q.exportFramePNG(timecode, file.fsName.replace(/\.png$/i, ""));
    } finally {
      try {
        seq.setPlayerPosition(position.ticks);
      } catch (e) {}
      if (before && before.sequenceID !== seq.sequenceID) {
        try {
          app.project.openSequence(before.sequenceID);
        } catch (e2) {}
      }
    }
    return file.fsName;
  }

  A.preview = function (args) {
    var seq = findSequence(args.target, true);
    var frame = args.frame;
    if (frame === null || frame === undefined) frame = frameOfTicks(seq, seq.getPlayerPosition().ticks);
    if (frame < 0 || frame > frameCount(seq)) {
      N.fail("Frame " + frame + " is outside " + seq.name + " (frames 0 to " + frameCount(seq) + ").");
    }
    var path = exportFrame(seq, frame, args.folder + "/frame");
    return {
      path: path,
      width: seq.frameSizeHorizontal,
      height: seq.frameSizeVertical,
      frame: frame,
      sequence: seq.name,
      label: seq.name,
      background: "#000000"
    };
  };

  function importsBin() {
    var root = project().rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var child = root.children[i];
      if (child.type === ProjectItemType.BIN && child.name === BIN_NAME) return child;
    }
    return root.createBin(BIN_NAME);
  }

  function samePath(a, b) {
    return String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase();
  }

  A["import"] = function (args) {
    project();
    if (args.kind === "vector" || args.kind === "model") {
      N.fail("Premiere Pro cannot import this kind of file (" + args.kind + ").");
    }
    var file = N.file(args.path);
    if (!file.exists) N.fail("The downloaded file is missing: " + args.path);
    var bin = importsBin();
    var ok = app.project.importFiles([file.fsName], true, bin, false);
    var found = null;
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
      var child = bin.children[i];
      try {
        if (samePath(child.getMediaPath(), file.fsName)) {
          found = child;
          break;
        }
      } catch (e) {}
    }
    if (!found) N.fail("Premiere Pro did not import " + file.name + (ok === false ? "." : " (it may not read this format)."));
    return { imported: [found.name], bin: BIN_NAME };
  };

  function presetPath() {
    var base = String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/");
    // On macOS app.path is the .app bundle; the presets are inside Contents.
    var bases = [base, base + "Contents/"];
    for (var b = 0; b < bases.length; b++) {
      for (var i = 0; i < H264_PRESETS.length; i++) {
        var f = new File(bases[b] + H264_PRESETS[i]);
        if (f.exists) return f.fsName;
      }
    }
    N.fail("Could not find Premiere Pro's H.264 export preset under " + base + "MediaIO/systempresets.");
  }

  A["export"] = function (args) {
    var seq = findSequence(args.target, true);
    var base = args.folder + "/" + args.stem;
    if (args.format === "png") {
      var frame = args.frames ? args.frames[0] : frameOfTicks(seq, seq.getPlayerPosition().ticks);
      var path = exportFrame(seq, frame, base + "-" + frame);
      return { path: path, sequence: seq.name, frames: [frame, frame], width: seq.frameSizeHorizontal, height: seq.frameSizeVertical };
    }
    if (args.format !== "mp4") N.fail("Premiere Pro exports mp4, png and prproj.");
    var out = N.file(base + ".mp4");
    var preset = presetPath();
    var mode = app.encoder.ENCODE_ENTIRE;
    var savedIn = null;
    var savedOut = null;
    var range = [0, frameCount(seq) - 1];
    if (args.frames) {
      range = args.frames;
      if (range[1] >= frameCount(seq)) N.fail("Frames " + range[0] + "-" + range[1] + " go past the end of " + seq.name + " (" + frameCount(seq) + " frames).");
      savedIn = seq.getInPointAsTime().ticks;
      savedOut = seq.getOutPointAsTime().ticks;
      var tpf = ticksPerFrame(seq);
      seq.setInPoint(String(range[0] * tpf));
      seq.setOutPoint(String((range[1] + 1) * tpf));
      mode = app.encoder.ENCODE_IN_TO_OUT;
    }
    var answer;
    try {
      answer = seq.exportAsMediaDirect(out.fsName, preset, mode);
    } finally {
      if (savedIn !== null) {
        try {
          seq.setInPoint(savedIn);
          seq.setOutPoint(savedOut);
        } catch (e) {}
      }
    }
    if (!out.exists) N.fail("Premiere Pro did not write the video" + (answer ? ": " + answer : "."));
    return {
      path: out.fsName,
      sequence: seq.name,
      frames: range,
      width: seq.frameSizeHorizontal,
      height: seq.frameSizeVertical,
      duration: N.round((range[1] - range[0] + 1) / fps(seq), 3)
    };
  };

  A.project_file = function () {
    if (!hasProject()) return { path: null, dirty: null };
    var f = N.file(app.project.path);
    return { path: f.exists ? f.fsName : null, dirty: dirty() };
  };

  A.save = function (args) {
    var p = project();
    if (!args.path) {
      if (!p.path || !N.file(p.path).exists) {
        N.fail("This project has never been saved, so there is no file to save to. Pass `path`, for example C:/Projects/edit.prproj.");
      }
      p.save();
      return { path: String(app.project.path) };
    }
    N.folderOf(args.path);
    p.saveAs(N.file(args.path).fsName);
    return { path: String(app.project.path) };
  };

  A.open_check = function (args) {
    var ext = String(args.path).toLowerCase().replace(/^.*\./, "");
    if (ext !== "prproj") {
      return { error: "Premiere Pro opens .prproj projects. To bring in " + File(args.path).name + ", upload it to NOLGIA and use import_asset." };
    }
    // Premiere opens the other project next to this one; nothing is lost.
    return { loses_changes: false };
  };

  A.open = function (args) {
    var file = N.file(args.path);
    if (!file.exists) N.fail("There is no file at " + args.path + ".");
    var ok = app.openDocument(file.fsName, true, true, true, false);
    if (!ok) N.fail("Premiere Pro could not open " + file.fsName + ".");
    return { path: String(app.project.path) };
  };

  N.adapter = A;
})($.global.__nolgia);
