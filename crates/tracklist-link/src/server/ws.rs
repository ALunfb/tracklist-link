//! Per-connection WebSocket handler.
//!
//! We accept the TCP stream, peek enough of the HTTP request to extract
//! Origin / Host / `token` query param, validate all three, then complete
//! the WebSocket upgrade via `tokio-tungstenite::accept_async`.
//!
//! Once upgraded, we serve the pub/sub protocol: a client sends
//! `Subscribe` / `Unsubscribe` / `Ping`, the server fans `AudioFrame`s
//! from the broadcast bus to whichever topics the client has subscribed
//! to.

use super::{auth, origin};
use crate::audio::AudioFrame;
use crate::config::Config;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};
use tracklist_link_proto::{
    BeatEvent, ClientMessage, FftFrame, Heartbeat, LevelFrame, ServerMessage, SilenceEvent,
    Topic, VizPreset, VizSettings, PROTOCOL_VERSION,
};

pub async fn handle(
    stream: TcpStream,
    cfg: Arc<Config>,
    bus: broadcast::Sender<AudioFrame>,
    viz_settings: Arc<RwLock<VizSettings>>,
    viz_preset: Arc<RwLock<VizPreset>>,
) -> Result<()> {
    // We need to validate headers BEFORE the WS upgrade completes, and
    // tungstenite's `accept_hdr_async` callback lets us do exactly that:
    // return a non-101 response to short-circuit.
    let cfg_hdrs = cfg.clone();
    let token_check_failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = token_check_failed.clone();

    let ws_stream = tokio_tungstenite::accept_hdr_async(
        stream,
        move |req: &Request, response: Response| -> Result<Response, http::Response<Option<String>>> {
            let headers = req.headers();
            let host = headers
                .get(http::header::HOST)
                .and_then(|v| v.to_str().ok());
            let origin = headers
                .get(http::header::ORIGIN)
                .and_then(|v| v.to_str().ok());
            let token = extract_token(req.uri().query());

            if !origin::check_host(cfg_hdrs.port, host) {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                return Err(http_err(http::StatusCode::FORBIDDEN, "bad host"));
            }
            if !origin::check_origin(&cfg_hdrs.allowed_origins, origin) {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                return Err(http_err(http::StatusCode::FORBIDDEN, "origin not allowed"));
            }
            if !auth::check_token(&cfg_hdrs.token, token.as_deref()) {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                return Err(http_err(http::StatusCode::UNAUTHORIZED, "bad token"));
            }

            Ok(response)
        },
    )
    .await
    .context("ws handshake")?;

    if token_check_failed.load(std::sync::atomic::Ordering::SeqCst) {
        // Defensive — shouldn't reach this after the callback returned Err
        // but belt-and-braces.
        return Ok(());
    }

    let (mut tx, mut rx) = ws_stream.split();

    // Send Hello immediately so the client can verify protocol version.
    let hello = serde_json::to_string(&ServerMessage::Hello {
        v: PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        sample_rate: cfg.sample_rate,
    })?;
    tx.send(Message::Text(hello)).await?;

    // Send the current VizSettings snapshot right after Hello so freshly-
    // connected clients (e.g. the web /visualizer in OBS) mirror the Tune
    // panel's current state without waiting for the streamer to nudge a
    // slider. Sent unconditionally — Topic::VizSettings is a "config"
    // channel rather than a high-frequency stream, so there's no reason
    // to gate it on subscription.
    let snapshot = *viz_settings.read().unwrap();
    let viz_msg = serde_json::to_string(&ServerMessage::VizSettings(snapshot))?;
    tx.send(Message::Text(viz_msg)).await?;

    // Same snapshot pattern for the current preset — so a newly-opened
    // OBS Browser Source loads the right preset immediately rather than
    // cycling to something random and waiting for the companion's next
    // broadcast. Empty name = companion hasn't loaded any preset yet;
    // clients should keep their current visual in that case.
    let preset_snapshot = viz_preset.read().unwrap().clone();
    if !preset_snapshot.name.is_empty() {
        let preset_msg =
            serde_json::to_string(&ServerMessage::VizPreset(preset_snapshot))?;
        tx.send(Message::Text(preset_msg)).await?;
    }

    // Per-connection subscription set.
    let mut subs: HashSet<Topic> = HashSet::new();
    let mut bus_rx = bus.subscribe();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(2));
    let start = now_ms();

    loop {
        tokio::select! {
            // Inbound client messages.
            msg = rx.next() => {
                let Some(msg) = msg else { break; };
                let msg = match msg {
                    Ok(m) => m,
                    Err(err) => { debug!(?err, "ws read error"); break; }
                };
                match msg {
                    Message::Text(t) => {
                        match serde_json::from_str::<ClientMessage>(&t) {
                            Ok(ClientMessage::Subscribe { topics }) => {
                                for tp in topics { subs.insert(tp); }
                            }
                            Ok(ClientMessage::Unsubscribe { topics }) => {
                                for tp in topics { subs.remove(&tp); }
                            }
                            Ok(ClientMessage::Ping { nonce }) => {
                                let out = serde_json::to_string(&ServerMessage::Pong { nonce })?;
                                tx.send(Message::Text(out)).await?;
                            }
                            Err(err) => {
                                warn!(?err, "malformed client message");
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }

            // Outbound frames from the audio bus.
            frame = bus_rx.recv() => {
                match frame {
                    Ok(AudioFrame::Fft64 { seq, t_ms, bands }) if subs.contains(&Topic::AudioFft64) => {
                        let msg = ServerMessage::Fft(FftFrame { bins: 64, seq, t_ms, bands });
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(AudioFrame::Level { seq, t_ms, rms, peak }) if subs.contains(&Topic::AudioLevel) => {
                        let msg = ServerMessage::Level(LevelFrame { seq, t_ms, rms, peak });
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(AudioFrame::Beat { seq, t_ms, confidence }) if subs.contains(&Topic::AudioBeat) => {
                        let msg = ServerMessage::Beat(BeatEvent { seq, t_ms, confidence });
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(AudioFrame::Silence { seq, t_ms, silent }) if subs.contains(&Topic::AudioSilence) => {
                        let msg = ServerMessage::Silence(SilenceEvent { seq, t_ms, silent });
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    // VizSettings + VizPreset are always-on (like Heartbeat).
                    // Every change reaches every client regardless of subs.
                    Ok(AudioFrame::VizSettings(settings)) => {
                        let msg = ServerMessage::VizSettings(settings);
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(AudioFrame::VizPreset(preset)) => {
                        let msg = ServerMessage::VizPreset(preset);
                        tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                    }
                    Ok(_) => { /* not subscribed — drop */ }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Client was slow. Seq counter lets them detect it.
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }

            // Periodic heartbeat keeps the connection warm + lets clients
            // monitor liveness faster than TCP keepalive.
            _ = heartbeat.tick() => {
                let msg = ServerMessage::Heartbeat(Heartbeat {
                    t_ms: now_ms(),
                    subscribers: bus.receiver_count() as u32,
                    uptime_since_ms: start,
                });
                tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
            }
        }
    }

    Ok(())
}

fn extract_token(query: Option<&str>) -> Option<String> {
    let q = query?;
    for pair in q.split('&') {
        let mut kv = pair.splitn(2, '=');
        if let (Some("token"), Some(v)) = (kv.next(), kv.next()) {
            return Some(v.to_string());
        }
    }
    None
}

fn http_err(status: http::StatusCode, body: &str) -> http::Response<Option<String>> {
    http::Response::builder()
        .status(status)
        .body(Some(body.to_string()))
        .expect("static response")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
