//! Tracklist Link — local audio companion.
//!
//! Captures the default system audio output on Windows via WASAPI loopback,
//! runs an FFT pipeline, and serves the results over a localhost WebSocket
//! to audio-reactive clients (overlays, visualizers, etc).
//!
//! Architecture:
//!   - Main thread runs the tray + winit event loop (Windows requires the
//!     system-tray message pump on the main thread).
//!   - A background thread owns the tokio runtime, which drives the WS
//!     server. Audio capture uses its own std::thread for the cpal
//!     callback and pushes into the tokio broadcast bus from there.
//!
//! Security: binds 127.0.0.1 only, validates Origin + Host + token on
//! every WS upgrade, never makes outbound calls. See SECURITY.md.

mod audio;
mod config;
mod server;

#[cfg(windows)]
mod tray;

use anyhow::Result;
use std::sync::{Arc, Mutex};
use tracing::info;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tracklist_link=info,warn".into()),
        )
        .init();

    let cfg = Arc::new(Mutex::new(config::Config::load_or_create()?));
    {
        let guard = cfg.lock().unwrap();
        info!(
            bind = %guard.bind_addr(),
            sample_rate = guard.sample_rate,
            "tracklist-link starting"
        );
    }

    // Broadcast bus — audio thread → WS subscribers.
    let (bus_tx, _) = tokio::sync::broadcast::channel::<audio::AudioFrame>(64);

    // Audio capture spawns its own std::thread for the cpal callback.
    let sample_rate = cfg.lock().unwrap().sample_rate;
    audio::spawn_capture(sample_rate, bus_tx.clone())?;

    // Tokio runtime on a worker thread so the tray event loop can own
    // the main thread on Windows.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let server_cfg = cfg.clone();
    let server_bus = bus_tx.clone();
    std::thread::spawn(move || {
        let _ = rt.block_on(async move {
            let snapshot = server_cfg.lock().unwrap().clone();
            server::run(snapshot, server_bus).await
        });
    });

    #[cfg(windows)]
    {
        tray::run(cfg)?;
    }

    // Non-Windows: keep the main thread alive until interrupted. The MVP
    // targets Windows only, but letting `cargo check` succeed on Linux CI
    // is worth the two lines.
    #[cfg(not(windows))]
    {
        let _ = cfg;
        std::thread::park();
    }

    Ok(())
}
