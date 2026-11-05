# Luped CGM mobile protocol

Luped CGM intentionally contains no PebbleKit JS companion and exposes no
settings page in the Pebble app. A supported mobile app such as Loop or Trio
owns settings, alerts and glucose delivery over a direct watch connection.

The mobile app should send `CONFIGURED: 1` and a `DATA` JSON array whenever
settings change, when a new glucose sample arrives, when its alerts change, and
in response to the watch's one-time startup `COMMAND: "refresh"` request.

`DATA` is a 16-element array (protocol version 1); hosts may send only the
first 10, and the watch reads every field by index:

| Index | Value                                                                                                                  |
| ----: | ---------------------------------------------------------------------------------------------------------------------- |
|     0 | Protocol version (`1`)                                                                                                 |
|     1 | Glucose value in the selected display unit                                                                             |
|     2 | Delta in the selected display unit                                                                                     |
|     3 | Direction index: DoubleDown, SingleDown, FortyFiveDown, Flat, FortyFiveUp, SingleUp, DoubleUp                          |
|     4 | Up to 12 glucose values, oldest first, for the graph. `[]` in full-screen mode (index 7 = `1`)                         |
|     5 | Units: `0` mg/dL, `1` mmol/L                                                                                           |
|     6 | Reading timestamp in Unix milliseconds                                                                                 |
|     7 | Full-screen ring: `0` ring with graph, `1` full-screen ring                                                            |
|     8 | Host glucose alert: `0` none, `1` low, `2` urgent low, `3` high, `4` predicted low; negative while Watch Alarms is off |
|     9 | Alert event: changes each time the host fires an alert, including repeats; negative to ask for the alarm sound too     |
|    10 | Insulin on board (U, 1 decimal), or `null`                                                                             |
|    11 | Carbs on board (g, whole), or `null`                                                                                   |
|    12 | Last loop completed (ms since Unix epoch), or `null`                                                                   |
|    13 | Closed loop: `1`, open loop: `0`, or `null`                                                                            |
|    14 | Status line the phone formatted (ISF & target as `ISF<tab>target` around the ring), or `null`                          |
|    15 | Name of the host app sending it, such as `"Loop"` or `"Trio"`                                                          |

**Host app (index 15).** Only one app on the phone should use the watch at a
time: if two apps both host Luped, the watch follows whichever it connects to.
The watch keeps the first name it gets after it starts; `DATA` without a name
changes nothing. If a later `DATA` names a different app, the watch stops
showing data and shows "APP CHANGED" with both names and "Restart this
watchface", forgets its bolus key and takes no new one, and buzzes the glucose
alarm then and every minute until the watchface is restarted.

**Presets (Luped Remote only).** `DATA` has no presets. Luped Remote asks with
`COMMAND presets` and the host answers on the `PRESETS` key (10007, only Luped
Remote declares it): `[overrides, temp targets]`, each `[[id, name, running], …]`
(`running` 1 or 0, at most 16) or `null` for a kind the host doesn't have (Loop
has no temp targets, so the remote offers none). Names are cleaned on the phone
for the watch fonts (no control or invisible characters, emoji or symbols, at
most 32 characters) and only shown. The remote starts one with `override:<id>`
or `temptarget:<id>`, the id exactly as received: the host's own when it is
plain (letters, digits, `.`, `_`, `-`), otherwise a `~` token the host maps back.

**Protocol version (index 0).** A watch that gets `DATA` with a version above 1
ignores it, shows "UPDATE NEEDED" and "Update this watchface", and buzzes the
glucose alarm then and every minute. It shows data again once the phone sends
version 1. A host that changes what any index means must raise the version.

**Loop status (indexes 10–13).** In the graph layout Luped shows IOB and COB at
the left of the status strip (dimmed once the loop is stale) and Loop's status
ring with the minutes since the last loop in the top-right corner (on the
status strip on round screens): a full ring for a closed loop, open at the top
for an open loop, green up to 6 minutes, yellow up to 16, red after that, as
Loop's own ring. In an open loop the glucose ring itself is open at the top too.
The phone can replace IOB and COB with a line it formats itself (index 14),
chosen in its settings; it dims the same way. The glucose ring's bottom covers
the middle of the strip; ISF & target is too long for the space before it, so
it comes as `ISF<tab>target` and the target goes between the ring and the CGM
time. A host that sends no loop status
gets neither. The full-screen
ring does not show them.

**Turning them off.** Each of indexes 10–14 may be `null`, and the watch draws
only what it gets: with 10, 11 and 14 `null` the strip is empty, and with 12 and
13 `null` there is no loop ring (and the strip, if it shows anything, is
dimmed, since the loop's age is unknown). Loop's plugin (elbbepTransport 0.3.35+) sends only what the user's Status Line
and Loop Ring choices show: **None** with Loop Ring on (the default) sends 12–13
only, so the loop ring stays; **None** with Loop Ring off sends 10–14 as `null`;
IOB & COB sends 10–13; the phone-formatted lines send 12–13 and 14. While a line
is shown the loop ring stays on, because the line's stale dimming needs the
loop's age.

**History (index 4).** Only the graph uses it, and the full-screen ring has no
graph, so hosts send `[]` there (Loop does since elbbepTransport 0.3.8). The
current value, delta and trend travel in their own fields. When the user turns
full-screen off, the host sends a new `DATA` with the history at once. An empty
history in graph mode shows "Waiting for CGM" in the graph area.

**Alerts (indexes 8-9).** The host evaluates its own glucose alerts and applies
its own mute; the watch has no thresholds. Index 8 is the most important active
glucose alert (urgent low, low, high, predicted low; `0` when none), negative
while the user has turned watch alarms off. Index 9 is
an alert event the host advances every time it fires an alert, including each
repeat of an alert that is still active, whether or not watch alarms are on.
The host persists it so a restart can't reuse the value the watch last saw; it
wraps at 1000. The watch buzzes with the glucose-alarm pattern when the event
differs from the last one it saw and index 8 is above `0` (the same pattern
for every alert). It records the event on every `DATA`, even when it doesn't buzz, and
records the first event after the watchface starts without buzzing. So the
watch buzzes when the host fires, repeats with the host, and stops when the
user acknowledges on the phone. Thresholds and repeat intervals do not travel.
Index 8 colours the ring and the glucose: red for low and urgent low, amber for
high, green otherwise (including predicted low), whatever its sign. The colour
follows the host's alert episode, which ends when glucose recovers, not when the
user acknowledges; with the host's alerts muted or turned off it stays green.
History points in the graph are one neutral colour, and the graph scales to the
readings. Independently, the watch gives one short buzz when its latest
reading becomes 15 minutes old.

The app may send `ERROR` for a temporary data-source error. It may request a
diagnostic snapshot with `COMMAND: "diagnostics"` or reset counters with
`COMMAND: "diagnostics-reset"`. The watch responds on `DIAGNOSTICS`.

Alarm sound: a watch with a speaker (Pebble Time 2; Luped 0.1.25, Luped Remote
0.1.7) tells the host with `COMMAND: "speaker:on"`, or `"speaker:quiet"` while
the watch's Quiet Time is on (which mutes the speaker if the user set it to),
after its startup `refresh` and whenever Quiet Time starts or ends. Watches
without a speaker, and older ones, never send it, so the host offers the sound
only for watches that did. To sound an alarm as well as buzz it, the host sends
its alert event (index 9) negative: older watches only compare the value, so
they buzz as before. The sound plays at the watch's speaker volume and never
without the buzz.

Find my Pebble: the host sends `COMMAND: "findpebble:<seconds>"` (Loop sends 60)
to whichever of Luped and Luped Remote is running. The watch buzzes back to
back and, on watches with a speaker, beeps every 2.5 seconds, with the backlight
on and a full "Find my Pebble" screen, for that many seconds (at most 300), or
until any button
is pressed (on the watchface that leaves the face, which ends it too) or the
host sends `findpebble:0`. The watch doesn't answer; the message's ACK or NACK
tells the host whether a running app received it. Watches older than Luped
0.1.24 and Luped Remote 0.1.6 ignore it, as they ignore any `COMMAND` they
don't know.

The watch may ask the host for an action with `COMMAND`: `mute:<minutes>`
(mute its alerts; Loop mutes for 30, 60, 120 or 240 minutes, rounding up) or
`mute:cancel` (end the mute), or `carbs:<grams>[:<absorption>]`, with the amount chosen on the watch
and, optionally, how fast the carbs are absorbed: `fast`, `medium` or `slow`
(the host maps them to its own absorption times; without it, its default),
`override:<preset>` (start the host's override preset with that id, or that
name ignoring case) or `override:cancel` (end the running one),
`temptarget:<preset>` or `temptarget:cancel` (the same for temp target presets,
on hosts that have them), or a signed bolus (below). A request naming no preset, or one the host doesn't have, is answered
`failed` or `refused`. Each request ends with `@<confirmedAt>`, when the user
confirmed it, in whole seconds since 1970 by the watch's clock (for example
`carbs:30@1798000000`). A resent request keeps the same value. The host refuses
requests without it, and requests confirmed more than 30 seconds ago or more
than 5 seconds in the future, so the watch's clock must be within a few seconds
of the phone's (the Pebble app keeps it in step). The host runs its own checks
and acts only if its plugin declares the capability and its user allowed it; a
request without a valid amount is answered `failed`. The host answers each
request on `RESULT`, kept short as `<action>:<outcome>` (for example `mute:ok`,
`signedbolus:refused`, `carbs:ok`); outcomes are `ok`, `refused`, `ignored` (the
plugin doesn't offer it) and `failed`. An answer that isn't `ok` may add the
reason as a third field, `<action>:<outcome>:<reason>` (for example
`carbs:refused:too soon`): `not allowed`, `too soon`, `over max`,
`over recommended`, `daily limit`, `too old`, `no recent glucose`,
`no such preset`, `in progress`, `invalid amount`, `old key` or `not verified`
(LupedKit's `LupedResultReason`; short, lowercase, never a `:`). A watch reads
the first two fields and may ignore the rest, so older watches keep working;
an `ok` answer never has a reason, as watches buzz "done" for answers ending in
`:ok`. The full reason is in the host's log.
Luped shows the answer as `Bolus: done`, `Carbs: refused` and so on (a
`signedbolus` or `signedforcedbolus` answer as Bolus) for a minute or until the
next reading: in the status strip under the ring, or in Large Glucose in place
of the reading time, red when not done. It buzzes long for `ok` and twice
otherwise. Luped Remote (a watchapp, UUID
`738255f4-b58b-41cd-a7ae-27fc80e81fcb`) sends the same requests and shows the
answer itself, with the reason under it (0.1.1 and later). The watch keeps a
phone session open for each app the phone publishes a service for, but only the
running app accepts pushes, so the host sends each `RESULT` to the app that is
running: if the remote has closed before its answer, the watchface gets and
shows it.

### Bolus recommendations

Before the user picks a bolus, Luped Remote (0.1.3 and later) asks what the host
would recommend with the carbs about to go with it: `COMMAND recommend:<grams>[:<absorption>]`
(0 for none, with `@<confirmedAt>` like any request; 0.1.4 and later add the
absorption the user chose). It is a question only:
nothing is added or delivered, and it needs no key. The host answers on the
`RECOMMEND` message key (10006, after `RESULT`; only Luped Remote declares it),
never on `RESULT`, and only to Luped Remote: if the remote has closed, the answer
is dropped. The answer is `<grams>:ok:<units>:<maximum bolus>` (for example
`10:ok:0.45:5`; the maximum is empty when unknown), or
`<grams>:<outcome>[:<reason>]` with the outcomes and reasons of `RESULT` (for
example `10:refused:not allowed`, `0:ignored` from a host without them). Loop
answers only while its user allows boluses from the watch and its glucose is
recent, with the carbs as the entry they would become (medium absorption,
dated now); the bolus itself is still checked when it comes, against the
recommendation after the carbs are added. Numbers have at most three decimals.
A host that doesn't know the request (LupedKit before 1.1.1) logs and ignores
it, so the remote stops waiting after a few seconds and goes on without one.

### Signed boluses

Boluses are only ever signed; there is no unsigned bolus request (`bolus:` and
`forcedbolus:` are not commands). The watchface gets no button presses, so
Luped Remote sends them (`signedbolus:<units>`, after its confirmation screen
and only while its Allow bolus setting is on); the watchface only shows their
answers.

- **Session key, phone to watch:** `COMMAND auth:v1:<sid>:<key>`. `sid` is 16
  lowercase hex digits, `key` 64 (256 random bits). The phone sends a new one
  whenever the watchface starts (its ready handshake) or the Bluetooth session
  opens, and only while its plugin offers remote bolus. The watch keeps the key
  in memory only (never in storage) and forgets it when it restarts; a new key
  makes everything signed with the old one invalid.
- **Request, watch to phone:**
  `COMMAND signedbolus:<units>[:<grams>[:<absorption>]]@<confirmedAt>#<sid>.<seq>.<mac>`, or
  `signedforcedbolus:` for a bolus the host checks without its recommendation.
  `units` has at most two decimals and is above 0 (`0.01` to `99.99`, no
  leading zeros); the host rounds it down to its pump's step. `grams` is
  optional, a whole number from 1 to 999: the host adds those carbs first, then
  checks the bolus against its recommendation with the carbs included.
  `absorption` (`fast`, `medium` or `slow`, only after grams; Luped Remote
  0.1.4 and later) is how fast those carbs are absorbed. `seq`
  starts at 1 for each key and goes up by one for each new request.
- **Signature:** `mac` is the first 16 bytes of HMAC-SHA256 with the session
  key over `v1|<sid>|<seq>|<confirmedAt>|<action>|<units>|<grams>` (`grams`
  empty when there are none; every field exactly as sent), then
  `|<absorption>` only when the request has one, as 32 lowercase hex
  digits. With key bytes `00 01 … 1f`,
  `v1|0123456789abcdef|1|1798000000|signedbolus|1.5|30` gives
  `6eb19f16b120d0b9cdb6c36ea5eb56bf`.
- **Checks before the host hears of it:** a current key, the same `sid`, a
  matching MAC, `seq` above the last accepted one, and the 30 s / 5 s timing
  above. A failed check is answered `<action>:refused`.
- **Resends:** a request is passed to the host once. Resending it while the host
  handles it gets nothing back; resending it afterwards gets the same `RESULT`s
  again (`carbs:<outcome>` first when it had carbs, then
  `signedbolus:<outcome>` or `signedforcedbolus:<outcome>`).

The signature proves the request is unchanged and comes from the watchface run
that received this session's key. It doesn't prove who is wearing the watch, and
any app installed under Luped's UUID would get the key too. The host's own
bolus checks (permission, maximum bolus, recommendation unless forced, rate
limits) always still apply.

Alloy turns a watchface's writes off whenever a non-system session (the
host's PPoGATT session) opens or closes, and only a new `Message` turns them
back on. Luped reopens its `Message` (at most every 30 seconds) when a write
fails, so requests and diagnostics are not stuck until the watchface restarts.
Luped appends two fields to the shared diagnostics array: index 38 counts
system pop-ups (notifications, alarms, calls) that covered the watchface, and
index 39 lists the last 5 host-alert buzzes as `[alert event, alert level,
start (ms since Unix epoch), outcome]`. PebbleOS silently drops an app's
vibration while another one plays and cancels it when a system pop-up closes,
so the outcome records whether a pop-up covered the watchface during the
4.7-second buzz: `-2` the buzz call failed, `-1` not covered, `0` already
covered when the buzz started, otherwise the milliseconds into the buzz. Index
40 counts alert events that arrived while Watch Alarms was off (level 0, no
buzz).

Loop delivers these messages over its own PPoGATT session (the watch stays
connected to the Pebble app at the same time) through the LupedSmartwatchKit
plugin. The phone side of this protocol is the `LupedKit` library in
[elbbepTransport](https://github.com/dabear/elbbepTransport), which Loop links
and other apps such as Trio can share.

There is no watch-side periodic glucose fetch timer in this variant. Glucose is
pushed by the host; the startup refresh request exists only to restore state
after the watchface starts.

The CrimsonBear variant keeps its own 16-element layout with watch-evaluated
thresholds (`src/embeddedjs/protocol.js`); it is unaffected.
