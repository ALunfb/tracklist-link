//! Localhost WebSocket server.
//!
//! Single entrypoint. Accepts TCP connections on `127.0.0.1:<port>`, does a
//! manual HTTP/1.1 upgrade (to validate Origin + Host + token before
//! upgrading to a WebSocket), then hands off to the per-connection handler.

pub mod auth;
pub mod origin;
pub mod ws;

use crate::audio::AudioFrame;
use crate::config::Config;
use anyhow::Result;
use std::sync::{Arc, Mutex, RwLock};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tracing::{info, warn};
use tracklist_link_proto::{VizPreset, VizSettings};

/// Run the WebSocket server.
///
/// `cfg` is shared with the Tauri commands (`AppState.cfg`) — we hold an
/// `Arc<Mutex<Config>>` here so that token regeneration via the UI takes
/// effect for *new* connections without restarting the app. Earlier
/// versions cloned the config out at startup, which left the WS auth
/// validating against a stale token after every regen.
pub async fn run(
    cfg: Arc<Mutex<Config>>,
    bus: broadcast::Sender<AudioFrame>,
    viz_settings: Arc<RwLock<VizSettings>>,
    viz_preset: Arc<RwLock<VizPreset>>,
) -> Result<()> {
    // Bind address (port) is read once at startup. Port changes still
    // require a restart — they'd require rebinding the listener which
    // is a bigger ceremony. Token + origin allowlist are read per
    // handshake (see ws::handle).
    let addr = cfg.lock().expect("config mutex poisoned").bind_addr();
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "ws server listening");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(ok) => ok,
            Err(err) => {
                warn!(?err, "accept failed");
                continue;
            }
        };
        // Sanity check: the listener is bound to localhost, but defense in
        // depth — every accepted peer must be loopback too. If the OS ever
        // betrays us (unlikely but cheap to check) we reject.
        if !peer.ip().is_loopback() {
            warn!(%peer, "non-loopback connection rejected");
            continue;
        }
        let cfg = cfg.clone();
        let bus = bus.clone();
        let viz_settings = viz_settings.clone();
        let viz_preset = viz_preset.clone();
        tokio::spawn(async move {
            if let Err(err) = ws::handle(stream, cfg, bus, viz_settings, viz_preset).await {
                warn!(?err, %peer, "ws handler exited with error");
            }
        });
    }
}
