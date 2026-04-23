//! Tauri IPC commands exposed to the React frontend.
//!
//! Keep these thin — they're serde-serializable wrappers over the existing
//! `Config` + companion internals. Frontend code in `frontend/src/lib/tauri.ts`
//! calls them via `invoke("command_name", ...)`.

use crate::config::Config;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::ShellExt;

/// Injected into Tauri's managed state during setup so every command can
/// reach the single Config cell the capture thread + WS server also share.
pub struct AppState {
    pub cfg: Arc<Mutex<Config>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct StatusView {
    pub app_version: String,
    pub port: u16,
    pub sample_rate: u32,
    pub bind_addr: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConfigView {
    pub port: u16,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub sample_rate: u32,
}

#[tauri::command]
pub fn get_status(state: tauri::State<'_, AppState>) -> StatusView {
    let cfg = state.cfg.lock().unwrap();
    StatusView {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        port: cfg.port,
        sample_rate: cfg.sample_rate,
        bind_addr: cfg.bind_addr().to_string(),
    }
}

#[tauri::command]
pub fn get_config(state: tauri::State<'_, AppState>) -> ConfigView {
    let cfg = state.cfg.lock().unwrap();
    ConfigView {
        port: cfg.port,
        token: cfg.token.clone(),
        allowed_origins: cfg.allowed_origins.clone(),
        sample_rate: cfg.sample_rate,
    }
}

#[tauri::command]
pub fn regenerate_token(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let mut guard = state.cfg.lock().unwrap();
    let rotated = Config::rotate_token(guard.clone()).map_err(|e| e.to_string())?;
    *guard = rotated;
    guard.save().map_err(|e| e.to_string())?;
    tracing::info!("token regenerated via UI");
    Ok(guard.token.clone())
}

#[tauri::command]
pub async fn open_pair_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (token, port) = {
        let cfg = state.cfg.lock().unwrap();
        (cfg.token.clone(), cfg.port)
    };
    // Same shape the tray uses: fragment keeps the token off the wire.
    let url = format!(
        "https://music.blackpearl.gg/dashboard#pair=1&token={}&port={}",
        url_fragment_encode(&token),
        port,
    );
    app.shell()
        .open(&url, None)
        .map_err(|e| e.to_string())?;
    Ok(url)
}

#[tauri::command]
pub fn copy_token_to_clipboard(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let token = state.cfg.lock().unwrap().token.clone();
    // `clip.exe` ships with every Windows install. Matches what the tray
    // action used so there's one clipboard code path.
    use std::io::Write;
    let mut child = std::process::Command::new("clip")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn clip.exe: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "clip stdin".to_string())?
        .write_all(token.as_bytes())
        .map_err(|e| format!("write clip: {e}"))?;
    child.wait().map_err(|e| format!("clip wait: {e}"))?;
    let _ = app; // reserved for future: toast notification
    Ok(())
}

#[tauri::command]
pub fn open_config_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::config::config_dir().map_err(|e| e.to_string())?;
    app.shell()
        .open(dir.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Percent-encode everything outside the URL-safe set. Mirrors the
/// implementation in `tray.rs` so both surfaces produce identical URLs.
fn url_fragment_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
