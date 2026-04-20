// In-process whisper.cpp binding for Local Voice AI.
//
// Eliminates the per-chunk whisper-cli process spawn and model reload by
// keeping a WhisperContext loaded in memory across feeds. This is the primary
// practical win of moving from the CLI to the C-API: chunk transcription that
// used to take ~800 ms of overhead per call collapses to tens of ms.
//
// This is NOT incremental/true streaming — whisper.cpp decodes each audio
// window from scratch. Callers should feed accumulated or sliding windows of
// PCM, not deltas, and expect deduplicated output from the extension side.

#![deny(clippy::all)]

use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;
use std::sync::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[napi]
pub struct WhisperBinding {
    inner: Mutex<WhisperContext>,
    language: String,
    threads: i32,
}

#[napi]
impl WhisperBinding {
    /// Load a ggml Whisper model. `language` is a BCP-47-ish code ("en", "auto", etc.).
    /// `threads` is the number of CPU threads for inference.
    #[napi(constructor)]
    pub fn new(model_path: String, language: String, threads: i32) -> Result<Self> {
        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(&model_path, params)
            .map_err(|e| Error::from_reason(format!("load model: {:?}", e)))?;
        Ok(Self {
            inner: Mutex::new(ctx),
            language,
            threads: threads.max(1),
        })
    }

    /// Transcribe a buffer of 16 kHz mono Float32 PCM samples (interleaved as
    /// little-endian 4-byte floats). Returns the full transcript for this
    /// window — caller is responsible for deduplicating against previous
    /// outputs if it feeds overlapping windows.
    #[napi]
    pub fn transcribe(&self, pcm: Buffer) -> Result<String> {
        let samples = bytes_to_f32(&pcm)
            .ok_or_else(|| Error::from_reason("PCM buffer length must be a multiple of 4"))?;
        if samples.is_empty() {
            return Ok(String::new());
        }

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_language(Some(&self.language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        let ctx = self.inner.lock().map_err(|_| Error::from_reason("context lock poisoned"))?;
        let mut state = ctx
            .create_state()
            .map_err(|e| Error::from_reason(format!("create state: {:?}", e)))?;
        state
            .full(params, &samples)
            .map_err(|e| Error::from_reason(format!("inference: {:?}", e)))?;

        let n = state
            .full_n_segments()
            .map_err(|e| Error::from_reason(format!("segments: {:?}", e)))?;
        let mut out = String::new();
        for i in 0..n {
            match state.full_get_segment_text(i) {
                Ok(s) => out.push_str(&s),
                Err(e) => return Err(Error::from_reason(format!("segment {}: {:?}", i, e))),
            }
        }
        Ok(out.trim().to_string())
    }
}

fn bytes_to_f32(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr = [chunk[0], chunk[1], chunk[2], chunk[3]];
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}
