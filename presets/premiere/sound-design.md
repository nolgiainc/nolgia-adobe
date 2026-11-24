---
slug: premiere-sound-design
name: Do the sound design in Premiere Pro
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Do the sound design."
---

# Do the sound design in Premiere Pro

NOLGIA watches the cut, picks sounds from NOLGIA's Sound Library for what
happens on screen (hits, whooshes, footsteps, doors, room tone, ambience),
and puts them into the open sequence on new audio tracks, timed to the
frame, with their levels and fades set. The editor's own tracks and clips are
never touched, and the whole run comes back out with one sentence. It needs
NOLGIA for Premiere Pro 0.4.0 or newer (the `sound_design` command kind; it
is listed in the session's capabilities in `nolgia_app_status`).

This workflow is the one exception to "never edit an existing sequence" in
the shared rules: `nolgia_app_sound_design` `place` adds new audio tracks and
clips to the person's sequence and changes nothing already on it. It saves
the project and makes its own backup first, so the separate `prproj` safety
copy and save are not needed here.

Every `sound_design` call below goes through `nolgia_app_sound_design` with
`action` and the fields shown. If that tool is not in your tool list, send the
same command as a bridge command: `POST /bridge/commands` with `{"app":
"premiere", "kind": "sound_design", "args": {...}, "timeout_seconds": 600}`,
then `nolgia_app_command` with its id until it is finished. Give `place` and
`preview` 600 seconds.

Name the sequence in every call: `read` answers its `sequence.id`; pass that
same id as `sequence` to `preview` and `place`, so the sounds go on the cut
that was planned even if the person opens another sequence meanwhile.

## Ask

1. Which sequence and which part: the active sequence, and its in to out
   range when one is marked (default), or the whole sequence. NOLGIA plans at
   most 10 minutes at a time: longer sequences are done part by part, each
   with its own in and out.
2. Direction, once, only when the person gave none: "Describe the sound you
   want, or say go." Examples worth offering: "gritty and punchy, whooshes on
   the cuts", "quiet city morning, no music", "keep the dialogue clear".

## Build

1. **Read the sequence.** `sound_design` `{action: "read"}` (with `sequence`
   when the person named one). Keep `sequence.id`. Say in one sentence what
   is there: the sequence name, its length, its frame rate, how many video
   and audio tracks, which audio tracks are empty, and any `nolgia_runs`
   already on it (an earlier sound design: ask whether to keep it or take it
   out first). If `in_ms` and `out_ms` are set, that range is the part to do.
2. **Make the preview.** `sound_design` `{action: "preview", sequence: <the
   id>}` (add `range: "sequence"` for the whole sequence when the person
   asked for it). It renders a small H.264 with sound on the person's
   computer and uploads it to their NOLGIA Library. Keep `asset_id` and
   `timeline_offset_ms` (where the preview starts on the timeline). A preview
   longer than 10 minutes is refused with what to do: pass that on.
3. **Price, then the person's yes.** `nolgia_plan_sound_design` with the
   `asset_id` and the brief, without `confirm`: the answer is the quote. Tell
   the person the price in one line: "The plan costs 2 credits per started
   minute of video: N credits for this M minute cut." If `can_plan` is
   false, say its `message` and stop. Wait for a yes. Then the same call
   with `confirm: true` and `agreed_credits` set to the quote's
   `cost_credits`. The plan is the only step that costs credits.
4. **Wait for the plan.** `nolgia_get_sound_design_plan` until `status` is
   done (or failed: say why in plain words and stop).
5. **The cue sheet, then a yes.** In a few lines: how many sounds, the main
   ones with their times ("0:03 door slam, 0:07 to 0:12 rain outside, 0:15
   whoosh on the cut"), and what the bed is. Ask whether to put them in, and
   change any pick the person asks for. Wait for a yes.
6. **Place the sounds.** `sound_design` `{action: "place", sequence: <the
   id>, plan_id: <the plan id>, timeline_offset_ms: <the preview's
   timeline_offset_ms>}`, plus what the person changed:
   - `picks`: cue id to another sound for it (`{sound_id}` from the cue's
     candidates or a library search, or `{asset_id}` of a sound in their
     Library), with `gain_db`, `fade_in_ms` or `fade_out_ms` if asked;
   - `skip`: cue ids to leave out;
   - `overrides`: cue id to `start_ms`, `gain_db`, `fade_in_ms`,
     `fade_out_ms` or `lane` (where and how loud only).
   Do not call the package or export tool for Premiere Pro: the plugin asks
   NOLGIA for the plan's sounds itself, with its own sign-in, and downloads
   only what NOLGIA hands it. The plan id is the run's id: the same plan
   placed again places nothing twice, so a retry is safe. The plugin puts the
   sounds in a folder next to the project (`NOLGIA Sounds/<plan id>`), saves
   the project and backs it up into `NOLGIA backups` before it changes
   anything, imports the sounds into their own bin, and lays them on new
   tracks after all others ("NOLGIA SFX 1", "NOLGIA Ambience" ...). An unsaved
   project is refused: ask the person to save it (File > Save) and place
   again. If a cue comes back "NOLGIA is still making this sound", place again
   a minute later to add it.

## Check

- `sound_design` `{action: "read", sequence: <the id>}` again: the NOLGIA
  tracks are there and hold as many clips as `placed` says, and the person's
  own tracks have the same clips as before.
- Read every cue in the place answer whose `status` is `not_placed`, and its
  `warnings`: say each in plain words.

## Deliver

Tell the person, in a few short lines:

- what was added: how many sounds, on which new tracks, and the main ones
  with their times;
- where the files are (`folder`) and the bin;
- how to undo: "Say: take the sound design out." (that is `sound_design`
  `{action: "remove", run_id: <the plan id>}`: it takes out exactly the clips
  and empty tracks this run added; the files and the bin stay; a sound the
  person moved, and a NOLGIA track the person renamed or put their own clips
  on, stay too, and the answer lists them);
- the credit lines any CC BY sound requires (`credits` in the place answer,
  also written to `CREDITS.txt` in the folder): they must go with the film
  wherever it is published.
