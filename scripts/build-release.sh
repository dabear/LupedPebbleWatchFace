#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
repo_root="$(pwd)"

do_build=false
do_install=false
measure_memory=false
install_target="--phone"
do_publish=false
do_minify=true
skip_deps=false
release_notes=""
interactive=false
variant="luped"

usage() {
  cat <<'EOF'
Usage: ./scripts/build-release.sh [--variant luped|lupedhelper] [--build] [--install] [--measure-memory] [--cloudpebble] [--publish] [--minify] [--no-minify] [--skip-deps] [--release-notes TEXT]

Each variant is a directory under variants/ (luped is the default; lupedhelper
is the Luped Remote watchapp). With no
arguments, the script interactively selects actions. Explicit action flags
run without prompts. --install targets the connected phone (--cloudpebble installs
through CloudPebble instead). --measure-memory (with --build --install)
builds with the firmware's XS memory counters, measures the watchface's memory on
the watch after installing, then restarts it without them; never publish that
build, as the counters wake the watch every second; --publish pushes main
to GitHub and publishes the release to the RePebble store without requiring
--build or --install. Each variant publishes under its own store listing. The Pebble
publisher still performs its mandatory package build. Minification is ON by default: it
safely compresses and mangles internal watch JavaScript identifiers without mangling
protocol properties, which keeps the Alloy resource pack small enough to launch on the
watch. --no-minify disables it (--minify is kept for explicitness but is now the default).
--skip-deps avoids reinstalling dependencies for local builds only after validating
that node_modules exactly matches package-lock.json; it is not allowed with --publish.
EOF
}

if [[ $# -eq 0 ]]; then
  interactive=true
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --variant)
        if [[ $# -lt 2 ]]; then
          echo "--variant requires a variant name (luped or lupedhelper)." >&2
          exit 2
        fi
        variant="$2"
        shift
        ;;
      --build) do_build=true ;;
      --install) do_install=true ;;
      --measure-memory) measure_memory=true ;;
      --cloudpebble) install_target="--cloudpebble" ;;
      --publish) do_publish=true ;;
      --minify) do_minify=true ;;
      --no-minify) do_minify=false ;;
      --skip-deps) skip_deps=true ;;
      --release-notes)
        if [[ $# -lt 2 ]]; then
          echo "--release-notes requires text." >&2
          exit 2
        fi
        release_notes="$2"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
fi

if [[ ! -f "variants/$variant/watchface-config.json" ]]; then
  echo "Unknown variant: $variant" >&2
  usage >&2
  exit 2
fi

confirm() {
  local prompt="$1"
  local default="$2"
  local answer
  read -r -p "$prompt" answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

if [[ "$interactive" == true ]]; then
  read -r -p "Variant [$(cd variants && ls | paste -sd / -)] (luped): " variant
  variant="${variant:-luped}"
  if [[ ! -f "variants/$variant/watchface-config.json" ]]; then
    echo "Unknown variant: $variant" >&2
    exit 2
  fi
  if confirm "Build the PBW? [Y/n] " y; then do_build=true; fi
  if confirm "Install on the connected phone? [y/N] " n; then do_install=true; fi
  if confirm "Push GitHub and publish to RePebble? [y/N] " n; then
    do_publish=true
    default_notes="$(git log -1 --pretty=%s)"
    read -r -p "Release notes [$default_notes]: " release_notes
    release_notes="${release_notes:-$default_notes}"
  fi
  if [[ "$do_build" == true || "$do_publish" == true ]]; then
    if confirm "Minify generated watch JavaScript? [Y/n] " y; then do_minify=true; else do_minify=false; fi
  fi
fi

if [[ "$do_build" == false && "$do_install" == false && "$do_publish" == false ]]; then
  echo "No action selected." >&2
  exit 2
fi

pebble_bin="${PEBBLE_BIN:-}"
if [[ -z "$pebble_bin" ]]; then
  pebble_bin="$(command -v pebble || true)"
fi
# Memory limits. The archive guard below is a coarse proxy; what actually
# runs out is the XS machine (see AGENTS.md): by default a fixed 32 KB static
# block, or the stack/slot/chunk sizes the variant's C stub asks for, taken
# from the app heap (about 122 KB on a Pebble Time 2, shared with AppMessage
# buffers and PebbleOS).
print_xs_machine() {
  local stub="$stage/src/c/mdbl.c" stack slot chunk
  stack="$(sed -nE 's/.*_XS_STACK \(([0-9]+) \* 1024\).*/\1/p' "$stub")"
  slot="$(sed -nE 's/.*_XS_SLOT \(([0-9]+) \* 1024\).*/\1/p' "$stub")"
  chunk="$(sed -nE 's/.*_XS_CHUNK \(([0-9]+) \* 1024\).*/\1/p' "$stub")"
  if [[ -n "$stack" && -n "$slot" && -n "$chunk" ]]; then
    echo "XS machine: stack ${stack} KB + slots ${slot} KB + chunks ${chunk} KB = $((stack + slot + chunk)) KB from the app heap (src/c/mdbl.c)."
  else
    echo "XS machine: default 32 KB static block (stack 6 KB; slot and chunk heaps start at 8 KB each and grow inside the block)."
  fi
}

# Every module the manifest matches is compiled into the archive, imported or
# not; list them so an unused one (typings JSON, a shared helper) shows up.
print_archive_modules() {
  local files="$stage/build/mods/emery/mcrun/tmp/pebble/release/embeddedjs/files" xsb name size
  [[ -d "$files" ]] || return 0
  echo "Archive modules (emery):"
  for xsb in "$files"/*.xsb; do
    name="$(basename "$xsb" .xsb)"
    size="$(wc -c < "$xsb" | tr -d ' ')"
    if [[ "$name" == "main" ]]; then
      printf '  %-24s %7s B\n' "$name" "$size"
    else
      printf '  %-24s %7s B  <- not imported by %s; check the manifest\n' "$name" "$size" "$display_name"
    fi
  done
}

# After a --measure-memory install: restart the watchface with app logs on,
# report its XS memory from the firmware's instrumentation, then restart it
# with logs off so the counters stop.
print_xs_usage() {
  local line
  echo "Measuring XS memory on the watch (15 s)..."
  line="$( (echo "APP='$app_uuid'; WAIT=15"; echo "exec(open('$PWD/scripts/xs-usage.py').read())"; echo "exit()") \
    | "$pebble_bin" repl "$install_target" 2>&1 | grep -o 'XSUSAGE.*' | tail -1)"
  case "$line" in
    "XSUSAGE FATAL"*) echo "XS memory: the watchface crashed: ${line#XSUSAGE FATAL }" >&2; return 1 ;;
    "XSUSAGE NONE"|"") echo "XS memory: no instrumentation received (the C stub needs LUPED_XS_INSTRUMENTATION)."; return 0 ;;
  esac
  python3 - "$line" <<'PY'
import sys
v = dict(kv.split("=") for kv in sys.argv[1].split()[1:])
v = {k: int(x) for k, x in v.items()}
def row(name, used, avail, warn):
    pct = 100 * used / avail if avail else 0
    flag = "  <- close to the limit" if pct >= warn else ""
    print("  %-8s %7d / %7d B  %5.1f%%%s" % (name, used, avail, pct, flag))
if v.get("live_slot", -1) >= 0:
    print("XS memory in use on the watch (after the last garbage collection in %d samples):" % v["samples"])
    row("slots", v["live_slot"], v["slot_avail"], 85)
    row("chunks", v["live_chunk"], v["chunk_avail"], 85)
else:
    print("XS memory in use: unknown, no garbage collection in %d samples (the peak below includes garbage)." % v["samples"])
print("Peak, including garbage not yet collected (XS collects only when it runs short):")
row("slots", v["slot_used"], v["slot_avail"], 101)
row("chunks", v["chunk_used"], v["chunk_avail"], 101)
row("stack", v["stack_used"], v["stack_avail"], 75)
free = v["appfree_min"]
print("  app heap free for PebbleOS: %d B%s" % (free, "  <- low, keep 12 KB or more" if free < 12 * 1024 else ""))
print("  garbage collections: %d, keys: %d" % (v["gcs"], v["keys"]))
PY
}

if [[ -z "$pebble_bin" || ! -x "$pebble_bin" ]]; then
  echo "Set PEBBLE_BIN to an executable pebble-tool command." >&2
  exit 1
fi

# Release metadata per variant; a new variant adds its own case here.
package_file="variants/$variant/package.json"
case "$variant" in
  luped)
    artifact="build/luped-cgm.pbw"
    display_name="Luped CGM"
    screenshot_prefix="emery_luped"
    # The two store screenshots: assets/<prefix>_<name>_screenshot.png.
    screenshot_names=(graph fullscreen)
    store_icon_dir="variants/luped/assets"
    store_icon_prefix="luped"
    store_description="A Loop-styled CGM watchface for Pebble Time 2 and Pebble Round 2. Requires a direct watch connection from a supported iPhone app such as Loop or Trio; the watchface has no Pebble app settings and does not fetch glucose data on its own."
    extra_private_methods=""
    ;;
  lupedhelper)
    artifact="build/luped-remote.pbw"
    display_name="Luped Remote"
    screenshot_prefix="emery_lupedhelper"
    screenshot_names=(main confirm)
    store_icon_dir="variants/lupedhelper/assets"
    store_icon_prefix="lupedhelper"
    store_description="Luped Remote is the button-driven companion to the Luped CGM watchface for Pebble Time 2 and Pebble Round 2. It shows the latest glucose, trend, IOB and COB from your iPhone app and sends it requests: mute alerts, add carbs (fast, medium or slow), end an override or temp target, and an optional signed bolus, with or without carbs (with their absorption) and starting at the phone's recommendation for them, that is off by default. Every request needs a confirmation on the watch (hold the top and bottom right buttons for 2 seconds); the phone then applies its own checks and limits and the watch shows whether it was done. Requires a direct watch connection from a supported iPhone app such as Loop or Trio; without one it only shows its connecting screen. It is not medical advice and does not replace the phone app. Tip: on the watch, Settings > Quick Launch > Tap Up > Luped Remote opens it with one press of Up from the watchface."
    # The remote's own methods (main.js.in, "// @if helper"), mangled like Luped's.
    extra_private_methods="|helper[A-Za-z]+"
    ;;
  *)
    echo "No release metadata for variant $variant; add it to scripts/build-release.sh." >&2
    exit 2
    ;;
esac
version="$(node -p "require('./$package_file').version")"
app_uuid="$(node -p "require('./$package_file').pebble.uuid")"
stage="build/variants/$variant/project"

assemble_watchface() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require("fs");

const [templatePath, configPath, destinationPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const template = fs.readFileSync(templatePath, "utf8");
const output = [];
const stack = [];
let active = true;

for (const line of template.split("\n")) {
  const condition = line.match(/^\s*\/\/ @if ([A-Za-z][A-Za-z0-9]*)\s*$/);
  if (condition) {
    if (!(condition[1] in config))
      throw new Error(`Unknown variant condition: ${condition[1]}`);
    stack.push({ parent: active, matched: Boolean(config[condition[1]]), sawElse: false });
    active = active && Boolean(config[condition[1]]);
    continue;
  }
  if (/^\s*\/\/ @else\s*$/.test(line)) {
    const frame = stack[stack.length - 1];
    if (!frame || frame.sawElse) throw new Error("Unexpected variant @else");
    frame.sawElse = true;
    active = frame.parent && !frame.matched;
    continue;
  }
  if (/^\s*\/\/ @endif\s*$/.test(line)) {
    const frame = stack.pop();
    if (!frame) throw new Error("Unexpected variant @endif");
    active = frame.parent;
    continue;
  }
  if (active) output.push(line);
}
if (stack.length) throw new Error("Unclosed variant condition");

const color = (name) => {
  const value = config.colors && config.colors[name];
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(item)))
    throw new Error(`Invalid color: ${name}`);
  return value.join(", ");
};
const arrowScale = config.flatArrowScale == null
  ? String(config.fullArrowScale)
  : `(this.state.direction === "Flat" ? ${config.flatArrowScale} : ${config.fullArrowScale})`;
const replacements = {
  COLOR_INK: color("ink"),
  COLOR_RING_BORDER: color("ringBorder"),
  COLOR_ACCENT: color("accent"),
  COLOR_GRAPH: color("graph"),
  COLOR_PANEL: color("panel"),
  COLOR_PALE: color("pale"),
  COLOR_LOW: color("low"),
  COLOR_HIGH: color("high"),
  SETUP_APP_TEXT: JSON.stringify(config.text.setupApp),
  SETTINGS_TEXT: JSON.stringify(config.text.settings),
  SETUP_ACTION_TEXT: JSON.stringify(config.text.setupAction),
  COMPACT_GLUCOSE_Y: `(cy - ${Number(config.compactGlucoseOffset)})`,
  FULL_ARROW_SCALE: arrowScale,
};
const assembled = output.join("\n").replace(/@([A-Z][A-Z0-9_]*)@/g, (_, name) => {
  if (!(name in replacements)) throw new Error(`Unknown variant token: ${name}`);
  return replacements[name];
});
if (/@[A-Z][A-Z0-9_]*@/.test(assembled)) throw new Error("Unresolved variant token");
fs.writeFileSync(destinationPath, assembled);
NODE
}

prepare_stage() {
  rm -rf "$stage"
  mkdir -p "$stage/src/c" "$stage/src/embeddedjs" "$stage/resources/images"
  # Each variant sizes its own XS machine (variants/<variant>/src/c/mdbl.c).
  if [[ "$measure_memory" == true ]]; then
    { echo "#define LUPED_XS_INSTRUMENTATION 1"; cat "variants/$variant/src/c/mdbl.c"; } > "$stage/src/c/mdbl.c"
  else
    cp "variants/$variant/src/c/mdbl.c" "$stage/src/c/mdbl.c"
  fi
  assemble_watchface \
    src/embeddedjs/main.js.in \
    "variants/$variant/watchface-config.json" \
    "$stage/src/embeddedjs/main.js"

  cp "variants/$variant/package.json" "$stage/package.json"
  cp "variants/$variant/wscript" "$stage/wscript"
  cp "variants/$variant/src/embeddedjs/manifest.json" "$stage/src/embeddedjs/manifest.json"
  cp -R "variants/$variant/resources/images/." "$stage/resources/images/"
}

verify_installed_dependencies() {
  if [[ ! -f node_modules/.package-lock.json ]]; then
    echo "--skip-deps requires an existing npm install; run npm ci first." >&2
    return 1
  fi
  npm ls --all --include=dev >/dev/null
  node <<'NODE'
const fs = require("fs");

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const installed = JSON.parse(
  fs.readFileSync("node_modules/.package-lock.json", "utf8")
);
const lockedRoot = (lock.packages || {})[""] || {};
const expectedPackages = Object.fromEntries(
  Object.entries(lock.packages || {}).filter(([path]) => path)
);
const dependencyKeys = ["dependencies", "devDependencies", "optionalDependencies"];
const declarationsMatch = dependencyKeys.every(
  (key) =>
    JSON.stringify(manifest[key] || {}) === JSON.stringify(lockedRoot[key] || {})
);
if (
  lock.name !== installed.name ||
  !declarationsMatch ||
  JSON.stringify(expectedPackages) !== JSON.stringify(installed.packages || {})
) {
  console.error(
    "Installed dependencies do not exactly match package-lock.json; run npm ci first."
  );
  process.exit(1);
}
NODE
  echo "Verified installed dependencies exactly match package-lock.json."
}

remove_stage_build_dependencies() {
  node - "$stage/package.json" <<'NODE'
const fs = require("fs");

const packagePath = process.argv[2];
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
delete packageData.devDependencies;
fs.writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
NODE
}

if [[ "$measure_memory" == true ]]; then
  if [[ "$do_publish" == true ]]; then
    echo "--measure-memory builds with the XS memory counters and cannot be used with --publish." >&2
    exit 2
  fi
  if [[ "$do_build" != true || "$do_install" != true ]]; then
    echo "--measure-memory needs --build and --install." >&2
    exit 2
  fi
fi

if [[ "$do_publish" == true && "$skip_deps" == true ]]; then
  echo "--skip-deps is for local builds only and cannot be used with --publish." >&2
  exit 2
fi

if [[ "$do_publish" == true ]]; then
  if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "Publishing must run from the main branch." >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit all changes before publishing." >&2
    exit 1
  fi
  release_notes="${release_notes:-$(git log -1 --pretty=%s)}"
  # The shake test sends watch requests (boluses, presets, mute) on a shake:
  # test builds only, never a store release.
  if node -e "process.exit(require('./variants/$variant/watchface-config.json').allowShakeDebugActionTestOnly ? 0 : 1)"; then
    echo "allowShakeDebugActionTestOnly is on in variants/$variant/watchface-config.json; turn it off before publishing." >&2
    exit 1
  fi
  # The demo test build shows sample data and answers its own requests.
  if node -e "process.exit(require('./variants/$variant/watchface-config.json').demoTestOnly ? 0 : 1)"; then
    echo "demoTestOnly is on in variants/$variant/watchface-config.json; turn it off before publishing." >&2
    exit 1
  fi
  if ! command -v gh >/dev/null; then
    echo "Publishing also creates a GitHub release: install and log in to the GitHub CLI (gh)." >&2
    exit 1
  fi
  release_tag="$variant-v$version"
  if git ls-remote --exit-code --tags origin "refs/tags/$release_tag" >/dev/null; then
    echo "$release_tag is already released; raise the version in $package_file first." >&2
    exit 1
  fi
fi

if [[ "$do_build" == true || "$do_publish" == true ]]; then
  echo "Validating $display_name $version..."
  if [[ "$skip_deps" == true ]]; then
    verify_installed_dependencies
  else
    npm ci
  fi
  npm run lint
  npm run format:check
fi

if [[ "$do_build" == true || "$do_publish" == true ]]; then
  prepare_stage
  if [[ "$skip_deps" == true ]]; then
    remove_stage_build_dependencies
  fi
  npx --no-install eslint "$stage/src/embeddedjs/main.js"
  if [[ "$do_minify" == true ]]; then
    # Only these CrimsonBearWatchface (the template's class) prototype methods
    # are eligible for property mangling. State, diagnostics, AppMessage, Pebble
    # and renderer properties are deliberately absent so the phone/mobile
    # protocol and host APIs stay stable.
    private_watch_methods='/^(start|text|glucoseColor|glucoseText|deltaText|newDiagnostics|ensureDiagnosticsWindow|countDiagnostic|addDiagnostic|recordDraw|diagnosticsSnapshot|recordLatency|resetDiagnostics|drawGlucose|arrow|graphPoint|graph|drawVariantRing|setupScreen|readingTime|drawCgmStatus|footer|drawBluetoothDisconnectedIndicator|fullScreenFace|face|requestRender|draw|recoverRender|drawNow|drawMinute|drawMinuteNow|startBatteryService|updateBattery|startMessageService|requestDataRefresh|requestDiagnostics|checkConnection|setPhoneConnected|flushOutbound|updateStaleState|readMessages|loopFreshness|drawLoopRing|resultText'"$extra_private_methods"')$/'
    for watch_module in main; do
      readable_module="$stage/src/embeddedjs/$watch_module.js"
      minified_module="$stage/src/embeddedjs/$watch_module.min.js"
      readable_module_size="$(wc -c < "$readable_module" | tr -d ' ')"
      terser_arguments=(--compress passes=3 --mangle --module --comments false)
      if [[ "$watch_module" == "main" ]]; then
        terser_arguments+=(--mangle-props "regex=$private_watch_methods")
      fi
      npx --no-install terser "$readable_module" "${terser_arguments[@]}" --output "$minified_module"
      minified_module_size="$(wc -c < "$minified_module" | tr -d ' ')"
      mv "$minified_module" "$readable_module"
      echo "Minified $watch_module.js: $readable_module_size -> $minified_module_size bytes."
    done
    echo "Only allowlisted private watch methods were property-mangled; protocol properties, exported names, and string values were preserved."
  fi
fi

if [[ "$do_build" == true ]]; then
  echo "Building $display_name $version..."
  (cd "$stage" && "$pebble_bin" build)
  # No archive-size guard: the variant's own stub gives XS its memory from the
  # app heap, so the limit is XS memory use, measured on the watch with
  # --install --measure-memory, not the archive size.
  echo
  printf '%-10s %12s %12s\n' "Platform" "App binary" "Alloy size"
  for platform in emery gabbro; do
    resource_pack="$stage/build/$platform/app_resources.pbpack"
    app_binary="$stage/build/$platform/pebble-app.bin"
    resource_size="$(wc -c < "$resource_pack" | tr -d ' ')"
    app_size="$(wc -c < "$app_binary" | tr -d ' ')"
    printf '%-10s %9s B %9s B\n' "$platform" "$app_size" "$resource_size"
  done
  echo "Alloy limit: XS memory on the watch, not the archive size; use --install --measure-memory to measure slots, chunks and free app heap."
  print_xs_machine
  print_archive_modules
  cp "$stage/build/project.pbw" "$artifact"
  test -s "$artifact"
  artifact_size="$(wc -c < "$artifact" | tr -d ' ')"
  echo "PBW package: $artifact_size bytes ($artifact)"
  if command -v sha256sum >/dev/null 2>&1; then
    artifact_sha256="$(sha256sum "$artifact" | awk '{print $1}')"
  else
    artifact_sha256="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  fi
  echo "PBW SHA-256: $artifact_sha256"
fi

if [[ "$do_install" == true ]]; then
  if [[ ! -s "$artifact" ]]; then
    echo "$artifact is missing; include --build first." >&2
    exit 1
  fi
  echo "Installing $display_name $version (${install_target#--})..."
  "$pebble_bin" install "$artifact" "$install_target"
  if [[ "$measure_memory" == true ]]; then
    print_xs_usage
  fi
fi

if [[ "$do_publish" == true ]]; then
  git fetch origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Local main does not contain origin/main; pull or rebase first." >&2
    exit 1
  fi

  echo "Pushing commit $(git rev-parse --short HEAD) to GitHub..."
  git push origin HEAD:main

  echo "Publishing $version to the RePebble store..."
  (
    cd "$stage"
    "$pebble_bin" publish \
      --is-published \
      --non-interactive \
      --no-gif-all-platforms \
      --screenshots \
        "$repo_root/assets/${screenshot_prefix}_${screenshot_names[0]}_screenshot.png" \
        "$repo_root/assets/${screenshot_prefix}_${screenshot_names[1]}_screenshot.png" \
      --replace-screenshots \
      --description "$store_description" \
      --icon-small "$repo_root/$store_icon_dir/$store_icon_prefix-store-icon-small.png" \
      --icon-large "$repo_root/$store_icon_dir/$store_icon_prefix-store-icon-large.png" \
      --release-notes "$release_notes"
  )

  # Release the PBW the store just got (pebble publish builds the stage); the
  # artifact in build/ may be older, such as a test build left there.
  cp "$stage/build/project.pbw" "$artifact"
  echo "Creating GitHub release $release_tag..."
  gh release create "$release_tag" "$artifact" \
    --target "$(git rev-parse HEAD)" \
    --title "$display_name $version" \
    --notes "$release_notes"
fi

echo "Completed selected actions for $display_name $version."
