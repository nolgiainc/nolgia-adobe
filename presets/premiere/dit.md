---
slug: premiere-dit
name: Offload and verify your cards (DIT)
category: Film assistant
app: premiere
min_app_version: "25.0"
beta: true
starter_prompt: "Use NOLGIA to do my DIT: copy my camera cards to my drives, check every copy, name the files by shoot, day and camera, and give me the DIT report. Then bring the footage into Premiere Pro, organized by day."
---

# Offload and verify your cards (DIT)

NOLGIA does the DIT. It copies each camera card to one to three drives, reads every copy
back to prove it matches the card, writes industry manifests (ASC MHL) and a
DIT report, and can name the files by shoot, date, time and camera. Then the
footage comes into Premiere Pro organized by day. The cards are only read.
Nothing at a destination is ever replaced.

Everything runs through the `dit` command kind, which drives the NOLGIA CLI on
this computer (`nolgia dit`). If the CLI is missing, the command says how to
install it. Pass that on word for word.

## Ask

1. Which cards or folders to copy. Give full paths: on Windows `E:\`, on a Mac
   `/Volumes/A001`. One folder per card.
2. Where to copy them: one to three destinations (a working drive plus a
   backup is the usual pair). Full paths.
3. The shoot's name, which becomes the folder on each drive (`Brand film D1`),
   and a name for each card if theirs are unclear (`A001`, `B001`).
4. Any client or post house hash requirement. xxh64 is always made; add MD5
   or SHA-1 only when asked (`hash: "xxh64,md5"`).
5. Whether to rename the files after the copy (default: no). If yes: a short
   shoot code for the names, and a label per camera (`ILME-FX3A=A-FX3A`).

## Build

1. **Plan.** Run `dit` with `subcommand: "offload"` and `dry_run: true`. It
   shows the cards, sizes, destinations, free space and any conflicts. A
   conflict means a different file is already at a destination. Stop there
   and tell the person; never work around it.
2. **Copy and verify.** Run the same offload without `dry_run`. The panel
   shows the person the plan and waits for their Approve. Long offloads come
   back as a job: follow it with `action: "status"` and the `job_id` until
   `running` is false. `exit_code` 0 means every copy matched. 68 means a
   problem, and `result` names each file. 130 means it stopped: start the
   same offload again and it resumes.
3. **Look at what was shot.** Run `subcommand: "inventory"` on the shoot
   folder at the first destination. If it warns that a camera's clock looks
   hours off, ask whether it was one shoot. If yes, pass that offset as
   `clock_offsets` (`"ILME-FX3A=-12h"`) to the rename and the report.
4. **Rename (only if asked).** Run `subcommand: "rename"` without `apply` and
   show the person the examples. Then run it with `apply: true`; the panel
   asks for Approve. The names keep the camera's own name at the end.
   Card-structure files keep theirs, and `undo` restores everything.
   Afterwards run `subcommand: "manifest"` on each card folder, so the ASC
   MHL lists the new names.
5. **The report.** Run `subcommand: "report"` on the shoot folder with
   `verify: true`. It re-reads every file, which takes about as long as the copy.
6. **Into Premiere Pro.** Import the shoot folder at the first destination
   with `nolgia_app_run` (`app.project.importFiles`). Then follow the
   "Organize a Premiere Pro project" workflow, using the shoot folder's days.

## Check

- The offload result: `status` `complete`, and `verified` equal to the card's
  file count at every destination.
- The report's verification: every file matches, none missing.
- In Premiere Pro, the clip count matches the inventory's video count.

## Deliver

Tell the person, in a few lines:
- what was copied where (files, size, each destination);
- that every copy was read back and matched;
- where the report and the manifests are (`_DIT` in the shoot folder, and
  `ascmhl` in each card);
- the camera list from the inventory, and any clock offset you corrected.

Remind them the cards were only read. Once they have two verified copies,
reformatting a card is their call.
