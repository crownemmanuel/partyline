// Subset of libDF's C API (DeepFilterNet libDF/src/capi.rs, feature "capi") used by VoiceIsolation.swift.
#pragma once
#include <stdint.h>

typedef struct DFState DFState;

/// path: DeepFilterNet tar.gz ONNX model. atten_lim: dB. log_level: NULL for no logging.
DFState *df_create(const char *path, float atten_lim, const char *log_level);
/// Samples per frame (480 at 48 kHz for DeepFilterNet3).
uintptr_t df_get_frame_length(DFState *st);
void df_set_atten_lim(DFState *st, float lim_db);
/// input/output: df_get_frame_length() mono samples in [-1, 1]. Returns local SNR.
float df_process_frame(DFState *st, float *input, float *output);
void df_free(DFState *model);
