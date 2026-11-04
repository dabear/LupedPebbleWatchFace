# Luped CGM

A Loop-styled glucose watchface for Pebble Time 2 and Pebble Round 2. It shows
the current glucose in a ring with a trend arrow, the change since the last
reading, and either a 12-reading graph with insulin and carbs on board and the
loop status, or a full-screen ring, plus date, time and battery. It uses the
Alloy embedded JavaScript runtime.

<table align="center">
  <tr>
    <th>Graph mode</th>
    <th>Full-screen mode</th>
  </tr>
  <tr>
    <td><img src="assets/emery_luped_graph_screenshot.png" alt="Luped CGM graph mode on Pebble Time 2" width="200"></td>
    <td><img src="assets/emery_luped_fullscreen_screenshot.png" alt="Luped CGM full-screen mode on Pebble Time 2" width="200"></td>
  </tr>
</table>

Luped needs a direct watch connection from a supported iPhone app such as Loop
or Trio. It has no PebbleKit JS companion and no settings page in the Pebble
app, and it does not fetch glucose on its own: the iPhone app sends readings,
alert settings and status to the watch. The watchface is informational and must
not be used on its own to make treatment decisions; it is not medical advice.

## Supported watches

- Pebble Time 2 (`emery`, 200×228)
- Pebble Round 2 (`gabbro`, 260×260)

## Build

You need Python 3.10, Node.js, [`uv`](https://docs.astral.sh/uv/), and a
working ARM toolchain:

```sh
uv tool install --python 3.10 pebble-tool
pebble sdk install latest
npm ci
PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh --build --minify
```

The package is written to `build/luped-cgm.pbw`. The root `package.json` only
holds the build tooling (ESLint, Prettier, Terser); the watchface's own Pebble
package is [`variants/luped/package.json`](variants/luped/package.json).

Run without arguments to choose the variant, build, phone installation and
publication interactively. Flags run non-interactively and can be combined:

```sh
PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh --build --install
PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh --build --minify --skip-deps
PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh --build --install --measure-memory
PEBBLE_BIN="$(command -v pebble)" ./scripts/build-release.sh --publish --release-notes "Release notes"
```

`--install` installs on the connected phone (`--cloudpebble` installs through
CloudPebble instead). Build and publish actions install locked dependencies and
run lint and formatting checks; `npm test` runs the watch-code tests. Publishing
requires a clean `main`, pushes it to GitHub, publishes to the RePebble store and
creates a GitHub release.

Every build lists the XS machine the C stub asks for (52 KB from the app heap)
and every module in the archive, flagging any the watchface does not import.
What runs out first is XS memory, not the archive size: `--install
--measure-memory` builds with the firmware's memory counters, restarts the
watchface with logs on, prints its XS memory on the watch, then restarts it
without them (the counters wake the watch every second; never publish that
build), for example:

```text
XS memory on the watch (peak of 15 samples; used includes garbage not yet collected):
  slots      15296 /   32752 B   46.7%
  chunks      6212 /   16384 B   37.9%
  stack       2240 /    4096 B   54.7%
  app heap free for PebbleOS: 28748 B
```

## Variants

The script assembles [`src/embeddedjs/main.js.in`](src/embeddedjs/main.js.in)
for a variant, selected with `--variant` (default `luped`), using the palette,
text and compile-time flags in `variants/<variant>/watchface-config.json`. Lines
between `// @if <flag>`, `// @else` and `// @endif` are kept or dropped before the
Moddable bytecode compile, so there is no runtime variant overhead. Each variant
also has its own `package.json` (name, UUID, version), `wscript`, Moddable
manifest, C stub and menu icon under `variants/<variant>/`.

`allowShakeDebugActionTestOnly` (`false`) is for test builds: set to `true`, a
shake sends a fixed watch request (`SHAKE_DEBUG_ACTION` in `main.js.in`:
`mute:30`, or a signed bolus such as `signedforcedbolus:0.1:1`). `--publish`
refuses to run while it is on.

## Protocol and attribution

- The mobile integration contract is documented in
  [`variants/luped/PROTOCOL.md`](variants/luped/PROTOCOL.md).
- Palette and icon sources are credited in
  [`variants/luped/ATTRIBUTION.md`](variants/luped/ATTRIBUTION.md).

Luped started as a variant of
[CrimsonBear Cgm](https://github.com/dabear/CrimsonBearPebbleWatchFace), a
Nightscout watchface, and shares its history.
