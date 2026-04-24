//! Wire protocol between Tracklist Link (the companion) and its clients.
//!
//! The companion speaks JSON over a WebSocket connection. Clients send
//! `ClientMessage` frames (subscribe / unsubscribe / ping), and the companion
//! broadcasts `ServerMessage` frames for every subscribed topic.
//!
//! All messages use a discriminated-union `kind` field so parsers can dispatch
//! on the type without inspecting internal shape. Every message carries a
//! schema `v` version so older clients can degrade gracefully when we
//! evolve the protocol.
//!
//! # Stability
//!
//! - `v = 1` is the initial protocol, covering `audio/fft/64`, `audio/level`,
//!   `audio/beat`, and `system/heartbeat`.
//! - Additive changes (new `kind` values, new topics, new optional fields)
//!   do NOT bump `v`. Clients must ignore unknown kinds / fields.
//! - Breaking changes bump `v` and introduce a new message variant; the
//!   companion serves both old + new for a deprecation window.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Named subscription targets. Named rather than a string enum so the Rust
/// side is exhaustive-match-checked when we add a topic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Topic {
    /// 64-band FFT of the audio output. Payload: [`FftFrame`] at ~60 Hz.
    #[serde(rename = "audio/fft/64")]
    AudioFft64,
    /// 512-band FFT — heavier, for spectrum / lyrics-sync clients.
    #[serde(rename = "audio/fft/512")]
    AudioFft512,
    /// RMS + peak amplitude, 60 Hz. Payload: [`LevelFrame`].
    #[serde(rename = "audio/level")]
    AudioLevel,
    /// Onset / beat event. Payload: [`BeatEvent`]. Future topic — currently
    /// reserved so clients don't fall over if the companion starts emitting.
    #[serde(rename = "audio/beat")]
    AudioBeat,
    /// BPM estimate. Future topic.
    #[serde(rename = "audio/bpm")]
    AudioBpm,
    /// Heartbeat + companion status. Always-on; no subscription needed for
    /// clients to receive these — the server sends them to every connected
    /// client every few seconds.
    #[serde(rename = "system/heartbeat")]
    SystemHeartbeat,
    /// Silence state-change event (audio/silence). Emitted on silence
    /// entry + exit, not per-frame. Consumers track the last-seen
    /// `silent` boolean themselves.
    #[serde(rename = "audio/silence")]
    AudioSilence,
    /// Visualizer tuning settings. Edge-triggered: broadcast whenever the
    /// streamer changes a slider in the companion's Tune panel (plus once
    /// on companion boot so early clients pick up the starting values).
    /// Web clients use these to mirror the companion's local viz tuning
    /// live, without requiring per-URL configuration.
    #[serde(rename = "viz/settings")]
    VizSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// Subscribe to one or more topics. Duplicate subs are idempotent.
    Subscribe { topics: Vec<Topic> },
    /// Drop subscriptions.
    Unsubscribe { topics: Vec<Topic> },
    /// Ping. Server responds with a `Pong` carrying the same nonce.
    Ping { nonce: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServerMessage {
    /// Sent once after a successful WebSocket upgrade + auth. Client should
    /// verify protocol version matches its expectation.
    Hello {
        /// Schema version the companion speaks.
        v: u32,
        /// Companion app version (semver string).
        app_version: String,
        /// Sample rate of the captured audio stream, in Hz.
        sample_rate: u32,
    },
    Pong {
        nonce: u64,
    },
    /// An FFT frame. Magnitudes are normalized to 0..1 (approximately — we
    /// cap at 1.0 but rare peaks beyond are clipped, not rescaled).
    #[serde(rename = "audio/fft")]
    Fft(FftFrame),
    #[serde(rename = "audio/level")]
    Level(LevelFrame),
    #[serde(rename = "audio/beat")]
    Beat(BeatEvent),
    #[serde(rename = "audio/bpm")]
    Bpm(BpmEstimate),
    #[serde(rename = "audio/silence")]
    Silence(SilenceEvent),
    #[serde(rename = "viz/settings")]
    VizSettings(VizSettings),
    #[serde(rename = "system/heartbeat")]
    Heartbeat(Heartbeat),
    /// Subscription error — e.g. requested topic not yet implemented. Clients
    /// should treat this as a hint, not a fatal condition.
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FftFrame {
    /// Size of the band vector (64 or 512 currently).
    pub bins: u32,
    /// Monotonic frame counter for drop detection.
    pub seq: u64,
    /// Unix ms of the sample window midpoint.
    pub t_ms: u64,
    /// Magnitudes 0..1, length = bins.
    pub bands: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelFrame {
    pub seq: u64,
    pub t_ms: u64,
    /// Linear RMS, 0..1.
    pub rms: f32,
    /// Linear peak, 0..1.
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatEvent {
    pub seq: u64,
    pub t_ms: u64,
    /// Confidence 0..1.
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SilenceEvent {
    pub seq: u64,
    pub t_ms: u64,
    /// True when the stream just went silent; false when it just came
    /// back. Edge-triggered — no per-frame spam.
    pub silent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BpmEstimate {
    pub t_ms: u64,
    pub bpm: f32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub t_ms: u64,
    /// Active subscriber count across all topics.
    pub subscribers: u32,
    /// Running since this unix ms.
    pub uptime_since_ms: u64,
}

/// Live visualizer tuning — mirror of the companion's VizSettings. Values
/// arrive camelCase over the wire so JS consumers don't need to translate.
/// All fields match their TypeScript counterparts in
/// `frontend/src/lib/viz-settings.ts` both in name and semantics.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VizSettings {
    /// Pre-butterchurn spectrum multiplier. 1.0 = pass-through.
    pub audio_gain: f32,
    /// Fast-attack envelope alpha per band, 0..1.
    pub attack: f32,
    /// Slow-release envelope alpha per band, 0..1.
    pub release: f32,
    /// Linear bass/treble tilt. -1 = bass, +1 = treble, 0 = flat.
    pub spectrum_tilt: f32,
    /// Bands below this magnitude are zeroed before butterchurn sees them.
    pub noise_gate: f32,
    /// Seconds between auto-cycle preset swaps (when shuffle is on).
    pub auto_cycle_seconds: u32,
    /// Cross-fade duration when switching presets, seconds. 0 = hard cut.
    pub blend_time: f32,
}

impl Default for VizSettings {
    fn default() -> Self {
        Self {
            audio_gain: 1.0,
            attack: 0.55,
            release: 0.12,
            spectrum_tilt: 0.0,
            noise_gate: 0.0,
            auto_cycle_seconds: 30,
            blend_time: 2.0,
        }
    }
}
