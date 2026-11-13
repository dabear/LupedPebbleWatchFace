const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// The Luped variant, assembled as its watchface-config.json selects.
const config = JSON.parse(
  fs.readFileSync("variants/luped/watchface-config.json", "utf8")
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
let buzzes = 0;
const context = {
  Vibes: {
    pattern() {
      buzzes++;
    },
  },
  screen: { round: false },
  console,
};
vm.createContext(context);
vm.runInContext(source, context);
const face = Object.create(context.Face.prototype);
let inbox = [];
Object.assign(face, {
  state: { configured: true },
  configurationKnown: true,
  diagnostics: {},
  message: { read: () => inbox },
  ensureDiagnosticsWindow() {},
  countDiagnostic() {},
  addDiagnostic() {},
  updateStaleState() {
    return false;
  },
  setPhoneConnected() {},
  checkHostAlert() {},
  draw() {},
  requestRender() {},
  updateBattery() {},
  lastTelemetrySentAt: Date.now(),
  lastBatterySampleAt: Date.now(),
});
const data = (version, host) =>
  JSON.stringify([
    version,
    100,
    0,
    3,
    [],
    0,
    1000,
    0,
    0,
    0,
    null,
    null,
    null,
    null,
    null,
    host,
  ]);
const receive = (...messages) => {
  inbox = messages;
  face.readMessages();
};
const screen = () => {
  const lines = [];
  face.render = { width: 200, height: 228, fillRectangle() {} };
  face.colors = {};
  face.fonts = {};
  face.text = (text) => lines.push(text);
  face.face();
  return lines;
};

// No name, then the first name: allowed.
receive(["DATA", data(1, null)]);
receive(["DATA", data(1, "Loop")]);
assert.equal(face.hostChange, undefined);
assert.equal(face.state.glucose, 100);
receive(["COMMAND", "auth:v1:0123456789abcdef:" + "00".repeat(32)]);
assert.ok(face.bolusAuth);
// A message without a name says nothing about the host.
receive(["DATA", data(1, null)]);
receive(["DATA", data(1, "Loop")]);
assert.equal(face.hostChange, undefined);
assert.equal(buzzes, 0);

// Another app: warning screen, buzz, key dropped, no new key taken.
receive(["DATA", data(1, "Trio")]);
assert.deepEqual([...face.hostChange], ["Loop", "Trio"]);
assert.equal(buzzes, 1);
assert.equal(face.bolusAuth, null);
receive(["COMMAND", "auth:v1:0123456789abcdef:" + "00".repeat(32)]);
assert.equal(face.bolusAuth, null);
assert.deepEqual(screen(), [
  "!",
  "APP CHANGED",
  "Loop to Trio",
  "Restart this",
  "watchface",
]);
// It stays until restarted, even back on the first app, and buzzes each minute.
receive(["DATA", data(1, "Loop")]);
assert.ok(face.hostChange);
face.drawMinute({ date: new Date() });
assert.equal(buzzes, 2);
face.render = null;
face.drawMinuteNow(); // no footer over the warning: returns before drawing

// A newer protocol: its own warning, data ignored, until version 1 is back.
Object.assign(face, {
  hostChange: undefined,
  host: undefined,
  state: { configured: true },
});
buzzes = 0;
face.refreshPending = true;
receive(["DATA", data(2, "Loop")]);
assert.equal(face.newProtocol, 2);
assert.equal(face.state.glucose, undefined, "v2 data is not shown");
assert.equal(face.refreshPending, false);
assert.equal(buzzes, 1);
receive(["DATA", data(2, "Loop")]);
assert.equal(buzzes, 1, "one buzz per change, then each minute");
assert.deepEqual(screen(), [
  "!",
  "UPDATE NEEDED",
  "Phone sends v2",
  "Update this",
  "watchface",
]);
receive(["DATA", data(1, "Loop")]);
assert.equal(face.newProtocol, 0);
assert.equal(face.state.glucose, 100);
assert.equal(face.hostChange, undefined);

// The first draw after a warning repaints the whole screen, so none of the
// warning shows through the face; later draws repaint only the content again.
const draws = [];
const draw = () => {
  const realFace = face.face;
  face.render = {
    width: 200,
    height: 228,
    begin: (...area) => draws.push(area.length ? "content" : "full"),
    end() {},
  };
  face.face = () => {};
  face.drawNow();
  face.face = realFace;
};
draw();
face.newProtocol = 2;
draw();
face.newProtocol = 0;
draw();
draw();
assert.deepEqual(draws, ["full", "full", "full", "content"]);
console.log("Luped host change and protocol version warnings passed");
