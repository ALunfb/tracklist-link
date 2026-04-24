//! Audio capture + FFT pipeline.
//!
//! Windows-only for MVP. WASAPI loopback via cpal reads the default output
//! device's mix (post-mix, pre-DAC). Audio frames land in a ring buffer,
//! the FFT thread windows them, transforms, log-bins, and pushes the
//! results into a broadcast channel that the WS server fans out.

pub mod beat;
pub mod capture;
pub mod fft;
pub mod silence;

use serde::Serialize;
use tracklist_link_proto::VizSettings;

/// A single broadcastable frame produced by the audio pipeline (or, in
/// the case of VizSettings, by a user-initiated IPC call). The WS server
/// filters per-subscription before serializing to the wire.
#[derive(Debug, Clone, Serialize)]
pub enum AudioFrame {
    Fft64 { seq: u64, t_ms: u64, bands: Vec<f32> },
    Level { seq: u64, t_ms: u64, rms: f32, peak: f32 },
    Beat { seq: u64, t_ms: u64, confidence: f32 },
    /// Silence entered / exited (audio/silence topic). `silent` indicates
    /// the NEW state: true = just went quiet, false = just came back.
    Silence { seq: u64, t_ms: u64, silent: bool },
    /// Live viz-tuning push (viz/settings topic). Edge-triggered by
    /// slider changes in the Tune panel; broadcast to all clients so
    /// external visualizers (web /visualizer in OBS) mirror the local one.
    VizSettings(VizSettings),
}

pub use capture::spawn_capture;
