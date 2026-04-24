//! FFT + log-band aggregation.
//!
//! Given a window of PCM samples, apply a Hann window, run a real FFT,
//! fold magnitudes into log-spaced frequency bins (30 Hz → 16 kHz across
//! 64 output bands), and normalize to a stable 0..1 range that clients
//! can drive into visualizers.
//!
//! Also emits a simple RMS + peak amplitude for the `audio/level` topic.
//!
//! Range choice: most music doesn't carry meaningful energy below 30 Hz
//! (sub-bass rumble / DC drift) or above 16 kHz (cymbal sizzle that most
//! speakers + consumer-grade mastering roll off). Tightening the band
//! range keeps the 64 available bands concentrated where audible content
//! actually lives, instead of wasting a quarter of them on silence.

use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

const OUTPUT_BANDS: usize = 64;
const FREQ_MIN: f32 = 30.0;
const FREQ_MAX: f32 = 16_000.0;

pub struct Processor {
    size: usize,
    sample_rate: u32,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    spectrum: Vec<realfft::num_complex::Complex<f32>>,
    /// Precomputed mapping: for each output band, the [start_bin, end_bin)
    /// range of raw FFT bins that get summed into it.
    band_ranges: Vec<(usize, usize)>,
    /// Smoothing state — previous output to blend with for temporal
    /// stability (roughly a 1-pole IIR with α≈0.6 on attack, α≈0.3 on
    /// release).
    prev: Vec<f32>,
}

impl Processor {
    pub fn new(size: usize, sample_rate: u32) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(size);
        let spectrum = fft.make_output_vec();
        let window = hann(size);
        let band_ranges = build_band_ranges(size, sample_rate, OUTPUT_BANDS);
        Self {
            size,
            sample_rate,
            fft,
            window,
            spectrum,
            band_ranges,
            prev: vec![0.0; OUTPUT_BANDS],
        }
    }

    /// Returns (bands, rms, peak). `samples` must equal the processor's
    /// configured window size.
    pub fn process(&mut self, samples: &[f32]) -> (Vec<f32>, f32, f32) {
        debug_assert_eq!(samples.len(), self.size);

        // Amplitude side — before windowing, so rms/peak are true levels.
        let mut sumsq = 0.0f32;
        let mut peak = 0.0f32;
        for &s in samples {
            sumsq += s * s;
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        let rms = (sumsq / self.size as f32).sqrt();

        // Window + FFT.
        let mut windowed = Vec::with_capacity(self.size);
        for i in 0..self.size {
            windowed.push(samples[i] * self.window[i]);
        }
        // realfft mutates its input slice; fine since we've already windowed.
        let _ = self
            .fft
            .process(&mut windowed, &mut self.spectrum);

        // Magnitude per FFT bin, then fold into log-spaced output bands.
        let mut bands = vec![0.0f32; OUTPUT_BANDS];
        for (b_idx, &(start, end)) in self.band_ranges.iter().enumerate() {
            let mut acc = 0.0f32;
            let mut n = 0u32;
            for s in &self.spectrum[start..end.min(self.spectrum.len())] {
                acc += (s.re * s.re + s.im * s.im).sqrt();
                n += 1;
            }
            if n > 0 {
                // Rough normalization — FFT magnitudes vary with window size;
                // divide by size/2 and apply a log-ish scale so soft content
                // is visible without loud content clipping hard.
                let mag = acc / n as f32;
                let norm = (mag / (self.size as f32 / 4.0)).sqrt();
                bands[b_idx] = norm.min(1.0);
            }
        }

        // Temporal smoothing: fast attack, slower release. Looks way more
        // "musical" than raw per-frame FFT output, which flickers heavily.
        for (i, v) in bands.iter_mut().enumerate() {
            let prev = self.prev[i];
            let k = if *v > prev { 0.6 } else { 0.3 };
            let next = prev + (*v - prev) * k;
            self.prev[i] = next;
            *v = next;
        }

        (bands, rms, peak.min(1.0))
    }
}

/// Hann window coefficients. Pre-computed once.
fn hann(n: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(n);
    let denom = (n - 1) as f32;
    for i in 0..n {
        let phase = 2.0 * std::f32::consts::PI * i as f32 / denom;
        out.push(0.5 - 0.5 * phase.cos());
    }
    out
}

/// Log-spaced band ranges. For a size-N FFT at sample_rate, the k-th raw
/// bin is at frequency k * sample_rate / N. We divide [FREQ_MIN..FREQ_MAX]
/// log-uniformly into `bands` sub-ranges and look up which raw bins land
/// in each.
fn build_band_ranges(size: usize, sample_rate: u32, bands: usize) -> Vec<(usize, usize)> {
    let bin_count = size / 2 + 1;
    let min_log = FREQ_MIN.ln();
    let max_log = FREQ_MAX.ln();
    let bin_hz = sample_rate as f32 / size as f32;
    let mut out = Vec::with_capacity(bands);
    for b in 0..bands {
        let lo_hz = (min_log + (max_log - min_log) * (b as f32 / bands as f32)).exp();
        let hi_hz = (min_log + (max_log - min_log) * ((b + 1) as f32 / bands as f32)).exp();
        let lo_bin = (lo_hz / bin_hz).floor() as usize;
        let hi_bin = ((hi_hz / bin_hz).ceil() as usize).min(bin_count);
        out.push((lo_bin.max(1), hi_bin.max(lo_bin + 1)));
    }
    out
}
