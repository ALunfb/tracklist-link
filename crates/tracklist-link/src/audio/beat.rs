//! Energy-based beat detector.
//!
//! Looks at the low-frequency bands (bass + low-mid, roughly 40-250 Hz given
//! the 64-band log layout) and fires a beat event when their sum spikes
//! significantly above the recent running average. Cheap (~100 adds +
//! 1 sqrt per frame), deterministic, good-enough-for-visuals quality.
//!
//! Not a full onset-detection algorithm — it won't distinguish kick from
//! snare, and it'll double-fire on reverb tails with aggressive settings.
//! For the visualizer / overlay use case that's fine; for music-production
//! accuracy a proper spectral-flux detector would live here instead.
//!
//! The detector is intentionally a plain struct with a single `push` entry
//! point — it can be swapped later for a more elaborate algorithm without
//! touching the capture thread or the broadcast wiring.

use std::collections::VecDeque;

/// How many FFT frames to keep in the rolling window for mean/variance.
/// At ~43 fps output, 64 frames ≈ 1.5 seconds — long enough to smooth
/// tempo changes but short enough to adapt to song transitions.
const HISTORY: usize = 64;

/// Minimum time between consecutive beats, ms. 180ms → 333 BPM ceiling,
/// which is above every realistic music tempo and defeats the double-
/// trigger on a kick's decay tail.
const MIN_BEAT_GAP_MS: u64 = 180;

/// How many of the lowest FFT bands to sum for the "energy" signal. With
/// the 64-band log layout covering 20 Hz → 20 kHz, the bottom 8 bands
/// catch roughly the kick + bass-guitar region (~20-250 Hz).
const BASS_BANDS: usize = 8;

/// Default multiplier on the rolling standard deviation. Higher = fewer
/// and stronger beats detected; lower = more permissive. 1.6 is the
/// initial value in casual testing; user-tunable via the Tune panel to
/// compensate for low-volume streams (Spotify at 20% with voice chat
/// produces quieter bass than the default assumes).
pub const DEFAULT_SENSITIVITY: f32 = 1.6;

pub struct BeatDetector {
    history: VecDeque<f32>,
    last_beat_ms: u64,
    seq: u64,
}

impl BeatDetector {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(HISTORY),
            last_beat_ms: 0,
            seq: 0,
        }
    }

    /// Push a new FFT frame. Returns `Some(BeatHit)` when this frame
    /// crosses the beat threshold. `sensitivity` is a runtime-tunable
    /// multiplier on the rolling stddev (see DEFAULT_SENSITIVITY).
    pub fn push(&mut self, bands: &[f32], t_ms: u64, sensitivity: f32) -> Option<BeatHit> {
        let bass = bass_energy(bands);

        // Warm-up: let history fill before we fire anything. Prevents a
        // cold-start spurious beat on the very first loud frame.
        if self.history.len() < HISTORY / 2 {
            self.history.push_back(bass);
            return None;
        }

        let (mean, std) = mean_std(&self.history);
        // Very quiet sections → very small std → any tiny wobble clears the
        // threshold. Floor the std so silence doesn't produce phantom beats.
        let effective_std = std.max(0.01);
        let threshold = mean + sensitivity * effective_std;

        let fired = bass > threshold
            && t_ms.saturating_sub(self.last_beat_ms) > MIN_BEAT_GAP_MS;

        // Update history after the check so the current-frame energy isn't
        // in the baseline we just compared against.
        self.history.push_back(bass);
        if self.history.len() > HISTORY {
            self.history.pop_front();
        }

        if fired {
            self.last_beat_ms = t_ms;
            self.seq = self.seq.wrapping_add(1);
            // Confidence: clamp excess-over-threshold to a usable range.
            let excess = (bass - threshold) / effective_std;
            let confidence = (excess / 3.0).clamp(0.0, 1.0);
            Some(BeatHit {
                seq: self.seq,
                t_ms,
                confidence,
            })
        } else {
            None
        }
    }
}

impl Default for BeatDetector {
    fn default() -> Self {
        Self::new()
    }
}

pub struct BeatHit {
    pub seq: u64,
    pub t_ms: u64,
    pub confidence: f32,
}

fn bass_energy(bands: &[f32]) -> f32 {
    let n = bands.len().min(BASS_BANDS);
    let mut s = 0.0;
    for &b in &bands[..n] {
        s += b;
    }
    s
}

fn mean_std(h: &VecDeque<f32>) -> (f32, f32) {
    let n = h.len().max(1) as f32;
    let mut sum = 0.0;
    for &v in h {
        sum += v;
    }
    let mean = sum / n;
    let mut var = 0.0;
    for &v in h {
        let d = v - mean;
        var += d * d;
    }
    (mean, (var / n).sqrt())
}
