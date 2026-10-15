---
slug: premiere-log-grade
name: Grade camera log footage in Premiere Pro
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to grade the flat log footage on my Premiere Pro sequence: bring it to a finished, consistent look with Lumetri, show me a before and after from the same frame, and leave every value where I can change it."
---

# Grade camera log footage in Premiere Pro

Bring flat camera log footage (Sony S-Log3, Canon C-Log, Panasonic V-Log and
the like) on a sequence to a finished, consistent picture with Lumetri Color,
one effect per clip with the same values, so the person can open Effect
Controls and change any of them. A before and an after from the same frame show
what changed.

## Ask

1. Which sequence (default: the active one) and which clips (default: every
   clip on V1).
2. The look: neutral and clean (default), warmer, cooler, punchier, or softer.
3. Whether a NOLGIA film stock should go on top (see "Film stocks" below):
   which stock, and the camera's log, so you install the right version.

## Build

1. **Read the clips.** For each clip's project item, `getColorSpace()` (name,
   `transferCharacteristic`, `primaries`): when Premiere already recognises
   the log (its color management converts it), grade lightly; when it reports
   Rec. 709 for footage that looks grey and flat, it does not, and the grade
   does the conversion. Read the camera from the XMP or the sidecar if there
   is one, and say what you found.
2. **The before still.** `nolgia_app_preview` with `sequence` and a `frame`
   that shows skin or the main subject. Keep the frame number.
3. **Add Lumetri, one per clip.** The regular DOM cannot add effects; the QE
   DOM can: `app.enableQE(); var q = qe.project.getActiveSequence();
   q.getVideoTrackAt(0).getItemAt(i).addVideoEffect(
   qe.project.getVideoEffectByName("Lumetri Color"));`. Skip clips that
   already have one (look in `trackItem.components` for a component whose
   `displayName` is `Lumetri Color`) and say so.
4. **Set the values by name, not by index.** Walk the Lumetri component's
   `properties` and match `displayName` (several names repeat in Lumetri, so
   count: the first `Saturation` is Basic Correction's, the second Creative's).
   A starting point for 8-bit Sony S-Log3 at its base ISO, to adjust from the
   before still: Exposure +0.2, Contrast 65, Highlights -25, Shadows 5,
   Whites 25, Blacks -55, Saturation 155, Vibrance 15. Other log curves need
   less contrast; footage Premiere already converts needs almost none.
5. **The after still** from the same frame, and two more frames (a dark shot,
   a bright one). Skin must read as skin, blacks must not crush, white walls and
   dresses must not clip.

## Film stocks

NOLGIA's film stocks (`nolgia_list_color_presets`) have log versions
(`<slug>-slog3`, `-logc3`, `-vlog`, `-bmdfilm5`) that convert the log and apply
the stock in one LUT.

1. **Install it.** `nolgia_app_import` with `color_preset`, for example
   `kodak-portra-400-slog3` (plugin 0.1.2 and newer). The plugin puts the
   `.cube` in the person's own Adobe LUT folder, no administrator rights:
   `%APPDATA%\Adobe\Common\LUTs` on Windows,
   `~/Library/Application Support/Adobe/Common/LUTs` on a Mac. A log version
   goes in `Technical` and a plain look in `Creative`. The result names the LUT
   and the menu it appears in (`menu`).
2. **The person picks it once.** Premiere reads its LUT folders only when it
   starts, and its scripting cannot set a LUT on a clip: the Input LUT and Look
   entries take a path or an index from script but nothing renders (tested in
   Premiere Pro 26.2), and `apply_to` reports the LUT as not applied. So ask the
   person to save, quit and reopen Premiere, then choose the LUT in Lumetri
   Color > Basic Correction > Input LUT (a log version) or Creative > Look (a
   plain look) on the first clip. Copying that Lumetri Color to the other clips
   (Edit > Copy, then Paste Attributes) carries it across.
3. **Then the values.** With a log version in the Input LUT, set the conversion
   values above back to 0: converting twice crushes the picture. Keep only
   small adjustments on top, and take the after stills again.

With an older plugin, `color_preset` is refused: download the `.cube` and have
the person choose it in Lumetri > Basic Correction > Input LUT > Browse.

## Check

- Every clip has exactly one Lumetri Color with the values you set (read them
  back), and nothing else in its effects changed.
- Before and after at the same frame, plus the two extra frames, looked at.

## Deliver

Save the project. Export the after frame as `png` with `nolgia_app_export`
and, if they want to see it move, an `mp4` of the sequence. Tell the person the
values used, where to change them (Effect Controls > Lumetri Color > Basic
Correction), and, when a film stock is installed, which LUT to pick and where.
