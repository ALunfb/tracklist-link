//! Silence detector — the second reactive-signal producer after beats.
//!
//! Watches the RMS level and emits a state-change event when the stream
//! crosses the silence threshold for longer than a debounce window.
//! Enables "auto-pause viz when the streamer goes quiet," "switch OBS
//! scene after 30 s of dead air" (future feature), and the general
//! heuristic that powers ducking-adjacent effects.
//!
//! Two emissions per transition — one on silence onset, one on silence
//! end — so consumers can react to both edges with a single topic.

use std::collections::VecDeque;

/// Default RMS threshold. Below this the detector starts counting
/// "silent frames." 0.02 roughly corresponds to the noise floor of
/// a muted Spotify output under a typical streamer's mic chatter —
/// anything quieter is almost certainly no music.
pub const DEFAULT_SILENCE_RMS: f32 = 0.02;

/// How long the RMS has to stay below threshold before we declare
/// silence. Shorter = triggers on every song gap; longer = misses
/// real silences. 1.5 s is the usual MilkDrop silence_detect default.
const ENTER_MS: u64 = 1500;

/// How long RMS has to stay above threshold before we clear silence.
/// Shorter than ENTER_MS so a single kick on an empty passage
/// immediately "wakes" the consumer.
const EXIT_MS: u64 = 250;

/// Rolling RMS window for hysteresis. At ~43 fps we keep ~250 ms of
/// history and check whether the MAX in that window exceeded the
/// threshold — defeats single-sample transients.
const HYSTERESIS_FRAMES: usize = 12;

pub struct SilenceDetector {
    /// True once we've declared silence. State changes produce an event.
    in_silence: bool,
    /// Time (ms) when the current streak of below-threshold frames
    /// began. 0 means no streak active.
    below_since: u64,
    /// Time when the current streak of above-threshold frames began.
    above_since: u64,
    /// Rolling history of recent RMS values for hysteresis.
    history: VecDeque<f32>,
    seq: u64,
}

pub enum SilenceEvent {
    /// RMS just dropped below threshold for long enough.
    Entered { seq: u64, t_ms: u64 },
    /// RMS just rose above threshold after being in silence.
    Exited { seq: u64, t_ms: u64 },
}

impl SilenceDetector {
    pub fn new() -> Self {
        Self {
            in_silence: false,
            below_since: 0,
            above_since: 0,
            history: VecDeque::with_capacity(HYSTERESIS_FRAMES),
            seq: 0,
        }
    }

    /// Ingest an RMS frame. Returns a state-change event when the
    /// detector crosses into or out of silence; None otherwise.
    pub fn push(&mut self, rms: f32, t_ms: u64, threshold: f32) -> Option<SilenceEvent> {
        self.history.push_back(rms);
        if self.history.len() > HYSTERESIS_FRAMES {
            self.history.pop_front();
        }
        // Hysteresis: a frame is "loud" if ANY of the recent history
        // exceeded the threshold. That way a single dropout mid-song
        // doesn't trigger silence, and a single beat mid-silence does
        // wake us.
        let recent_max = self
            .history
            .iter()
            .copied()
            .fold(0.0f32, |a, b| a.max(b));
        let effectively_loud = recent_max > threshold;
        let effectively_quiet = !effectively_loud;

        if effectively_quiet {
            if self.below_since == 0 {
                self.below_since = t_ms;
            }
            self.above_since = 0;
            if !self.in_silence && t_ms.saturating_sub(self.below_since) >= ENTER_MS {
                self.in_silence = true;
                self.seq = self.seq.wrapping_add(1);
                return Some(SilenceEvent::Entered {
                    seq: self.seq,
                    t_ms,
                });
            }
        } else {
            if self.above_since == 0 {
                self.above_since = t_ms;
            }
            self.below_since = 0;
            if self.in_silence && t_ms.saturating_sub(self.above_since) >= EXIT_MS {
                self.in_silence = false;
                self.seq = self.seq.wrapping_add(1);
                return Some(SilenceEvent::Exited {
                    seq: self.seq,
                    t_ms,
                });
            }
        }
        None
    }
}

impl Default for SilenceDetector {
    fn default() -> Self {
        Self::new()
    }
}
