//! Tracklist Link — local audio companion.
//!
//! Tauri-based desktop app on Windows. Core responsibilities, each in its
//! own module:
//!
//!   - `audio`  — WASAPI loopback capture via cpal + 64-band FFT.
//!   - `server` — localhost WebSocket server that fans FFT/level frames out
//!                to subscribed overlays. Binds 127.0.0.1 only.
//!   - `config` — persisted config (port, per-install token, allowed
//!                origins) at `%APPDATA%\blackpearl\tracklist-link\`.
//!   - `commands` — Tauri IPC commands the React frontend invokes.
//!
//! Startup order: config is loaded first, the audio capture thread starts
//! pushing into a tokio broadcast channel, a dedicated tokio runtime runs
//! the WS server, and finally Tauri takes over the main thread for the
//! window + tray event loop.
//!
//! Security: binds 127.0.0.1 only, validates Origin + Host + token on
//! every WS upgrade, never makes outbound calls beyond URLs the user
//! clicks. See SECURITY.md.

// Prevent spawning the default console window on Windows release builds —
// the tray + main window are the UI; console output goes to stdout only
// when explicitly launched from a terminal.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio;
mod commands;
mod config;
mod server;

use anyhow::Result;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tracing::info;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tracklist_link=info,warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = Arc::new(Mutex::new(config::Config::load_or_create()?));
            {
                let guard = cfg.lock().unwrap();
                info!(
                    bind = %guard.bind_addr(),
                    sample_rate = guard.sample_rate,
                    "tracklist-link starting"
                );
            }

            // Audio capture pushes into a broadcast channel; the WS server
            // subscribes and fans out to each connected overlay.
            let (bus_tx, _) = tokio::sync::broadcast::channel::<audio::AudioFrame>(64);
            let sample_rate = cfg.lock().unwrap().sample_rate;
            audio::spawn_capture(sample_rate, bus_tx.clone())?;

            // WS server on its own tokio runtime so the UI's async work
            // doesn't share a scheduler with audio fan-out.
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

            // Share the Config cell with every IPC command.
            app.manage(commands::AppState { cfg });

            // Bridge: audio broadcast bus → Tauri events. Lets the React
            // frontend consume FFT + level frames without authing against
            // its own WS server (the WS is for external overlays).
            let app_handle = app.handle().clone();
            let mut ui_rx = bus_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match ui_rx.recv().await {
                        Ok(audio::AudioFrame::Fft64 { bands, seq, t_ms }) => {
                            let payload = serde_json::json!({
                                "seq": seq,
                                "t_ms": t_ms,
                                "bands": bands,
                            });
                            let _ = app_handle.emit("audio-fft-64", payload);
                        }
                        Ok(audio::AudioFrame::Level { rms, peak, seq, t_ms }) => {
                            let payload = serde_json::json!({
                                "seq": seq,
                                "t_ms": t_ms,
                                "rms": rms,
                                "peak": peak,
                            });
                            let _ = app_handle.emit("audio-level", payload);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            // UI fell behind — drop frames, keep going.
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // System tray — pair/copy/quit mirroring the pre-Tauri layout.
            setup_tray(app.handle())?;

            // Intercept window close → hide to tray. Keeps the companion
            // running when the streamer hits the X, matching how audio
            // apps (Discord, Spotify, etc.) behave. Quit via tray menu.
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_config,
            commands::regenerate_token,
            commands::open_pair_url,
            commands::copy_token_to_clipboard,
            commands::open_config_folder,
            commands::list_presets,
            commands::read_preset,
            commands::open_presets_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tracklist Link");
}

fn setup_tray(app: &tauri::AppHandle) -> Result<()> {
    let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
    let pair = MenuItem::with_id(app, "pair", "Pair dashboard", true, None::<&str>)?;
    let copy_token = MenuItem::with_id(app, "copy-token", "Copy token", true, None::<&str>)?;
    let open_cfg = MenuItem::with_id(app, "open-config", "Open config folder", true, None::<&str>)?;
    let regen = MenuItem::with_id(app, "regen", "Regenerate token", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &pair,
            &copy_token,
            &open_cfg,
            &PredefinedMenuItem::separator(app)?,
            &regen,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // Synthesize a 32x32 RGBA icon at runtime. Saves us from shipping a
    // bundled .png asset for the MVP — swap for `include_bytes!(...)` once
    // we have a proper brand mark. The color matches the purple accent
    // used across the UI and the website so the tray visually ties back
    // to the rest of the Tracklist surface.
    let size = 32u32;
    let mut icon_bytes = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        // Accent purple (#a855f7) with full alpha.
        icon_bytes.extend_from_slice(&[0xa8, 0x55, 0xf7, 0xff]);
    }
    let icon = tauri::image::Image::new_owned(icon_bytes, size, size);

    let _tray = TrayIconBuilder::with_id("main")
        .tooltip("Tracklist Link")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "pair" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state: tauri::State<'_, commands::AppState> = handle.state();
                    if let Err(err) = commands::open_pair_url(handle.clone(), state).await {
                        tracing::warn!(%err, "tray pair failed");
                    }
                });
            }
            "copy-token" => {
                let state: tauri::State<'_, commands::AppState> = app.state();
                if let Err(err) = commands::copy_token_to_clipboard(app.clone(), state) {
                    tracing::warn!(%err, "tray copy token failed");
                }
            }
            "open-config" => {
                if let Err(err) = commands::open_config_folder(app.clone()) {
                    tracing::warn!(%err, "tray open config failed");
                }
            }
            "regen" => {
                let state: tauri::State<'_, commands::AppState> = app.state();
                if let Err(err) = commands::regenerate_token(state) {
                    tracing::warn!(%err, "tray regen failed");
                }
            }
            "quit" => {
                tracing::info!("quit from tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the main window — matches Discord/Slack.
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
