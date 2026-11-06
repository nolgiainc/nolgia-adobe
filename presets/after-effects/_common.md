# After Effects presets: rules every workflow follows

These instructions are served to the agent with every After Effects preset in
the Film assistant category. The agent works through the NOLGIA Bridge tools
(`nolgia_app_*`) on After Effects running on the person's own computer. Code
for `nolgia_app_run` is ExtendScript.

## Before anything changes

1. Call `nolgia_app_status`. If After Effects is not listed, stop and tell the
   person in two lines: install NOLGIA for Adobe from nolgia.ai/plugins, then
   open Window > Extensions > NOLGIA in After Effects and sign in. Do not guess
   or continue without it.
2. Call `nolgia_app_info`. Read what is really open: the project file and
   whether it has unsaved changes, the active comp (size, frame rate, frames,
   layers with their types and effects) and the other comps. Describe it back in
   one sentence so the person can correct you.
3. Keep the person's work safe. Read `nolgia_work` in the info:
   - `save_after_change: true` (NOLGIA for Adobe 0.3.0 and newer, the
     default): the plugin does it. Before your first change it backs the
     project up (a byte copy in `NOLGIA backups` next to it, unsaved changes
     included), and after each `nolgia_app_run` or `nolgia_app_import` it saves
     the project in place; each result says `saved` and `backups`. A project
     that was never saved goes into Documents/NOLGIA projects first: tell the
     person where (the result's `notes`).
   - `save_after_change: false`, or no `nolgia_work` (an older plugin): make the
     safety copy with `nolgia_app_export` format `aep` (a copy of the project as
     last saved, next to it, never over a file); if there are unsaved changes,
     ask the person to save first. Then `nolgia_app_save` with no `path` after
     each step that changes the project. If the project was never saved, ask
     where to save it and save with `nolgia_app_save` `path`.
   - Never use `nolgia_app_save` with a `path` as a safety copy. Before 0.3.0
     that is Save As: the open project moves onto the new file, every later
     change goes there, and the person's own file never gets them.
   - When `nolgia_work.last.open_now` is false after a crash, NOLGIA's last
     saved work is in `nolgia_work.last.project`: tell the person, and open it
     only when they say so.
4. Ask only the questions the workflow lists. Offer a sensible default for each
   so the person can just say "go".

## While working

- Reach After Effects only through these NOLGIA tools. Never drive it from outside the
  plugin: no AppleScript or `osascript`, no COM, no Windows UI automation, no
  simulated keystrokes or clicks, and not any other tool that scripts the app from outside. Those skip the
  person's Activity list, "Ask before running code" and the plugin's error
  handling, and a bad call that way can crash After Effects and lose unsaved work.
- Work in small steps: one `nolgia_app_run` per logical step, each returning a
  short summary in `result` (comp names, layer names and indexes, frame
  ranges). Each run is one undo step in After Effects.
- Never delete, rename, move or re-time the person's existing comps, layers or
  footage unless they asked. Build in a new comp named after the workflow (for
  example `NOLGIA Shot 010 comp`) that uses their footage as layers, and put
  every item you add in a project folder named after the workflow.
- Keep everything editable: effects stay live with their controls, masks stay
  masks, tracking stays as keyframes or expressions. No pre-rendering or
  "Convert to Layered Comp" unless the workflow says so.
- After each visible change, call `nolgia_app_preview` (with `comp` and
  `frame`) and look at the image before moving on. If it looks wrong, fix it
  before the next step. Do not describe a result you have not seen.
- Renders run on the person's computer: `nolgia_app_export` `mp4` renders the
  comp through the render queue (H.264) and can take minutes. If a tool hands
  back a `command_id`, follow it with `nolgia_app_command` instead of starting it
  again.
- If code fails, read the error (it names the line and shows it), fix the code
  and try once more. After two failures on the same step, explain what failed in
  plain words and ask how to proceed.

## Change only what the person points at

- Before a change, work out its scope and say it back in one line, with the
  frames ("Keying layer 1, frames 108 to 140 only"). In this order: a layer,
  comp or time range the person names; the selected layers; a work area that
  is not the whole comp; the layer under the playhead. `nolgia_app_info` gives
  `active_comp.scope` (`selected_layers`, `work_area`,
  `work_area_is_whole_comp`, `playhead_frame`, `layers_under_playhead`; older
  plugins: `selected_layers`, `work_area`, `current_frame`) and every layer's
  `in_frame` and `out_frame`. A layer the person placed over only
  part of the timeline (a background still) marks the range too.
- A timecode (HH:MM:SS:FF, or SS:FF) is frames at the comp's frame rate:
  00:04:12 at 24 fps is 4 x 24 + 12 = frame 108, counted from the comp's
  start; subtract `start_timecode_frame` when the comp does not start at 0.
- Change only that part. For part of a layer's time, split that range into its
  own layer (duplicate it, set the copy's in and out points to the range, trim
  the original around it) and put effects on that piece; a new comp for the
  work is as long as the range. Never key, grade or track a whole layer when
  the person named a part of it, and never move, remove or precompose layers
  outside the scope (after `precompose`, the person's layers stay where they
  were).
- The whole comp only when the person asks for it or nothing narrower exists.
  When the scope is unclear and the change is heavy (a key, a grade, a track or
  a stack of effects on footage longer than about 10 seconds), ask one short
  question with the default you would take.
- A layer with `dynamic_link: true` (also in `dynamic_link_items`) is a
  Premiere Pro sequence that Premiere renders for After Effects frame by frame:
  slow and memory-heavy at 4K. Never duplicate it whole (no second or third
  copy for a core matte, a clean plate or a light wrap: those copies cover the
  range only), never add effects to all of it for a part, and preview only
  frames inside the range. After Effects can fall over under several 4K copies
  of a long Dynamic Link sequence with keys and grades on each.
- Previews: `nolgia_app_preview` at the width you need (768 is enough to judge
  a key; the plugin renders at a lower resolution to match). Export a full-size
  `png` only for a frame the person will keep. To preview or export a comp that
  is not the active one (a helper comp of only the range), pass its name as
  `comp`: never open it in the person's viewer.
- When you finish, say what changed and what did not: the comp and layers, the
  frames, the effects added; then "Not touched:" the rest (the other frames,
  the person's other layers and comps). Name the file it is saved in (`saved`)
  and the backup (`backups`).

## A person on a green screen: keep them exactly as filmed

When the person keys themselves and says "don't change anything on me", "only
remove the green" or "match the background to me", that wins over every step
of a workflow that grades the element toward the plate:

- Nothing on the person's layers but the key (Keylight, spill suppression on
  the edge). No colour, exposure, grain, light wrap, rim, blur or resampling
  on them. Every match (black level, brightness, colour of light, saturation,
  a lens blur, the footage's grain) goes on the background layer, measured
  with `sampleImage` on both.
- Keylight alone still moves the inside of the matte (its clip and despill):
  lay the untouched clip again ABOVE the keyed layer, no effects, with an
  ALPHA track matte from a precomp of the clip keyed hard (Clip Black 40, Clip
  White 70) and choked about 6 px (`"ADBE Simple Choker"`). The person's solid
  pixels are then the clip's own; the keyed layer only shows at the edge.
- Read the light direction on both before saying anything about it (the
  person's brighter cheek, the plate's shadows). When they differ, offer to
  mirror the background (free) or a relit copy of the picture made on NOLGIA
  (priced first).

## ExtendScript that bites (After Effects)

- It is ES3: no `let`, `const`, arrow functions, template strings,
  `Array.prototype.indexOf`, `map` or `forEach`, and no `JSON` object. Words ES3
  reserves (`short`, `int`, `class`, `char`, `final`, `native` ...) cannot be
  variable names. Return data by setting `result` (or as the last expression);
  the plugin turns it into JSON.
- Collections count from 1: `app.project.item(1)`, `comp.layer(1)` (the top
  layer). Adding a layer puts it at index 1 and shifts every other index, so keep
  references to layers, not their numbers.
- `app.project.activeItem` is only the comp in the viewer. Open a comp with
  `comp.openInViewer()` before relying on it, or find comps by name.
- Times are seconds. Frame n of a comp is `n / comp.frameRate`; the plugin's
  `frame` arguments count from 0 at the comp's first frame, whatever its start
  timecode.
- Add effects and reach properties by match name, never by display name, which
  changes with the app's language: `layer.property("ADBE Effect Parade")
  .addProperty("ADBE Gaussian Blur 2")`, `layer.property("ADBE Transform Group")
  .property("ADBE Position")`. Do not guess match names: `app.effects` lists
  every installed effect's `displayName` and `matchName` (Keylight is
  `"Keylight 906"`, Match Grain `"VISINF Grain Duplication"`, CC Rainfall
  `"CSRainfall"`). An effect's parameters are reached by index or by their own
  match names; list them once (`effect.property(i).name`) before setting them.
- Popup (menu) parameters count from 1. Some values (custom ones such as
  histograms) throw when read or turned into text: read only what you need.
- Adding, removing or moving an effect (`addProperty`, `remove`, `moveTo`) makes
  existing references to the effects on that layer invalid ("Object is
  invalid"), and every line after that fails: get them again by name or match
  name after each change.
- Mask vertices are in the layer's own pixels, not the comp's: on a scaled or
  moved layer, convert the comp points first, and on a flipped layer (negative
  scale) mirror them.
- Track mattes can point at any layer: `layer.setTrackMatte(matteLayer,
  TrackMatteType.LUMA)` (or `ALPHA`), and the matte layer is switched off for you.
  `comp.layers.precompose(indices, name, true)` moves layers into a new comp
  and leaves one layer in their place.
- A step that fails halfway keeps what it changed before the error. Write steps
  so they can run twice (find the layer or effect before adding it again).
- Menu commands (`app.executeCommand(app.findMenuCommandId("..."))`, for layer
  styles and the like) act on the selected layers and need the comp open in the
  viewer (`comp.openInViewer()`).
- A property with keyframes ignores `setValue`; use `setValueAtTime` or remove
  the keyframes first. After setting an expression, read `prop.expressionError`:
  an empty string means it works.
- Solids made with `layers.addSolid` land in the project's Solids folder;
  footage from `nolgia_app_import` lands in `NOLGIA imports`.
- The 3D Camera Tracker, Warp Stabilizer and Content-Aware Fill analyse in the
  app, but their buttons (Create Camera, Track, Generate Fill Layer) cannot be
  pressed from a script. Set the effect up, then ask the person to press the
  button and tell you when it is done.
- A modal dialog in After Effects (a warning at start up, a missing font) holds
  every script until someone closes it. If a command sits in `running` for no
  reason, ask the person to look at After Effects.

## Using NOLGIA where it helps

- A missing element (a sky, a background plate, a prop, an atmospheric layer):
  make a still with `nolgia_text_to_image` or a short clip with
  `nolgia_text_to_video` / image to video, then bring it in with
  `nolgia_app_import`. For an element that needs a clean edge, generate it on a
  plain background and cut it out with `remove-background`.
- These generations cost credits: say what you are about to make and roughly
  what it costs (read it from the tool's estimate) before you run it, and make it
  only when After Effects cannot build it (procedural fog, rain, glows and grain
  add no generation cost). Work in After Effects itself adds no generation cost.

## Finishing

1. Save the project in place: with `save_after_change` the last change's result
   already says `saved`; otherwise `nolgia_app_save` with no `path`. Never save
   over a different file, and never Save As (`save_as`) unless the person asks
   for the project under a new name.
2. Export a preview with `nolgia_app_export` (`mp4` of the finished comp, or
   `png` for a still) so the person has it in their NOLGIA library, and show a
   still.
3. Tell the person, in a few lines: what you changed and on which frames, what
   you did not touch, where it lives (comp and folder names), the one or two
   controls they are most likely to adjust and where those are, the file it is
   saved in and the path of the backup or safety copy.
