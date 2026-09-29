// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// NOLGIA for Illustrator: the app side of each command.
//
// Artboards are numbered from 1, as Illustrator's Artboards panel shows
// them. Sizes are in points (1/72 inch), which is also pixels at 100%.

(function (N) {
  var A = {};
  var LAYER_NAME = "NOLGIA imports";
  var EXPORT_LONG_SIDE = 2048; // png export: at least this many pixels on the long side

  A.quiet = function () {
    var level = null;
    try {
      level = app.userInteractionLevel;
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    } catch (e) {}
    return { level: level };
  };

  A.unquiet = function (guard) {
    try {
      if (guard && guard.level !== null) app.userInteractionLevel = guard.level;
    } catch (e) {}
  };

  function doc(required) {
    if (app.documents.length) return app.activeDocument;
    if (required === false) return null;
    N.fail("Illustrator has no document open. Open or create one first.");
  }

  function savedPath(d) {
    try {
      if (d.path && d.path.fsName && d.fullName && d.fullName.exists) return d.fullName.fsName;
    } catch (e) {}
    return null;
  }

  function documentInfo() {
    var d = doc(false);
    if (!d) return { name: "" };
    var path = savedPath(d);
    return path ? { name: d.name, path: path } : { name: "" };
  }

  function round(v) {
    return N.round(v, 2);
  }

  function artboardInfo(d, ab, index, active) {
    var r = ab.artboardRect; // left, top, right, bottom (y up)
    return {
      number: index + 1,
      name: ab.name,
      width: round(r[2] - r[0]),
      height: round(r[1] - r[3]),
      rect: [round(r[0]), round(r[1]), round(r[2]), round(r[3])],
      active: index === active
    };
  }

  function layerInfo(layer, depth) {
    var info = {
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      items: layer.pageItems.length
    };
    if (layer.layers.length) {
      info.sublayers = [];
      for (var i = 0; i < layer.layers.length && depth < 3; i++) info.sublayers.push(layerInfo(layer.layers[i], depth + 1));
    }
    return info;
  }

  // The artboard a command is about: by name or number, else the active one.
  // Returns its 0-based index.
  function targetArtboard(d, target) {
    if (target === null || target === undefined || target === "") return d.artboards.getActiveArtboardIndex();
    if (typeof target === "number") {
      if (target < 1 || target > d.artboards.length) {
        N.fail("There is no artboard " + target + "; this document has " + d.artboards.length + ".");
      }
      return target - 1;
    }
    for (var i = 0; i < d.artboards.length; i++) if (d.artboards[i].name === String(target)) return i;
    var names = [];
    for (var j = 0; j < d.artboards.length && j < 30; j++) names.push(d.artboards[j].name);
    N.fail("There is no artboard named " + target + ". Artboards: " + names.join(", ") + ".");
  }

  // ------------------------------------------------------------- commands

  A.snapshot = function () {
    var d = doc(false);
    return { document: documentInfo(), dirty: d ? !d.saved : false, app_version: String(app.version) };
  };

  A.info = function () {
    var d = doc(false);
    var docs = [];
    for (var i = 0; i < app.documents.length; i++) docs.push(app.documents[i].name);
    if (!d) return { app_version: String(app.version), document: { name: "", dirty: false }, documents: docs };
    var info = documentInfo();
    info.title = d.name;
    info.dirty = !d.saved;
    var active = d.artboards.getActiveArtboardIndex();
    var boards = [];
    for (i = 0; i < d.artboards.length; i++) boards.push(artboardInfo(d, d.artboards[i], i, active));
    var layers = [];
    for (i = 0; i < d.layers.length && i < 200; i++) layers.push(layerInfo(d.layers[i], 0));
    var selection = [];
    var sel = d.selection;
    if (sel && sel.length) {
      for (i = 0; i < sel.length && i < 200; i++) selection.push({ type: sel[i].typename, name: sel[i].name || "" });
    }
    return {
      app_version: String(app.version),
      document: info,
      documents: docs,
      color_space: String(d.documentColorSpace).replace("DocumentColorSpace.", ""),
      ruler_units: String(d.rulerUnits).replace("RulerUnits.", ""),
      width: round(d.width),
      height: round(d.height),
      artboards: boards,
      active_artboard: active + 1,
      layers: layers,
      selection: selection,
      counts: {
        page_items: d.pageItems.length,
        paths: d.pathItems.length,
        compound_paths: d.compoundPathItems.length,
        groups: d.groupItems.length,
        placed: d.placedItems.length,
        raster: d.rasterItems.length,
        text: d.textFrames.length,
        symbols: d.symbolItems.length,
        swatches: d.swatches.length
      }
    };
  };

  // Export one artboard as PNG24 at `scale` percent. Returns the file.
  function exportPng(d, index, file, scale, transparent) {
    var before = d.artboards.getActiveArtboardIndex();
    d.artboards.setActiveArtboardIndex(index);
    try {
      var opts = new ExportOptionsPNG24();
      opts.artBoardClipping = true;
      opts.antiAliasing = true;
      opts.transparency = Boolean(transparent);
      opts.saveAsHTML = false;
      opts.horizontalScale = scale;
      opts.verticalScale = scale;
      d.exportFile(file, ExportType.PNG24, opts);
    } finally {
      d.artboards.setActiveArtboardIndex(before);
    }
    if (file.exists) return file;
    // Some versions add the artboard name to the file name.
    var found = file.parent.getFiles("*.png");
    if (found.length) return found[0];
    N.fail("Illustrator did not write the PNG.");
  }

  function boardSize(d, index) {
    var r = d.artboards[index].artboardRect;
    return { width: r[2] - r[0], height: r[1] - r[3] };
  }

  A.preview = function (args) {
    var d = doc();
    var index = targetArtboard(d, args.target);
    var size = boardSize(d, index);
    var want = args.width || 1280;
    // Illustrator scales between 1% and 776%.
    var scale = Math.max(1, Math.min(776, Math.ceil((want / size.width) * 100)));
    var file = exportPng(d, index, N.file(args.folder + "/frame.png"), scale, false);
    return {
      path: file.fsName,
      width: Math.round((size.width * scale) / 100),
      height: Math.round((size.height * scale) / 100),
      artboard: d.artboards[index].name,
      label: d.name + ", " + d.artboards[index].name,
      background: "#ffffff"
    };
  };

  function importsLayer(d) {
    for (var i = 0; i < d.layers.length; i++) if (d.layers[i].name === LAYER_NAME) return d.layers[i];
    var layer = d.layers.add();
    layer.name = LAYER_NAME;
    return layer;
  }

  // Centre `item` on the active artboard.
  function centre(d, item) {
    var r = d.artboards[d.artboards.getActiveArtboardIndex()].artboardRect;
    var b = item.geometricBounds; // left, top, right, bottom
    var w = b[2] - b[0];
    var h = b[1] - b[3];
    item.position = [(r[0] + r[2]) / 2 - w / 2, (r[1] + r[3]) / 2 + h / 2];
  }

  A["import"] = function (args) {
    var file = N.file(args.path);
    if (!file.exists) N.fail("The downloaded file is missing: " + args.path);
    if (args.kind !== "image" && args.kind !== "vector") {
      N.fail("Illustrator imports images and vector files (SVG, PDF, AI, EPS), not " + args.kind + ".");
    }
    var d = doc(false);
    if (!d) {
      var opened = app.open(file);
      return { imported: [opened.name], document: opened.name, opened_as_document: true };
    }
    var layer = importsLayer(d);
    var wasLocked = layer.locked;
    layer.locked = false;
    layer.visible = true;
    var item;
    if (args.kind === "vector") {
      item = layer.groupItems.createFromFile(file);
    } else {
      var placed = layer.placedItems.add();
      placed.file = file;
      item = placed;
      if (args.as !== "link") {
        var before = layer.rasterItems.length;
        placed.embed();
        item = layer.rasterItems.length > before ? layer.rasterItems[0] : null;
        if (!item) N.fail("Illustrator placed the image but did not embed it.");
      }
    }
    item.name = args.name || file.name;
    centre(d, item);
    layer.locked = wasLocked;
    return { imported: [item.name], type: item.typename, layer: LAYER_NAME, linked: args.as === "link" };
  };

  function svgOptions() {
    var opts = new ExportOptionsSVG();
    opts.embedRasterImages = true;
    opts.fontType = SVGFontType.OUTLINEFONT;
    opts.coordinatePrecision = 3;
    try {
      opts.documentEncoding = SVGDocumentEncoding.UTF8;
    } catch (e) {}
    try {
      opts.cssProperties = SVGCSSPropertyLocation.PRESENTATIONATTRIBUTES;
    } catch (e2) {}
    return opts;
  }

  A["export"] = function (args) {
    var d = doc();
    var index = targetArtboard(d, args.target);
    if (args.format === "png") {
      var size = boardSize(d, index);
      var longSide = Math.max(size.width, size.height);
      var scale = Math.max(100, Math.min(400, Math.ceil((EXPORT_LONG_SIDE / longSide) * 100)));
      var file = exportPng(d, index, N.file(args.folder + "/" + args.stem + ".png"), scale, true);
      return {
        path: file.fsName,
        artboard: d.artboards[index].name,
        width: Math.round((size.width * scale) / 100),
        height: Math.round((size.height * scale) / 100)
      };
    }
    var target = N.file(args.file);
    N.folderOf(args.file);
    var before = d.artboards.getActiveArtboardIndex();
    if (args.format === "svg") {
      d.artboards.setActiveArtboardIndex(index);
      try {
        var opts = svgOptions();
        try {
          opts.saveMultipleArtboards = true;
          opts.artboardRange = String(index + 1);
        } catch (e) {}
        d.exportFile(target, ExportType.SVG, opts);
      } finally {
        d.artboards.setActiveArtboardIndex(before);
      }
      var written = target.exists ? target : findSibling(target, ".svg");
      // Illustrator adds the artboard number ("-01"); keep the name asked for.
      if (written.fsName !== target.fsName && !target.exists && written.rename(target.name)) written = target;
      return { path: written.fsName, artboard: d.artboards[index].name };
    }
    if (args.format === "pdf") {
      // Export for Screens writes a PDF without switching the open document
      // to it (Save As PDF would).
      var folder = new Folder(target.parent.fsName + "/nolgia-pdf-" + new Date().getTime());
      folder.create();
      var pdfOpts = new ExportForScreensPDFOptions();
      var items = new ExportForScreensItemToExport();
      items.artboards = String(index + 1);
      items.document = false;
      d.exportForScreens(folder, ExportForScreensType.SE_PDF, pdfOpts, items, "nolgia-");
      var pdfs = findAll(folder, ".pdf");
      if (!pdfs.length) N.fail("Illustrator did not write the PDF.");
      pdfs[0].copy(target.fsName);
      for (var i = 0; i < pdfs.length; i++) pdfs[i].remove();
      removeTree(folder);
      if (!target.exists) N.fail("Illustrator did not write the PDF.");
      return { path: target.fsName, artboard: d.artboards[index].name };
    }
    N.fail("Illustrator exports png, svg, pdf and ai.");
  };

  function findSibling(file, ext) {
    var found = file.parent.getFiles("*" + ext);
    var stem = file.name.replace(/\.[^.]*$/, "");
    for (var i = 0; i < found.length; i++) {
      if (decodeURI(found[i].name).indexOf(decodeURI(stem)) === 0) return found[i];
    }
    N.fail("Illustrator did not write the " + ext.substr(1).toUpperCase() + ".");
  }

  function findAll(folder, ext) {
    var out = [];
    var entries = folder.getFiles();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] instanceof Folder) out = out.concat(findAll(entries[i], ext));
      else if (entries[i].name.toLowerCase().slice(-ext.length) === ext) out.push(entries[i]);
    }
    return out;
  }

  function removeTree(folder) {
    var entries = folder.getFiles();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] instanceof Folder) removeTree(entries[i]);
      else entries[i].remove();
    }
    folder.remove();
  }

  A.project_file = function () {
    var d = doc();
    return { path: savedPath(d), dirty: !d.saved };
  };

  A.save = function (args) {
    var d = doc();
    if (!args.path) {
      if (!savedPath(d)) {
        N.fail("This document has never been saved, so there is no file to save to. Pass `path`, for example C:/Projects/logo.ai.");
      }
      d.save();
      return { path: savedPath(d) };
    }
    N.folderOf(args.path);
    var opts = new IllustratorSaveOptions();
    opts.pdfCompatible = true;
    d.saveAs(N.file(args.path), opts);
    return { path: savedPath(app.activeDocument) || N.file(args.path).fsName };
  };

  A.open_check = function (args) {
    // Illustrator opens the other file in its own window; nothing is lost.
    return { loses_changes: false };
  };

  A.open = function (args) {
    var file = N.file(args.path);
    if (!file.exists) N.fail("There is no file at " + args.path + ".");
    var d = app.open(file);
    return { path: savedPath(d) || file.fsName, name: d.name };
  };

  N.adapter = A;
})($.global.__nolgia);
