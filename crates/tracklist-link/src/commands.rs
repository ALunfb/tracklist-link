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

#[derive(Debug, Serialize, Clone)]
pub struct PresetEntry {
    pub name: String,
    /// Path component only — no directories, so the frontend can't ask
    /// for arbitrary filesystem reads (belt-and-braces on top of the
    /// `presets_dir()` containment).
    pub filename: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub kind: String,
}

/// Ensure the presets dir exists and return its path. Called by every
/// preset command so the streamer's first interaction doesn't fail with
/// "directory not found."
fn ensure_presets_dir() -> Result<std::path::PathBuf, String> {
    let base = crate::config::config_dir().map_err(|e| e.to_string())?;
    let dir = base.join("presets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create presets dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn list_presets() -> Result<Vec<PresetEntry>, String> {
    let dir = ensure_presets_dir()?;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Support both common MilkDrop extensions. Skip everything else
        // so a stray .txt / thumbs.db doesn't crowd the list.
        let kind = match path.extension().and_then(|e| e.to_str()) {
            Some("milk") => "milk2",
            Some("milk2") => "milk2",
            Some("milk3") => "milk3",
            Some("json") => "butterchurn",
            _ => continue,
        }
        .to_string();
        let meta = entry.metadata().map_err(|e| format!("metadata: {e}"))?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let name = filename
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| filename.clone());
        out.push(PresetEntry {
            name,
            filename,
            size_bytes: meta.len(),
            modified_ms,
            kind,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn read_preset(filename: String) -> Result<String, String> {
    // Path-traversal guard: only accept a bare filename. No slashes, no
    // dotdot. This is stricter than join()ing which would still leak a
    // read capability if the bytes happened to normalize outside the dir.
    if filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.is_empty()
    {
        return Err("invalid filename".to_string());
    }
    let dir = ensure_presets_dir()?;
    let path = dir.join(&filename);
    // Final belt-and-braces check: canonicalize both paths and confirm
    // the resolved path is still under the presets directory. Catches
    // any symlink chicanery that slipped past the string check.
    let canon_path = std::fs::canonicalize(&path).map_err(|e| format!("canonicalize: {e}"))?;
    let canon_dir = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize dir: {e}"))?;
    if !canon_path.starts_with(&canon_dir) {
        return Err("path escapes presets dir".to_string());
    }
    std::fs::read_to_string(&canon_path).map_err(|e| format!("read preset: {e}"))
}

#[tauri::command]
pub fn open_presets_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = ensure_presets_dir()?;
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
