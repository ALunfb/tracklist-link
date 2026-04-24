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
    /// DEPRECATED — v0.8.0 removed beat detection. Kept here so older
    /// web clients that still send `{"kind":"subscribe","topics":["audio/beat",…]}`
    /// don't error-out the whole subscribe message; the server silently
    /// never emits to this topic. Remove once cached old clients are
    /// past their refresh window (~1 week).
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
    /// Currently-active preset name. Broadcast whenever the companion
    /// loads a new preset (auto-cycle or manual pick). External clients
    /// mirror the selection so all visualizer instances (companion app,
    /// web `/visualizer`, OBS Browser Source) show the same preset.
    #[serde(rename = "viz/preset")]
    VizPreset,
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
    #[serde(rename = "audio/silence")]
    Silence(SilenceEvent),
    #[serde(rename = "viz/settings")]
    VizSettings(VizSettings),
    #[serde(rename = "viz/preset")]
    VizPreset(VizPreset),
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
pub struct SilenceEvent {
    pub seq: u64,
    pub t_ms: u64,
    /// True when the stream just went silent; false when it just came
    /// back. Edge-triggered — no per-frame spam.
    pub silent: bool,
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
    /// Bass boost, 0..1. Scales the bottom ~third of bands — 0 = flat,
    /// 1 = double the bass. Treble side was removed because it had
    /// little visible effect on butterchurn presets.
    pub bass_boost: f32,
    /// Seconds between auto-cycle preset swaps (when shuffle is on).
    pub auto_cycle_seconds: u32,
    /// Cross-fade duration when switching presets, seconds. 0 = hard cut.
    pub blend_time: f32,
}

impl Default for VizSettings {
    fn default() -> Self {
        Self {
            audio_gain: 1.0,
            bass_boost: 0.0,
            auto_cycle_seconds: 30,
            blend_time: 2.0,
        }
    }
}

/// Currently-active preset name. Empty string = no preset selected yet
/// (initial state before any load). External clients that recognize the
/// name load it; ones that don't (different preset pool version, etc.)
/// keep their current visual.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VizPreset {
    pub name: String,
}
