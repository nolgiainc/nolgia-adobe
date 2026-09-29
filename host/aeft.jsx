// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// NOLGIA for After Effects: the app side of each command.
//
// Frames count from 0 at a comp's first frame, whatever its Start Timecode
// (the comp's own start is reported as start_timecode_frame).

(function (N) {
  var A = {};
  var FOLDER_NAME = "NOLGIA imports";

  // ------------------------------------------------------------ plumbing

  A.quiet = function () {
    try {
      app.beginSuppressDialogs();
    } catch (e) {}
    return true;
  };

  A.unquiet = function () {
    try {
      app.endSuppressDialogs(false);
    } catch (e) {}
  };

  A.beginUndo = function (name) {
    try {
      app.beginUndoGroup(name);
    } catch (e) {}
  };

  A.endUndo = function () {
    try {
      app.endUndoGroup();
    } catch (e) {}
  };

  function project() {
    if (!app.project) N.fail("After Effects has no project open.");
    return app.project;
  }

  function dirty() {
    try {
      if (typeof app.project.dirty === "boolean") return app.project.dirty;
    } catch (e) {}
    return null;
  }

  function documentInfo() {
    var f = app.project ? app.project.file : null;
    if (!f) return { name: "" };
    return { name: File.decode(f.name), path: f.fsName };
  }

  function isComp(item) {
    return item instanceof CompItem;
  }

  function comps() {
    var out = [];
    var items = project().items;
    for (var i = 1; i <= items.length; i++) if (isComp(items[i])) out.push(items[i]);
    return out;
  }

  function activeComp() {
    var item = app.project.activeItem;
    if (isComp(item)) return item;
    try {
      var viewer = app.activeViewer;
      if (viewer && viewer.type === ViewerType.VIEWER_COMPOSITION) {
        viewer.setActive();
        if (isComp(app.project.activeItem)) return app.project.activeItem;
      }
    } catch (e) {}
    return null;
  }

  // The comp a command is about: by name (or id), else the active one, else
  // the only one.
  function targetComp(target, required) {
    var list = comps();
    if (target !== null && target !== undefined && target !== "") {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === String(target) || String(list[i].id) === String(target)) return list[i];
      }
      var names = [];
      for (var j = 0; j < list.length && j < 30; j++) names.push(list[j].name);
      N.fail("There is no composition named " + target + ". Compositions: " + (names.join(", ") || "none") + ".");
    }
    var c = activeComp();
    if (c) return c;
    if (list.length === 1) return list[0];
    if (!required) return null;
    if (!list.length) N.fail("This project has no composition. Make one first.");
    N.fail("No composition is active. Open one in the Timeline, or name it (comp).");
  }

  function fps(c) {
    return c.frameRate;
  }

  function frameOf(c, time) {
    return Math.round(time * fps(c));
  }

  function timeOf(c, frame) {
    return frame / fps(c);
  }

  function frameCount(c) {
    return Math.round(c.duration * fps(c));
  }

  function layerType(layer) {
    if (layer instanceof CameraLayer) return "camera";
    if (layer instanceof LightLayer) return "light";
    if (layer instanceof TextLayer) return "text";
    if (layer instanceof ShapeLayer) return "shape";
    if (layer.nullLayer) return "null";
    if (layer.adjustmentLayer) return "adjustment";
    try {
      var src = layer.source;
      if (src instanceof CompItem) return "precomp";
      if (src instanceof FootageItem) {
        if (src.mainSource instanceof SolidSource) return "solid";
        if (src.mainSource instanceof PlaceholderSource) return "placeholder";
        if (src.hasVideo === false && src.hasAudio) return "audio";
        return src.mainSource && src.mainSource.isStill ? "still" : "footage";
      }
    } catch (e) {}
    return "layer";
  }

  function layerInfo(c, layer) {
    var info = {
      index: layer.index,
      name: layer.name,
      type: layerType(layer),
      enabled: layer.enabled,
      in_frame: frameOf(c, layer.inPoint),
      out_frame: frameOf(c, layer.outPoint),
      selected: layer.selected
    };
    try {
      if (layer.source) info.source = layer.source.name;
    } catch (e) {}
    try {
      if (layer.threeDLayer) info.three_d = true;
    } catch (e2) {}
    try {
      if (layer.parent) info.parent = layer.parent.index;
    } catch (e3) {}
    try {
      if (layer.hasTrackMatte) info.track_matte = true;
    } catch (e4) {}
    try {
      if (layer.solo) info.solo = true;
      if (layer.locked) info.locked = true;
      if (layer.shy) info.shy = true;
      if (layer.motionBlur) info.motion_blur = true;
    } catch (e5) {}
    try {
      var fx = layer.property("ADBE Effect Parade");
      if (fx && fx.numProperties) {
        var names = [];
        for (var i = 1; i <= fx.numProperties && i <= 20; i++) names.push(fx.property(i).name);
        info.effects = names;
      }
    } catch (e6) {}
    return info;
  }

  function compInfo(c, detailed) {
    var info = {
      name: c.name,
      id: c.id,
      width: c.width,
      height: c.height,
      pixel_aspect: N.round(c.pixelAspect, 4),
      frame_rate: N.round(c.frameRate, 3),
      duration: N.round(c.duration, 3),
      frames: frameCount(c),
      layers: c.numLayers
    };
    if (!detailed) return info;
    info.current_frame = frameOf(c, c.time);
    info.work_area = { start_frame: frameOf(c, c.workAreaStart), end_frame: frameOf(c, c.workAreaStart + c.workAreaDuration) - 1 };
    try {
      info.start_timecode_frame = c.displayStartFrame;
    } catch (e) {
      info.start_timecode_frame = Math.round(c.displayStartTime * c.frameRate);
    }
    info.background = N.hex(c.bgColor);
    info.motion_blur = c.motionBlur;
    info.resolution_factor = c.resolutionFactor;
    try {
      info.renderer = c.renderer;
    } catch (e2) {}
    var layers = [];
    var selected = [];
    for (var i = 1; i <= c.numLayers; i++) {
      var layer = c.layer(i);
      if (i <= 200) layers.push(layerInfo(c, layer));
      if (layer.selected) selected.push(layer.index);
    }
    info.layer_list = layers;
    info.selected_layers = selected;
    return info;
  }

  // -------------------------------------------------------------- commands

  A.snapshot = function () {
    return { document: documentInfo(), dirty: dirty(), app_version: String(app.version) };
  };

  A.info = function () {
    var p = project();
    var counts = { comps: 0, footage: 0, folders: 0, solids: 0, stills: 0 };
    for (var i = 1; i <= p.items.length; i++) {
      var item = p.items[i];
      if (item instanceof CompItem) counts.comps++;
      else if (item instanceof FolderItem) counts.folders++;
      else if (item instanceof FootageItem) {
        if (item.mainSource instanceof SolidSource) counts.solids++;
        else if (item.mainSource && item.mainSource.isStill) counts.stills++;
        else counts.footage++;
      }
    }
    var doc = documentInfo();
    doc.dirty = dirty();
    var list = comps();
    var brief = [];
    for (var j = 0; j < list.length && j < 200; j++) brief.push(compInfo(list[j], false));
    var selection = [];
    for (var k = 0; k < p.selection.length && k < 100; k++) selection.push(p.selection[k].name);
    var active = app.project.activeItem;
    var queued = 0;
    for (var q = 1; q <= p.renderQueue.numItems; q++) {
      if (p.renderQueue.item(q).status === RQItemStatus.QUEUED) queued++;
    }
    var c = activeComp();
    return {
      app_version: String(app.version),
      document: doc,
      project: {
        items: p.numItems,
        comps: counts.comps,
        footage: counts.footage,
        stills: counts.stills,
        solids: counts.solids,
        folders: counts.folders,
        bits_per_channel: p.bitsPerChannel,
        working_space: p.workingSpace || ""
      },
      active_item: active ? { name: active.name, type: active.typeName } : null,
      active_comp: c ? compInfo(c, true) : null,
      comps: brief,
      selected_items: selection,
      render_queue: { items: p.renderQueue.numItems, queued: queued }
    };
  };

  // A footage item (not a comp) with this name or id, else null.
  function footageItem(target) {
    if (target === null || target === undefined || target === "") return null;
    var items = project().items;
    for (var i = 1; i <= items.length; i++) {
      var it = items[i];
      if (isComp(it)) {
        if (it.name === String(target) || String(it.id) === String(target)) return null;
        continue;
      }
      if (it instanceof FootageItem && (it.name === String(target) || String(it.id) === String(target))) return it;
    }
    return null;
  }

  // A still of a footage item: a temporary comp around it, removed right
  // away (After Effects still writes the frame it was asked for).
  function previewFootage(item, args) {
    var rate = item.frameRate > 0 ? item.frameRate : 24;
    var still = item.mainSource && item.mainSource.isStill;
    var frames = still ? 1 : Math.max(1, Math.round(item.duration * rate));
    var frame = args.frame === null || args.frame === undefined ? 0 : args.frame;
    if (frame < 0 || frame >= frames) N.fail("Frame " + frame + " is outside " + item.name + " (frames 0 to " + (frames - 1) + ").");
    var file = N.file(args.folder + "/frame.png");
    A.beginUndo("NOLGIA: preview");
    try {
      var temp = project().items.addComp("NOLGIA preview", item.width, item.height, item.pixelAspect, frames / rate, rate);
      temp.layers.add(item);
      temp.saveFrameToPng(frame / rate, file);
      temp.remove();
    } finally {
      A.endUndo();
    }
    return { path: file.fsName, width: item.width, height: item.height, frame: frame, source: item.name, label: item.name, background: "#000000" };
  }

  A.preview = function (args) {
    var footage = footageItem(args.target);
    if (footage) return previewFootage(footage, args);
    var c = targetComp(args.target, true);
    var frame = args.frame === null || args.frame === undefined ? frameOf(c, c.time) : args.frame;
    if (frame < 0 || frame >= frameCount(c)) {
      N.fail("Frame " + frame + " is outside " + c.name + " (frames 0 to " + (frameCount(c) - 1) + ").");
    }
    var file = N.file(args.folder + "/frame.png");
    c.saveFrameToPng(timeOf(c, frame), file);
    return {
      path: file.fsName,
      width: c.width,
      height: c.height,
      frame: frame,
      comp: c.name,
      label: c.name,
      background: N.hex(c.bgColor)
    };
  };

  function importsFolder() {
    var p = project();
    for (var i = 1; i <= p.items.length; i++) {
      var item = p.items[i];
      if (item instanceof FolderItem && item.name === FOLDER_NAME && item.parentFolder === p.rootFolder) return item;
    }
    return p.items.addFolder(FOLDER_NAME);
  }

  A["import"] = function (args) {
    var p = project();
    var file = N.file(args.path);
    if (!file.exists) N.fail("The downloaded file is missing: " + args.path);
    var options = new ImportOptions(file);
    if (!options.canImportAs(ImportAsType.FOOTAGE)) {
      N.fail("After Effects cannot import " + file.name + ".");
    }
    options.importAs = ImportAsType.FOOTAGE;
    try {
      options.sequence = false;
    } catch (e) {}
    A.beginUndo("NOLGIA: import");
    try {
      var item = p.importFile(options);
      item.parentFolder = importsFolder();
      var out = { imported: [item.name], item_id: item.id, folder: FOLDER_NAME };
      if (args.as === "layer") {
        var c = targetComp(null, true);
        var layer = c.layers.add(item);
        out.comp = c.name;
        out.layer = layer.name;
        out.layer_index = layer.index;
      }
      return out;
    } finally {
      A.endUndo();
    }
  };

  function findTemplate(list, wanted, pattern) {
    for (var i = 0; i < list.length; i++) if (list[i] === wanted) return list[i];
    for (var j = 0; j < list.length; j++) if (pattern.test(list[j])) return list[j];
    return null;
  }

  function span(c, frames) {
    var start = 0;
    var end = frameCount(c) - 1;
    if (frames) {
      start = frames[0];
      end = frames[1];
    }
    if (start < 0 || end >= frameCount(c)) {
      N.fail("Frames " + start + "-" + end + " are outside " + c.name + " (frames 0 to " + (frameCount(c) - 1) + ").");
    }
    return [start, end];
  }

  function renderMovie(c, frames, path) {
    var rq = project().renderQueue;
    if (rq.rendering) N.fail("After Effects is already rendering. Wait for it to finish.");
    var range = span(c, frames);
    var held = [];
    for (var i = 1; i <= rq.numItems; i++) {
      var other = rq.item(i);
      if (other.status === RQItemStatus.QUEUED) {
        held.push(other);
        other.render = false;
      }
    }
    var rqi = rq.items.add(c);
    try {
      try {
        var settings = findTemplate(rqi.templates, "Best Settings", /best/i);
        if (settings) rqi.applyTemplate(settings);
      } catch (e) {}
      rqi.timeSpanStart = timeOf(c, range[0]);
      rqi.timeSpanDuration = timeOf(c, range[1] - range[0] + 1);
      var om = rqi.outputModule(1);
      var template = findTemplate(om.templates, "H.264 - Match Render Settings - 15 Mbps", /^H\.264/);
      if (!template) N.fail("This After Effects has no H.264 output module template, so it cannot write MP4.");
      om.applyTemplate(template);
      om.file = N.file(path);
      rq.render();
      if (rqi.status !== RQItemStatus.DONE) {
        N.fail("After Effects did not finish the render (" + rqi.status + ").");
      }
      return { path: om.file.fsName, frames: range };
    } finally {
      try {
        rqi.remove();
      } catch (e2) {}
      for (var h = 0; h < held.length; h++) {
        try {
          held[h].render = true;
        } catch (e3) {}
      }
    }
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = "0" + s;
    return s;
  }

  A["export"] = function (args) {
    var c = targetComp(args.target, true);
    var base = args.folder + "/" + args.stem;
    if (args.format === "png") {
      var frame = args.frames ? args.frames[0] : frameOf(c, c.time);
      span(c, [frame, frame]);
      var file = N.file(base + "-" + pad4(frame) + ".png");
      c.saveFrameToPng(timeOf(c, frame), file);
      return { path: file.fsName, comp: c.name, frames: [frame, frame], width: c.width, height: c.height };
    }
    if (args.format === "mp4") {
      var out = renderMovie(c, args.frames, base + ".mp4");
      return {
        path: out.path,
        comp: c.name,
        frames: out.frames,
        width: c.width,
        height: c.height,
        duration: N.round((out.frames[1] - out.frames[0] + 1) / c.frameRate, 3)
      };
    }
    N.fail("After Effects exports mp4, png and aep.");
  };

  A.project_file = function () {
    var f = project().file;
    return { path: f ? f.fsName : null, dirty: dirty() };
  };

  A.save = function (args) {
    var p = project();
    if (!args.path) {
      if (!p.file) {
        N.fail("This project has never been saved, so there is no file to save to. Pass `path`, for example C:/Projects/shot.aep.");
      }
      p.save();
      return { path: p.file.fsName };
    }
    var file = N.file(args.path);
    N.folderOf(args.path);
    p.save(file);
    return { path: p.file ? p.file.fsName : file.fsName };
  };

  A.open_check = function (args) {
    var ext = String(args.path).toLowerCase().replace(/^.*\./, "");
    if (!N.contains(["aep", "aepx", "aet"], ext)) {
      return { error: "After Effects opens .aep projects. To bring in " + File(args.path).name + ", upload it to NOLGIA and use import_asset." };
    }
    var d = dirty();
    var hasWork = app.project && (app.project.numItems > 0 || app.project.file);
    return { loses_changes: d === true || (d === null && Boolean(hasWork)) };
  };

  A.open = function (args) {
    var file = N.file(args.path);
    if (!file.exists) N.fail("There is no file at " + args.path + ".");
    try {
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    } catch (e) {}
    var p = app.open(file);
    if (!p || !p.file) N.fail("After Effects could not open " + file.fsName + ".");
    return { path: p.file.fsName };
  };

  N.adapter = A;
})($.global.__nolgia);
