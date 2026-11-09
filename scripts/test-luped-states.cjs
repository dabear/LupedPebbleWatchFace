// State-machine regressions (STATE_MACHINES.md, Issues): each case drives the
// assembled app through the transition that used to reach an invalid state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const log = [];
// One variant, assembled as its watchface-config.json selects, in its own context.
function load(variant) {
  const config = JSON.parse(
    fs.readFileSync(`variants/${variant}/watchface-config.json`, "utf8")
  );
  const source = fs
    .readFileSync("src/embeddedjs/main.js.in", "utf8")
    .replace(/\/\/ @if (\w+)\n([\s\S]*?)\/\/ @endif/g, (_, flag, body) => {
      const [yes, no = ""] = body.split(/\/\/ @else\n/);
      return config[flag] ? yes : no;
    })
    .replace(/^import .*;\n/gm, "")
    .replace(/@[A-Z][A-Z0-9_]*@/g, "0")
    .replace(
      "new CrimsonBearWatchface().start();",
      "globalThis.Face = CrimsonBearWatchface;"
    );
  const context = {
    Vibes: {
      pattern: () => log.push("buzz"),
      cancel: () => log.push("cancel"),
      shortPulse: () => log.push("short"),
      longPulse: () => log.push("long"),
      doublePulse: () => log.push("double"),
    },
    Natives: {
      findPebbleBeep: () => log.push("find beep"),
      findPebbleQuiet: () => log.push("quiet"),
      alarmBeep: () => log.push("alarm beep"),
    },
    watch: { light() {}, exit: () => log.push("exit") },
    screen: { round: false },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1,
    clearInterval() {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

let inbox = [];
let sent = [];
function newFace(context) {
  const face = Object.create(context.Face.prototype);
  Object.assign(face, {
    state: { configured: true, hostAlertState: 0 },
    configurationKnown: true,
    isConnected: true,
    message: { read: () => inbox, write: (map) => sent.push(...map.values()) },
    draw() {},
    requestRender() {},
  });
  return face;
}
const receive = (face, ...messages) => {
  inbox = messages;
  face.readMessages();
};
// [version, glucose, delta, trend, history, mmol, updated, fullScreen, alert level, alert event, …, host]
const data = (host, level, event, glucose = 100) =>
  JSON.stringify([
    1,
    glucose,
    0,
    3,
    [],
    0,
    Date.now(),
    0,
    level,
    event,
    null,
    null,
    null,
    null,
    null,
    host,
  ]);

// Luped Remote
{
  const context = load("lupedhelper");
  vm.runInContext(
    'SETTINGS.find((item) => item.id === "allowBolus").value = 1;',
    context
  );
  const face = newFace(context);
  Object.assign(face, { view: "main", menuIndex: 0, secondsLeft: 60, held: {} });
  receive(face, ["DATA", data("Loop", 0, 1)]);

  // Issue 1: a late answer for another action doesn't end the wait.
  face.confirmation = { action: "mute", command: "mute:30", lines: ["Mute"] };
  face.helperSend();
  assert.equal(face.pending.action, "mute");
  assert.match(sent.pop(), /^mute:30@/);
  receive(face, ["RESULT", "signedbolus:ok"]);
  assert.equal(
    face.pending && face.pending.action,
    "mute",
    "a bolus answer ended the mute's wait"
  );
  assert.equal(face.view, "sending");
  assert.equal(face.result, "signedbolus:ok", "the late answer still shows");
  receive(face, ["RESULT", "mute:ok"]);
  assert.equal(face.pending, null);
  assert.equal(face.view, "result");

  // Issue 1: a bolus with carbs: an earlier request's mute answer doesn't end
  // it, its own carbs answer doesn't either, its bolus answer does.
  receive(face, ["COMMAND", "auth:v1:0123456789abcdef:" + "00".repeat(32)]);
  face.confirmation = {
    action: "bolus",
    command: "signedbolus:1:20:medium",
    lines: ["Bolus"],
  };
  face.helperSend();
  assert.match(sent.pop(), /^signedbolus:1:20:medium@\d+#0123456789abcdef\.1\./);
  receive(face, ["RESULT", "mute:ok"]);
  assert.equal(
    face.pending && face.pending.action,
    "bolus",
    "a mute answer ended the bolus's wait"
  );
  receive(face, ["RESULT", "carbs:ok"]);
  assert.equal(face.pending.carbs, "ok");
  receive(face, ["RESULT", "signedforcedbolus:ok"]);
  assert.equal(face.pending, null);
  assert.equal(face.view, "result");

  // Issue 1: Bolus without a key while a request waits: the wait stays on.
  face.confirmation = { action: "carbs", command: "carbs:10:fast", lines: ["Carbs"] };
  face.helperSend();
  face.bolusAuth = null;
  face.view = "main";
  log.length = 0;
  face.helperOpen("bolus");
  assert.equal(face.view, "main", "the no-key answer covered the waiting request");
  assert.notEqual(face.result, "bolus:no key");
  assert.deepEqual(log, ["double"]);
  receive(face, ["RESULT", "carbs:ok"]);

  // Issue 1 (audit 2026-11-09): a late carbs answer isn't taken by a bolus
  // without carbs: it shows and buzzes like any other answer; the wait stays.
  receive(face, ["COMMAND", "auth:v1:0123456789abcdef:" + "00".repeat(32)]);
  face.confirmation = { action: "bolus", command: "signedbolus:1", lines: ["Bolus"] };
  face.helperSend();
  log.length = 0;
  receive(face, ["RESULT", "carbs:ok"]);
  assert.equal(
    face.pending && face.pending.carbs,
    undefined,
    "a bolus without carbs took a carbs answer"
  );
  assert.equal(face.result, "carbs:ok");
  assert.deepEqual(log, ["long"], "the late carbs answer didn't buzz");
  receive(face, ["RESULT", "signedbolus:ok"]);
  assert.equal(face.pending, null);

  // Issue 2 (audit 2026-11-09): the Up+Down hold doesn't send while a warning
  // covers the confirm screen, neither started under it nor finishing under it.
  face.confirmation = { action: "carbs", command: "carbs:10:fast", lines: ["Carbs"] };
  face.view = "confirm";
  Object.assign(face, { held: {}, holdTimer: null, chordAt: 0 });
  face.newProtocol = 2;
  sent.length = 0;
  face.helperRaw(1, "up");
  face.helperRaw(1, "down");
  assert.equal(face.holdTimer, null, "a hold started under the warning screen");
  face.helperRaw(0, "up");
  face.helperRaw(0, "down");
  face.newProtocol = 0;
  face.helperRaw(1, "up");
  face.helperRaw(1, "down");
  assert.ok(face.holdTimer, "the hold didn't start on the confirm screen");
  face.newProtocol = 2;
  face.holdStart = Date.now() - 5000;
  face.helperHoldStep();
  assert.equal(face.pending, null, "the hold sent under the warning screen");
  assert.equal(sent.length, 0);
  face.newProtocol = 0;
  Object.assign(face, { held: {}, holdTimer: null, chordAt: 0 });

  // Issue 2: once the answer's minute is up the result view shows the main
  // screen, and the buttons act on the main screen.
  face.view = "result";
  face.result = null;
  face.menuIndex = 0;
  face.helperPress("up");
  assert.equal(face.view, "main");
  assert.notEqual(face.menuIndex, 0, "Up didn't move the list");
  face.view = "result";
  log.length = 0;
  face.helperPress("back");
  assert.deepEqual(log, ["exit"], "Back on the main screen didn't close the app");
}

// Luped
{
  const context = load("luped");
  const face = newFace(context);
  face.startupId = 1;
  face.diagnostics = face.newDiagnostics();
  face.lastTelemetrySentAt = Date.now();
  face.hasSpeaker = true;

  // Issue 3: two apps taking turns: the second's data is dropped, so their
  // different alert events don't buzz as alarms.
  receive(face, ["DATA", data("Loop", 3, 10, 200)]);
  log.length = 0;
  receive(face, ["DATA", data("Trio", 3, 5, 90)]);
  assert.deepEqual([...face.hostChange], ["Loop", "Trio"]);
  assert.deepEqual(log, ["buzz"], "only the app-changed buzz");
  assert.equal(face.state.glucose, 200, "the other app's data was shown");
  receive(face, ["DATA", data("Loop", 3, 10, 200)], ["DATA", data("Trio", 3, 6, 90)]);
  receive(face, ["DATA", data("Loop", 3, 10, 200)]);
  assert.deepEqual(log, ["buzz"], "taking turns buzzed as alarms");
  // The first app's own new alert still buzzes.
  receive(face, ["DATA", data("Loop", 3, 11, 200)]);
  assert.deepEqual(log, ["buzz", "buzz"]);

  // Issue 4: an alarm during Find my Pebble ends the search first, so its buzz
  // and sound aren't dropped or cancelled by it.
  face.hostChange = undefined;
  face.findPebble(60);
  assert.ok(face.findUntil);
  log.length = 0;
  receive(face, ["DATA", data("Loop", 1, -12, 60)]);
  assert.equal(face.findUntil, 0, "the search went on over the alarm");
  assert.deepEqual(log, ["cancel", "quiet", "buzz", "alarm beep"]);
  // Its timer can't come back and cancel the alarm.
  face.findStep();
  assert.deepEqual(log, ["cancel", "quiet", "buzz", "alarm beep"]);
}
console.log("Luped state machine regressions passed");
