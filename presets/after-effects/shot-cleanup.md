---
slug: after-effects-shot-cleanup
name: Remove unwanted objects in After Effects
category: Film assistant
app: after_effects
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to remove the unwanted objects I point out from my shot in After Effects, keeping the texture and camera movement, and check the whole shot for patches and flicker."
---

# Remove unwanted objects in After Effects

Take something out of a shot (a sign, a stand, a crew member, a logo, a boom)
so nobody can tell it was there: the patch carries the plate's own texture and
grain, moves with the camera, and holds steady from the first frame to the
last. The plate is never changed; the cleanup lives on layers above it.

## Ask

1. What should go? Preview the first, middle and last frames first and list what
   you see that could be unwanted, so the person can point at it by name.
   (Default: the objects they named.)
2. Over which frames? (Default: the whole shot.)
3. Should NOLGIA make a clean plate when the shot has none? It costs credits
   (about 4 to 8 for one edited frame); say so. (Default: try a patch from the
   plate's own pixels first.)

## Build

1. **A new comp over the plate.** Make `NOLGIA <plate name> cleanup` with the
   plate's settings, the plate at the bottom, and a project folder
   `NOLGIA Shot Cleanup` for everything you add.
2. **Study the motion.** Preview the object every 12 frames (and every 2 to 4
   frames where it moves fast). Write down its box on each of those frames
   (left, top, right, bottom in comp pixels) and how the camera moves: locked,
   a pan, a push, handheld. The method depends on it.
3. **Pick the method for each object.**
   - *Locked camera, object never moves:* one clean frame of that area is enough.
     Take it from a frame where the object is not there, or from nearby texture
     (a copy of the plate, offset so clean ground covers the object), or have
     NOLGIA make one: export that frame with `nolgia_app_export` `png`, edit it
     with `nolgia_image_to_image` and a prompt that removes only the object and
     keeps everything else, import it with `nolgia_app_import`, and check that it
     lines up with the plate (Difference blend mode: aligned areas go black).
   - *Moving camera:* the patch must move with the plate. Set up Track Motion
     (or Mocha) on the plate and ask the person to press Track (scripts cannot),
     then apply the track to the patch. If they cannot, keyframe the patch's
     position (and scale for a push) by eye on the frames you studied and check
     the frames in between.
   - *Moving object on a busy background:* Content-Aware Fill does this best:
     draw the mask around the object (mode Subtract, keyframed to follow it),
     then ask the person to open Window > Content-Aware Fill and click Generate
     Fill Layer. Say plainly that a script cannot press that button.
4. **Reveal the patch through a mask.** On the patch layer, a mask a little
   larger than the object and its shadow or reflection, feathered 8 to 20 px so
   the edge disappears into the texture, keyframed on the studied frames if the
   object or camera moves. Name the layer `Cleanup <object>`.
5. **Match texture.** A still patch has no grain and looks painted: add
   `"ADBE Match Grain"` with the plate as the noise source. If the plate's
   exposure or colour drifts (clouds, flicker, auto exposure), add Levels on the
   patch and keyframe it where the surroundings change.
6. **Keep it editable.** No pre-comps unless needed, no rendering the patch
   into the plate. The plate stays untouched at the bottom.

## Check

- Preview every 12 frames across the whole shot at full width, and two frames
  in a row where the object moved fastest. Look for: a visible edge or a soft
  blob, texture that is too smooth or frozen on a surface that should move,
  a patch that slides against the plate, and brightness that jumps from frame to
  frame (flicker).
- For a clean plate, check alignment in Difference mode on a few frames, then
  set it back to Normal.
- Fix what you find (more feather, a bigger mask, more grain, more keyframes)
  and preview those frames again.

## Deliver

Save the project. Export an `mp4` of the cleanup comp, and a before and after:
a second comp `NOLGIA <plate name> before-after` with the plate on the left and
the cleanup on the right (or a wipe across the frame), exported as `mp4`. Tell
the person which objects were removed and how, which frames to look at closely,
and the controls: each `Cleanup` layer's mask feather and expansion, its grain,
and its keyframes.
