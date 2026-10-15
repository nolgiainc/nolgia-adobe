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
3. Whether a NOLGIA film stock should go on top by hand afterwards (see
   "Film stocks" below).

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
the stock in one LUT. Premiere's scripting cannot load a LUT into Lumetri: the
Input LUT and Look entries take a path or an index from script but nothing
renders (tested in Premiere Pro 26.2). So offer the stock as a manual step:
download the `.cube` and have the person choose it in Lumetri > Basic
Correction > Input LUT > Browse, or put it in the user LUT folder Adobe
documents for Lumetri (`%APPDATA%\Adobe\Common\LUTs\Technical` on Windows,
`~/Library/Application Support/Adobe/Common/LUTs/Technical` on a Mac) so it is
listed there after Premiere restarts. With a stock in the Input LUT, set the
conversion values above back to 0; converting twice crushes the picture.

## Check

- Every clip has exactly one Lumetri Color with the values you set (read them
  back), and nothing else in its effects changed.
- Before and after at the same frame, plus the two extra frames, looked at.

## Deliver

Save the project. Export the after frame as `png` with `nolgia_app_export`
and, if they want to see it move, an `mp4` of the sequence. Tell the person the
values used, where to change them (Effect Controls > Lumetri Color > Basic
Correction), and how to add a film stock by hand.
