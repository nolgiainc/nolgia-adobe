# Mac test for NOLGIA for Adobe 0.4.0 (sound design in Premiere Pro)

0.4.0 has not been run on a Mac. This is the run that proves it there. It
takes about 20 minutes. Nothing in it uses a NOLGIA account or credits: the
plugin talks to the mock API on the Mac itself.

## What you need

- A Mac with Premiere Pro 2026 (26.x) in `/Applications/Adobe Premiere Pro
  2026`, and nothing important open in it: the test starts and quits
  Premiere Pro itself, and refuses to start while Premiere Pro is running.
- Python 3 (`python3 --version`; macOS asks to install the command line
  tools the first time, say yes) and Node 18 or newer (`node --version`; from
  nodejs.org if missing).
- Adobe's ZXPSignCmd for macOS, from
  github.com/Adobe-CEP/CEP-Resources, folder `ZXPSignCMD/4.1.103/mac` (Adobe
  asks to sign on the platform the package is installed on).
- Optional: `ffprobe` (from ffmpeg, `brew install ffmpeg`) to check the
  preview's size, frame rate and length too.
- The repository at the 0.4.0 commit:
  `git clone https://github.com/nolgiainc/nolgia-adobe && cd nolgia-adobe && git checkout feat/sound-design`
  (or the release tag once there is one).

## Steps

1. Quit Premiere Pro.
2. Write down which NOLGIA for Adobe is installed now (to put it back
   after): Premiere Pro > Window > Extensions > NOLGIA shows the version at
   the bottom of the panel, or
   `grep -o 'ExtensionBundleVersion="[^"]*"' "/Library/Application Support/Adobe/CEP/extensions/NOLGIA/CSXS/manifest.xml"`.
3. Unit tests: `npm test`. All must pass.
4. Build the signed package:
   `node tools/build.js --zxpsigncmd /path/to/ZXPSignCmd`
   It writes `dist/nolgia-adobe-0.4.0.zxp`.
5. Run the proof (it installs that package with Adobe's installer first):
   `python3 tests/e2e_sound_design.py --zxp dist/nolgia-adobe-0.4.0.zxp --report ~/Desktop/sound-design-mac.json`
   If macOS asks whether Terminal may control Premiere Pro or read the
   screen's dialogs, allow it (System Settings > Privacy & Security >
   Accessibility); without it a Premiere Pro dialog may stay up and the test
   waits for you to close it.
6. Watch the lines it prints. Each check says PASS or FAIL:
   - starts and connects with sound_design
   - a scratch project with the bars on a 23.976 sequence
   - read: tracks, clips, in and out, markers
   - preview: H.264 of the in to out range, uploaded, its start on the timeline
   - place: eight tones on three new tracks, the editor's tracks as they were
   - the mix measures: gain 0/-6/-12 dB, mono centred, fades from silence
   - a repeated place places nothing twice
   - remove: the run's clips and tracks out, the files kept, A1 as it was
7. Look at the result yourself once: open the project it made
   (`~/Documents/NOLGIA sound design proof <date>/project/sound proof.prproj`)
   in Premiere Pro. After the test the NOLGIA tracks are gone again (that is
   the remove check); the sound files are still in `NOLGIA Sounds/e2e-run-1`
   next to the project and in the bin `NOLGIA imports / Sound design`, and
   the backups are in `NOLGIA backups`.
8. Put the version from step 2 back if it was not 0.4.0: download it from
   nolgia.ai/plugins/premiere (or the GitHub release) and install it the
   usual way.

## What to send back

- The file `~/Desktop/sound-design-mac.json` (the measured numbers and every
  check), the printed PASS and FAIL lines, the Mac's macOS version and the
  Premiere Pro version (Premiere Pro > About Premiere Pro).
- On Windows (Premiere Pro 26.2, November 2026) the mix measured: a tone at
  -15.05 dBFS RMS placed at 0, -6 and -12 dB came out at -15.05, -21.05 and
  -27.05; a mono tone on the new stereo track at -18.06 on each side; fades
  start from silence and reach the level exactly at their end. The Mac must
  measure the same within 0.2 dB. Anything else is a finding: write it down
  with the numbers.

## Known differences to look for on a Mac

- Premiere Pro's presets sit inside the app bundle (`Contents/MediaIO`); the
  plugin looks there too. If the preview check fails with "H.264 presets were
  not found", send the folder listing of
  `/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634`.
- Premiere Pro on macOS ignores AppleScript (also its quit), so the test
  quits it through the plugin.
- Folder and file names: the sounds folder is `NOLGIA Sounds/<run>` next to
  the project, and names keep letters of any language; check that the file
  names in that folder read right in Finder.
