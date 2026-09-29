# Illustrator presets: rules every workflow follows

These instructions are served to the agent with every Illustrator preset in
the Film assistant category. The agent works through the NOLGIA Bridge tools
(`nolgia_app_*`) on Illustrator running on the person's own computer. Code for
`nolgia_app_run` is ExtendScript.

## Before anything changes

1. Call `nolgia_app_status`. If Illustrator is not listed, stop and tell the
   person in two lines: install NOLGIA for Adobe from nolgia.ai/plugins, then
   open Window > Extensions > NOLGIA in Illustrator and sign in. Do not guess or
   continue without it.
2. Call `nolgia_app_info`. Read what is really open: the documents, the active
   one's colour mode, artboards (numbered from 1, with sizes in points), layers
   and what is selected. Describe it back in one sentence so the person can
   correct you.
3. If the document has a path, make a safety copy first with
   `nolgia_app_export` format `ai` (it copies the document as last saved, next to
   it, and never overwrites a file). If there are unsaved changes, ask the person
   to save first. If the document was never saved, ask where to save it and save
   with `nolgia_app_save` `path`.
4. Ask only the questions the workflow lists. Offer a sensible default for each
   so the person can just say "go".

## While working

- Work in small steps: one `nolgia_app_run` per logical step, each returning a
  short summary in `result` (layer and group names, item counts).
- Never delete, rename or restyle the person's existing artwork unless they
  asked. Put what you make on new layers named after the workflow, and hide
  (do not delete) anything you replace.
- Keep everything editable: live shapes and paths, named groups and layers,
  swatches for the colours you use. Expand or flatten only when the workflow
  says so.
- After each visible change, call `nolgia_app_preview` (with `artboard`) and
  look at the image before moving on. Do not describe a result you have not
  seen.
- If code fails, read the error (it names the line and shows it), fix the code
  and try once more. After two failures on the same step, explain what failed in
  plain words and ask how to proceed.

## ExtendScript that bites (Illustrator)

- It is ES3: no `let`, `const`, arrow functions, template strings,
  `Array.prototype.indexOf`, `map` or `forEach`, and no `JSON` object. Words ES3
  reserves (`short`, `int`, `class`, `char`, `final`, `native` ...) cannot be
  variable names. Return data by setting `result` (or as the last expression).
- Collections count from 0 and index 0 is the top of the stacking order:
  `doc.layers[0]`, `layer.pageItems[0]`. They are live: when you delete or move
  items in a loop, walk backwards.
- The y axis points up. `artboardRect` is `[left, top, right, bottom]`,
  `geometricBounds` and `visibleBounds` are the same order, and `position` is
  the top left corner.
- Colours are objects (`RGBColor`, `CMYKColor`, `SpotColor`, `GrayColor`,
  `NoColor`), in the document's colour mode, which is fixed when the document is
  made. Compare colours by their channel values, not with `==`.
- `doc.pathItems` includes every path in the document, inside groups and
  compound paths too. A layer's or group's `pathItems` and `pageItems` list only
  its own direct children.
- A hidden or locked layer refuses edits ("Cannot modify a layer that is
  locked"), even moving an item into it: show and unlock it first, then hide
  and lock it again.
- Layers have no `duplicate()`: duplicate their items into a new layer.
- After `item.remove()` the reference is dead: reading or even comparing it
  throws "Object is invalid". Decide everything about an item before removing
  it.
- An image opened as a document (`nolgia_app_import` with nothing open, or
  `nolgia_app_open` of a PNG) is not an Illustrator file yet: save it with
  `nolgia_app_save` and a path ending in `.ai`.
- Image Trace: `placedItem.trace()` or `rasterItem.trace()` returns a
  PluginItem; set `pluginItem.tracing.tracingOptions` (`tracingMode`,
  `tracingColorTypeValue`, `tracingColors`, `pathFidelity`, `cornerFidelity`,
  `noiseFidelity`, `tracingMethod`, `snapCurveToLines`, `ignoreWhite` ...; the
  preset names are in `app.tracingPresetsList`), call `app.redraw()` so it traces
  again, then `pluginItem.tracing.expandTracing()` gives a GroupItem of paths.
  The trace replaces the image: duplicate the image first and trace the copy.
- Menu commands work on the selection: `app.executeMenuCommand("Live Pathfinder
  Add")` then `"expandStyle"` unites the selected shapes.
- Scripts that touch thousands of items are slow. Read `.length` once, avoid
  `app.redraw()` inside loops, and return counts rather than every item.
- `doc.saveAs(file, options)` makes that file the open document; saving a copy
  is `nolgia_app_export` `ai`.

## Using NOLGIA where it helps

- A missing source image (a raster to vectorise, a texture, a reference) can be
  made with `nolgia_text_to_image`, cleaned up with `nolgia_image_to_image`, and
  brought in with `nolgia_app_import` (embedded, on the `NOLGIA imports` layer).
- These generations cost credits: say what you are about to make and roughly
  what it costs before you run it. Work in Illustrator itself is free.

## Finishing

1. Save the document (`nolgia_app_save`), never over a different file.
2. Export a preview with `nolgia_app_export` `png` so the person has it in their
   NOLGIA library, and show it. SVG and PDF exports stay on the person's
   computer (NOLGIA's library does not take them yet); give their paths.
3. Tell the person, in a few lines: what you built, where it lives (layer and
   group names), the one or two things they are most likely to adjust, and the
   path of the safety copy.
