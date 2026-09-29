// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 NOLGIA Inc
//
// Scale and re-encode images with the panel's own canvas: previews are
// shrunk to the size the agent asked for (JPEG when a PNG would be too big),
// and WebP from NOLGIA becomes PNG, which Adobe's apps read.

/* global window, document, Blob, URL, Image */
"use strict";

(function () {
  const fs = require("fs");

  function mimeOf(head) {
    if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
    if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
    if (head.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
    if (head.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
    return "application/octet-stream";
  }

  function load(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("the image could not be read"));
      img.src = url;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the image could not be encoded"))), type, quality);
    });
  }

  // Convert `src` to `dest` (png or jpeg), `width` pixels wide at most
  // (never larger than the source). Resolves {width, height}.
  async function convertImage(src, dest, options) {
    const opts = options || {};
    const data = fs.readFileSync(src);
    const url = URL.createObjectURL(new Blob([data], { type: mimeOf(data) }));
    let img;
    try {
      img = await load(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    let source = img;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const width = opts.width ? Math.max(1, Math.min(opts.width, w)) : w;
    const height = Math.max(1, Math.round((h * width) / w));
    // Halve in steps first: one big downscale on a canvas aliases.
    while (w / 2 >= width * 1.01) {
      const step = document.createElement("canvas");
      step.width = Math.max(width, Math.round(w / 2));
      step.height = Math.max(height, Math.round(h / 2));
      const sctx = step.getContext("2d");
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(source, 0, 0, step.width, step.height);
      source = step;
      w = step.width;
      h = step.height;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const jpeg = opts.format === "jpeg";
    if (opts.background || jpeg) {
      ctx.fillStyle = opts.background || "#000000";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    const blob = await toBlob(canvas, jpeg ? "image/jpeg" : "image/png", jpeg ? opts.quality || 0.9 : undefined);
    fs.writeFileSync(dest, Buffer.from(await blob.arrayBuffer()));
    return { width, height };
  }

  window.NolgiaImaging = { convertImage };
})();
