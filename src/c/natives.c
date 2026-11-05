#include <pebble.h>

// Find my Pebble's sound (findPebble() in main.js.in), for both variants: Alloy
// has no speaker module, so the stub hands the firmware this fxBuildFFI and the
// JavaScript calls Natives.findPebbleBeep() and Natives.findPebbleQuiet().
// Watches without a speaker play nothing (findPebbleBeep() returns false).

txAPI *XS = NULL;

// Three short high beeps, 1.1 s: the watch plays them every 2.5 s.
static const SpeakerNote s_beeps[] = {
  { .midi_note = 96, .waveform = SpeakerWaveformSquare, .duration_ms = 200, .velocity = 127 },
  { .midi_note = 0, .duration_ms = 150 },
  { .midi_note = 96, .waveform = SpeakerWaveformSquare, .duration_ms = 200, .velocity = 127 },
  { .midi_note = 0, .duration_ms = 150 },
  { .midi_note = 100, .waveform = SpeakerWaveformSquare, .duration_ms = 400, .velocity = 127 },
};

static void xs_find_pebble_beep(txMachine *the) {
  bool started = speaker_play_notes(s_beeps, ARRAY_LENGTH(s_beeps), 100);
  XS->fromInteger(the, mxResult, started ? 1 : 0);
}

static void xs_find_pebble_quiet(txMachine *the) {
  speaker_stop();
}

static void prv_define(txMachine *the, txCallback callback, char *name) {
  XS->newHostFunction(the, callback, 0, 0, 0);
  XS->push(the, mxThis);
  XS->defineID(the, XS->id(the, name), 0, 0x0E);
  XS->pop(the);
}

void fxBuildFFI(txMachine *the, txAPI *api) {
  XS = api;
  prv_define(the, xs_find_pebble_beep, "findPebbleBeep");
  prv_define(the, xs_find_pebble_quiet, "findPebbleQuiet");
}
