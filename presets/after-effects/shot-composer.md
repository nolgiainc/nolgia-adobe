---
slug: after-effects-shot-composer
name: Composite a shot in After Effects
category: Film assistant
app: after_effects
min_app_version: "25.0"
starter_prompt: "Use NOLGIA to composite my shot in After Effects: key and place my elements into the background plate, match light, atmosphere, depth of field, motion blur and grain, and give me a preview and an editable project."
---

# Composite a shot in After Effects

Put the person's elements into their background plate so the shot reads as one
photograph: clean keys, elements that sit on the ground and follow the camera,
matching light and colour, the same haze, focus, motion blur and grain as the
plate. Everything stays live in a new comp, so they can keep adjusting it.

## Ask

1. Which item is the plate, and which are the elements to put in it? (Default:
   the longest footage in the active comp or project is the plate; the other
   footage and stills are elements.) Look at a frame of each with
   `nolgia_app_preview` before asking, and name what you see.
2. What should the shot look like when it is done: a reference image, a film or
   show, or a few words? (Default: match the plate as it is, no new grade.)
3. For each element: where does it go and how big is it (feet on the ground by
   the car, far in the background, above the rooftops)? (Default: a sensible
   place you describe back before building.)
4. Is anything missing that the shot needs (a sky, smoke, a background element)?
   Offer to build it in After Effects for free when it can be procedural (fog,
   rain, glow, grain), or to generate it with NOLGIA, with the credit cost, when
   it cannot.

## Build

1. **A new comp over the plate.** Make `NOLGIA <plate name> comp` with the
   plate's size, pixel aspect, frame rate and duration (`items.addComp`), put
   the plate at the bottom, and put everything you add in a project folder
   `NOLGIA Shot Composer`. The person's own comps stay as they are.
2. **Read the plate first.** Preview three frames (start, middle, end) and write
   down: where the light comes from and how hard it is, the colour of the
   shadows and of the brightest areas, how deep the blacks go at each distance
   (haze lifts them), what is in focus, whether the camera moves (compare the
   same feature on the first and last frame), and whether moving things are
   blurred. Every later step matches these notes.
3. **Key.** For an element shot on green or blue: Keylight (`"Keylight 906"`;
   its parameters are `"Keylight 906-0004"` Screen Colour, `-0005` Screen Gain,
   `-0012` Clip Black, `-0013` Clip White, `-0018` Screen Despot White, `-0002`
   View, where 5 is Screen Matte, 10 Intermediate Result and 11 Final Result).
   Set Screen Colour from the backing right beside the subject (read it from a
   preview of the take; a lit backing varies a lot across the frame), Screen
   Gain around 100 to 110, then view the Screen Matte and move Clip Black up and
   Clip White down until the backing is solid black and the subject solid
   white; glossy or dark costume needs Clip White well below 100 (around 40 to
   50 is common). Check the matte on three frames: add a temporary
   `"ADBE Shift Channels"` that takes red, green and blue from alpha (value 9)
   and preview. When one key cannot give both a soft edge and a solid core:
   - **A garbage mask** that follows the subject: trace the silhouette from
     previews of the Screen Matte every 15 frames, 20 px outside it, as mask
     path keyframes.
   - **Split the key** into layers of the same take, each with its own mask: a
     feet layer below the ankles with a second Keylight picked from the lit
     floor, and the body above them.
   - **Add a fill layer** under the body: the same key set hard, its holes
     closed with `"ADBE Matte Choker"` (Choke 1 about -110, Choke 2 about 110),
     then choked 6 px. A closed matte grows past the edge and brings back a halo
     of backing colour, so set this layer's garbage mask to a Mask Expansion of
     about -14 px, which keeps the fill just inside the outline.
   Then precompose the key layers (`comp.layers.precompose(indices, name, true)`)
   so choke, spill, grade and grain are set once, on the precomp, with
   `"ADBE Simple Choker"` about 1.5 px. An element with its own alpha skips all
   this; a still from `remove-background` needs only the choker.
4. **Remove the spill, keep the costume's colour.** Advanced Spill Suppressor
   (`"ADBE Spill2"`) on the precomp with Method set to Ultra (parameter 1 = 2),
   Key Color (parameter 4) the backing colour and Tolerance (parameter 5) about
   50: it clears green bounce from shoes and dark cloth and leaves yellow and
   orange alone. The Standard method turns yellow orange, and widening Spill
   Range or Tolerance to clear an edge halo greys a yellow costume; fix a halo
   in the matte (step 3) instead. Measure the hue of any saturated costume
   colour in the take and in the composite (median hue of its pixels from
   previews); they must stay within about 3 degrees, and say so.
5. **Place it.** Put the anchor point at the contact point (the feet), then
   scale and position so the size fits the plate's perspective (a person is
   about 1.7 m: compare with doors, curbs, other people at the same depth) and
   the feet sit on the ground line. Scaling and moving the plate instead is
   fine when the element is full frame: it keeps the element sharp. Read where
   the sun is from the plate's own shadows on the ground near the element, not
   from the brightest patch of sky, and flip the element (scale x -100) when its
   key light is on the other side.
6. **Follow the camera.** A locked-off plate needs no track. For a moving
   camera: apply the 3D Camera Tracker or set up Track Motion on the plate and
   ask the person to press Track (scripts cannot), then parent the element to a
   null that carries the track. If they cannot, keyframe the element's position
   and scale by eye every 6 to 12 frames from previews and check the frames in
   between.
7. **Match light and colour.** Lumetri Color (`"ADBE Lumetri"`, by index: 15
   Temperature, 16 Tint, 17 Saturation, 20 Exposure, 21 Contrast, 22
   Highlights, 23 Shadows, 25 Blacks, 41 Faded Film) on the precomp, so its
   whites, mid tones and blacks fall where the plate's do at the same depth.
   Measure both from previews rather than guessing. Grade the element toward the
   plate, never the other way round, and keep it gentle: lifting Blacks, Faded
   Film, cooling the Temperature and a Saturation cut all push a saturated
   yellow toward orange and grey (a yellow raincoat turned peach this way), so
   re-measure the costume hue after the grade and put Saturation back up a
   little if it dropped. **Light wrap**, so the plate's light bleeds onto the
   edges: a comp `NOLGIA wrap matte` holding the element's silhouette filled
   white with a copy filled black and blurred 15 to 20 px on top (the result is
   a bright band just inside the edge); over the element, a copy of the plate
   blurred about 30 px, in Screen at 50 to 70 percent, with that comp as its
   track matte (`wrapLayer.setTrackMatte(matteLayer, TrackMatteType.LUMA)`).
   For a coloured rim instead (a neon sign, a sunset behind), an Inner Glow layer
   style in the light's colour at 20 to 40 percent (select the layer with the
   comp open in the viewer, then
   `app.executeCommand(app.findMenuCommandId("Inner Glow"))`, and set
   `innerGlow/color`, `innerGlow/opacity`, `innerGlow/blur` under
   `"ADBE Layer Styles"`).
8. **Ground it.** A contact shadow right under the feet: a dark solid in the
   plate's shadow colour with a feathered elliptical mask, Multiply at 40 to 60
   percent. Then the cast shadow, a feathered polygon from the feet in the
   direction the plate's own shadows run, Multiply at 30 to 45 percent. A
   projected copy of the silhouette only reads well when the light is low and to
   the side; with the sun ahead or behind, it shows as a detached shape. On wet
   or shiny ground, a reflection too: a copy of the element flipped at the feet
   (scale y negative), 30 to 45 percent opacity, Gaussian Blur, a little
   Turbulent Displace, and a Linear Wipe at 180 degrees so it fades away from
   the feet.
9. **Match atmosphere.** Haze goes in the grade: lift the element's blacks
   (Lumetri Blacks) as much as the plate's at the element's own distance, which
   near the camera is very little. For rain or snow in front of it,
   `"CSRainfall"` (CC Rainfall) on a solid in Screen mode with Composite With
   Original off; for drifting fog, Fractal Noise in Screen at low opacity. Do not
   use a Fill effect on the element for haze: on a keyed layer after Lumetri it
   hid the layer.
10. **Match depth of field.** Blur the plate, not the element, when the element
    is the subject: `"ADBE Camera Lens Blur"` (1 Blur Radius, 3 Shape, 4
    Roundness, 10 Blur Map layer, 12 Placement 2 to stretch the map, 13 Blur
    Focal Distance, 17 Highlight Gain) with a depth map: a comp holding a black
    to white Gradient Ramp (`"ADBE Ramp"`), black at the element's feet and white
    toward the horizon, plus a second ramp in Lighten mode that greys toward the
    bottom of frame so the ground nearer the camera softens too. Put the map comp
    in the shot, switched off, and pick it as the Blur Map. Blur an element that
    is off the focal plane the same way until its edges match plate detail at
    that distance.
11. **Match motion blur.** Elements that move in the comp get layer motion blur
    on and the comp's motion blur on, with the shutter angle that matches the
    plate's blur (180 degrees when unsure). Footage with blur already in it
    stays off.
12. **Match grain.** Match Grain (`"VISINF Grain Duplication"`: parameter 1 is
    the Viewing Mode, set 5 for Final Output; parameter 2 the noise source
    layer, the plate) on each element, or Add Grain (`"VISINF Grain Implant"`)
    tuned by eye. Grain goes on every element and never on the plate.
13. **Missing layers.** Build what can be procedural in After Effects. Generate
    only what cannot, after saying the cost: `nolgia_text_to_image` (about 2 to
    8 credits for a still) or `nolgia_image_to_video` (about 12 to 50 credits for
    5 seconds), on a plain background and cut out with `remove-background`
    (1 credit) when it needs an edge; bring it in with `nolgia_app_import`.
    Then match it like any other element.
14. **Optional unifying grade.** Only if the person asked for a look: one
    adjustment layer on top named `Shot grade` (a soft `"CS Vignette"`, CC
    Vignette, at about 25 is often all it needs).

## Check

- Preview the start, middle and end frames at full width (`width` 1920) and look
  at the edges: no green or blue fringe, no dark or bright halo, hair and motion
  edges soft, not chewed.
- Blacks and whites of each element must match the plate's at the same depth;
  the light must come from the same side; the element must not float (contact
  shadow, feet on the ground) and must not slide against the plate between
  frames.
- Grain: in a flat area, the element and the plate must look equally noisy.
- Colour: the median hue of the costume's saturated colours in the composite is
  within about 3 degrees of the take (compare the first frame of the take with a
  composite frame, side by side), and skin has not turned green or grey.
- If something is off, fix it and preview again before moving on.

## Deliver

Save the project, export an `mp4` of the comp (the whole shot, or a 3 to 5
second range for a long one) and show a still. Offer a before and after too: a
comp `NOLGIA <plate name> before-after` with the raw take over the finished
comp, revealed by a mask that sweeps across the frame with a thin line at its
edge, small `BEFORE` and `AFTER` labels in the top corners, and a slow push-in,
exported as `mp4`; it shows the work at a glance. The take must sit exactly
where it sits in the shot (same flip and position), and a mask on a flipped
layer is mirrored. Tell the person: the comp and
folder names, the controls they are most likely to adjust (Keylight Screen Gain
and Clip values, the colour correction on each element, grain amount, blur
radius, light wrap opacity, shadow opacity), and which layers NOLGIA generated and what they
cost.
