//! Windows system-tray UI for the companion.
//!
//! Minimal scope:
//!   - Tray icon with tooltip "Tracklist Link"
//!   - Right-click menu: Copy token, Open config folder, Regenerate token, Quit
//!   - Left-click: toggles a status window (TODO M1.1)
//!
//! Pairing via the `tracklist-link://` URL scheme lives in `pair.rs` and
//! ships as M1.1 — for now streamers paste the companion token from the
//! config file into the Tracklist dashboard manually, which is a ~10-second
//! one-time step.

use crate::config::Config;
use anyhow::{Context, Result};
use std::sync::{Arc, Mutex};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    TrayIconBuilder,
};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::WindowId,
};

/// Runs on the main thread. Blocks until the user picks Quit. The caller
/// must have already spawned the audio + WS threads — the tray just
/// provides the UI + termination hook.
pub fn run(cfg: Arc<Mutex<Config>>) -> Result<()> {
    let menu = Menu::new();

    let copy_token = MenuItem::new("Copy token", true, None);
    let open_config = MenuItem::new("Open config folder", true, None);
    let regen = MenuItem::new("Regenerate token", true, None);
    let quit = MenuItem::new("Quit", true, None);

    menu.append_items(&[
        &copy_token,
        &open_config,
        &PredefinedMenuItem::separator(),
        &regen,
        &PredefinedMenuItem::separator(),
        &quit,
    ])
    .context("build tray menu")?;

    // Solid-color fallback icon. Replace with a bundled PNG once we ship a
    // proper brand asset; the binary doesn't need one to function.
    let icon = build_flat_icon(32, [35, 140, 90, 255]);

    let _tray = TrayIconBuilder::new()
        .with_tooltip("Tracklist Link")
        .with_icon(icon)
        .with_menu(Box::new(menu))
        .build()
        .context("build tray icon")?;

    let event_loop = EventLoop::new().context("create winit event loop")?;
    event_loop.set_control_flow(ControlFlow::Wait);

    let mut app = TrayApp {
        cfg,
        copy_token_id: copy_token.id().clone(),
        open_config_id: open_config.id().clone(),
        regen_id: regen.id().clone(),
        quit_id: quit.id().clone(),
    };
    event_loop.run_app(&mut app).context("run tray event loop")?;
    Ok(())
}

struct TrayApp {
    cfg: Arc<Mutex<Config>>,
    copy_token_id: MenuId,
    open_config_id: MenuId,
    regen_id: MenuId,
    quit_id: MenuId,
}

impl ApplicationHandler for TrayApp {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        _event: winit::event::WindowEvent,
    ) {
        // No windows owned by this app yet; status panel comes later.
    }

    fn new_events(&mut self, event_loop: &ActiveEventLoop, _cause: winit::event::StartCause) {
        // Drain pending tray menu events. The tray-icon crate delivers these
        // out-of-band from winit's own event stream; we poll each tick.
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            self.handle_menu_event(event, event_loop);
        }
    }
}

impl TrayApp {
    fn handle_menu_event(&mut self, event: MenuEvent, event_loop: &ActiveEventLoop) {
        let id = event.id();
        if id == &self.copy_token_id {
            if let Err(err) = self.copy_token() {
                tracing::warn!(?err, "copy token failed");
            }
        } else if id == &self.open_config_id {
            if let Err(err) = self.open_config_folder() {
                tracing::warn!(?err, "open config failed");
            }
        } else if id == &self.regen_id {
            if let Err(err) = self.regen_token() {
                tracing::warn!(?err, "regen token failed");
            }
        } else if id == &self.quit_id {
            tracing::info!("quit requested from tray menu");
            event_loop.exit();
        }
    }

    fn copy_token(&self) -> Result<()> {
        let token = self.cfg.lock().unwrap().token.clone();
        // `clip.exe` is shipped with every Windows install and writes stdin
        // to the clipboard. Avoids pulling in the `arboard` dep for a single
        // one-shot copy.
        use std::io::Write;
        let mut child = std::process::Command::new("clip")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .context("spawn clip.exe")?;
        child
            .stdin
            .as_mut()
            .context("clip stdin")?
            .write_all(token.as_bytes())?;
        let status = child.wait()?;
        if !status.success() {
            anyhow::bail!("clip.exe exited {status}");
        }
        tracing::info!("token copied to clipboard");
        Ok(())
    }

    fn open_config_folder(&self) -> Result<()> {
        let dir = crate::config::config_dir()?;
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .context("spawn explorer")?;
        Ok(())
    }

    fn regen_token(&self) -> Result<()> {
        // Rotate the secret. All connected clients will lose access on their
        // next connection attempt (the broadcast channel stays alive for
        // currently-open sockets until they reconnect).
        let mut cfg = self.cfg.lock().unwrap();
        *cfg = Config::rotate_token(cfg.clone())?;
        cfg.save()?;
        tracing::info!("token regenerated");
        Ok(())
    }
}

/// 32x32 RGBA icon of a single solid color. Good enough for MVP so the tray
/// shows *something*; swap for `include_bytes!("icon.png")` later.
fn build_flat_icon(size: u32, rgba: [u8; 4]) -> tray_icon::Icon {
    let mut buf = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        buf.extend_from_slice(&rgba);
    }
    // unwrap: the input dimensions and buffer size are guaranteed correct.
    tray_icon::Icon::from_rgba(buf, size, size).expect("build tray icon")
}
