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
   (left, top, right, bottom in comp pixels), and compare a static feature (a
   trunk, a corner, a sign) on the first and last frame to see whether the
   camera moves: locked, a pan, a push, handheld. The method depends on it.
3. **Pick the method for each object.**
   - *Locked camera, object never moves:* one clean frame of that area is enough.
     Take it from a frame where the object is not there, or from nearby texture
     (a copy of the plate, offset so clean ground covers the object), or have
     NOLGIA make one: export that frame with `nolgia_app_export` `png`, and give
     it to `nolgia_image_to_image` as the source image (`image_url`) with an
     editing model (`flux-kontext-pro`, about 4 credits) and a prompt that
     removes only the object and its shadow and keeps everything else. A model
     that only takes the frame as a loose reference paints a different scene.
     Import the result with `nolgia_app_import`. It may come back at another
     size or aspect: scale it to the plate's width, centre it, and check with
     the Difference blend mode that everything outside the object goes black
     (then set it back to Normal).
   - *Moving camera:* the patch must move with the plate. Set up Track Motion
     (or Mocha) on the plate and ask the person to press Track (scripts cannot),
     then apply the track to the patch. If they cannot, keyframe the patch's
     position (and scale for a push) by eye on the frames you studied and check
     the frames in between.
   - *Moving object on a busy background:* Content-Aware Fill does this best:
     draw the mask around the object (mode Subtract, keyframed to follow it),
     then ask the person to open Window > Content-Aware Fill and click Generate
     Fill Layer. Say plainly that a script cannot press that button.
4. **Reveal the patch through a mask.** On the patch layer, a mask around the
   object and everything the Difference check showed changed, which often
   includes a long shadow or a reflection well outside the object, feathered 8
   to 20 px so the edge disappears into the texture, keyframed on the studied
   frames if the object or camera moves. Masks are in the layer's own pixels:
   on a scaled patch, convert the comp points you measured. Name the layer
   `Cleanup <object>`.
5. **Match texture.** A still patch has no grain and looks painted: add Match
   Grain (`"VISINF Grain Duplication"`: parameter 1 Viewing Mode 5, Final
   Output; parameter 2 the plate as noise source). On a surface that moves
   (grass, water, leaves), a still patch looks frozen: add Turbulent Displace
   (Amount 3 to 5, Size about 20, an Evolution expression such as
   `time * 140`) before the grain so it moves like its surroundings. If the
   plate's exposure or colour drifts (clouds, flicker, auto exposure), add
   Levels on the patch and keyframe it where the surroundings change.
6. **Keep it editable.** No pre-comps unless needed, no rendering the patch
   into the plate. The plate stays untouched at the bottom.

## Check

- Preview every 12 frames across the whole shot at full width, and two frames
  in a row where the object moved fastest. Look for: a visible edge or a soft
  blob, texture that is too smooth or frozen on a surface that should move
  (compare how much the patch and the area next to it change between two
  frames), a patch that slides against the plate, and brightness that jumps
  from frame to frame (flicker).
- For a clean plate, check alignment in Difference mode on a few frames, then
  set it back to Normal.
- Fix what you find (more feather, a bigger mask, more grain, more keyframes)
  and preview those frames again.

## Deliver

Save the project. Export an `mp4` of the cleanup comp, and a before and after:
a second comp `NOLGIA <plate name> before-after` with the plate above the
cleanup comp, revealed by an animated mask and a thin split line that sweeps
across the frame, exported as `mp4`. A slow push-in helps, as long as it never
drifts farther than its zoom covers (check the last frame for black edges). Tell
the person which objects were removed and how, which frames to look at closely,
and the controls: each `Cleanup` layer's mask feather and expansion, its grain,
and its keyframes.
