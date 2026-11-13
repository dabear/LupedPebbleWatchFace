# Project guidance

## Keeping this file current

- When a task reveals a new build, emulator, rendering, integration or workflow fact, add it here in the same task (and the same commit, if any). Keep it to the operational consequence, command or invariant; protocol details belong in `variants/luped/PROTOCOL.md`, state transitions in `STATE_MACHINES.md`.

## Builds

- Variants: `luped` (Luped CGM watchface, the default) and `lupedhelper` (Luped Remote watchapp, `build/luped-remote.pbw`, UUID `738255f4-b58b-41cd-a7ae-27fc80e81fcb`), both from `src/embeddedjs/main.js.in`. Every variant's `watchface-config.json` must list every flag (`helper`, `demoTestOnly`, …); the assembler throws on a missing one. CrimsonBear lives in `dabear/CrimsonBearPebbleWatchFace`.
- Luped Remote must never change Luped's build: helper code goes only in `// @if helper` sections (`// @else` where it replaces Luped code). After any change rebuild `--variant luped` and compare `python3 scripts/pbw-hash.py build/luped-cgm.pbw` and the assembled `main.js` with the previous build. Never nest `// @if` sections (`scripts/test-*.cjs` assemble with a non-nesting regex). Keep constants used only by gated code inside the same section, or lint fails on unused bindings. The helper's minify allowlist is `extra_private_methods` in its `build-release.sh` case.
- Release verification: `PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh [--variant <v>] --build --minify`. Build both `emery` and `gabbro`. Raise `variants/<v>/package.json` when bumping. Report Alloy size, PBW size and SHA-256 from the summary.
- `--skip-deps` is for repeated local builds only after a successful install (`npm ls --all` passes, hidden lock matches `package-lock.json`); publishing rejects it. Slow builds are almost always `npm ci`/registry validation (can stall ~5 min); compiling takes under a second.
- Builds are reproducible except `pebble-app.bin`'s build time (0x7C), GNU build ID (0x94, hashes the absolute stage path) and header CRC (0x14), and `manifest.json` timestamps/CRCs, so compare hashes only between builds from the same checkout path.
- Tooling: Pebble Tool needs Python 3.10 on Apple Silicon (`uv tool install --python 3.10 pebble-tool`). The SDK's `.venv` must use pebble-tool's Python minor version, or the build fails after the Moddable prebuild with `SRE module mismatch` (recreate `.venv` and `pip install -r sdk-core/requirements.txt`, or reinstall the SDK). Fallback executable: `/private/tmp/cgm-pebble-venv/bin/pebble` (5.0.40, SDK 4.33.1); temp cleanup can break it (`No module named 'pebble_tool'`), then recreate the venv with `pip install pebble-tool==5.0.40`. The macOS emulator needs Homebrew `libpng`.

## Memory

- Every module the manifest matches goes into the Alloy archive, imported or not, and the archive costs app heap about byte for byte. Keep code a variant never runs inside `// @if`. Luped's manifest leaves out Moddable's typings include and its stage leaves out `protocol.js`. Archive contents: `build/variants/<v>/project/build/mods/emery/mcrun/tmp/pebble/release/embeddedjs/files/*.xsb`.
- The real limit is XS runtime memory ("Alloy: Fatal Error / memory full"; the dialog stays over everything until a button is pressed). `ModdableCreationRecord` in each `mdbl.c` sets stack/slot/chunk; above 32 KB in total the firmware takes them from the app heap. Luped: 4 KB stack, 32 KB slots, 16 KB chunks (~50 % / ~41 % used, ~28.7 KB app heap left). Luped Remote: 28 KB slots so the 48 KB total fits the static block and takes no app heap (0.1.4: 42 KB app heap free at its lowest, slot peak 25.9 of 28.7 KB, chunk 10.6 of 16 KB).
- Measure with `build-release.sh --install --measure-memory` (`--phone` or `--cloudpebble`); report slot, chunk and stack use and free app heap, and flag ≥ 85 % slots/chunks or < 12 KB free heap. It defines `LUPED_XS_INSTRUMENTATION`; never ship that: the firmware then samples every second for the whole run, which cost Luped 0.1.11–0.1.20 about a third of the battery. `pebble install --logs` misses startup lines; subscribe to logs first and restart from `pebble repl`.
- In the emulator: prepend `#define LUPED_XS_INSTRUMENTATION 1` to the stage's `src/c/mdbl.c`, install on emery, and pipe `APP="…"; WAIT=20` plus `exec(open("scripts/xs-usage.py").read())` into `pebble repl --emulator emery` (rerun if it prints `XSUSAGE NONE`; `live_*` values shift with GC timing, heap minimum and keys are stable).

## Phone link (Loop, Trio)

- Luped has no PebbleKit JS (`enableMultiJS: false`); CLI AppMessage injection doesn't reproduce the Loop integration. Loop and Trio push through their own CoreBluetooth PPoGATT server via the LupedSmartwatchKit plugin (LoopKit `SmartwatchManager`; submodule in LoopWorkspace and `dabear/Trio`, PR branch `smartwatch-manager-review`). Transport and Luped logic: `dabear/elbbepTransport` (`~/Code/elbbepTransport`, `swift test`), required by tagged version. After tagging, raise the plugin's `minimumVersion` and move the `elbbeptransport` pin in the LoopWorkspace and Trio `Package.resolved` files. `DATA` changes update `LupedKit` and `PROTOCOL.md` together.
- PebbleOS subscribes to every PPoGATT service the phone publishes, one session per app UUID; the running app's messages go to its UUID's session and pushes to an app that isn't running are NACKed. elbbepTransport serves both apps (one `PebbleTransport` each; Luped Remote only while the user turns it on). Routing: the app that last started or sent gets messages; a NACK moves them to the other app, except within 10 s of that app accepting or sending (busy: retried 2 s later), and a silent target moves them back; Send Now starts with the watchface; a `RESULT` goes to whichever app runs; each app run gets its own bolus key. Log lines start `Watchface:` or `Luped Remote:`.
- Apps with JS enabled send (and ACK) only through the Pebble app's system session, so only JS-free faces like Luped get a two-way third-party session. The legacy PebbleKit iOS binary never detects Core watches (company ID `0x0EEA`).
- Alloy sends key 15025 (`kPKJSReadyMessage`) at startup and keeps `Message` unwritable until the phone answers, so the transport must answer before Luped's `COMMAND refresh`. Without `AppMessage8kSupport` (phone-version reply, cached per UUID, applies on next start) a JS-free face's inbox is 144 bytes.
- Alloy's `Message` re-evaluates `is_open && is_system && pkjsReady` on every comm-session event, so a third-party session opening or closing makes the outbox unwritable until the face restarts or receives a message (inbound is unaffected). Upstream fix: ignore non-system session events.
- Call `flushOutbound()` after assigning a new `Message`: its first `onWritable` can fire before `this.message` is set. `onWritable` means send availability, not delivery; `onSuspend` can be transient contention.
- `RESULT` is `<action>:<outcome>[:<reason>]`; every reader takes only the first two fields and only `:ok` means done. A bolus the pump didn't confirm is `signedbolus:failed:check pump` (LupedKit 1.4.8); a `RESULT` or Find my Pebble in flight at a session reset is sent again.
- Alarms are the host's: `DATA` index 8 is the active alert level (negative while Watch Alarms is off), index 9 the alert event (negative asks for the sound); the watch buzzes when the event changes while the level is above 0 and has no thresholds or mute of its own. The stale buzz (reading 15 min old) is the watch's own, Luped only. An alarm buzz ends Find my Pebble first (otherwise PebbleOS drops the alarm's buzz).

## Luped Remote

- Buttons: `pebble/button` (`new Button({ types, single: { repeat }, onPush })`); subscribing `back` overrides the system Back, so the main screen calls `watch.exit()` itself. `watch.exit(1)` returns to the watchface. Auto-close after 60 s without a press, paused while a request waits for `RESULT` (30 s).
- Send chord: a `raw: true` Button on Up+Down (not Select) tracks presses in `helperRaw`; both down within 500 ms, held 2 s, sends. Its own single clicks are ignored until 300 ms after release. Emulator: `pebble emu-button --duration <ms> click up down`. Back has no raw events.
- Only a `RESULT` for the waiting request's action ends `pending` (answers are resent and can arrive late); a `carbs:` answer belongs to it only when `pending.withCarbs`. `helperView()` decides the screen for both `face()` and `helperPress()`; the hold neither starts nor sends while `helperCovered()`.
- Repaint only what changes: the 1 s tick repaints just the header (`helperDrawHeader`), wheels and the hold bar only their strip. Full-screen redraws each second during fast presses made the app vanish in the emulator.
- Remote actions need `isConnected` (otherwise dimmed, double buzz). Buzzes: short when actually sent, long on `ok`, double otherwise (a buzz right after another is dropped by PebbleOS). Bolus needs the phone's `auth:v1` key. The watch fonts have no symbols: mark with text ("(on)"); `helperFit` truncates with "…".
- `localStorage` keeps settings per UUID across reinstalls; `pebble wipe` resets them. Quick Launch can't be set for the user (watch prefs, writable only by the Pebble app); docs tell users Settings → Quick Launch → Tap Up.
- Feature specifics (bolus with carbs, recommendations, absorption, presets, Find my Pebble, alarm sound) are in `PROTOCOL.md`; the speaker is reached through `src/c/natives.c` (`fxBuildFFI` → JS global `Natives`), and works only where PebbleOS has `CONFIG_SPEAKER` (Pebble Time 2 and the emery emulator, which plays nothing; not gabbro).

## Test builds and state machines

- `npm test` runs `scripts/test-luped-signing.cjs`, `test-luped-warnings.cjs` and `test-luped-states.cjs`. `STATE_MACHINES.md` lists every state machine with invariants and transitions; update it with any new state, transition or timeout, and a regression test must fail on the code before its fix.
- `demoTestOnly` (publishing refuses it) gives a phone-free build: sample `DATA` and a test bolus key at startup, always connected, each request answered `<action>:ok` after 3 s. Set it only for the build, then back to false. Feed other data with `demoReceive(this, [["DATA", …]])` from a temporary fixture.
- `pebble emu-bt-connection --connected no` doesn't reach the app; call `setPhoneConnected(false)` from a temporary fixture.
- Never leave sample data, forced `configured`/`fullScreen`, fixtures or diagnostic rendering in production source or in `build/`.

## Rendering invariants

- The footer caches clock, date, battery and Bluetooth separately. Clock, date and battery compare only on `minutechange` (with `event.date`) and redraw only the changed region; connection changes redraw only the Bluetooth indicator. The clock clear is `max(previous, current width) + 2` wide (`footerState.clockWidth`), as the proportional font can exceed a fixed box.
- The CGM time is absolute `HH:mm`, updated only by a content render. The initial configuration is unknown: show connecting, and setup only after an explicit `CONFIGURED: 0`.
- Graph mode: bold glucose in the ring, delta below, a reading-time strip behind the ring's lower part. The trend arrow sits outside the ring, so clear its box (`arrowClearRadius`) before drawing. Full-screen mode: no strip, time inside the ring, ring meets the footer.
- After the first configured render keep the static background and strip fill; redraw only changing pixels. Setup, resize and layout changes redraw the static layers.
- Answers (`resultText()`) show for a minute or until the next reading: in graph mode the action on the strip's left and the outcome in the CGM time's slot (the ring covers the strip from x≈80); in Large Glucose in place of the reading time. Not done is red.
- Colors come from `glucoseColor()`: green `accent`, red `low`, yellow `high`; solid rings, no gradients. Emery/Gabbro are 6-bit color, so screenshots don't match source RGB; use `pebble screenshot --no-correction` to check exact colors.
- Round (gabbro) hides everything outside a 130 px circle; `screen.round` is set per platform at build time (Moddable's `pebble-display`). Graph mode: the trend arrow sits 30 px further in, graph points are clamped inside the circle (the latest dot stays visible), the minute strip repaint redraws the glucose ring over it, and the date and battery sit left of the ring (the footer's corners are hidden). Large Glucose: the ring is flush with the display (radius 133 to `drawVariantRing`), the clock, date, battery and offline indicator sit in its black bottom (from `cy + 46`), there is no footer row and content renders repaint the whole screen. Minute-redraw patches must stay inside the black bottom or they leave black bars on the white face. Tests stub `screen` (`round: false`; the round cases set `true`).
- Rendering is single-flight (`renderBusy`, cleared in `finally`) with dirty/priority flags and zero-delay coalescing; minute redraws share the tick's wake-up (no fixed delay). `Battery` is sampled at most every 5 minutes; hourly diagnostics ride the next outbound write, with a dedicated flush only after 15 minutes.

## Emulator and screenshots

- Names in reports: Pebble Time 2 (`emery`, 200×228), Pebble Round 2 (`gabbro`, 260×260).
- Before screenshots: `pebble kill`, `pebble wipe` (no `--emulator`; never `--everything`), install the intended PBW alone, and wait for the coalesced render (the first frame can be blank or setup). Capture with `pebble screenshot --emulator emery --no-open <path>`, save under `assets/`, `open` it, and inspect it. Check graph and full-screen modes after layout changes.
- Fixtures: use temporary source-level sample state (Luped can't be injected from the CLI); for store assets the in-range mmol/L fixture (6.8, +0.2, 5.4–6.8, thresholds 3.0/4.0/10.0; mg/dL thresholds would color it low) behind `SCREENSHOT_FIXTURE`, `--vnc` to keep the emulator up. Two assets per variant, named by `screenshot_names` in `build-release.sh`: Luped graph and fullscreen, Luped Remote main and a carbs confirm (from `demoTestOnly` with the host name temporarily "Loop", after `pebble wipe`). The store upload uses the emery ones; `assets/gabbro_luped_*_screenshot.png` (README only) have the area outside the round display made transparent.

## Installing and publishing

- Phone installs: `pebble login`, then `pebble install <pbw> --cloudpebble`; confirm `App install succeeded`.
- Publish with `./scripts/build-release.sh --variant <v> --publish` after raising the version (RePebble and the GitHub tag `<v>-v<version>` both reject an existing one, also for screenshot-only updates). It refuses `allowShakeDebugActionTestOnly` and `demoTestOnly`, uploads screenshots with `--replace-screenshots`, and attaches the stage's `build/project.pbw` to the GitHub release (needs `gh`). `--description` and icons only apply when it creates a missing listing; edit existing ones on the RePebble dashboard. Luped's description must say it needs a direct connection from a supported iPhone app such as Loop or Trio.

## Pixel-budget reporting

- `invalidatedPixels` counts transaction area. After every release build, recompute the fixed daily table for both platforms (1 full frame + 288 CGM updates + 1,440 clock redraws + 1 date redraw; battery and Bluetooth stay out), diff it against the table below, state any change (or none), and replace the table with the new numbers, date and commit. The clock row still assumes 86×30 and must be recomputed for the dynamic clock clear.
- Last recorded (2026-10-12, Luped 0.1.1, 30,938 Alloy bytes):
  | Component            | Region                 | Count/day | Emery px/day   | Gabbro px/day  |
  | -------------------- | ---------------------- | --------- | -------------- | -------------- |
  | Full frame           | 200×228 / 260×260      | 1         | 45,600         | 67,600         |
  | CGM content updates  | 200×198 / 260×230      | 288       | 11,404,800     | 17,222,400     |
  | Minute clock redraws | 86×30 (both platforms) | 1,440     | 3,715,200      | 3,715,200      |
  | Date rollover        | 58×30 (both platforms) | 1         | 1,740          | 1,740          |
  | **Fixed total**      |                        |           | **15,167,340** | **21,006,940** |
