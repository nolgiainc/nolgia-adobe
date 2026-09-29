---
slug: illustrator-vectorize
name: Vectorize an image in Illustrator
category: Film assistant
app: illustrator
min_app_version: "29.0"
starter_prompt: "Use NOLGIA to turn my image into clean, editable vector art in Illustrator, keeping its composition and colours, organized into named layers and groups."
---

# Vectorize an image in Illustrator

Rebuild a raster illustration, logo or poster as vector art that looks the same
at any size: traced with settings tuned to this image, expanded into real
paths, grouped and named by colour and role, with stray specks removed and the
palette saved as swatches. The original image stays in the document, hidden.

## Ask

1. Which image? The selected or placed image in the open document (default), a
   file on their computer, or an image in their NOLGIA library (bring it in with
   `nolgia_app_import`).
2. What kind of art is it? Look at it with `nolgia_app_preview` first and
   suggest one: flat art or a logo (few colours, crisp corners), a detailed
   illustration (more colours, smooth curves), line art (black and white), or a
   photo (posterised look). (Default: your suggestion.)
3. What must stay most faithful: faces, lettering, thin lines, small details?
   Those get more path fidelity, or are rebuilt by hand after the trace.
4. How many colours? (Default: the number of distinct flat colours you see,
   usually 6 to 16.)

## Build

1. **Keep the original.** If the image came in with nothing open, it opened as
   its own document: save it as a new `.ai` first (`nolgia_app_save` with a path
   ending in `.ai`, next to the image). Rename its layer `Source image`,
   duplicate the image onto a new layer `Vector art` (show and unlock
   `Source image` while you duplicate: a hidden layer refuses edits), then hide
   and lock `Source image`. Only the copy is traced.
2. **Trace the original, not an upscale.** An AI upscale paints texture into
   flat areas, and the trace turns that texture into extra shapes and halos.
   Trace flat art and illustrations from the image as it is. Offer an upscale
   (NOLGIA's Topaz models, about 7 credits) only for small, blurry line art or
   photos, and compare both traces before keeping one.
3. **Trace with settings for this art.** `trace()` the copy, then set
   `tracing.tracingOptions`, and call `app.redraw()` so it traces again:
   - flat art or a logo: `tracingMode` colour, `tracingColorTypeValue` limited,
     `tracingColors` one or two more than the flat colours you count,
     `pathFidelity` about 75, `cornerFidelity` 100, `noiseFidelity` about 16 px,
     `tracingMethod` abutting, `snapCurveToLines` on;
   - detailed illustration: more colours, `pathFidelity` 85 to 95,
     `noiseFidelity` 5 to 10, `cornerFidelity` about 75;
   - line art: black and white mode, `threshold` set so thin lines stay whole,
     `ignoreWhite` on;
   - photo: colour mode, 16 to 30 colours, `noiseFidelity` 10 to 20.
   Keep the abutting method: its shapes do not overlap, so they can be regrouped
   later without changing the picture.
4. **Compare and tune.** Preview the trace, then the source (hide one, show the
   other), and look closely at straight edges (they should stay straight), small
   shapes, lettering and the colours. Adjust fidelity, noise and colours, and
   repeat two or three times at most.
5. **Expand.** `tracing.expandTracing()` turns the trace into a group of paths.
   Name it `Vector art`.
6. **Merge near-identical colours.** The trace splits one flat colour into two
   or three shades (`#f7ebcc` and `#f7edcd`). Give every path the colour of the
   shade that covers the most area, so the art has one colour per flat colour.
   Report the final palette.
7. **Clean specks without making holes.** In an abutting trace a small shape
   usually fills a hole in the shape around it, so deleting it leaves a pinhole.
   Recolour a speck of an odd colour to the colour around it instead, and if the
   person wants fewer paths, merge same-colour specks into the shape around them
   (select both, `app.executeMenuCommand("Live Pathfinder Add")`, then
   `"expandStyle"`). Delete only white background shapes, and only when the
   person does not want a background.
8. **Organise.** Where the art has clear objects (a character, a logo mark, a
   sun), make a sublayer for each and one for what is behind them, and inside
   each a group per colour named for it, a plain colour name and the hex value
   (`Fox red #e33c26`). Art without clear objects gets sublayers by role:
   `Background`, `Shapes`, `Details`, `Lines`. Order them back to front as the
   trace had them.
9. **Look for flecks.** Regrouping can bring a tiny shape to the front that was
   hidden before (two shapes on one spot), or show a hole whose filler you moved.
   Preview close-ups of busy areas and fix what you see: recolour a fleck to its
   surroundings, or remove the tiny hole sub-path from its compound path.
10. **Swatches.** Add a swatch group `NOLGIA palette` with the final colours so
    the person can recolour the art in one place.
11. **Rebuild what needs it.** Lettering and small logos rarely trace well. If
    the person marked them as important, say so and offer to rebuild them as
    live text or clean shapes by hand, or leave them for the person.

## Check

- Preview the vector art and the source at the same size, side by side (one
  preview each), and at least one close-up of the most detailed area. The
  composition, colours and the important shapes must match; no specks, holes or
  lost details.
- Look at a close-up of the busiest area at full width: no pinholes, no
  flecks of a colour that is not there in the source.
- Report the numbers: colours, paths, groups, and specks recoloured.

## Deliver

Save as a new `.ai` next to the source (never over the source image or another
file), export a `png` preview with `nolgia_app_export`, and an `svg` if the
person wants one (it stays on their computer). Tell them: the layers and groups,
how to recolour with the `NOLGIA palette` swatches, the trace settings used, and
anything they may want to redraw by hand.
