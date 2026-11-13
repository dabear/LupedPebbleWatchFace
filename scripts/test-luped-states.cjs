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

// Emulator-reproduced (2026-11-13), each checked on gabbro before the fix.
{
  const context = load("luped");

  // The battery sensor is optional: a failed start or a throwing sample() must
  // not take the minute tick down (it ended in "Alloy: Fatal Error").
  for (const battery of [
    undefined,
    {
      sample: () => {
        throw new Error("no sensor");
      },
    },
  ]) {
    const face = newFace(context);
    const renders = [];
    Object.assign(face, {
      battery,
      lastBatterySampleAt: 0,
      lastMinuteEventAt: 0,
      lastTelemetrySentAt: Date.now(),
      startupId: 1,
      requestRender: (priority) => renders.push(priority),
    });
    face.state.updated = Date.now();
    face.diagnostics = face.newDiagnostics();
    assert.doesNotThrow(
      () => face.drawMinute({ date: new Date() }),
      "a missing or throwing battery sensor broke the minute tick"
    );
    assert.equal(renders.length, 1, "the minute render wasn't requested");
  }

  // The graph keeps every point inside its panel, also for readings beyond the
  // 40-400 mg/dL (2.2-22.2 mmol/L) domain.
  {
    const face = newFace(context);
    const bounds = { x: 8, y: 131, width: 244, height: 80 };
    for (const [value, minimum, maximum] of [
      [450, 40, 400],
      [28, 2.2, 22.2],
      [20, 40, 400],
      [5, 2.2, 22.2],
    ]) {
      const { y } = face.graphPoint(value, 3, 12, bounds, minimum, maximum);
      assert.ok(
        y >= bounds.y && y <= bounds.y + bounds.height,
        `${value} plotted at y=${y}, outside ${bounds.y}-${bounds.y + bounds.height}`
      );
    }
  }

  // Round screens: the minute repaint of the status strip redraws the glucose
  // ring over it, as face() draws them (the strip reaches 11 px into the ring).
  {
    const round = load("luped");
    round.screen.round = true;
    const face = newFace(round);
    const calls = [];
    Object.assign(face, {
      render: {
        width: 260,
        height: 260,
        begin: (...region) => calls.push(`begin ${region.join(",")}`),
        end: () => calls.push("end"),
        fillRectangle() {},
        getTextWidth: () => 40,
      },
      fonts: { footer: {}, label: {} },
      colors: { ink: 0, white: 0, crimson: 0 },
      recoverRender: (error) => {
        throw error;
      },
      footerState: {
        clock: null,
        date: null,
        battery: null,
        batteryWidth: 0,
        clockWidth: 0,
        connected: true,
      },
      statusY: 114,
      statusRing: { cx: 125, cy: 70, radius: 58 },
      loopFresh: 0,
      loopFreshness: () => 0,
      text() {},
      drawBluetoothDisconnectedIndicator() {},
      drawCgmStatus: () => calls.push("strip"),
      drawVariantRing: () => calls.push("ring"),
    });
    face.state.fullScreen = false;
    face.diagnostics = face.newDiagnostics();
    face.drawMinuteNow(new Date());
    const strip = calls.indexOf("strip");
    assert.ok(strip >= 0, "the strip wasn't repainted");
    assert.equal(calls[strip + 1], "ring", "the ring wasn't redrawn over the strip");
    assert.equal(
      calls[strip + 2],
      "end",
      "the ring was drawn outside the strip's transaction"
    );
  }
}

// Round-screen visibility (emulator audit, 2026-11-13): nothing the user needs to
// read may be drawn where the round display hides it.
{
  const round = load("luped");
  round.screen.round = true;
  const insideDisplay = (x, y, margin) => Math.hypot(x - 130, y - 130) <= 130 - margin;
  const stubRender = () =>
    new Proxy(
      { width: 260, height: 260 },
      { get: (target, key) => (key in target ? target[key] : () => 0) }
    );
  const stubFace = () => {
    const face = newFace(round);
    Object.assign(face, {
      render: stubRender(),
      fonts: new Proxy({}, { get: () => ({}) }),
      colors: new Proxy({}, { get: () => 0 }),
      stale: false,
      statusLine: null,
      drawVariantRing() {},
      drawCgmStatus() {},
      footer() {},
    });
    Object.assign(face.state, {
      glucose: 142,
      delta: -3,
      direction: "SingleDown",
      units: "mg/dL",
      fullScreen: false,
      readings: [150, 148, 147, 146, 145, 144, 143, 143, 142, 142, 142, 142],
      updated: Date.now(),
    });
    return face;
  };

  // The trend arrow (up to 18 px from its centre) stays inside the display.
  for (const direction of ["DoubleDown", "FortyFiveDown", "Flat"]) {
    const face = stubFace();
    face.state.direction = direction;
    const arrows = [];
    face.arrow = (cx, cy) => arrows.push([cx, cy]);
    face.face(false, false);
    assert.equal(arrows.length, 1);
    const [cx, cy] = arrows[0];
    for (const [dx, dy] of [
      [18, 0],
      [13, 13],
      [13, -13],
      [0, 16],
    ]) {
      assert.ok(
        insideDisplay(cx + dx, cy + dy, 2),
        `${direction} arrow at ${cx},${cy} is cut off by the bezel`
      );
    }
  }

  // Round graph mode: the footer's corners are outside the display, so the date
  // and battery sit left of the glucose ring, inside the display, and the minute
  // redraw repaints them there.
  {
    const face = stubFace();
    face.state.battery = 85;
    face.render.getTextWidth = (text) => String(text).length * 6;
    const texts = [];
    face.text = (value, font, color, x, y, centered) =>
      texts.push({ value: String(value), x, y, centered });
    face.face(false, false);
    const ringLeft = face.statusRing.cx - face.statusRing.radius + 3;
    for (const wanted of [/^[A-Z][a-z]{2} \d{1,2}$/, /^85%$/]) {
      const t = texts.find((item) => wanted.test(item.value));
      assert.ok(t, `${wanted} is not drawn in round graph mode`);
      const width = t.value.length * 6;
      const left = t.centered ? t.x - width / 2 : t.x;
      for (const [x, y] of [
        [left, t.y + 3],
        [left, t.y + 16],
        [left + width, t.y + 3],
        [left + width, t.y + 16],
      ]) {
        assert.ok(
          insideDisplay(x, y, 2),
          `"${t.value}" reaches ${x},${y}, outside the display`
        );
        assert.ok(x < ringLeft, `"${t.value}" reaches the glucose ring at ${x},${y}`);
      }
    }
    const regions = [];
    texts.length = 0;
    Object.assign(face, {
      render: {
        width: 260,
        height: 260,
        begin: (x, y, w, h) => regions.push([x, y, w, h]),
        end() {},
        fillRectangle() {},
        getTextWidth: (text) => String(text).length * 6,
      },
      footerState: {
        clock: "10:00",
        date: "Fri 13",
        battery: "80%",
        batteryWidth: 0,
        clockWidth: 0,
        connected: true,
      },
      loopFresh: 0,
      loopFreshness: () => 0,
      recoverRender: (error) => {
        throw error;
      },
    });
    face.diagnostics = face.newDiagnostics();
    face.drawMinuteNow(new Date(2026, 10, 14, 11, 7));
    assert.ok(
      texts.some((t) => t.value === "Sat 14"),
      "the date wasn't repainted"
    );
    assert.ok(
      texts.some((t) => t.value === "85%"),
      "the battery wasn't repainted"
    );
    const top = regions.filter(([, y]) => y < 100);
    assert.ok(
      top.length >= 2,
      "the date and battery weren't repainted beside the ring"
    );
    for (const [x, y, w, h] of top)
      assert.ok(x + w <= ringLeft, `region ${x},${y},${w},${h} reaches the ring`);
  }

  // The round graph keeps its points evenly spaced: clamping each point on its
  // own pulled the oldest one onto its neighbour.
  for (const readings of [
    [5.4, 5.5, 5.7, 5.8, 6, 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.8],
    [5.4, 5.1, 4.8, 4.5, 4.2, 4, 3.8, 3.6, 3.5, 3.3, 3.2, 3.1],
  ]) {
    const face = stubFace();
    Object.assign(face.state, { units: "mmol/L", readings });
    const dots = [];
    face.render = new Proxy(
      {
        width: 260,
        height: 260,
        drawCircle: (color, x, y, r) => (r === 2 || r === 4 ? dots.push([x, y]) : 0),
      },
      { get: (target, key) => (key in target ? target[key] : () => 0) }
    );
    face.graph(0, 131, 260, 99);
    // Each point is two circles (outline, then fill): one per point.
    const points = dots.filter((_, i) => i % 2 === 1);
    const xs = points.map(([x]) => x);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    assert.ok(
      Math.max(...gaps) - Math.min(...gaps) <= 1,
      `uneven round graph spacing: ${gaps.join(", ")}`
    );
    for (const [x, y] of dots)
      assert.ok(insideDisplay(x, y, 6), `dot at ${x},${y} is hidden by the bezel`);
  }

  // Every graph point, and its 6 px dot, stays inside the display.
  {
    const face = stubFace();
    const bounds = { x: 8, y: 138, width: 244, height: 85 };
    for (const y of [138, 160, 190, 223]) {
      const value = 400 - ((y - bounds.y) / bounds.height) * 360;
      for (const index of [0, 11]) {
        const point = face.graphPoint(value, index, 12, bounds, 40, 400);
        assert.ok(
          insideDisplay(point.x, point.y, 6),
          `point ${index} at ${point.x},${point.y} is hidden by the bezel`
        );
      }
    }
  }

  // Round Large Glucose: the ring is flush with the display's edge, and the reading,
  // time, clock, date and battery are all inside it (no footer row).
  {
    const face = stubFace();
    Object.assign(face.state, { fullScreen: true, battery: 85 });
    face.render.getTextWidth = (text) => String(text).length * 8;
    const rings = [];
    const texts = [];
    face.drawVariantRing = (cx, cy, radius) => rings.push([cx, cy, radius]);
    face.text = (value, font, color, x, y, centered) =>
      texts.push({ value: String(value), x, y, centered });
    face.footer = () => assert.fail("round full-screen drew the footer row");
    face.face(true, false);
    const [cx, cy, radius] = rings[0];
    assert.equal(cx, 130);
    assert.equal(cy, 130);
    assert.ok(
      radius - 3 >= 128 && radius - 3 <= 130,
      `ring outer edge r=${radius - 3} is not flush with the display (130)`
    );
    // The inside of the ring: its outer radius minus the 10 px band and its 2 px edge.
    const inner = radius - 3 - 12;
    const isClock = (value) => /^\d\d:\d\d$/.test(value);
    const strings = texts.map((t) => t.value);
    assert.ok(strings.some(isClock), "the clock is missing");
    assert.ok(
      strings.some((v) => /^[A-Z][a-z]{2} \d{1,2}$/.test(v)),
      "the date is missing"
    );
    assert.ok(strings.includes("85%"), "the battery is missing");
    for (const t of texts) {
      const textWidth = t.value.length * 8;
      const left = t.centered ? t.x - textWidth / 2 : t.x;
      const height = isClock(t.value) ? 32 : 24;
      for (const [x, y] of [
        [left, t.y],
        [left + textWidth, t.y],
        [left, t.y + height],
        [left + textWidth, t.y + height],
      ]) {
        assert.ok(
          Math.hypot(x - 130, y - 130) <= inner,
          `"${t.value}" reaches ${x},${y}, outside the ring's inside`
        );
      }
    }
  }

  // The minute redraw on round Large Glucose only touches regions inside the ring,
  // and repaints the clock, date and battery when they change.
  {
    const face = stubFace();
    Object.assign(face.state, { fullScreen: true, battery: 85 });
    const regions = [];
    const texts = [];
    Object.assign(face, {
      render: {
        width: 260,
        height: 260,
        begin: (x, y, w, h) => regions.push([x, y, w, h]),
        end() {},
        fillRectangle() {},
        getTextWidth: (text) => String(text).length * 8,
      },
      colors: { ink: 0, white: 1, crimson: 0 },
      footerState: {
        clock: "10:00",
        date: "Fri 13",
        battery: "80%",
        batteryWidth: 0,
        clockWidth: 0,
        connected: false,
      },
      text: (value) => texts.push(String(value)),
      recoverRender: (error) => {
        throw error;
      },
    });
    face.isConnected = true;
    face.diagnostics = face.newDiagnostics();
    face.drawMinuteNow(new Date(2026, 10, 14, 11, 7));
    assert.deepEqual(
      texts.sort(),
      ["11:07", "85%", "Sat 14"].sort(),
      "clock, date and battery weren't repainted"
    );
    assert.ok(regions.length >= 3);
    for (const [x, y, w, h] of regions) {
      for (const [px, py] of [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ]) {
        assert.ok(
          Math.hypot(px - 130, py - 130) <= 118,
          `redraw region ${x},${y},${w},${h} reaches the ring band`
        );
      }
      // The patches are filled black: one starting above the black bottom (y 176)
      // left a black bar over the white face at each minute.
      assert.ok(
        y >= 176,
        `redraw region ${x},${y},${w},${h} starts above the black bottom`
      );
    }
  }
}
console.log("Luped state machine regressions passed");
