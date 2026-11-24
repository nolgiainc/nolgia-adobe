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

  // ---------------------------------------------------------- transcribe

  var MP3_PRESETS = ["MediaIO/systempresets/3F3F3F3F_4D503320/MP3 128kbps.epr"];
  var TEMP_BIN = "NOLGIA transcription (temporary)";

  function isMediaClip(item) {
    if (!item || (item.type !== ProjectItemType.CLIP && item.type !== ProjectItemType.FILE)) return false;
    try {
      if (item.isSequence()) return false;
    } catch (e) {}
    return true;
  }

  function mediaPath(item) {
    try {
      return String(item.getMediaPath() || "");
    } catch (e) {
      return "";
    }
  }

  function clipEntry(item) {
    var entry = { name: String(item.name), path: mediaPath(item), node_id: String(item.nodeId) };
    try {
      var d = Number(item.getOutPoint().seconds) - Number(item.getInPoint().seconds);
      if (d > 0) entry.duration = N.round(d, 3);
    } catch (e) {}
    return entry;
  }

  function eachItem(item, fn, depth) {
    for (var i = 0; i < item.children.numItems; i++) {
      var child = item.children[i];
      if (child.type === ProjectItemType.BIN) {
        if (depth < 12) eachItem(child, fn, depth + 1);
      } else if (fn(child) === true) {
        return true;
      }
    }
    return false;
  }

  function findItem(test) {
    var found = null;
    eachItem(project().rootItem, function (item) {
      if (test(item)) {
        found = item;
        return true;
      }
      return false;
    }, 0);
    return found;
  }

  // The clips a transcription is about: the selected clips in the Project
  // panel (or, with none, the clips selected in the active sequence), every
  // clip used in a sequence, or clips named by name or media path.
  A.transcribe_targets = function (args) {
    project();
    var out = [];
    var seen = {};
    var skipped = 0;
    var notFound = [];
    var note = "";
    function add(item) {
      if (!isMediaClip(item)) return;
      if (seen[item.nodeId]) return;
      seen[item.nodeId] = true;
      var entry = clipEntry(item);
      if (!entry.path) {
        skipped++;
        return;
      }
      out.push(entry);
    }
    if (args.clips === "selected") {
      var sel = null;
      try {
        sel = app.getCurrentProjectViewSelection();
      } catch (e) {}
      for (var i = 0; sel && i < sel.length; i++) add(sel[i]);
      if (!out.length) {
        var seq = app.project.activeSequence;
        if (seq) {
          var picked = seq.getSelection();
          for (var j = 0; picked && j < picked.length; j++) {
            try {
              if (picked[j].projectItem) add(picked[j].projectItem);
            } catch (e2) {}
          }
        }
      }
      if (!out.length) note = "Nothing is selected: select clips in the Project panel (or on the timeline), or pass clips.";
    } else if (args.clips === "sequence") {
      var target = findSequence(args.sequence, true);
      var groups = [target.videoTracks, target.audioTracks];
      for (var g = 0; g < groups.length; g++) {
        for (var t = 0; t < groups[g].numTracks; t++) {
          var clips = groups[g][t].clips;
          for (var c = 0; c < clips.numItems; c++) {
            try {
              if (clips[c].projectItem) add(clips[c].projectItem);
            } catch (e3) {}
          }
        }
      }
      if (!out.length) note = "Sequence " + target.name + " has no clips with media.";
    } else {
      for (var k = 0; k < args.clips.length; k++) {
        var want = String(args.clips[k]);
        var item = findItem(function (it) {
          return isMediaClip(it) && (it.name === want || samePath(mediaPath(it), want));
        });
        if (item) add(item);
        else notFound.push(want);
      }
      if (!out.length) note = "None of those clips are in the open project.";
    }
    var result = { clips: out, note: note };
    if (notFound.length) result.not_found = notFound;
    if (skipped) result.skipped_without_media = skipped;
    return result;
  };

  function mp3Preset() {
    var base = String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/");
    var bases = [base, base + "Contents/"];
    for (var b = 0; b < bases.length; b++) {
      for (var i = 0; i < MP3_PRESETS.length; i++) {
        var f = new File(bases[b] + MP3_PRESETS[i]);
        if (f.exists) return f.fsName;
      }
    }
    N.fail("Could not find Premiere Pro's MP3 export preset under " + base + "MediaIO/systempresets.");
  }

  // The audio of one clip as an MP3, for NOLGIA's transcription: a temporary
  // sequence of just that clip in a temporary bin, exported and removed.
  A.transcribe_audio = function (args) {
    var p = project();
    var item = findItem(function (it) {
      return isMediaClip(it) && (String(it.nodeId) === String(args.node_id) || (!args.node_id && samePath(mediaPath(it), args.path)));
    });
    if (!item) N.fail("The clip is no longer in the open project.");
    var preset = mp3Preset();
    var before = app.project.activeSequence;
    var bin = p.rootItem.createBin(TEMP_BIN);
    var seq = null;
    var out = N.file(args.folder + "/" + args.stem + ".mp3");
    var answer = null;
    var seconds = null;
    try {
      seq = app.project.createNewSequenceFromClips("NOLGIA audio " + item.name, [item], bin);
      if (!seq) N.fail("Premiere Pro could not make a sequence of " + item.name + " to export its audio.");
      seconds = N.round(Number(seq.end) / TICKS, 3);
      answer = seq.exportAsMediaDirect(out.fsName, preset, app.encoder.ENCODE_ENTIRE);
    } finally {
      if (seq) {
        try {
          app.project.deleteSequence(seq);
        } catch (e) {}
      }
      try {
        bin.deleteBin();
      } catch (e2) {}
      if (before) {
        try {
          app.project.openSequence(before.sequenceID);
        } catch (e3) {}
      }
    }
    if (!out.exists) N.fail("Premiere Pro did not write the audio of " + item.name + (answer ? ": " + answer : "."));
    return { path: out.fsName, clip: String(item.name), duration: seconds };
  };

  // ---------------------------------------------------------- sound design
  //
  // The app side of `sound_design` (core/soundrun.js plans; this does). The
  // calls below were proven in Premiere Pro 26.2 on Windows: new audio
  // tracks through QE addTracks after the last one, named with QE setName;
  // track.overwriteClip on those new, empty tracks only; Volume > Level and
  // its keyframes for gain and fades; trackItem.remove and QE
  // removeAudioTrack to take a run out. Times are ticks strings.

  var PREVIEW_PRESETS = [
    "MediaIO/systempresets/4E49434B_48323634/Mobile Device 480p SD Wide.epr",
    "MediaIO/systempresets/4E49434B_48323634/Vimeo 480p SD Wide.epr",
    "MediaIO/systempresets/4E49434B_48323634/High Quality 480 SD Wide.epr",
    "MediaIO/systempresets/4E49434B_48323634/02 - Match Source - Low bitrate.epr"
  ].concat(H264_PRESETS);
  var CLIP_LIST_LIMIT = 3000;

  function ticksOrNull(time) {
    try {
      var t = String(time.ticks);
      return t.charAt(0) === "-" ? null : t;
    } catch (e) {
      return null;
    }
  }

  function seqFacts(seq) {
    var facts = {
      name: seq.name,
      id: String(seq.sequenceID),
      timebase: String(seq.timebase),
      end: String(seq.end),
      width: seq.frameSizeHorizontal,
      height: seq.frameSizeVertical
    };
    facts["in"] = null;
    facts.out = null;
    try {
      var i = ticksOrNull(seq.getInPointAsTime());
      var o = ticksOrNull(seq.getOutPointAsTime());
      if (i !== null && o !== null && Number(o) > Number(i)) {
        facts["in"] = i;
        facts.out = o;
      }
    } catch (e) {}
    return facts;
  }

  function projectFsName() {
    if (!hasProject()) return null;
    var f = N.file(app.project.path);
    return f.exists ? f.fsName : null;
  }

  function audioTrackById(seq, id) {
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      if (String(seq.audioTracks[i].id) === String(id)) return { track: seq.audioTracks[i], index: i };
    }
    return null;
  }

  function pathKey(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
  }

  // The bin at `parts` under the project root ("NOLGIA imports", "Sound
  // design", "<date> <run>"), made where missing.
  function binAt(parts) {
    var bin = project().rootItem;
    for (var p = 0; p < parts.length; p++) {
      var next = null;
      for (var i = 0; i < bin.children.numItems; i++) {
        var child = bin.children[i];
        if (child.type === ProjectItemType.BIN && child.name === String(parts[p])) {
          next = child;
          break;
        }
      }
      bin = next || bin.createBin(String(parts[p]));
      if (!bin) N.fail("Premiere Pro did not make the bin " + parts.join(" / ") + ".");
    }
    return bin;
  }

  // The items in `bin` by media path (lower case, forward slashes).
  function itemsByPath(bin) {
    var out = {};
    for (var i = 0; i < bin.children.numItems; i++) {
      var child = bin.children[i];
      try {
        if (child.type !== ProjectItemType.BIN) out[pathKey(child.getMediaPath())] = child;
      } catch (e) {}
    }
    return out;
  }

  // The command's project must be the open one (someone may open another
  // while the sounds download).
  function sameProject(args) {
    if (!args.project) return;
    var open = projectFsName();
    if (!open || pathKey(open) !== pathKey(N.file(args.project).fsName)) {
      N.fail("The open project is no longer " + args.project + ", so NOLGIA changed nothing.");
    }
  }

  // QE works on the active sequence: `fn(qeSequence)` with `seq` active, then
  // the sequence that was active before is shown again. Fails unless QE's
  // sequence is `seq` (its guid, or its name where QE has no guid).
  function withActive(seq, fn) {
    app.enableQE();
    var before = activate(seq);
    try {
      var q = qe.project.getActiveSequence();
      if (!q) N.fail("Premiere Pro could not open the sequence " + seq.name + ".");
      var guid = null;
      try {
        guid = q.guid;
      } catch (e) {}
      var same = guid !== null && guid !== undefined && String(guid) !== "" ? String(guid) === String(seq.sequenceID) : String(q.name) === String(seq.name);
      if (!same) N.fail("Premiere Pro did not switch to the sequence " + seq.name + " (it is on " + q.name + "), so NOLGIA changed nothing there.");
      return fn(q);
    } finally {
      if (before && before.sequenceID !== seq.sequenceID) {
        try {
          app.project.openSequence(before.sequenceID);
        } catch (e) {}
      }
    }
  }

  function trackClipsBrief(track) {
    var list = [];
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      var e = { start: c.start.ticks, end: c.end.ticks, node_id: String(c.nodeId) };
      try {
        e.media = String(c.projectItem.getMediaPath());
      } catch (x) {}
      list.push(e);
    }
    return list;
  }

  function busyAt(track, start, end) {
    var s = Number(start);
    var e = Number(end);
    for (var i = 0; i < track.clips.numItems; i++) {
      var c = track.clips[i];
      if (Number(c.start.ticks) < e && s < Number(c.end.ticks)) return c;
    }
    return null;
  }

  function volumeLevel(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
      var comp = clip.components[i];
      var match = String(comp.matchName);
      if (match.indexOf("Internal Volume") === 0 || (match.indexOf("Channel") < 0 && comp.displayName === "Volume")) {
        for (var j = 0; j < comp.properties.numItems; j++) {
          if (comp.properties[j].displayName === "Level") return comp.properties[j];
        }
        if (comp.properties.numItems > 1) return comp.properties[1];
      }
    }
    return null;
  }

  A.sd_read = function (args) {
    var seq = findSequence(args.sequence, true);
    var count = 0;
    var truncated = 0;
    function clipsOf(track) {
      var list = [];
      for (var i = 0; i < track.clips.numItems; i++) {
        if (count >= CLIP_LIST_LIMIT) {
          truncated = CLIP_LIST_LIMIT;
          break;
        }
        count++;
        var c = track.clips[i];
        var e = { name: c.name, start: c.start.ticks, end: c.end.ticks, out: c.outPoint.ticks, enabled: true };
        e["in"] = c.inPoint.ticks;
        try {
          e.enabled = !c.disabled;
        } catch (x) {}
        try {
          var item = c.projectItem;
          if (item && item.isSequence()) e.kind = "sequence";
          else if (item) e.media = String(item.getMediaPath());
        } catch (x2) {}
        try {
          if (c.isAdjustmentLayer()) e.kind = "adjustment";
        } catch (x3) {}
        try {
          if (c.isMGT()) e.kind = "graphic";
        } catch (x4) {}
        list.push(e);
      }
      return list;
    }
    function tracks(coll) {
      var out = [];
      for (var i = 0; i < coll.numTracks; i++) {
        var t = coll[i];
        var e = { index: i + 1, id: t.id, name: t.name, clips: clipsOf(t) };
        try {
          e.muted = t.isMuted();
        } catch (x) {}
        try {
          e.locked = t.isLocked();
        } catch (x2) {}
        out.push(e);
      }
      return out;
    }
    var markers = [];
    try {
      var m = seq.markers.getFirstMarker();
      while (m && markers.length < 1000) {
        markers.push({ name: m.name, start: m.start.ticks, end: m.end.ticks, type: String(m.type), comment: m.comments });
        m = seq.markers.getNextMarker(m);
      }
    } catch (e) {}
    return {
      project: projectFsName(),
      sequence: seqFacts(seq),
      video_tracks: tracks(seq.videoTracks),
      audio_tracks: tracks(seq.audioTracks),
      markers: markers,
      truncated: truncated
    };
  };

  A.sd_preview_info = function (args) {
    var seq = findSequence(args.sequence, true);
    var base = String(app.path).replace(/\\/g, "/").replace(/\/?$/, "/");
    var bases = [base, base + "Contents/"];
    var preset = null;
    for (var b = 0; b < bases.length && !preset; b++) {
      for (var i = 0; i < PREVIEW_PRESETS.length; i++) {
        var f = new File(bases[b] + PREVIEW_PRESETS[i]);
        if (f.exists) {
          preset = f.fsName;
          break;
        }
      }
    }
    return { sequence: seqFacts(seq), preset: preset, looked: base + "MediaIO/systempresets" };
  };

  A.sd_export_preview = function (args) {
    var seq = findSequence(args.sequence, true);
    var out = N.file(args.file);
    var preset = N.file(args.preset);
    if (!preset.exists) N.fail("The preview preset is missing: " + preset.fsName);
    var mode = args.mode === "in_out" ? app.encoder.ENCODE_IN_TO_OUT : app.encoder.ENCODE_ENTIRE;
    // Paths must be the system's own (backslashes on Windows): a forward
    // slash path answers "Unknown Error" and writes nothing.
    var answer = seq.exportAsMediaDirect(out.fsName, preset.fsName, mode);
    if (!out.exists) N.fail("Premiere Pro did not write the preview" + (answer ? ": " + answer : "."));
    return { path: out.fsName };
  };

  A.sd_state = function (args) {
    var seq = findSequence(args.sequence, true);
    var names = [];
    for (var i = 0; i < seq.audioTracks.numTracks; i++) names.push(String(seq.audioTracks[i].name));
    var tracks = [];
    var ids = args.track_ids || [];
    for (var j = 0; j < ids.length; j++) {
      var found = audioTrackById(seq, ids[j]);
      if (found) tracks.push({ id: found.track.id, index: found.index + 1, name: found.track.name, clips: trackClipsBrief(found.track) });
    }
    return { project: projectFsName(), sequence: seqFacts(seq), track_names: names, tracks: tracks };
  };

  A.sd_import = function (args) {
    sameProject(args);
    var bin = binAt(args.bin_path);
    var have = itemsByPath(bin);
    var want = [];
    for (var i = 0; i < args.paths.length; i++) {
      var f = N.file(args.paths[i]);
      if (!f.exists) continue;
      if (!have[pathKey(f.fsName)]) want.push(f.fsName);
    }
    if (want.length) app.project.importFiles(want, true, bin, false);
    // Each item's path as Premiere keeps it: NOLGIA matches them in Node
    // (on macOS a name may come back in another Unicode form).
    var items = [];
    var mapping = [];
    for (var j = 0; j < bin.children.numItems; j++) {
      var child = bin.children[j];
      try {
        if (child.type === ProjectItemType.BIN) continue;
        items.push(String(child.getMediaPath()));
        mapping.push(oneClipAudio(child));
      } catch (e) {}
    }
    return { bin: args.bin_path.join(" / "), items: items, mapping: mapping };
  };

  // A sound goes in as ONE clip on one track: with the preference Default
  // Audio Tracks > Stereo Media set to Mono, Premiere would make a stereo
  // file two mono clips (two tracks). Its channel mapping is set back to one
  // clip of the file's own channels. Answers what it found and did.
  function oneClipAudio(item) {
    var out = { media: String(item.getMediaPath()) };
    try {
      var m = item.getAudioChannelMapping;
      if (typeof m === "function") m = item.getAudioChannelMapping();
      if (!m) return out;
      out.type = m.audioChannelsType;
      out.clips = m.audioClipsNumber;
      if (m.audioClipsNumber > 1 && (m.audioChannelsType === 0 || m.audioChannelsType === undefined)) {
        m.audioChannelsType = m.audioClipsNumber === 2 ? 1 : 0; // 1: stereo
        m.audioClipsNumber = 1;
        item.setAudioChannelMapping(m);
        var after = item.getAudioChannelMapping;
        if (typeof after === "function") after = item.getAudioChannelMapping();
        out.changed = true;
        out.type_after = after ? after.audioChannelsType : null;
        out.clips_after = after ? after.audioClipsNumber : null;
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  A.sd_add_tracks = function (args) {
    sameProject(args);
    var seq = findSequence(args.sequence, true);
    var names = args.names || [];
    if (!names.length) return { tracks: [] };
    return withActive(seq, function (q) {
      var count = seq.audioTracks.numTracks;
      // 0 video tracks; names.length audio tracks of type 1 after the last one.
      q.addTracks(0, 0, names.length, 1, count, 0, 0);
      if (seq.audioTracks.numTracks !== count + names.length) {
        N.fail("Premiere Pro did not add the audio tracks (it has " + seq.audioTracks.numTracks + ", NOLGIA expected " + (count + names.length) + ").");
      }
      var out = [];
      for (var i = 0; i < names.length; i++) {
        var t = seq.audioTracks[count + i];
        if (t.clips.numItems) N.fail("A track Premiere Pro just added is not empty, so NOLGIA stopped.");
        try {
          q.getAudioTrackAt(count + i).setName(String(names[i]));
        } catch (e) {}
        out.push({ id: t.id, index: count + i + 1, name: String(seq.audioTracks[count + i].name) });
      }
      return { tracks: out };
    });
  };

  A.sd_place = function (args) {
    sameProject(args);
    var seq = findSequence(args.sequence, true);
    var items = itemsByPath(binAt(args.bin_path));
    var results = [];
    for (var i = 0; i < args.placements.length; i++) {
      var p = args.placements[i];
      var r = { key: p.key, ok: false };
      results.push(r);
      // `media` is the item's path exactly as sd_import answered it.
      var item = items[pathKey(p.media)];
      if (!item) {
        r.reason = "its file is not in the bin.";
        continue;
      }
      var found = audioTrackById(seq, p.track_id);
      if (!found) {
        r.reason = "its track is no longer in the sequence.";
        continue;
      }
      var track = found.track;
      if (p.track_name && String(track.name) !== String(p.track_name)) {
        r.reason = "its track is now called " + track.name + ", so it is not NOLGIA's to add to.";
        continue;
      }
      var there = busyAt(track, p.start, p.end);
      if (there) {
        // overwriteClip would write over it: never.
        r.reason = "something (" + there.name + ") is on " + track.name + " at that time.";
        continue;
      }
      var clip = null;
      try {
        item.setInPoint(p["in"], 4);
        item.setOutPoint(p.out, 4);
        track.overwriteClip(item, p.start);
      } catch (e) {
        r.reason = "Premiere Pro refused it (" + e + ").";
      } finally {
        try {
          item.clearInPoint();
          item.clearOutPoint();
        } catch (e2) {}
      }
      if (r.reason) continue;
      for (var c = 0; c < track.clips.numItems; c++) {
        var placedNow = track.clips[c];
        try {
          if (String(placedNow.start.ticks) === String(p.start) && pathKey(placedNow.projectItem.getMediaPath()) === pathKey(p.media)) clip = placedNow;
        } catch (e4) {}
      }
      if (!clip) {
        r.reason = "Premiere Pro did not put it on the timeline.";
        continue;
      }
      r.ok = true;
      r.node_id = String(clip.nodeId);
      r.start = clip.start.ticks;
      r.end = clip.end.ticks;
      r["in"] = clip.inPoint.ticks;
      r.out = clip.outPoint.ticks;
      try {
        var level = volumeLevel(clip);
        if (!level) {
          r.note = "its volume could not be set (no Volume effect found)";
        } else {
          level.setValue(p.level, true);
          var keys = p.keys || [];
          if (keys.length) {
            level.setTimeVarying(true);
            for (var k = 0; k < keys.length; k++) {
              level.addKey(keys[k][0]);
              level.setValueAtKey(keys[k][0], keys[k][1], true);
            }
          }
        }
      } catch (e3) {
        r.note = "its volume or fades could not be set (" + e3 + ")";
      }
    }
    return { results: results };
  };

  // Takes out the clips Node matched against the record (`clips`: key,
  // track_id, track_name, start, media as sd_state answered them). Each is
  // checked again here: on that track, the track still carrying that name,
  // at that start, of that file; anything that does not agree on all of them
  // is left alone and reported. Then each of the run's `tracks` ({id, name})
  // that is empty and still carries its name is removed, after checking that
  // QE's track at that place is the same one.
  A.sd_remove = function (args) {
    sameProject(args);
    var seq = findSequence(args.sequence, true);
    var removed = [];
    var missing = [];
    var clips = args.clips || [];
    for (var i = 0; i < clips.length; i++) {
      var want = clips[i];
      var found = audioTrackById(seq, want.track_id);
      var clip = null;
      var why = "its track is no longer in the sequence";
      if (found && String(found.track.name) !== String(want.track_name)) why = "its track is now called " + found.track.name;
      else if (found) {
        why = "it is not where NOLGIA placed it";
        for (var c = 0; c < found.track.clips.numItems && !clip; c++) {
          var x = found.track.clips[c];
          try {
            if (String(x.start.ticks) === String(want.start) && String(x.projectItem.getMediaPath()) === String(want.media)) clip = x;
          } catch (e) {}
        }
      }
      if (!clip) {
        missing.push({ key: want.key, reason: why });
        continue;
      }
      clip.remove(false, false);
      removed.push(want.key);
    }
    var tracksRemoved = [];
    var tracksKept = [];
    var tracks = args.tracks || [];
    var order = [];
    for (var j = 0; j < tracks.length; j++) {
      var f = audioTrackById(seq, tracks[j].id);
      if (!f) continue;
      if (String(f.track.name) !== String(tracks[j].name)) {
        tracksKept.push({ id: f.track.id, name: f.track.name, reason: "it was renamed (it was " + tracks[j].name + "), so it is the editor's now and stays." });
        continue;
      }
      order.push({ id: tracks[j].id, name: tracks[j].name });
    }
    if (!order.length) return { removed: removed, missing: missing, tracks_removed: tracksRemoved, tracks_kept: tracksKept };
    withActive(seq, function (q) {
      // From the last track up, so the indices of the others hold.
      for (var k = 0; k < order.length; k++) order[k].index = audioTrackById(seq, order[k].id).index;
      order.sort(function (a, b) {
        return b.index - a.index;
      });
      for (var m = 0; m < order.length; m++) {
        var now = audioTrackById(seq, order[m].id);
        if (!now) continue;
        var n = now.track.clips.numItems;
        if (n) {
          tracksKept.push({ id: now.track.id, name: now.track.name, reason: "it has " + n + " clip" + (n === 1 ? "" : "s") + " NOLGIA did not place, so it stays." });
          continue;
        }
        // QE's track at that place must be this one: same name, nothing on it.
        var qt = null;
        try {
          qt = q.getAudioTrackAt(now.index);
        } catch (e2) {}
        var qName = null;
        var qBusy = 0;
        try {
          qName = String(qt.name);
          for (var it = 0; it < qt.numItems; it++) {
            var qi = qt.getItemAt(it);
            if (qi && String(qi.type) !== "Empty") qBusy++;
          }
        } catch (e3) {
          qName = null;
        }
        if (qName !== String(order[m].name) || qBusy) {
          tracksKept.push({ id: now.track.id, name: now.track.name, reason: "Premiere Pro's track list did not match (" + qName + "), so NOLGIA did not remove it; it is empty and can be deleted by hand." });
          continue;
        }
        var before = seq.audioTracks.numTracks;
        try {
          q.removeAudioTrack(now.index);
        } catch (e4) {}
        if (seq.audioTracks.numTracks === before - 1 && !audioTrackById(seq, order[m].id)) tracksRemoved.push(order[m].id);
        else tracksKept.push({ id: now.track.id, name: now.track.name, reason: "Premiere Pro did not remove it; it is empty and can be deleted by hand." });
      }
    });
    return { removed: removed, missing: missing, tracks_removed: tracksRemoved, tracks_kept: tracksKept };
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
