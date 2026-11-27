---
slug: premiere-log-grade
name: Grade camera log footage in Premiere Pro
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to grade the camera log footage on my Premiere Pro sequence the way a colourist does: convert the log, correct each clip from its own frame, match the shots of each scene to a wide shot, and only then the look I pick, at the strength I choose. Show me a before and after from the same frame, leave every value where I can change it, and keep my own sequence as it is."
---

# Grade camera log footage in Premiere Pro

Grade flat camera log footage (Sony S-Log3, Canon C-Log, Panasonic V-Log and
the like) in the order a colourist works: the camera's log is converted first,
on its own; then each clip is exposed and balanced from a still of that clip;
then the shots of each scene are matched to one wide shot of it; and only then
does a look go on, at a stated strength, with nothing corrected after it. The
grade goes on a copy of the sequence, one Lumetri Color per clip for its
correction and one more on an adjustment layer for the look, so the person can
change any value in Effect Controls and their own sequence stays as it was.

NOLGIA for Premiere Pro cannot measure a frame: it has no scopes and no
command that reads pixel values. Every judgement about the picture in this
workflow is made by eye from stills (`nolgia_app_preview`), and you say so. What
is read rather than judged: each clip's colour space as Premiere reports it,
the camera from the clip's metadata, and the Lumetri values you read back.

## Ask

1. Which sequence (default: the active one) and which clips (default: every
   clip on V1). Say that the grade goes on a copy and their sequence is the
   before.
2. The look: none, the corrected picture alone (default); one of NOLGIA's film
   stocks (offer two or three by name from `nolgia_list_color_presets`); or a
   look LUT of their own. Its strength: 100 (default) or what they say ("60").
3. The scenes and the hero of each. Default: you propose them from the stills
   in Build step 2 and they confirm. A hero is a wide or establishing shot of
   its scene, never an insert or a close-up: a wide shows the scene's light,
   its shadows and something white or grey to read.
4. Only if the clips do not say: which camera and which log they were shot in
   (for example a Sony camera in S-Log3 with S-Gamut3.Cine).

## Build

1. **Read the clips.** One `nolgia_app_run` on the person's sequence: per clip
   its name, track, first and last frame (`clip.start.ticks` and
   `clip.end.ticks` over `sequence.timebase`), media path, whether it already
   has a Lumetri Color (a component in `trackItem.components` whose
   `displayName` is `Lumetri Color`), and from its project item
   `getColorSpace()` (`name`, `transferCharacteristic`, `primaries`), the
   camera from `getXMPMetadata()`, and any sidecar file next to the clip that
   names the picture profile or gamma (some cameras write one per clip). Many
   files name no camera at all in their XMP (a Canon XF-HEVC `.MP4` holds only
   dates, length and timecode there): then the clips do not say, and you ask
   (Ask 4). Say per camera what you found. The steps assume a Rec. 709
   sequence, Premiere's usual one; if the person grades for HDR, stop and say
   this workflow does not cover it.
2. **The before stills, then a plan.** Before anything changes,
   `nolgia_app_preview` with the person's `sequence` and a `frame` inside each
   clip (its middle, or where its subject is clearest). Keep each frame number:
   every later still of that clip uses the same frame. From these stills,
   propose the scenes (clips that share a place and its light) and one hero per
   scene, and say which clips have nothing white, grey or black to read. Wait
   for a yes.
3. **The conversion, once per clip, on its own.** Every clip must be converted
   from its camera's log exactly once, before any correction and never inside
   the look:
   - When `getColorSpace()` names the camera's log, Premiere's colour
     management is converting it. Nothing more is needed, and the clip's
     Input LUT stays empty.
   - When it reports Rec. 709 (or another display space) for footage that
     looks grey and flat, Premiere does not see the log. Ask the person to set
     the colour space of ONE clip of that camera to the camera's log, which is
     preferred: select the clip in the Project panel, Clip > Modify > Color,
     and choose the log in Override Media Color Space (Adobe's help also puts
     it in the Lumetri Color panel's Settings tab, under Source Clip). Say that
     this changes how the clip looks everywhere in the project, as correct
     colour management should. Then copy it to the other clips of that camera
     yourself: `other.setOverrideColorSpace(first.getColorSpace())` on each
     project item, and read `getColorSpace()` back. A script cannot name a
     colour space (`ColorSpace` has no constructor and
     `setOverrideColorSpace` refuses a name), so the person's one pick is what
     you copy. Take each clip's still again: one that still looks flat is the
     person's to set too. Only if Premiere offers no such choice for that
     camera: a conversion LUT from the camera's maker (log to Rec. 709,
     nothing else; one the person has or gets from the maker, since NOLGIA
     never ships it) in Lumetri Color > Basic Correction > Input LUT, picked
     by the person in step 4. Never a LUT that also carries a look, and never
     NOLGIA's log versions of a stock (`<slug>-slog3`, `-logc3`, `-vlog`,
     `-bmdfilm5`): they hold the conversion and the look in one LUT, so every
     correction would land after the look.
   - Scripting cannot make the first choice for the person: it can only copy
     a colour space it read from a clip, and an Input LUT or Look set from
     script takes the value but nothing renders (tested in Premiere Pro 26.2).
     Name the clips and exactly what to choose.
   - Never both on one clip: a log converted twice comes out crushed and
     oversaturated. Never convert with Contrast, Saturation and the other
     sliders.

   If the person chose a NOLGIA film stock, install it now, so one relaunch
   covers everything: `nolgia_app_import` with `color_preset` set to the
   plain stock's slug, for example `kodak-portra-400` (plugin 0.1.2 and newer).
   The plugin puts the `.cube` in the person's own Adobe LUT folder, under
   `Creative`, and the result names the LUT and its menu (Lumetri Color >
   Creative > Look). Premiere reads its LUT folders only when it starts, so ask
   the person to save, quit and reopen Premiere once they have made the colour
   space changes above, then call `nolgia_app_status` again before going on.
   With an older plugin `color_preset` is refused: download the `.cube`, and in
   step 7 the person picks it with Browse in the Creative > Look menu.
4. **Copy the sequence and add Lumetri, one per clip.** Duplicate the person's
   sequence (`sequence.clone()`), find the copy as the sequence that was not
   there before, open it (`app.project.openSequence(copy.sequenceID)`) and say
   its name. All the grading happens on the copy. The regular DOM cannot add
   effects; the QE DOM can: `app.enableQE(); var q =
   qe.project.getActiveSequence();
   q.getVideoTrackAt(0).getItemAt(i).addVideoEffect(
   qe.project.getVideoEffectByName("Lumetri Color"));`. QE's list of a track's
   items can include the gaps between clips, so pick the QE item whose name is
   the clip's rather than trusting the same index as the regular DOM.
   - Clips converted with an Input LUT (step 3) first: add Lumetri to one clip
     of that camera only. The person picks the conversion LUT in its Basic
     Correction > Input LUT (from the menu, or with Browse), then copies that
     Lumetri Color to the other clips of the same camera (Edit > Copy, then
     Paste Attributes), before you set any value: pasted later, it would
     overwrite each clip's own correction.
   - Then add one Lumetri Color to every other clip to be graded.
   - Skip the clips that already had a Lumetri Color on the person's sequence
     (Build step 1), say so, and ask whether the look should go over them.
   - Read each clip's `trackItem.components` from the regular DOM: every
     graded clip has exactly one component whose `displayName` is `Lumetri
     Color`.
5. **The hero of each scene first.** Take a still of the hero on the copy at
   its frame: this is the converted picture before any correction. Set Basic
   Correction values by name, not by index: walk the Lumetri component's
   `properties` and match `displayName` (several names repeat in Lumetri, so
   count: the first `Saturation` is Basic Correction's, the second Creative's).
   Read every value back after setting it. A value that does not read back is
   the person's to set: name the clip, the control and the value. In this
   order, judging each from a new still of the hero:
   - **Exposure.** Until the main subject sits where it should: skin reads as
     lit skin, neither grey nor glowing, and a mid grey thing looks mid grey.
     Never raise a shot so far that its brightest thing turns pure white, and
     never lower it so far that its darkest turns pure black.
   - **Balance: Temperature and Tint.** Until something that should be white,
     grey or black (a shirt, paper, a wall, a grey road, a tyre) reads neutral.
     Warm light that was meant (golden hour, sunset, lamps in the frame) stays:
     when the shadows and blacks look neutral and only the lit parts are warm,
     the warmth is the light, so leave it. Warm or cool all the way down into
     the shadows is the camera's white balance: correct it until the shadows
     look neutral, and stop there. A green or magenta cast is never the light.
   - **Contrast, then Saturation** (Basic Correction's), in small moves, until
     the picture looks like what the camera saw: skin and known colours (grass,
     sky) look normal. Highlights, Shadows, Whites and Blacks only to hold a
     highlight or a shadow, never to stretch the shot to pure black and pure
     white.

   If the hero has nothing white, grey or black to read, leave Temperature and
   Tint at 0, as shot, and name it to the person. Say each time what you judged
   and from which still. Show the hero's before and after and go on only when
   it is right.
6. **Match the other shots of each scene to its hero.** For each other clip of
   the scene, write the hero's Exposure, Temperature, Tint, Contrast,
   Highlights, Shadows, Whites, Blacks and Saturation into its Basic Correction
   as the starting point (never its Input LUT: each clip keeps its own
   conversion), take its still at its frame, and compare it with the hero's
   still side by side at the same size. Change it only on what the two shots
   share (the same ground, wall or garment, skin): exposure first, then
   Temperature and Tint, then Saturation. A shot from the same camera in the
   same light as the hero keeps the hero's values unless something they share
   clearly looks different. Do not balance a close-up or an insert on its own.
   A match never changes the direction of the hero's colour: a warm scene that
   comes out neutral or cool is a failed match. Every clip ends with values
   judged from its own still, not the same values pasted everywhere.
   - **Left as shot.** A shot with nothing white or grey to read and nothing it
     shares with the hero gets no move of its own: it keeps the hero's values,
     and you name it to the person with the reason. When you are not sure the
     thing you would read is really white or grey (off-white paint, a wall in
     warm light, sand), or the move would turn the shot's colour away from the
     hero's, do not make it: show the person the still and ask. A missed
     correction leaves a shot as it was; a wrong one ruins it.
7. **Only then, the look.** Skip this step when the look is none. The look goes
   on its own Lumetri Color above the corrections, so the person picks it once
   and no clip's correction is touched:
   - Ask the person to make an adjustment layer (Project panel > New Item >
     Adjustment Layer), put it on an empty track directly above the graded
     clips and stretch it from the first graded clip's start to the last one's
     end. If a track between them holds clips that were not graded, ask first:
     the look would land on those too. Add one Lumetri Color to it with QE as
     in step 4 (if QE cannot, the person's pick in the Lumetri Color panel
     adds it).
   - The person picks the look in that Lumetri Color > Creative > Look,
     because Premiere's scripting cannot set a LUT. Tell them its exact name
     (the `lut` from the install result) and the menu. A NOLGIA stock is
     always the plain one, which expects a finished Rec. 709 picture: what
     every clip is after its conversion and correction. A LUT of their own
     must be made for a finished Rec. 709 picture too; one made for a camera
     log ("for S-Log3") is a conversion and a look in one and does not go
     here.
   - Strength is that Lumetri's Creative `Intensity`: 100 unless the person
     asked for less. Set it by name and read it back, or tell the person the
     number. A lighter strength (75, 50, 30) is the person's named choice after
     seeing it at 100, never a repair.
   - Nothing is corrected after the look. Lumetri works through its sections
     from the top down, so on the adjustment layer everything other than Look
     and Intensity stays at its default, and Basic Correction on each clip is
     the only place a correction is made. If the look comes out harsh (blacks
     crushed, highlights clipped, skin too dark and heavy), the correction
     under it is wrong for it: lower Contrast or Exposure on the clips of that
     scene by the same amount, never the Intensity, and tell the person.
8. **Check the finished picture.** With the look on, take the after still of
   every hero, of each clip left as shot, and of the darkest and the brightest
   clip, each at its own frame. Look at each one:
   - skin reads as skin: not orange, grey, green or magenta, and lit rather
     than glowing;
   - blacks hold detail: dark clothes, hair and shadows are not one flat black;
   - highlights hold: white shirts, walls and sky keep their detail, and only
     the sun, lamps, windows and shiny reflections may be pure white;
   - no large part of the frame is pure white;
   - something that should be white or grey reads neutral, unless it sits in
     light that was meant to be warm;
   - the shots of a scene, one after another, look like one place and time.

   Fix anything that fails under the look (Basic Correction on the clips) and
   take the still again. What still fails, name to the person with its still;
   skin that is still off after the balance is theirs to fine tune on that
   clip (its HSL Secondary, which runs before the adjustment layer's look).

## Check

- Every graded clip on the copy has exactly one Lumetri Color, with the values
  you set (read them back); only its Basic Correction is changed, and nothing
  else in its effects changed.
- No clip is converted twice: a clip whose colour space Premiere reads as log
  has an empty Input LUT, and an Input LUT holds a conversion only.
- The adjustment layer's Lumetri Color holds the look and its Intensity and
  nothing else, and it spans the graded clips.
- The person's sequence is unchanged: the same clips and length as in Build
  step 1, and no Lumetri Color added to any of its clips.
- A before and an after at the same frame for every hero, and every clip left
  as shot named with its reason.

## Deliver

Save the project. Export with `nolgia_app_export` `png` the after frame of
every hero from the copy, at the frame of its before still from Build step 2
(those stills are already in the person's NOLGIA library, since previews are
uploaded there), and, if they want to see it move, an `mp4` of the copy. Tell
the person, in a few lines: the copy's name; how each camera's log was
converted; the scenes and their heroes; a table per clip (scene, Exposure,
Temperature, Tint, Contrast, Saturation); the look and its strength; the clips
left as shot and why; that every judgement of the picture was made by eye from
stills, since the plugin measures nothing; and where to change things (Effect
Controls > Lumetri Color > Basic Correction on each clip, and the adjustment
layer's Lumetri Color > Creative for the look).

## What this workflow never does

- Grade the person's own sequence: the grade is always on a copy.
- Convert a log twice, or inside the look: no log version of a stock, no log
  LUT in Creative > Look, no conversion with the sliders.
- Put the same values on every clip, or paste one clip's Lumetri Color over
  clips whose values are already set.
- Correct anything after the look, or lower the look's strength to hide a
  harsh result.
- Neutralise warm light that was meant, push a shot with nothing white or grey
  to read toward neutral on a guess, or make a shot's brightest thing white or
  its darkest black.
- Use Lumetri's Auto or Color Match's Apply Match: they guess from the picture
  and cannot tell light that was meant from a camera's mistake.
- Add grain, halation, glow, sharpening or a vignette: grain is the person's
  choice.
- Describe a measurement: the plugin has none.
