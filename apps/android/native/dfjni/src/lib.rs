//! JNI bridge from `com.partyline.audio.DeepFilter` to libDF (DeepFilterNet3, 48 kHz mono,
//! 480-sample hops). The model is compiled in, so this works offline. Every entry point catches
//! panics: an unwinding panic across JNI would abort the app's audio thread.

use std::panic::{catch_unwind, AssertUnwindSafe};

use df::tract::{DfParams, DfTract, RuntimeParams};
use jni::objects::{JClass, JFloatArray};
use jni::sys::{jfloat, jint, jlong};
use jni::JNIEnv;
use ndarray::Array2;

struct State {
    m: DfTract,
    input: Array2<f32>,
    output: Array2<f32>,
    frame: Vec<f32>,
}

#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeCreate(
    _env: JNIEnv,
    _class: JClass,
    atten_lim_db: jfloat,
) -> jlong {
    catch_unwind(|| {
        let params = RuntimeParams::default_with_ch(1)
            .with_atten_lim(atten_lim_db)
            .with_thresholds(-15.0, 35.0, 35.0)
            .with_post_filter(0.0);
        let m = DfTract::new(DfParams::default(), &params).ok()?;
        let hop = m.hop_size;
        let s = State { m, input: Array2::zeros((1, hop)), output: Array2::zeros((1, hop)), frame: vec![0.0; hop] };
        Some(Box::into_raw(Box::new(s)) as jlong)
    })
    .ok()
    .flatten()
    .unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeFrameLength(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let s = unsafe { &*(handle as *const State) };
    s.m.hop_size as jint
}

#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeSampleRate(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let s = unsafe { &*(handle as *const State) };
    s.m.sr as jint
}

/// Denoises one hop in place. `frame` holds `frame_length` samples in [-1, 1].
/// Returns the frame's local SNR in dB, or NaN on failure (the frame is then left unchanged).
#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeProcess(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    frame: JFloatArray,
) -> jfloat {
    if handle == 0 {
        return f32::NAN;
    }
    let s = unsafe { &mut *(handle as *mut State) };
    let hop = s.m.hop_size;
    if env.get_array_length(&frame).ok().map(|n| n as usize) != Some(hop) {
        return f32::NAN;
    }
    if env.get_float_array_region(&frame, 0, &mut s.frame).is_err() {
        return f32::NAN;
    }
    let r = catch_unwind(AssertUnwindSafe(|| {
        s.input.row_mut(0).as_slice_mut().unwrap().copy_from_slice(&s.frame);
        let snr = s.m.process(s.input.view(), s.output.view_mut()).ok()?;
        s.frame.copy_from_slice(s.output.row(0).as_slice().unwrap());
        Some(snr)
    }));
    match r {
        Ok(Some(snr)) => {
            if env.set_float_array_region(&frame, 0, &s.frame).is_err() {
                return f32::NAN;
            }
            snr
        }
        _ => f32::NAN,
    }
}

#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeSetAttenLim(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    atten_lim_db: jfloat,
) {
    if handle == 0 {
        return;
    }
    let s = unsafe { &mut *(handle as *mut State) };
    s.m.set_atten_lim(atten_lim_db);
}

#[no_mangle]
pub extern "system" fn Java_com_partyline_audio_DeepFilter_nativeFree(_env: JNIEnv, _class: JClass, handle: jlong) {
    if handle != 0 {
        drop(unsafe { Box::from_raw(handle as *mut State) });
    }
}
