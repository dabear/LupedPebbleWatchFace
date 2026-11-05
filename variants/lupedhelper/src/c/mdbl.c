#include <pebble.h>

// Luped Remote (a watchapp built from the same main.js.in as Luped) asks for
// Luped's XS machine instead of the default 32 KB static block: Luped's slot heap
// was ~94% and its chunk heap ~87% full in that block. Larger than the static
// block, the firmware takes these from the app heap (needs PebbleOS 4.21+, see
// PebbleOS #1621). The remote leaves Luped's graph, ring and footer drawing out
// and adds its own screens; measure it on a watch with --measure-memory before
// changing these. Buttons need no C: the pebble/button module subscribes them on
// this window for the JavaScript (it is blocked in watchfaces only).
#define LUPED_XS_STACK (4 * 1024) // Luped's peak use 2.2 KB
// 28 KB, not Luped's 32: the remote's live slots are about 20 KB (0.1.4 in the
// emery emulator), and with 32 KB its free app heap fell to 9.6 KB.
#define LUPED_XS_SLOT (28 * 1024)
#define LUPED_XS_CHUNK (16 * 1024)

// Memory counters only in a measuring build (scripts/build-release.sh
// --measure-memory defines LUPED_XS_INSTRUMENTATION). When app logging is on as
// the watchface starts, they wake the watch every second for as long as it runs,
// and the watchface keeps them after logging is turned off. Release builds had
// them from 0.1.11 to 0.1.20, when the battery lasted about 6 days instead of 9-10.
#ifdef LUPED_XS_INSTRUMENTATION
#define LUPED_XS_FLAGS kModdableCreationFlagLogInstrumentation
#else
#define LUPED_XS_FLAGS 0
#endif

int main(void) {
  Window *window = window_create();
  window_stack_push(window, true);
  ModdableCreationRecord creation = {
    .recordSize = sizeof(creation),
    .stack = LUPED_XS_STACK,
    .slot = LUPED_XS_SLOT,
    .chunk = LUPED_XS_CHUNK,
    .fxBuildFFI = fxBuildFFI, // src/c/natives.c: Find my Pebble's sound
#ifdef PBL_DEBUG
    .flags = LUPED_XS_FLAGS | kModdableCreationFlagDebug
#else
    .flags = LUPED_XS_FLAGS
#endif
  };
  moddable_createMachine(&creation);
  window_destroy(window);
  return 0;
}
