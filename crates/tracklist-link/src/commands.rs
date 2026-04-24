//! Tauri IPC commands exposed to the React frontend.
//!
//! Keep these thin — they're serde-serializable wrappers over the existing
//! `Config` + companion internals. Frontend code in `frontend/src/lib/tauri.ts`
//! calls them via `invoke("command_name", ...)`.

use crate::audio::AudioFrame;
use crate::config::Config;
use serde::Serialize;
use std::sync::{Arc, Mutex, RwLock};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::ShellExt;
use tokio::sync::broadcast;
use tracklist_link_proto::{VizPreset, VizSettings};

/// Injected into Tauri's managed state during setup so every command can
/// reach the single Config cell the capture thread + WS server also share,
/// plus the shared beat-sensitivity cell the audio thread reads every frame.
pub struct AppState {
    pub cfg: Arc<Mutex<Config>>,
    pub beat_sensitivity: Arc<RwLock<f32>>,
    /// Latest VizSettings pushed by the companion frontend. Held so newly
    /// connecting WS clients can get a snapshot immediately after Hello.
    pub viz_settings: Arc<RwLock<VizSettings>>,
    /// Currently-active preset name. Same snapshot-on-Hello pattern as
    /// viz_settings — lets freshly-connecting web clients load the right
    /// preset without waiting for the companion to cycle.
    pub viz_preset: Arc<RwLock<VizPreset>>,
    /// The audio broadcast bus — shared with capture/server for emitting
    /// viz/* changes as `AudioFrame::Viz*` to all subscribers.
    pub bus: broadcast::Sender<AudioFrame>,
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
    pub launch_minimized: bool,
    pub audio_device_name: Option<String>,
    pub beat_sensitivity: f32,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
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
        launch_minimized: cfg.launch_minimized,
        audio_device_name: cfg.audio_device_name.clone(),
        beat_sensitivity: cfg.beat_sensitivity,
    }
}

/// Live-push viz tuning to every connected WS client. Called by the
/// Tune panel whenever a slider moves (and once on mount with the
/// localStorage-restored starting values). Stores the latest snapshot
/// in AppState so new WS clients can pull it on Hello.
#[tauri::command]
pub fn set_viz_settings(
    state: tauri::State<'_, AppState>,
    settings: VizSettings,
) -> Result<(), String> {
    {
        let mut w = state.viz_settings.write().unwrap();
        *w = settings;
    }
    // Best-effort — if no one's subscribed, `send` returns an error
    // that's meaningless here (it just means the channel has no
    // receivers yet; when a client connects it'll read the snapshot
    // from AppState on Hello anyway).
    let _ = state.bus.send(AudioFrame::VizSettings(settings));
    Ok(())
}

/// Read the current VizSettings snapshot. Mostly a stub — the frontend
/// uses localStorage as its source of truth. Exposed so integration
/// tests + debugging have a way in.
#[tauri::command]
pub fn get_viz_settings(state: tauri::State<'_, AppState>) -> VizSettings {
    *state.viz_settings.read().unwrap()
}

/// Broadcast the currently-active preset name to all WS clients.
/// Invoked by the frontend after every `loadPreset` (auto-cycle or
/// manual pick). External visualizers use this to mirror the companion's
/// preset selection, keeping all visualizer instances on the same
/// preset across the stream.
#[tauri::command]
pub fn set_viz_preset(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let preset = VizPreset { name };
    {
        let mut w = state.viz_preset.write().unwrap();
        *w = preset.clone();
    }
    let _ = state.bus.send(AudioFrame::VizPreset(preset));
    Ok(())
}

/// Set the beat detector sensitivity live. Lower = more beats fire.
/// Persists to config and updates the Arc<RwLock> the capture thread
/// reads on every FFT frame, so the slider feels immediate.
#[tauri::command]
pub fn set_beat_sensitivity(
    state: tauri::State<'_, AppState>,
    value: f32,
) -> Result<(), String> {
    let clamped = value.clamp(0.3, 4.0);
    {
        let mut w = state.beat_sensitivity.write().unwrap();
        *w = clamped;
    }
    let mut cfg = state.cfg.lock().unwrap();
    cfg.beat_sensitivity = clamped;
    cfg.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Enumerate cpal output devices we can capture from. Called by the
/// Settings tab dropdown. Change applies on next app restart since the
/// capture thread doesn't yet support hot-swapping the device mid-flight.
#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    crate::audio::capture::list_output_devices()
        .into_iter()
        .map(|(name, is_default)| AudioDeviceInfo { name, is_default })
        .collect()
}

/// Save the preferred audio device name to config. `None` resets to the
/// system default. Takes effect on next app start.
#[tauri::command]
pub fn set_audio_device(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
) -> Result<(), String> {
    let mut cfg = state.cfg.lock().unwrap();
    cfg.audio_device_name = name;
    cfg.save().map_err(|e| e.to_string())?;
    Ok(())
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

/// Write a preset to the managed presets folder. Called by the frontend
/// after it has fetched the bytes from the user's install URL — putting
/// the actual write behind a Rust command keeps the path-traversal
/// validation in one place and out of JS.
#[tauri::command]
pub fn save_preset(filename: String, contents: String) -> Result<(), String> {
    if filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.is_empty()
        || filename.len() > 255
    {
        return Err("invalid filename".to_string());
    }
    // Extension allowlist — only recognized preset formats. Refuses an
    // attacker-crafted "preset.exe" even if the frontend guard is bypassed.
    let lower = filename.to_lowercase();
    let ext_ok = lower.ends_with(".json")
        || lower.ends_with(".milk")
        || lower.ends_with(".milk2")
        || lower.ends_with(".milk3");
    if !ext_ok {
        return Err("extension must be .json / .milk / .milk2 / .milk3".to_string());
    }
    // Size cap — biggest Butterchurn preset JSONs are ~40 KB; cap at 5 MB
    // so a hostile URL can't blow up the presets folder.
    if contents.len() > 5 * 1024 * 1024 {
        return Err("preset exceeds 5 MB limit".to_string());
    }
    // If it claims to be JSON, verify it parses. Avoids storing garbage
    // that will later blow up the visualizer at render time.
    if lower.ends_with(".json") {
        serde_json::from_str::<serde_json::Value>(&contents)
            .map_err(|e| format!("contents are not valid JSON: {e}"))?;
    }
    let dir = ensure_presets_dir()?;
    let path = dir.join(&filename);
    // Canonicalize dir to guard against symlink escapes. The file may not
    // yet exist (we're about to create it) so only the DIR is canonicalized.
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize dir: {e}"))?;
    if let Some(parent) = path.parent() {
        let canon_parent = std::fs::canonicalize(parent)
            .map_err(|e| format!("canonicalize parent: {e}"))?;
        if !canon_parent.starts_with(&canon_dir) {
            return Err("path escapes presets dir".to_string());
        }
    }
    std::fs::write(&path, contents).map_err(|e| format!("write preset: {e}"))?;
    Ok(())
}

/// Reads the current Run-key state via tauri-plugin-autostart. Returns
/// false if the manager isn't available (e.g., dev runs).
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    let manager = app.autolaunch();
    manager.is_enabled().map_err(|e| e.to_string())
}

/// Enable / disable the Windows Run-key entry that makes the companion
/// start on login. Requires no admin rights — writes under HKCU.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Persist the launch-minimized preference to config.toml. Does not apply
/// immediately — takes effect on next app start. Pairs naturally with
/// autostart so the companion launches silently in the tray.
#[tauri::command]
pub fn set_launch_minimized(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut cfg = state.cfg.lock().unwrap();
    cfg.launch_minimized = enabled;
    cfg.save().map_err(|e| e.to_string())?;
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
