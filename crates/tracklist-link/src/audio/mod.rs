//! Audio capture + FFT pipeline.
//!
//! Windows-only for MVP. WASAPI loopback via cpal reads the default output
//! device's mix (post-mix, pre-DAC). Audio frames land in a ring buffer,
//! the FFT thread windows them, transforms, log-bins, and pushes the
//! results into a broadcast channel that the WS server fans out.

pub mod beat;
pub mod capture;
pub mod fft;

use serde::Serialize;

/// A single broadcastable frame produced by the audio pipeline. The WS
/// server filters per-subscription before serializing to the wire.
#[derive(Debug, Clone, Serialize)]
pub enum AudioFrame {
    Fft64 { seq: u64, t_ms: u64, bands: Vec<f32> },
    Level { seq: u64, t_ms: u64, rms: f32, peak: f32 },
    Beat { seq: u64, t_ms: u64, confidence: f32 },
}

pub use capture::spawn_capture;
