//! On-disk config + first-run token generation.
//!
//! The config file lives at `%APPDATA%/tracklist-link/config.toml`. On first
//! run we generate a 32-byte secret token, base64-encode it, and write it
//! to the config. The user can rotate via tray menu — this regenerates and
//! forces existing clients to re-pair.
//!
//! Defaults are deliberately conservative: localhost-only bind, a single
//! known origin allowed (the Tracklist site), auto-start off until the user
//! opts in.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use directories::ProjectDirs;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;

const DEFAULT_PORT: u16 = 38475;
const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Localhost port the WS server binds to.
    pub port: u16,
    /// Base64(url-safe, no padding) of the 32-byte per-install secret.
    /// Clients present this via `?token=...` on the WS URL.
    pub token: String,
    /// Origins allowed to connect. Strict match on the scheme+host+port.
    /// Always includes localhost variants + the Tracklist site.
    pub allowed_origins: Vec<String>,
    /// Sample rate we request from the audio device. 48000 is the WASAPI
    /// default on modern Windows.
    pub sample_rate: u32,
    /// If true, the companion hides its window on launch — only the tray
    /// icon is visible. Matches how audio apps (Discord, Spotify) behave
    /// when configured to autostart on login.
    #[serde(default)]
    pub launch_minimized: bool,
}

impl Config {
    pub fn bind_addr(&self) -> SocketAddr {
        // Bind exclusively to the loopback interface. 0.0.0.0 is never used
        // — if a future feature needs remote access it goes through a
        // separate opt-in path with TLS.
        ([127, 0, 0, 1], self.port).into()
    }

    pub fn load_or_create() -> Result<Self> {
        let path = config_path()?;
        if path.exists() {
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            let cfg: Config = toml::from_str(&raw)
                .with_context(|| format!("parsing {}", path.display()))?;
            return Ok(cfg);
        }
        let cfg = Self::fresh();
        cfg.save()?;
        Ok(cfg)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = toml::to_string_pretty(self)?;
        std::fs::write(&path, raw)?;
        Ok(())
    }

    fn fresh() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: fresh_token(),
            allowed_origins: vec![
                "https://music.blackpearl.gg".into(),
                // Localhost for the dev loop (Next dev server + tooling).
                "http://localhost:3000".into(),
                "http://127.0.0.1:3000".into(),
            ],
            sample_rate: 48_000,
            launch_minimized: false,
        }
    }

    /// Rotate just the token; preserve every other setting. Called from the
    /// tray menu's "Regenerate token" action.
    pub fn rotate_token(mut cfg: Self) -> Result<Self> {
        cfg.token = fresh_token();
        Ok(cfg)
    }
}

fn fresh_token() -> String {
    let mut buf = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

/// Absolute path to the user-scoped config dir. Exposed so the tray's
/// "Open config folder" menu item can hand it to explorer.exe.
pub fn config_dir() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("gg", "blackpearl", "tracklist-link")
        .context("cannot resolve project directories")?;
    Ok(dirs.config_dir().to_path_buf())
}
