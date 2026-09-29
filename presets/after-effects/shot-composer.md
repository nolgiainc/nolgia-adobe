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
   shadows and of the brightest areas, how deep the blacks go, how hazy the
   distance is, what is in focus, whether the camera moves, and whether moving
   things are blurred. Every later step matches these notes.
3. **Key.** For an element shot on green or blue: Keylight (`"Keylight 906"`)
   with Screen Colour picked from the backing (read the backing colour from a
   preview), Screen Gain around 100 to 110, then Screen Matte clip black and
   clip white just far enough to make the backing solid black and the subject
   solid white. Check the matte by setting Keylight's View to Screen Matte and
   previewing, then set it back to Final Result. Follow with
   `"ADBE Simple Choker"` (0.5 to 1 px in) and a spill suppressor
   (`"ADBE Spill2"` is Advanced Spill Suppressor). An element with its own
   alpha skips this step; a still from `remove-background` needs only the
   choker.
4. **Place it.** Scale and position each element so its size fits the plate's
   perspective (a person next to a door is about as tall as the door frame), and
   put the contact point on the ground line you see in the plate.
5. **Follow the camera.** A locked-off plate needs no track. For a moving
   camera: apply the 3D Camera Tracker or set up Track Motion on the plate and
   ask the person to press Track (scripts cannot), then parent the element to a
   null that carries the track. If they cannot, keyframe the element's position
   and scale by eye every 6 to 12 frames from previews and check the frames in
   between.
6. **Match light and colour.** On each element, Curves or Levels (and a Tint or
   Lumetri colour shift) so its blacks, whites and mid tones fall where the
   plate's do at the same depth, with shadows tinted like the plate's shadows.
   Add a light wrap (a blurred copy of the plate, cut to a thin band inside the
   element's edge, Screen or Add at low opacity) so the plate's light bleeds
   onto the edges. Add a contact shadow where the element touches the ground: a
   copy of its alpha, black, skewed away from the light, blurred, Multiply at 30
   to 60 percent.
7. **Match atmosphere.** Distant elements take the plate's haze: a Fill with
   the haze colour at the opacity that makes their blacks as lifted as the
   plate's at that distance. For drifting fog or dust, a Fractal Noise layer in
   Screen at low opacity, slowly evolving.
8. **Match depth of field.** If the element is not in the plate's focal plane,
   blur it (`"ADBE Camera Lens Blur"`) until its edges are as soft as plate
   detail at the same distance.
9. **Match motion blur.** Elements that move in the comp get layer motion blur
   on and the comp's motion blur on, with the shutter angle that matches the
   plate's blur (180 degrees when unsure). Footage with blur already in it stays
   off.
10. **Match grain.** Add `"ADBE Match Grain"` to each element with the plate as
    the noise source layer, or `"ADBE Add Grain"` tuned by eye when Match Grain
    has no clean area to sample. Grain goes on every element and never on the
    plate.
11. **Missing layers.** Build what can be procedural in After Effects. Generate
    only what cannot, after saying the cost: `nolgia_text_to_image` (about 2 to
    8 credits for a still) or `nolgia_image_to_video` (about 12 to 50 credits for
    5 seconds), on a plain background and cut out with `remove-background`
    (1 credit) when it needs an edge; bring it in with `nolgia_app_import`.
    Then match it like any other element.
12. **Optional unifying grade.** Only if the person asked for a look: one
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
second range for a long one) and show a still. Tell the person: the comp and
folder names, the controls they are most likely to adjust (Keylight Screen Gain
and Clip values, the colour correction on each element, grain amount, blur
radius, light wrap opacity), and which layers NOLGIA generated and what they
cost.
