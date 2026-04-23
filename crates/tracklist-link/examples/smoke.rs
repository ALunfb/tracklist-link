//! Smoke test for the running companion.
//!
//! Connects to `ws://127.0.0.1:<port>/ws?token=<token>` with a valid Origin
//! header, subscribes to `audio/fft/64` + `audio/level`, prints the first
//! few frames, then exits.
//!
//! Run with:
//!     cargo run --release --example smoke
//!
//! Picks up the port + token from the same config file the binary reads, so
//! no manual setup is required after the companion has run once.
//!
//! Prerequisite: the `tracklist-link` binary must already be running (it
//! owns the audio capture + TCP listener).

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

#[derive(serde::Deserialize)]
struct LiteConfig {
    port: u16,
    token: String,
}

fn config_path() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("gg", "blackpearl", "tracklist-link")
        .context("resolve ProjectDirs")?;
    Ok(dirs.config_dir().join("config.toml"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let path = config_path()?;
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let cfg: LiteConfig = toml::from_str(&raw)?;

    let url = format!("ws://127.0.0.1:{}/ws?token={}", cfg.port, cfg.token);
    let mut req = url.clone().into_client_request()?;
    req.headers_mut().insert(
        "Origin",
        "http://localhost:3000".parse().expect("origin literal"),
    );
    // Host header is set by tungstenite automatically from the URL authority.

    eprintln!("connecting to {url}");
    let (mut ws, resp) = connect_async(req).await.context("connect")?;
    eprintln!("connected (status {})", resp.status());

    // Subscribe to both topics.
    let sub = serde_json::json!({
        "kind": "subscribe",
        "topics": ["audio/fft/64", "audio/level"],
    });
    ws.send(Message::Text(sub.to_string())).await?;
    eprintln!("subscribed to audio/fft/64 + audio/level");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    let mut fft_frames = 0usize;
    let mut level_frames = 0usize;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Some(msg) = tokio::time::timeout(remaining, ws.next()).await.ok().flatten() else {
            break;
        };
        let msg = msg?;
        let Message::Text(text) = msg else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let kind = val.get("kind").and_then(|k| k.as_str()).unwrap_or("?");
        match kind {
            "hello" => eprintln!("hello: {text}"),
            "system/heartbeat" => eprintln!(
                "heartbeat subs={} uptime_ms={}",
                val.get("subscribers").and_then(|v| v.as_u64()).unwrap_or(0),
                val.get("uptime_since_ms").and_then(|v| v.as_u64()).unwrap_or(0),
            ),
            "audio/fft" => {
                fft_frames += 1;
                if fft_frames <= 3 {
                    let bands = val.get("bands").and_then(|b| b.as_array());
                    let len = bands.map(|a| a.len()).unwrap_or(0);
                    let peak = bands
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_f64())
                                .fold(0f64, f64::max)
                        })
                        .unwrap_or(0.0);
                    let seq = val.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                    eprintln!(
                        "fft #{fft_frames} seq={seq} bands={len} peak_band={:.3}",
                        peak
                    );
                }
            }
            "audio/level" => {
                level_frames += 1;
                if level_frames <= 3 {
                    let rms = val.get("rms").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let peak = val.get("peak").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    eprintln!("level #{level_frames} rms={rms:.4} peak={peak:.4}");
                }
            }
            other => eprintln!("other: {other} · {text}"),
        }
    }

    eprintln!("---");
    eprintln!("fft frames received:   {fft_frames}");
    eprintln!("level frames received: {level_frames}");
    if fft_frames == 0 {
        eprintln!("WARN: zero FFT frames — expected ~20-40 per second");
    }
    ws.close(None).await.ok();
    Ok(())
}
