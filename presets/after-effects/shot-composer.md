---
slug: after-effects-shot-composer
name: Composite a VFX shot in After Effects
category: Film assistant
app: after_effects
min_app_version: "25.0"
starter_prompt: "Use NOLGIA to composite my VFX shot in After Effects: key and place my elements into the plate, match light, atmosphere, depth of field, motion blur and grain, and give me a preview and an editable project."
---

# Composite a VFX shot in After Effects

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
   `-0012` Clip Black, `-0013` Clip White, `-0002` View, where 5 is Screen Matte
   and 11 Final Result). Set Screen Colour from the backing (read it from a
   preview of the take), Screen Gain around 100 to 110, then view the Screen
   Matte and move Clip Black up and Clip White down until the backing is solid
   black and the subject solid white; glossy or dark costume needs Clip White
   well below 100 (around 50 is common). Set View back to Final Result, then add
   `"ADBE Simple Choker"` (0.5 to 1 px). Yellow, green or glossy costume picks up
   green, and despill turns it orange or red: keep `"ADBE Spill2"` (Advanced
   Spill Suppressor) low or off, fix the tone in the grade, and tell the person.
   An element with its own alpha skips this step; a still from
   `remove-background` needs only the choker.
4. **Place it.** Put the anchor point at the contact point (the feet), then
   scale and position so the size fits the plate's perspective (a person is
   about 1.7 m: compare with doors, curbs, other people at the same depth) and
   the feet sit on the ground line.
5. **Follow the camera.** A locked-off plate needs no track. For a moving
   camera: apply the 3D Camera Tracker or set up Track Motion on the plate and
   ask the person to press Track (scripts cannot), then parent the element to a
   null that carries the track. If they cannot, keyframe the element's position
   and scale by eye every 6 to 12 frames from previews and check the frames in
   between.
6. **Match light and colour.** Lumetri Color (`"ADBE Lumetri"`, by index: 15
   Temperature, 16 Tint, 17 Saturation, 20 Exposure, 21 Contrast, 22
   Highlights, 23 Shadows, 25 Blacks, 41 Faded Film) on the element, so its
   blacks, whites and mid tones fall where the plate's do at the same depth and
   its colour leans the same way. Measure both from previews rather than
   guessing. For light from behind or from a coloured source, give the element
   a rim: an Inner Glow layer style in the light's colour at 20 to 40 percent
   (select the layer with the comp open in the viewer, then
   `app.executeCommand(app.findMenuCommandId("Inner Glow"))`, and set
   `innerGlow/color`, `innerGlow/opacity`, `innerGlow/blur` under
   `"ADBE Layer Styles"`).
7. **Ground it.** A contact shadow where it touches the ground: a black solid
   with a feathered elliptical mask under the feet, Multiply at 30 to 60
   percent, stretched away from the light. On wet or shiny ground, a reflection
   too: a copy of the element flipped at the feet (scale y negative), 30 to 45
   percent opacity, Gaussian Blur, a little Turbulent Displace, and a Linear
   Wipe at 180 degrees so it fades away from the feet.
8. **Match atmosphere.** Haze goes in the grade: lift the element's blacks
   (Lumetri Blacks, Faded Film) as much as the plate's at that distance. For rain
   or snow in front of it, `"CSRainfall"` (CC Rainfall) on a solid in Screen
   mode with Composite With Original off; for drifting fog, Fractal Noise in
   Screen at low opacity. Do not use a Fill effect on the element for haze: on a
   keyed layer after Lumetri it hid the layer.
9. **Match depth of field.** If the element is not in the plate's focal plane,
   blur it (`"ADBE Camera Lens Blur"`) until its edges are as soft as plate
   detail at the same distance.
10. **Match motion blur.** Elements that move in the comp get layer motion blur
    on and the comp's motion blur on, with the shutter angle that matches the
    plate's blur (180 degrees when unsure). Footage with blur already in it
    stays off.
11. **Match grain.** Match Grain (`"VISINF Grain Duplication"`: parameter 1 is
    the Viewing Mode, set 5 for Final Output; parameter 2 the noise source
    layer, the plate) on each element, or Add Grain (`"VISINF Grain Implant"`)
    tuned by eye. Grain goes on every element and never on the plate.
12. **Missing layers.** Build what can be procedural in After Effects. Generate
    only what cannot, after saying the cost: `nolgia_text_to_image` (about 2 to
    8 credits for a still) or `nolgia_image_to_video` (about 12 to 50 credits for
    5 seconds), on a plain background and cut out with `remove-background`
    (1 credit) when it needs an edge; bring it in with `nolgia_app_import`.
    Then match it like any other element.
13. **Optional unifying grade.** Only if the person asked for a look: one
    adjustment layer on top named `Shot grade`.

## Check

- Preview the start, middle and end frames at full width (`width` 1920) and look
  at the edges: no green or blue fringe, no dark or bright halo, hair and motion
  edges soft, not chewed.
- Blacks and whites of each element must match the plate's at the same depth;
  the light must come from the same side; the element must not float (contact
  shadow, feet on the ground) and must not slide against the plate between
  frames.
- Grain: in a flat area, the element and the plate must look equally noisy.
- If something is off, fix it and preview again before moving on.

## Deliver

Save the project, export an `mp4` of the comp (the whole shot, or a 3 to 5
second range for a long one) and show a still. Offer a breakdown too: a comp
`NOLGIA <plate name> breakdown` with the raw take, the plate and the final
stacked and revealed one after another with Linear Wipes, exported as `mp4`; it
shows the work at a glance. Tell the person: the comp and
folder names, the controls they are most likely to adjust (Keylight Screen Gain
and Clip values, the colour correction on each element, grain amount, blur
radius, light wrap opacity), and which layers NOLGIA generated and what they
cost.
