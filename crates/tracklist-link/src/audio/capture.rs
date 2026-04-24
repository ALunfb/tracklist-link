//! WASAPI loopback capture via cpal.
//!
//! On Windows, cpal's default input host exposes a loopback mode when you
//! open the default OUTPUT device as an input. That's what we do here —
//! we read the same audio the speakers are playing, never the microphone.
//!
//! The capture callback is called by the audio driver at the device's
//! quantum (commonly 480 or 960 samples at 48kHz). We downmix to mono and
//! push into a ring buffer; the FFT task reads fixed-size windows from it.

use super::{beat, fft, AudioFrame};
use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::{info, warn};

/// FFT window size. 2048 @ 48kHz = ~42ms of audio per transform. Hop of
/// 1024 gives us ~23ms between frames = ~43 fps output rate.
const WINDOW_SIZE: usize = 2048;
const HOP_SIZE: usize = 1024;

/// Spawn the capture thread + FFT processor. Returns the stream handle so
/// the caller can keep it alive for the life of the program.
///
/// `device_name` — cpal device name to capture from, or None for the
/// system default. Devices are matched by exact name string; if the
/// named device has vanished (unplugged since last config save), we fall
/// back to default rather than failing startup.
///
/// `beat_sensitivity` — shared cell read by the beat detector on every
/// FFT frame. Writing it (from a Tauri command) changes detection
/// behavior live without restarting capture.
pub fn spawn_capture(
    device_name: Option<String>,
    sample_rate: u32,
    bus: broadcast::Sender<AudioFrame>,
    beat_sensitivity: Arc<std::sync::RwLock<f32>>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = resolve_output_device(&host, device_name.as_deref())
        .context("no output device available")?;
    info!(device = ?device.name(), "opening output device for loopback");

    // We want to capture what plays, at the requested rate if possible.
    let supported = device
        .default_output_config()
        .context("default output config")?;
    let channels = supported.channels() as usize;
    let actual_rate = supported.sample_rate().0;
    if actual_rate != sample_rate {
        warn!(
            requested = sample_rate,
            actual = actual_rate,
            "sample rate mismatch; using device default"
        );
    }

    let ring: Arc<Mutex<Ring>> = Arc::new(Mutex::new(Ring::with_capacity(WINDOW_SIZE * 8)));

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, channels, ring.clone()),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, channels, ring.clone()),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, channels, ring.clone()),
        other => anyhow::bail!("unsupported sample format: {:?}", other),
    }?;

    stream.play().context("starting audio stream")?;

    // The cpal stream is not Send, so we leak it to keep it alive. This is
    // acceptable for a long-lived daemon — the OS reclaims everything at exit.
    Box::leak(Box::new(stream));

    // FFT processor thread.
    let processor = fft::Processor::new(WINDOW_SIZE, actual_rate);
    std::thread::spawn(move || fft_loop(ring, processor, bus, beat_sensitivity));

    Ok(())
}

fn build_stream<T>(
    device: &cpal::Device,
    channels: usize,
    ring: Arc<Mutex<Ring>>,
) -> Result<cpal::Stream>
where
    T: cpal::Sample + cpal::SizedSample + ToF32 + 'static,
{
    let config = device.default_output_config()?.config();
    let stream = device.build_input_stream(
        &config,
        move |data: &[T], _| {
            // Downmix to mono by averaging channels. For stereo music this
            // is fine; for surround we'd want an appropriate downmix.
            let mut r = ring.lock().unwrap();
            for frame in data.chunks_exact(channels) {
                let mut sum = 0.0f32;
                for s in frame {
                    sum += s.to_f32();
                }
                r.push(sum / channels as f32);
            }
        },
        |err| warn!(?err, "audio stream error"),
        None,
    )?;
    Ok(stream)
}

fn fft_loop(
    ring: Arc<Mutex<Ring>>,
    mut processor: fft::Processor,
    bus: broadcast::Sender<AudioFrame>,
    beat_sensitivity: Arc<std::sync::RwLock<f32>>,
) {
    let mut seq: u64 = 0;
    let mut scratch = vec![0.0f32; WINDOW_SIZE];
    let mut beat_detector = beat::BeatDetector::new();
    loop {
        // Block lightly while waiting for enough samples.
        {
            let r = ring.lock().unwrap();
            if r.len() < WINDOW_SIZE {
                drop(r);
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
        }

        {
            let mut r = ring.lock().unwrap();
            r.read_window(WINDOW_SIZE, HOP_SIZE, &mut scratch);
        }

        let t_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let (bands64, rms, peak) = processor.process(&scratch);
        seq += 1;

        // Beat detection runs on the same bands the FFT emits so the
        // timestamps line up for cross-topic correlation (e.g. a consumer
        // that wants "was the last beat within 100ms of this round_win?").
        // Sensitivity is re-read every frame so the Tune panel slider
        // applies instantly with no restart.
        let sensitivity = *beat_sensitivity
            .read()
            .unwrap_or_else(|p| p.into_inner());
        let beat_hit = beat_detector.push(&bands64, t_ms, sensitivity);

        // Best-effort broadcast — a slow client gets dropped frames, which
        // is fine. The seq counter lets them detect drops client-side.
        let _ = bus.send(AudioFrame::Fft64 {
            seq,
            t_ms,
            bands: bands64,
        });
        let _ = bus.send(AudioFrame::Level { seq, t_ms, rms, peak });
        if let Some(hit) = beat_hit {
            let _ = bus.send(AudioFrame::Beat {
                seq: hit.seq,
                t_ms: hit.t_ms,
                confidence: hit.confidence,
            });
        }
    }
}

/// A very simple ring buffer. Writer is the audio callback, reader is the
/// FFT thread. Both protected by a Mutex for MVP simplicity; a lock-free
/// SPSC ring is an easy upgrade if this ever hot-spots.
struct Ring {
    buf: Vec<f32>,
    /// Total samples written since start.
    written: usize,
    /// Total samples the reader has "consumed" (for hop tracking).
    read: usize,
    /// Capacity — fixed.
    cap: usize,
}

impl Ring {
    fn with_capacity(cap: usize) -> Self {
        Self {
            buf: vec![0.0; cap],
            written: 0,
            read: 0,
            cap,
        }
    }
    fn push(&mut self, s: f32) {
        let idx = self.written % self.cap;
        self.buf[idx] = s;
        self.written += 1;
    }
    fn len(&self) -> usize {
        self.written.saturating_sub(self.read)
    }
    /// Copy the most recent `window` samples into `out`, then advance the
    /// read pointer by `hop` so the next call reads an overlapping window.
    fn read_window(&mut self, window: usize, hop: usize, out: &mut [f32]) {
        let start = self.written.saturating_sub(window);
        for i in 0..window {
            let idx = (start + i) % self.cap;
            out[i] = self.buf[idx];
        }
        self.read = self.read.saturating_add(hop);
    }
}

/// Find the cpal output device matching `preferred_name`, or fall back
/// to the system default. Fallback is deliberate — a device can vanish
/// between runs (USB unplug, Bluetooth disconnect), and the user would
/// rather have audio from "something" than a hard startup failure.
fn resolve_output_device(
    host: &cpal::Host,
    preferred_name: Option<&str>,
) -> Option<cpal::Device> {
    if let Some(name) = preferred_name {
        if let Ok(devices) = host.output_devices() {
            for d in devices {
                if d.name().ok().as_deref() == Some(name) {
                    return Some(d);
                }
            }
        }
        tracing::warn!(
            preferred = name,
            "preferred audio device not found; falling back to default"
        );
    }
    host.default_output_device()
}

/// Enumerate every cpal output device we can capture from. Used by the
/// Settings tab dropdown. Shapes as (name, is_current_default).
pub fn list_output_devices() -> Vec<(String, bool)> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok());
    let Ok(devices) = host.output_devices() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for d in devices {
        if let Ok(name) = d.name() {
            let is_default = default_name.as_deref() == Some(name.as_str());
            out.push((name, is_default));
        }
    }
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    out
}

/// Thin trait so we can share the capture body across sample formats.
trait ToF32 {
    fn to_f32(self) -> f32;
}
impl ToF32 for f32 {
    fn to_f32(self) -> f32 {
        self
    }
}
impl ToF32 for i16 {
    fn to_f32(self) -> f32 {
        self as f32 / i16::MAX as f32
    }
}
impl ToF32 for u16 {
    fn to_f32(self) -> f32 {
        (self as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)
    }
}
