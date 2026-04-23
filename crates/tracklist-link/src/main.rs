//! Tracklist Link — local audio companion.
//!
//! Captures the default system audio output on Windows via WASAPI loopback,
//! runs an FFT pipeline, and serves the results over a localhost WebSocket
//! to audio-reactive clients (overlays, visualizers, etc).
//!
//! Security: binds 127.0.0.1 only, validates Origin + Host + token on every
//! WS upgrade, never makes outbound calls in the hot path. See SECURITY.md
//! at the repo root for the full threat model.

mod audio;
mod config;
mod server;

// The tray + pairing UI lands in the next milestone. For MVP the companion
// runs headless and the user pastes the token into the Tracklist dashboard
// manually (the token is in the config.toml next to the binary).

use anyhow::Result;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tracklist_link=info,warn".into()),
        )
        .init();

    let cfg = config::Config::load_or_create()?;
    info!(
        bind = %cfg.bind_addr(),
        sample_rate = cfg.sample_rate,
        "tracklist-link starting"
    );

    // Fan-out channel from the audio thread to all WS subscribers. The audio
    // capture task pushes FFT + level frames; the WS server fans them to
    // clients that have subscribed to the matching topic.
    let (bus_tx, _) = tokio::sync::broadcast::channel::<audio::AudioFrame>(64);

    // Spawn the audio pipeline on a blocking thread — cpal callbacks are
    // synchronous and we don't want to hold up the tokio runtime.
    audio::spawn_capture(cfg.sample_rate, bus_tx.clone())?;

    // Start the WS server. Runs for the life of the process.
    server::run(cfg.clone(), bus_tx).await?;

    Ok(())
}
