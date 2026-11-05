#include <pebble.h>

// The speaker and Quiet Time for both variants (Find my Pebble and the glucose
// alarm sound in main.js.in): Alloy has no module for them, so the stub hands
// the firmware this fxBuildFFI and the JavaScript calls these functions on the
// global Natives. Watches without a speaker (PebbleOS CONFIG_SPEAKER off: the
// Pebble Round 2) play nothing and every play function returns false.

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

// One silent 1 ms rest at volume 0: whether the watch has a speaker, without a sound.
static const SpeakerNote s_probe[] = {
  { .midi_note = 0, .duration_ms = 1 },
};

static void xs_speaker_available(txMachine *the) {
  XS->fromInteger(the, mxResult, speaker_play_notes(s_probe, ARRAY_LENGTH(s_probe), 0) ? 1 : 0);
}

// The glucose alarm: three bursts of alternating high tones, 2.6 s, inside the
// 4.7 s alarm buzz.
#define ALARM_NOTE(midi) { .midi_note = (midi), .waveform = SpeakerWaveformSquare, .duration_ms = 150, .velocity = 127 }
#define ALARM_BURST ALARM_NOTE(91), ALARM_NOTE(96), ALARM_NOTE(91), ALARM_NOTE(96), { .midi_note = 0, .duration_ms = 250 }
static const SpeakerNote s_alarm[] = { ALARM_BURST, ALARM_BURST, ALARM_BURST };

static void xs_alarm_beep(txMachine *the) {
  bool started = speaker_play_notes(s_alarm, ARRAY_LENGTH(s_alarm), 100);
  XS->fromInteger(the, mxResult, started ? 1 : 0);
}

// Quiet Time can mute the speaker (the watch's own setting, which apps can't
// read); the buzz still comes.
static void xs_quiet_time(txMachine *the) {
  XS->fromInteger(the, mxResult, quiet_time_is_active() ? 1 : 0);
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
  prv_define(the, xs_speaker_available, "speakerAvailable");
  prv_define(the, xs_alarm_beep, "alarmBeep");
  prv_define(the, xs_quiet_time, "quietTime");
}
