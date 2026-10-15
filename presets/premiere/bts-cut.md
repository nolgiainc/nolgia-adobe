---
slug: premiere-bts-cut
name: Cut a behind-the-scenes edit in Premiere Pro
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to cut a 45 second behind-the-scenes edit in Premiere Pro from my shoot: look at the clips, pick the best moments, lay them out in order on a new sequence, and make a 9:16 version for Reels and TikTok, without touching my clips or my sequences."
---

# Cut a behind-the-scenes edit in Premiere Pro

Turn a day of loose camera clips into a short edit the person can finish: the
strongest two or three seconds of each good clip, in an order that tells the
day (getting ready, the set, the work, a closing image), on a new 16:9
sequence, plus a 9:16 copy reframed by Premiere's own Auto Reframe. The person
keeps the creative calls: every pick is a normal clip on the timeline that they
can trim, swap or delete.

## Ask

1. Which clips: a bin (default: the video bin of the day, as the "Organize a
   Premiere Pro project" workflow leaves it), or clips they select.
2. How long: 30 to 60 seconds (default 45). Shots of 1.5 to 3 seconds.
3. Formats: 16:9 and a 9:16 copy (default both), or one of them.
4. Sound: the clips' own sound (default), or a music track from their project
   or NOLGIA library on A2 (they bring it; never invent a song).
5. Anything that must be in it, or must stay out (a person, a product, a
   moment that is not public yet).

## Build

1. **Take stock.** One `nolgia_app_run` listing the chosen clips: name, media
   path, duration, frame rate (`getFootageInterpretation().frameRate`), start
   timecode, and the color label. Clips the organize workflow marked Rose
   (a frame rate that differs from the day's) are fine to use: in a sequence
   at the day's rate they play at real time. Never change a clip's frame rate
   or interpretation to make slow motion; offer it as a step for the person.
2. **Look at the clips.** You cannot judge a clip you have not seen.
   `nolgia_app_preview` needs a sequence: make a temporary sequence `NOLGIA
   Look` from the clips (`app.project.createNewSequenceFromClips`), preview a
   frame from the middle of each clip first, then four to eight frames across
   each promising clip. Keep a short note per clip: what happens, where it is
   sharp and steady, whether a face or a hand is doing something. Remove the
   Look sequence when you are done (`app.project.deleteSequence`).
3. **Plan the cut, then wait.** A table: shot number, clip, in and out in
   seconds, what it shows. Vary wide, close and detail; open on something that
   says "on set" (a monitor, a light, a camera), end on a still image. Total it.
   Wait for a yes (or "go").
4. **Lay it out, one shot per step.** Make the sequence from the first clip's
   settings (`createNewSequenceFromClips(name, [firstClip], sequencesBin)`),
   remove what it placed, then per shot:
   `item.setInPoint(inSeconds, 4); item.setOutPoint(outSeconds, 4);`
   `track.insertClip(item, endOfTrackSeconds);`
   `item.clearInPoint(4); item.clearOutPoint(4);`
   (4 is all media types; clearing keeps the person's master clip unmarked).
   One `nolgia_app_run` per shot, so each lands in the panel's Activity and can
   be undone by hand.
5. **The 9:16 copy.** `sequence.autoReframeSequence(9, 16, "default",
   "<name> 9x16", false)` makes a new reframed sequence (Premiere puts it in an
   `Auto Reframed Sequences` bin; at 4K it comes out 1215 x 2160). It returns
   quickly and keeps the effects already on the clips, so grade first if a
   grade is wanted (the "Grade camera log footage in Premiere Pro" workflow).

## Check

- `nolgia_app_info`: the new sequences exist, the shot count and length match
  the plan, and no existing sequence changed.
- Preview the first frame, a middle frame and the last frame of each new
  sequence. On the 9:16 copy, look for heads cut off and for a subject Auto
  Reframe lost; name those shots so the person can adjust Position in Effect
  Controls.

## Deliver

Save the project. Export both sequences with `nolgia_app_export` `mp4` (it
renders on the person's computer with Match Source; a minute of 4K takes about
half a minute here). Tell the person the sequence names, the shot list, the
length, and which shots to look at first.
