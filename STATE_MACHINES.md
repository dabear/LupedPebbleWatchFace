# State machines

Luped CGM (watchface) and Luped Remote (watchapp) are one class,
`CrimsonBearWatchface` in `src/embeddedjs/main.js.in`, assembled per variant.
Its state lives in plain fields; this file names the machines those fields
form, what must always hold, every transition, and the invalid states the code
could reach. Regression tests: `scripts/test-luped-states.cjs` (`npm test`).

Inputs are serialized: XS runs one callback at a time (AppMessage `onReadable`
/ `onWritable` / `onSuspend`, `minutechange`, `secondchange`, buttons, timers).
"Concurrency" below means interleavings of those callbacks and of the phone's
messages, which can come late, twice (the phone resends `RESULT`, PROTOCOL.md
"Resends"; LupedKit `resultToResend(afterRestart:)`), or from a second phone app.

Variant column: **L** Luped, **R** Luped Remote, **both**.

## 1. Screen cover (both)

What covers the whole screen, by precedence (`face()`, `drawNow()`):

| Precedence | State                          | Fields                                    |
| ---------- | ------------------------------ | ----------------------------------------- |
| 1          | Finding                        | `findUntil > 0`                           |
| 2          | Warning: newer protocol        | `newProtocol > 1`                         |
| 2          | Warning: app changed           | `hostChange = [first, other]`             |
| 3          | Connecting                     | `!configurationKnown`                     |
| 4          | Setup                          | `configurationKnown && !state.configured` |
| 5          | Face (L) / remote view (R, §9) | otherwise                                 |

Invariants

- `hostChange` is set at most once per run and never cleared (restart only).
- `newProtocol` is non-zero exactly while the last `DATA` had version > 1.
- After any cover, the next face draw is a full draw (`hasRenderedConfiguredFace = false`).

| From                  | Input                             | To                    | Effect                                                         |
| --------------------- | --------------------------------- | --------------------- | -------------------------------------------------------------- |
| Connecting            | `CONFIGURED v`                    | Setup / Face          | `configurationKnown = true`                                    |
| any                   | `DATA` version > 1                | Warning (protocol)    | data ignored, buzz once, `refreshPending = false`              |
| Warning (protocol)    | `DATA` version 1                  | previous              | data applied                                                   |
| any                   | `DATA` naming a host ≠ first host | Warning (app changed) | buzz once, `bolusAuth = null`, **that data dropped** (Issue 3) |
| Warning (app changed) | `DATA` from the first host        | same                  | data applied, its alarms still buzz                            |
| Warning (app changed) | `DATA` from the other host        | same                  | dropped                                                        |
| Warning (app changed) | `auth:v1:`                        | same                  | key ignored                                                    |
| Warning (either)      | `minutechange`                    | same                  | buzz                                                           |

## 2. Find my Pebble (both)

States: **Idle** (`findUntil = 0`, `findTimer = null`) and **Finding** (`findUntil > now`, `findTimer` set, light on).

| From    | Input                         | To               | Effect                                                               |
| ------- | ----------------------------- | ---------------- | -------------------------------------------------------------------- |
| any     | `COMMAND findpebble:n`, n > 0 | Finding          | restart: timer reset, `findSteps = 0`, capped at 300 s               |
| Finding | timer step, `now < findUntil` | Finding          | buzz on even steps, beep every step                                  |
| Finding | timer step, `now ≥ findUntil` | Idle             | `Vibes.cancel`, speaker stop, light off                              |
| Finding | `findpebble:0`                | Idle             | same                                                                 |
| Finding | any button (R)                | Idle             | same; the press does nothing else                                    |
| Finding | glucose alarm (§6)            | Idle, then alarm | **Issue 4**: the search ends first, then the alarm buzzes and sounds |
| Idle    | `findpebble:0`                | Idle             | nothing                                                              |

Invariants: `findTimer != null ⇔ findUntil > 0`. While Finding, R's countdown doesn't run and its chord doesn't start (§9).

## 3. Phone link and outbound queue (both)

Link: **Disconnected** / **Connected** (`isConnected`), from `watch.connected`, `onWritable` (→ Connected), `onSuspend` (→ Disconnected) and any received message (→ Connected).

Outbound work items, at most one `COMMAND` per write, in this priority:

| Slot                        | Set by                                                                                                         | Cleared by                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `bolusCommand` (one string) | L: shake test; R: `helperSend`, `helperAskRecommendation` (`recommend:`), `helperOpen("override")` (`presets`) | a successful write; R's timeouts (§9)                                          |
| `refreshPending`            | start (true), `requestDataRefresh`                                                                             | successful write, any `DATA` v1, `ERROR`, `DATA` v>1, `DATA` from another host |
| `speakerReportPending`      | start (speaker found), Quiet Time change, `COMMAND speaker`                                                    | successful write of the report                                                 |
| `telemetryPending` (L)      | hourly (minute tick), `COMMAND diagnostics`                                                                    | successful write (rides along with any of the above)                           |

`flushOutbound()` runs on every `onWritable`, every received message, every enqueue.

| Write result                                    | Effect                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| success                                         | clears the slot it carried (bolus, else speaker, else refresh) and telemetry |
| throws, no `DATA` received yet                  | slots kept; `onWritable` retries                                             |
| throws, `DATA` received, last reopen > 30 s ago | `Message` closed and recreated; the new one flushes                          |
| throws, reopened < 30 s ago                     | slots kept                                                                   |

Invariants

- A failed write never loses a slot; a signed bolus resent from the slot keeps its `seq`, `confirmedAt` and MAC.
- Refresh is never sent while a request is in `bolusCommand`; the speaker report waits behind both.

## 4. Render scheduler (both)

States: **Idle** (`renderTimer = null`, `!renderBusy`), **Scheduled** (`renderTimer` set), **Busy** (`renderBusy`). Pending work: `pendingFullRender`, `pendingMinuteRender` (+ `pendingMinuteDate`), `pendingRenderDelay` (max of requested delays).

| From             | Input                   | To                                                                             |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Idle             | `requestRender(p, d)`   | Scheduled (after `pendingRenderDelay`)                                         |
| Scheduled / Busy | `requestRender`         | same; flags and delay merged                                                   |
| Scheduled        | timer                   | Busy: full draw if pending, then minute draw if pending                        |
| Busy             | done                    | Idle, or Scheduled again if anything was requested meanwhile (keeps its delay) |
| Busy             | draw throws, first time | Scheduled with 1 s delay (`renderRetryCount = 1`)                              |
| Busy             | draw throws again       | Idle; no more retries until a draw succeeds                                    |

Invariants: at most one timer; `renderBusy` is cleared in `finally`; a retry's 1 s delay survives coalescing.

## 5. Reading freshness (both)

**Fresh** / **Stale** (`stale`): stale when the reading is ≥ 15 min old, evaluated on each `DATA` and `minutechange`. Fresh → Stale buzzes once (L only); Stale → Fresh on a newer reading.

## 6. Host alarm (both)

State: `lastAlertEvent` (undefined until the first `DATA` of the run).

| Condition on a v1 `DATA` from the followed host | Effect                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| first of the run                                | record the event, no buzz                                                    |
| event unchanged                                 | nothing                                                                      |
| event changed, level (index 8) > 0              | end Find my Pebble if running (Issue 4), buzz, beep if speaker and event < 0 |
| event changed, level ≤ 0                        | record (L counts `silentAlertEvents`)                                        |

Invariant: the event compared is always from the same host (Issue 3).

Known, not fixed (deferred by the user on 2026-11-05): Loop restarting during a sounded alert sends the same alert as +event, then -event, which counts as a change and buzzes once more. Fix when wanted: compare `Math.abs(event)`.

## 7. Request answer on screen (both)

`result` (`"<action>:<outcome>[:<reason>]"`) and `resultUntil`.

| From         | Input                                    | To                                               |
| ------------ | ---------------------------------------- | ------------------------------------------------ |
| none / shown | `RESULT`                                 | shown for 60 s, long buzz for `:ok`, else double |
| shown        | `minutechange` at or after `resultUntil` | none (so up to 60 s late)                        |
| shown (L)    | `DATA` with a newer reading              | none                                             |
| shown (R)    | `DATA`                                   | unchanged                                        |

## 8. Signed bolus key (both)

**No key** / **Key** (`bolusAuth = {sid, key, seq}`): `auth:v1:` → Key (seq 0) unless `hostChange`; app changed → No key. Each signing increments `seq`; a resend of the same slot doesn't.

## 9. Luped Remote views (R)

`view` plus the object each view needs. `helperView()` gives the effective view: a view whose object is gone is **main** (Issue 2). `face()` draws it and `helperPress()` acts on it.

| View         | Needs            | Select                                                         | Back                                  | Up/Down       |
| ------------ | ---------------- | -------------------------------------------------------------- | ------------------------------------- | ------------- |
| main         | —                | open item (below)                                              | sending if a request waits, else exit | move          |
| settings     | —                | edit / save                                                    | done / undo                           | move / change |
| amount       | `picker`         | carbs → absorption (0 g bolus carbs → asking); bolus → confirm | main                                  | change        |
| absorption   | `absorptionPick` | carbs → confirm; bolus → asking                                | main                                  | move          |
| asking       | `asking`         | —                                                              | main, `asking = null`                 | —             |
| presetAsking | `presetAsking`   | —                                                              | main, `presetAsking = null`           | —             |
| presets      | `presetPick`     | item → confirm                                                 | main                                  | move          |
| confirm      | `confirmation`   | — (chord sends)                                                | main                                  | —             |
| sending      | `pending`        | —                                                              | main                                  | —             |
| result       | `result`         | main                                                           | main                                  | —             |

Opening an item from main: settings always; otherwise needs a connection and no waiting request (double buzz). Bolus without the key shows "bolus: no key", but not while a request waits (Issue 1).

Asynchronous transitions

| Waiting           | Input                                                | To                                                                          |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `asking`          | `RECOMMEND` for these grams, `ok` / `ignored`        | amount (bolus picker)                                                       |
| `asking`          | `RECOMMEND` refused / failed                         | result                                                                      |
| `asking`          | 6 s                                                  | amount, "No answer from the phone"; slot cleared                            |
| `presetAsking`    | `PRESETS`                                            | presets                                                                     |
| `presetAsking`    | 6 s                                                  | presets (End preset only); slot cleared                                     |
| `pending` (bolus) | `RESULT carbs:…`                                     | stays, wait restarts (30 s)                                                 |
| `pending`         | `RESULT` for its action (`signed`/`forced` stripped) | result, `pending = null`                                                    |
| `pending`         | `RESULT` for another action                          | **stays** (Issue 1); that answer is shown in the status and buzzes          |
| `pending`         | 30 s                                                 | result: "no answer, check phone" if written, else "not sent" (slot dropped) |
| confirm           | chord held 2 s                                       | sending (`pending` set), or result (no phone, no key)                       |

Chord: `held` (raw Up/Down), `holdTimer`, `chordAt`/`chordDoneAt`. It starts only on confirm with both buttons down within 500 ms and sends only if the view is still confirm after 2 s.

Auto close: `secondsLeft` counts down each second except while `pending` or finding; any press resets it to 60; an answer leaves at least 15 s.

Invariants

- At most one `pending` request; nothing else is opened while it waits (Issue 1).
- `pending` ends only with its own action's answer or its timeout (Issue 1).
- The screen drawn and the screen the buttons act on are the same (Issue 2).
- The wheel timer runs only while the effective view is sending, asking or presetAsking.

## Issues

Ranked by impact. Each was reachable in the code before the fix, and each has a regression test that fails on the old code.

### Issue 1: Luped Remote: an answer for another request ended the wait (fixed)

**Evidence:** `readMessages` set `pending = null` on any `RESULT`. The phone resends answers (PROTOCOL.md "Resends", LupedKit `resultToResend(afterRestart:)`), and a request that timed out ("no answer, check phone") can still be answered later.

**Reachable:**

1. A carbs request times out.
2. The user sends a bolus.
3. The late `carbs:ok` arrives and ends the bolus's wait.

Ending the wait lifts the one-request-at-a-time guard, so a second bolus can be sent while the first is still being carried out. The phone's own limits (5 min between watch boluses) still apply. Separately, `helperOpen("bolus")` without a key replaced the waiting request's screen with "bolus: no key".

**Fix:** only an answer whose action matches `pending.action` ends the wait. Other answers still show and buzz. The no-key screen isn't shown while a request waits.

**Remaining:** a late duplicate answer for the _same_ action can't be told apart; a protocol request id would be needed.

### Issue 2: Luped Remote: the screen and the buttons disagreed (fixed)

**Evidence:**

- `face()` falls back to the main screen when a view's object is gone, but `helperPress()` used `view` as stored.
- After the answer's minute, the main screen showed while `view` was still `"result"`: Up and Down did nothing, Select only "closed" an answer that wasn't there, and Back went to main instead of closing the app.

**Fix:** `helperView()` is used by both.

### Issue 3: Two phone apps taking turns buzzed alarms on every message (fixed)

**Evidence:** after the app-changed warning, `DATA` from the other host was still applied. Each app has its own alert event counter, so with either at level > 0 every alternating message changed `lastAlertEvent` and buzzed as a new alarm. The shown state also flipped between the apps.

**Fix:** once the warning is up, the other host's `DATA` (including the one that raised the warning) is dropped. The first host's data and alarms continue.

### Issue 4: A glucose alarm during Find my Pebble was lost (fixed)

**Evidence:**

- Find's buzz runs back to back (4.7 s every 5 s), and the code's own note says PebbleOS drops a buzz that starts while another plays.
- Find's end calls `Vibes.cancel()` and `speaker_stop`, which cut an alarm that started in its last 4.7 s.

**Fix:** an alarm ends the search first (cancelling its buzz and sound), then buzzes and sounds.

### Not fixed, with reasons

| Finding                                                                                                                     | Why it stays                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ±event re-buzz after a Loop restart (§6)                                                                                    | Deferred by the user on 2026-11-05                                                                         |
| Backing out of asking/presetAsking leaves `recommend:`/`presets` in the slot; it is sent later                              | Harmless: neither changes anything on the phone, and a late answer is ignored (no `asking`/`presetAsking`) |
| A chord held as Find my Pebble starts still sends after 2 s                                                                 | The user deliberately held it; the send's screen shows once the search ends                                |
| An answer or timeout moves the remote from Settings to the result screen, dropping an unsaved edit                          | Unsaved by definition; the answer matters more                                                             |
| If `new Message()` throws while reopening, `message` stays the closed one, and the next failure calls `close()` on it again | Not observed; whether a second `close()` throws in Alloy is unverified                                     |
| `result` clears on the first minute tick after 60 s (up to 2 min)                                                           | Within design ("for a minute")                                                                             |
