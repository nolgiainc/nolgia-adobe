# NOLGIA for After Effects, Premiere Pro and Illustrator

NOLGIA's plugin for After Effects, Premiere Pro and Illustrator. It connects the app on your computer to
NOLGIA, so NOLGIA Agent can look at your project, make changes in it, render
previews and move files between the app and your NOLGIA library. Since 0.2.0
the NOLGIA panel has a chat: type what you want done in the app and NOLGIA
Agent does it right there. You can also use Claude, Cursor, Codex or another
agent with NOLGIA connected, through NOLGIA's MCP server.

```
the panel's chat -----------------> api.nolgia.ai --> your NOLGIA Agent (works in this app through the plugin)
your agent --MCP--> mcp.nolgia.ai --> api.nolgia.ai <--(the plugin connects out)-- the app on your computer
```

The plugin always connects out to NOLGIA; nothing connects in to your
computer. It only takes commands while you are signed in and have it switched
on, and it lists every command it runs.

One extension for all three apps (a CEP extension). It has two
parts: an invisible part that starts with the app and keeps the connection to
NOLGIA, and the NOLGIA panel, which shows what it is doing and holds the
switches. Closing the panel does not disconnect.

## Install and use

1. Get `nolgia-adobe-<version>.zxp` from [nolgia.ai/plugins](https://nolgia.ai/plugins)
   (or the [releases](https://github.com/nolgiainc/nolgia-adobe/releases) here).
2. Quit After Effects, Premiere Pro and Illustrator, then install it with
   Adobe's own installer. On Windows:

   ```bat
   "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install nolgia-adobe-0.2.5.zxp
   ```

   On macOS the same tool is
   `/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent --install nolgia-adobe-0.2.5.zxp`.
   The installer skips a version that is already installed: to reinstall the
   same version, remove it first (`/remove NOLGIA`). The package is signed, so
   no debug setting is needed.
3. Start the app and open Window > Extensions > NOLGIA.
   For transcripts in Premiere Pro (`transcribe`, below), click Install
   transcripts in the panel once: Adobe's installer adds NOLGIA Transcripts,
   a small UXP plugin that comes inside the extension (Premiere Pro 25.6 or
   later). If the panel does not show it running within a minute, open
   Window > UXP Plugins > NOLGIA Transcripts once.
4. Click Sign in. Your browser opens a NOLGIA page; check that the code
   matches the one in the panel and approve it. Each app signs in on its own.
5. Keep Connected on and tell NOLGIA Agent what to do in the panel's chat
   box. You can also ask Claude, Cursor, Codex or another agent with NOLGIA
   connected. Each command shows up in the Activity list. Click Pause (or turn
   Connected off) to stop at any time.

Settings in the panel:

- **Connected**: NOLGIA can send commands to this app only while this is on.
  It stays on the next time the app starts.
- **Allow NOLGIA Agent**: also let your NOLGIA Agent in the cloud work here, not
  only the agent apps you run yourself.
- **Ask before running code**: show every script NOLGIA wants to run in the
  panel (it opens by itself) and wait for you to click Run code or Deny.
  Only a click answers a request: its buttons turn on 1 second after it
  shows, the pointer has to go down and up on the button after that, and no
  key ever answers.
- **Sign out**: disconnect and forget the sign in on this computer.

The sign in and the switches are kept per app in
`%APPDATA%\NOLGIA\adobe\<app>\settings.json` (on macOS
`~/Library/Application Support/NOLGIA/adobe/<app>/settings.json`), readable only
by you, next to a log of what the plugin did (`nolgia.log`, never the token).

ExtendScript that NOLGIA runs runs on your computer with your permissions, like
any script. Turn on Ask before running code if you want to see it first.

## The chat in the panel

The NOLGIA Agent card is a chat with your NOLGIA Agent: the same Agent and the
same chats as nolgia.ai/agent. It works the same way as the chat in NOLGIA for
Photoshop.

- **Suggestions:** before your first message it suggests a few things to ask
  in this app. A click puts one in the box.
- **Pinned to this app:** your first message starts a chat pinned to this app
  (`app` on `POST /agent/sessions`: `after_effects`, `premiere` or
  `illustrator`, and the `instance_id` its connection runs under). So every
  turn tells the Agent you are writing from this app and that your requests
  are about it.
  - On nolgia.ai the chat shows as the app's name and your first words.
  - The panel remembers it, one chat per copy of the app (a second After
    Effects keeps its own). New chat starts another.
  - A chat that is not pinned to this copy is never used here.
- **One message is one turn:** while the Agent works, the box waits ("NOLGIA
  Agent is working"), and Stop ends the turn. What it does in the app shows
  in the Activity list as usual. The reply comes back in the panel with what
  the turn cost.
- **Closing the panel:** the chat lives in NOLGIA's invisible part, with the
  connection, so closing the panel does not stop a turn. Open the panel again
  to read the reply.
- **What it needs:** Connected and Allow NOLGIA Agent on, since the Agent
  reaches this app through them. When one is off, the card says so, with one
  button that turns it on.
- **Cost:** the line under the box gives what a turn costs on your Agent's
  model. It reads "NOLGIA Agent works right here, each turn from N credits on
  your model", with N from `GET /agent/models` for the brain `GET /agent`
  names. If NOLGIA doesn't say, it gives the lowest rate, from 10 credits.
- **No Agent or no credits:** if your account has no NOLGIA Agent yet, or no
  credits left, the card says so, with a link to nolgia.ai.
- **Signing out** forgets the chats on this computer (`chat.json` next to
  each app's settings).

The chat uses the sign in the panel already has; it asks for nothing new.

## What your agent can do

Every app takes the command kinds in the table; Premiere Pro also takes
`transcribe` (below). Frames count from 0 at the start of the comp or
sequence; artboards count from 1.

| Command | After Effects | Premiere Pro | Illustrator |
|---|---|---|---|
| `info` | project (file, unsaved changes, items by kind, bit depth), active comp (size, frame rate, frames, current frame, work area, layers with type, effects and selection), all comps, selected items, render queue | project (file), bins with counts, sequences (size, frame rate, length, tracks), active sequence (playhead, in and out, tracks, selected clips), selected items | open documents, the active one's colour mode, size, artboards, layers and sublayers, selection, counts of paths, groups, images and text |
| `run` | ExtendScript: `{value, stdout, stderr}` (see below) | same | same |
| `preview` | `comp` (or `camera`) name, `frame`, `width`: a still of a comp or of a footage item | `sequence` (or `camera`), `frame`, `width`: a frame of the sequence | `artboard` (name or number, or `camera`), `width`: the artboard |
| `import_asset` | footage into the `NOLGIA imports` folder; `as: "layer"` also adds it to the active comp; or `color_preset`, a NOLGIA film stock installed as a LUT (below) | media into the `NOLGIA imports` bin; or `color_preset`, a NOLGIA film stock installed as a LUT (below) | images embedded (or `as: "link"`) and SVG, PDF or AI as groups, on a `NOLGIA imports` layer; with nothing open, the image opens as a document |
| `export` | `mp4` (render queue, H.264), `png` (a frame), `aep` | `mp4` (H.264 Match Source), `png` (a frame), `prproj` | `png` (the artboard, at least 2048 px), `svg`, `pdf`, `ai` |
| `save` | `path?` | `path?` | `path?` |
| `open` | `.aep` (asks you first over unsaved changes) | `.prproj` (opens next to the open one) | any file Illustrator opens (in its own window) |
| `dit` | camera-card DIT through the NOLGIA CLI on this computer (below) | same | same |

**DIT (`dit`).** This runs the NOLGIA CLI's `nolgia dit` on this computer:
copy camera cards to one to three drives with every copy read back and
checked, ASC MHL manifests, inventory, rename, undo and the DIT report.

- **Arguments:** `subcommand` is one of `offload`, `verify`, `manifest`,
  `inventory`, `rename`, `undo` or `report`, with that subcommand's fields:
  - `offload`: `sources`, `destinations`, `shoot?`, `cards?`, `hash?`,
    `dry_run?`, `max_parallel?`
  - `verify`: `dir`, `manifest?`, `only?`, `record?`
  - `inventory`: `dir`, `clock_offsets?`, `csv?`
  - `rename`: `dir`, `shoot?`, `cameras?`, `clock_offsets?`, `pattern?`,
    `map?`, `apply?`
  - `undo`: `dir`, `map?`
  - `report`: `dir`, `manifest?`, `verify?`, `only?`, `clock_offsets?`,
    `out?`

  Paths are full paths.
- **Long work:** it comes back as `{job_id, running}`. Follow it with
  `action: "status"` and the `job_id`, or stop it with `action: "cancel"`;
  a cancelled offload resumes when started again.
- **Result:** a finished job has `exit_code` (0 everything matched, 68 a
  mismatch, missing file or conflict, 130 stopped) and the CLI's own JSON
  as `result`.
- **Approval:** `offload`, `rename` with `apply` and `undo` first run the
  CLI's dry run. They then always wait for your Approve in the panel,
  whoever sent them and whatever "Ask before running code" says. The cards
  are only read, and nothing at a destination is ever replaced.
- **What runs:** only the CLI, with arguments built from these fields, and
  never through a shell.
- **Install:** the plugin finds `nolgia` on PATH, in the installers'
  folders and in npm's global package. Without it, the command says how to
  install it (`npm install -g @nolgia/cli`).
- **Workflow:** "Offload and verify your cards (DIT)"
  (`presets/premiere/dit.md`).

**Transcripts in Premiere Pro (`transcribe`).** Timed transcripts of the
clips in the project, so an agent can cut on what people say.

- **Arguments:** `clips` is `"selected"` (default: the clips selected in the
  Project panel, else on the timeline), `"sequence"` (every clip used in
  `sequence`, default the active one) or a list of clip names or media paths;
  `engine` is `"auto"` (default), `"premiere"` or `"nolgia"`; `allow_credits`
  (default false); `language` (two letters, default `en`); `words` (also
  return each word's time).
- **Premiere's own Speech to Text** (free, on this computer): ExtendScript has
  no transcript API, so NOLGIA Transcripts (`premiere-uxp`, UXP) reads
  them and hands them to the extension over a local link: it listens on
  127.0.0.1 only (ports 47731 to 47733), only while NOLGIA is connected in
  Premiere, and answers only requests that carry that session's secret (made
  at each start and written with the port to `transcripts-link.json` in the
  plugin's settings folder, removed when the link closes) and a 127.0.0.1
  Host. Premiere Pro 25.6 and later read the transcript Premiere
  already has (Text panel > Transcript > Transcribe, or Preferences >
  Transcription > Automatically transcribe video clips on import); 26.5 and
  later also make it when there is none.
- **NOLGIA's transcription** (`engine: "auto"` for the clips Premiere has no
  transcript of, or `"nolgia"`): Premiere exports the clip's audio as an MP3
  (a temporary sequence in a temporary bin, both removed), it is uploaded to
  your NOLGIA library and transcribed (`POST /assets/{id}/transcription`,
  1 credit per started minute of each clip, at most 60 minutes). Only with
  `allow_credits: true`; without it the result has `needs_credits` (clips,
  minutes, credits) for the agent to ask about. Its segments are pause-cut
  chunks of up to about 24 seconds, without word times.
- **Result:** `transcripts` (per clip: `engine`, `timing` (`words`,
  `segments` or `chunks`), `segments` with `start`, `end`, `text` and
  Premiere's `speaker` label, `sentences` when word times are known, `file`),
  `missing` (with what to do), `needs_credits`, `credits_charged`. Each
  transcript is saved as JSON in `nolgia_transcripts` next to the project
  (`<clip>.json`; NOLGIA's as `<clip>.nolgia.json`)
  (Documents/NOLGIA exports/transcripts while it is unsaved), Premiere's own
  JSON included. Long work comes back as `{job_id, running}`; follow it with
  `action: "status"` or stop it with `action: "cancel"`.
- **Workflow:** "Cut a behind-the-scenes edit in Premiere Pro"
  (`presets/premiere/bts-cut.md`) cuts on whole sentences with it.

Previews are uploaded to your NOLGIA library as a PNG, or a JPEG when the PNG
would be too big for your agent to see inline (about 3.6 MB): `{asset_id,
width, height, mime_type, comp|sequence|artboard, frame}`. `mp4` and `png`
exports are uploaded too: `{asset_id, format, filename, frames}`. Project files
(`aep`, `prproj`, `ai`) stay on your computer: exporting one copies the project
as last saved next to it, never over a file (a project that was never saved is
saved into Documents/NOLGIA exports). NOLGIA's library does not take SVG or PDF
yet, so those exports stay on your computer too, next to the document:
`{asset_id: null, path, note}`. Imported files that the app needs on disk go
into `nolgia_assets` next to the project, or Documents/NOLGIA imports while it
is unsaved; WebP images are converted to PNG, which the apps read.

**LUTs in Premiere Pro and After Effects.** `import_asset` with
`color_preset` (a slug from `GET /color-presets`, which is public) installs
that NOLGIA film stock as a `.cube` LUT in the per-user Adobe LUT folder that
Lumetri Color reads, so no administrator rights are needed:
`%APPDATA%\Adobe\Common\LUTs` on Windows,
`~/Library/Application Support/Adobe/Common/LUTs` on macOS. A look goes in
`Creative` and is listed under Lumetri Color > Creative > Look. A camera log
variant (the slug plus `-slog3`, `-logc3`, `-vlog` or `-bmdfilm5`, for example
`kodak-portra-400-slog3`) converts that log footage to Rec.709 before the look,
so it goes in `Technical` and is listed under Basic Correction > Input LUT. The
file is named after the preset (`NOLGIA Kodak Portra 400 (S-Log3).cube`) and
replaces its own older copy: `{imported, kind: "lut", color_preset, lut, path,
menu, relaunch_needed, note}`. The apps read these folders when they start, so
the LUT shows up after you save, quit and reopen. Their scripting cannot set a
LUT on a clip, so `apply_to` installs the LUT and says it was not applied
(`applied_to: []`, `apply_note`): pick it in the menu above.

**`run`** evaluates ExtendScript in the app. The code sees `print()`, `log()`,
`console.log/info/warn/error` and `$.writeln` (captured as stdout; warn and error
as stderr), and `alert()` writes to stderr instead of opening a dialog. `value`
is what the code puts in `result`, else the value of its last statement, or
what it returns when it uses `return` at the top level. It is turned into JSON:
app objects become their names, files their paths, dates ISO text. A failure
returns the error with its line number and the lines around it. After Effects
groups each run into one undo step. ExtendScript cannot be stopped from
outside: when code outlives its time, NOLGIA stops waiting and says so, and the
app finishes it on its own.

## For scripts, render machines and tests

| Variable | Effect |
|---|---|
| `NOLGIA_TOKEN` | use this token instead of signing in (never saved) |
| `NOLGIA_API_URL` | API to talk to (default `https://api.nolgia.ai/v1`) |
| `NOLGIA_BRIDGE_AUTOCONNECT=1` | connect as soon as the app starts |
| `NOLGIA_ASK_BEFORE_RUN=0/1` | set Ask before running code |
| `NOLGIA_ALLOW_AGENT=0/1` | set Allow NOLGIA Agent |
| `NOLGIA_INSTANCE_ID` | fixed session id for this app |
| `NOLGIA_EXPORT_DIR` | where `aep`, `prproj` and `ai` copies of unsaved projects go |
| `NOLGIA_PREVIEW_MAX_BYTES` | the size above which previews become JPEG |
| `NOLGIA_LUT_DIR` | the LUT folder `color_preset` installs into (it holds `Creative` and `Technical`); default the per-user Adobe one |
| `NOLGIA_TRANSCRIPTS=0` | Premiere Pro: do not open the local link NOLGIA Transcripts connects to |
| `NOLGIA_TRANSCRIPTS_PORTS` | Premiere Pro: other ports for that link (NOLGIA Transcripts may reach 47731 to 47733) |
| `NOLGIA_UPIA`, `NOLGIA_TRANSCRIPTS_PACKAGE` | tests: the installer and the package Install transcripts uses |

Apps started from the Creative Cloud app or a launcher often do not get your
environment, so the same keys can go in a file instead:
`%APPDATA%\NOLGIA\adobe\env.json` (macOS
`~/Library/Application Support/NOLGIA/adobe/env.json`), for example
`{"NOLGIA_TOKEN": "nol_...", "NOLGIA_BRIDGE_AUTOCONNECT": "1"}`. The
environment wins over the file.

## Development

The parts that do not need an Adobe app live in [`core/`](core/)
(Node, no dependencies, CommonJS for the Node 17 inside CEP 12) and have unit
tests that run with Node 18 or newer against the same mock API the Blender
tests use:

```sh
npm test          # node --test "tests/*.test.js"
```

[`host/`](host/) is the ExtendScript: `nolgia.jsx` (JSON, `run`,
the call entry point) and one file per app (`aeft.jsx`, `ppro.jsx`,
`ilst.jsx`). It knows nothing about CEP, so a later UXP port can keep the app
files and replace only the transport ([`js/`](js/): `service.js`,
`panel.js` and the thin `cep.js`). CEP is switched off by default from
December 2028.

Build the signed installer (Adobe's `ZXPSignCmd` from
[Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources), which
signs best on the platform the package is installed on; from WSL it runs the
Windows one). Without `--cert` it makes a self-signed certificate once and
keeps it in `dist` (ignored by git):

```sh
node tools/build.js --zxpsigncmd /path/to/ZXPSignCmd.exe
# dist/nolgia-adobe-0.2.5.zxp
node tools/build-transcripts.js
# dist/nolgia-premiere-transcripts-<version>.ccx (NOLGIA Transcripts, a plain zip;
# build.js also puts it inside the .zxp, for the panel's Install transcripts)
```

`--debug` adds a `.debug` file that opens Chrome DevTools on ports 8092 to 8094
(the invisible part in After Effects, Premiere Pro, Illustrator) and 8095 to
8097 (the panel). Never ship that build.

The end-to-end test builds and installs the package with Adobe's installer,
points the plugin at the mock API (or production with `--api prod`) through
`env.json`, starts each app, drives every command through the caller side of
the API against its own session, checks the results and quits the app:

```sh
python3 tests/e2e_adobe.py --zxpsigncmd /path/to/ZXPSignCmd.exe
python3 tests/e2e_adobe.py --api prod --token-file ~/.config/nolgia/tokens.json --no-install
```

It runs on Windows, from WSL (Windows paths through `wslpath`) or on macOS,
closes the apps' own warning dialogs as they appear (their text is printed;
on macOS only when the terminal has Accessibility access), and removes
`env.json` and the test assets it made in production when it is done.

On macOS 26.6 (Apple silicon), on October 7, 2026, it passed in After Effects
2026 (26.5), Premiere Pro 2026 (26.5.2) and Illustrator 2026 (30.8.2) against
the mock API and the real one. Premiere Pro 26.5.2 on macOS ignores
AppleScript, its quit included, with or without NOLGIA installed (Cmd+Q
works), so the test quits it through the plugin with ExtendScript's
`app.quit()` and skips the ask check there (see the test's docstring). The
test's macOS support changed how it drives the apps on Windows too; it has
not been run on Windows since.

0.2.1 (the panel's chat) on macOS 26.6.2 (Apple silicon), on October 29,
2026, in After Effects 26.5.0, Premiere Pro 26.5.2 and Illustrator 30.8.2
against NOLGIA itself: installed over 0.1.3 with Adobe's installer, signed in
and connected in each app, one live NOLGIA Agent turn from each panel's chat
(70 credits each, the work done in the app), Activity and the panel scrolling
down to Sign out. 0.2.2 fixes what that test found: the plugin reports the
computer's own name (on a Mac the one in System Settings > General > About,
not its network name) and its operating system, After Effects' version reads
26.5 (build 89) instead of 26.5x89, an unsaved Illustrator document sends its
name, and the sign in page names the app. 0.2.2 passed its macOS re-test on
October 29, 2026 (macOS 26.6.2, After Effects 26.5.0 build 89, Premiere Pro
26.5.2, Illustrator 30.8.2): the session reported the Mac's own name, macOS,
"26.5 (build 89)" and Untitled-1, and the sign in page named each app. One
gap it found: After Effects' `info` result still said "26.5x89". 0.2.3 makes
the `info` result use the same label as the session (and the panel's start
line in Activity), in all three apps.

0.2.3 is broken: its host/nolgia.jsx still said 0.2.2, so the panel never
accepted the loaded app script and every command answered
"__NOLGIA_NOT_LOADED__" in all three apps. 0.2.4 fixes that, and the version
is now checked: it is written in six places (package.json, core/index.js,
CSXS/manifest.xml's bundle and two extensions, host/nolgia.jsx), and
`node tools/versions.js`, `tests/version.test.js` and `tools/build.js` all
refuse a mismatch. The test also runs the panel's own call snippet
(core/hostcall.js) against the real host/nolgia.jsx. To release a new
version, change all six. 0.2.4 also shows a request that is not code (a DIT
copy, opening another project) as plain text with its own note in the
approval card, instead of as code that "runs in" the app.

0.2.5 (from the owner's third Mac test, where a request in the Resolve
plugin was approved about 3 s after its window opened, with nobody
clicking): a request waiting for an answer floats over the top of the panel
instead of pushing the panel's content down under a click that is on its
way; its buttons look off and refuse clicks for 1 second each time it shows;
a click counts only when the pointer went down on that same button after
that; the buttons take no keyboard focus, so Return and Space never answer;
the answer goes to the request the card was drawn for; and the service logs
every answer and every refused click with its request. Checked with the
unit tests and with the panel (panel.html, css/panel.css, js/panel.js) in
headless Chromium, the engine CEP panels run on, driven by Playwright's real
mouse and keyboard: 0.2.4 moved the chat's Send button 166 px down when a
request showed, and approved a click 0.3 s after a request showed, a press
at 0.3 s released at 1.5 s, and Return and Space after a click had left
the button with focus; 0.2.5 moved nothing and approved none of these, and
approved a click 1.5 s after the request showed. Not run in the apps.

DIT (the `dit` command kind running the NOLGIA CLI 0.3.1), on October 15,
2026, against the real API through `POST /bridge/commands`: in Premiere Pro
2026 on Windows 11 with 0.1.3, `inventory` and the approval card for an
offload (denied); in Premiere Pro 26.5.2 on macOS 26.6.2 (Apple silicon)
with a 0.1.4 test build carrying the same `core/dit.js`, a dry-run plan, an
offload approved in the panel, `verify` of the shoot folder, `inventory`, a
`rename` dry run and `report --verify`.

Transcripts (the `transcribe` command kind with NOLGIA Transcripts), on
October 16, 2026, against the real API through `POST /bridge/commands`, on
our own clips: in Premiere Pro 26.2.0 on Windows 11, Premiere's own
transcripts (made with transcribe on import) read through the helper with
word times and speaker labels, the `needs_credits` quote, and NOLGIA's
transcription of two more clips (2 credits); a dialogue-first cut laid on
those sentences. In Premiere Pro 26.5.2 on macOS 26.6.2 (Apple silicon)
with a 0.1.4 test build: Install transcripts in the panel installed the
helper, which connected by itself; Premiere made a transcript on request
(`transcribeClipProjectItem`); NOLGIA's transcription through the MP3
export (1 credit). macOS resolves localhost to ::1 first, which is why the
local link listens on both loopbacks.

## This repository

| Path | What it holds |
|---|---|
| [`CSXS/`](CSXS/), [`panel.html`](panel.html), [`service.html`](service.html), [`js/`](js/), [`css/`](css/), [`icons/`](icons/), [`fonts/`](fonts/) | The CEP extension: the panel and the invisible part |
| [`core/`](core/) | The parts that do not need an Adobe app (Node, no dependencies) |
| [`host/`](host/) | The ExtendScript, one file per app |
| [`premiere-uxp/`](premiere-uxp/) | NOLGIA Transcripts, the small UXP plugin for transcripts in Premiere Pro |
| [`tools/`](tools/) | `build.js` (the signed .zxp), `build-transcripts.js` (the transcripts .ccx) and the mock API |
| [`tests/`](tests/) | Unit tests and the end-to-end test |
| [`presets/after-effects/`](presets/after-effects/), [`presets/premiere/`](presets/premiere/), [`presets/illustrator/`](presets/illustrator/) | The Film assistant workflows for each app and the rules each app's workflows share |
| [`tools/mock_bridge_server.py`](tools/mock_bridge_server.py) | An in-memory mock of the NOLGIA API that the tests run against |

The mock API is the same file in every NOLGIA plugin repository ([Blender](https://github.com/nolgiainc/nolgia-blender), [After Effects, Premiere Pro and Illustrator](https://github.com/nolgiainc/nolgia-adobe), [Photoshop](https://github.com/nolgiainc/nolgia-photoshop) and [DaVinci Resolve](https://github.com/nolgiainc/nolgia-resolve));
copy a change to it into the others.

This plugin used to live in the `adobe/` folder of
[nolgiainc/nolgia-plugins](https://github.com/nolgiainc/nolgia-plugins), with
the other NOLGIA plugins. On October 16, 2026 it moved here with its history,
its branches and its releases. The releases on nolgia-plugins stay where they
are, so links to them keep working. Issues and pull requests belong here.

## License

GPL-3.0-or-later ([`LICENSE`](LICENSE)); NOLGIA Transcripts too ([`premiere-uxp/LICENSE`](premiere-uxp/LICENSE)). IBM Plex Sans is under the SIL Open Font License ([`fonts/OFL.txt`](fonts/OFL.txt)).
