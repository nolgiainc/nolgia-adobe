---
slug: premiere-project-sorter
name: Organize a Premiere Pro project
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to organize my Premiere Pro project: sort the media into bins by shooting day and type, line up picture and sound by timecode where it is reliable, and make clearly named sequences, without touching my original files or edits."
---

# Organize a Premiere Pro project

Turn a project full of loose media into one an editor can start on: bins by
shooting day and by kind of media, picture lined up with the separately
recorded sound where the timecode makes that reliable, clearly named sequences,
and a short list of what needs a person's eyes. Nothing on disk changes and no
existing sequence is edited.

## Ask

1. Which media to sort: everything loose at the top of the project (default), a
   bin they name, or everything including their own bins (then ask before moving
   anything out of a bin they made).
2. How to tell the shooting days: from each clip's recorded date (default), from
   folder names on disk (`Day 2`, card folders), or from a list they give you.
3. Is there separately recorded sound (a recorder, files named like `ZOOM0001`
   or `T001`) that should be lined up with the picture? Were the camera and the
   recorder jammed to the same timecode? (Default: line up by timecode only
   where both carry it.)
4. A naming style for sequences. (Default: `<Project> D1 Sync`,
   `<Project> D1 Selects`.)

## Build

1. **Take stock without changing anything.** One `nolgia_app_run` that walks the
   chosen bins and returns, for each item: name, media path, kind (video, audio,
   still, graphic, sequence), duration, frame rate, start timecode in seconds
   (`startTime().seconds`: it reads a camera's timecode track and a sound
   recorder's BWF time), recorded date (`xmp:CreateDate` in
   `getXMPMetadata()`), and the file's date (`new File(path).modified`, a guess).
   Keep the total count: it must be the same at the end.
2. **Plan, then wait.** Put the clips in time order and split them into days
   where there is a gap of 6 hours or more, not at midnight, so a night shoot
   that runs past midnight stays one day. Take the date from `xmp:CreateDate`
   and the time of day from the timecode (cameras often write local time with a
   `Z`, as if it were UTC; if the dates and timecodes disagree, ask). Sound files
   rarely carry a date: they belong to the day whose picture their timecode
   overlaps, else the day of their file date. Stills usually have only a file
   date: use it, and say so. Name days `Day 1 2026-03-14` and so on, with kind
   bins inside each: `Video`, `Audio`, `Stills`. Graphics (logos, titles) are
   not shot on a day: one `Graphics` bin at the top. Show the plan as a short
   table (bin, number of clips) and wait for a yes.
3. **Make the bins and move the clips.** A bin `Days` at the top with a bin per
   day inside and the kind bins inside each day; `item.moveBin(bin)` moves a
   clip without changing it. Leave the person's own bins and existing sequences
   where they are.
4. **Line up picture and sound.** Premiere cannot merge clips or run
   Synchronize from a script, so say plainly that you line them up on a sequence
   instead. Pair a camera clip with a sound file when their timecode ranges
   overlap by at least half the clip and the frame rates agree. For each day
   with pairs, make a sync stringout `<Project> D1 Sync` (from the first video
   clip's settings, then remove what it placed): pairs one after another with a
   second between them, the sound file on A2 at the pair's start and the picture
   on V1 after it by the difference of their start timecodes (or the other way
   round when the picture starts first). `track.overwriteClip(item, seconds)`
   puts a camera clip's picture on V1 and its own sound on A1. Select the three
   items and `sequence.linkSelection()`; `getLinkedItems()` confirms. Laying
   clips out at their raw timecode instead leaves hours of empty timeline
   between takes.
5. **Name the rest of the sequences.** An empty `<Project> D1 Selects` per day
   for the editor, and all new sequences in a bin `Sequences` at the top.
   Existing sequences keep their names and edits.
6. **The review list.** Give every clip that needs a decision the red label:
   `item.setColorLabel(6)` (Rose, in Premiere's default labels; 1 is Iris, the
   blue video clips already have). Keep the reason: no timecode, picture with no
   sound when others that day have it, sound with no picture, two possible sound
   files, a frame rate that differs from the day's. Clips placed only by their
   file date are reported, not labelled.

## Check

- `nolgia_app_info`: the bins match the plan, and the number of clips is the
  same as at the start (nothing lost, nothing duplicated).
- Every media path is unchanged, and every existing sequence has the same length
  and track counts as before (compare with the stock you took).
- Preview a frame from each sync sequence (`nolgia_app_preview` with `sequence`)
  to see the picture is there. You cannot hear the sound: say that sync was set
  by timecode and ask the person to check one clap or cue per day.

## Deliver

Save the project. Tell the person: the bin structure with counts, the sync
sequences made and how many pairs each holds, and the review list (clip name and
reason), in a few lines each. Optionally export a `png` of the first sync
sequence's first frame with `nolgia_app_export` so they can see it in their
NOLGIA library.
