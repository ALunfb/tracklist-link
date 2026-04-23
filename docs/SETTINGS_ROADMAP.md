# Settings — Roadmap

What the companion's Settings tab should eventually expose, why, and what order to build it in.

## Design principles

1. **Sane defaults.** Most streamers should never open Settings.
2. **Per-install, local only.** No cloud sync (yet). The config file at `%APPDATA%\blackpearl\tracklist-link\config\config.toml` is the source of truth.
3. **Restart vs live.** Clearly mark which settings take effect immediately vs on restart. Audio device change = restart. Theme change = live.
4. **No unexplained knobs.** Every setting has a one-line description in the UI about when to touch it.
5. **Reset path.** One button that restores defaults. (Not per-setting — keep UI simple.)

## Categories

### Now (Phase 1 shipped)
- [x] Display bind address (read-only)
- [x] Display sample rate (read-only)
- [x] Display allowed origins (read-only)
- [x] Regenerate token
- [x] Open config folder (escape hatch for advanced users)

### Next (Phase 1.5 — a short follow-up session)
- [ ] **Launch on Windows startup** (registry Run key via `tauri-plugin-autostart`)
- [ ] **Start minimized to tray** (boot behavior, saved to config)
- [ ] **Preserve window size + position** across restarts
- [ ] **Theme accent color** picker — stored in config, applied via CSS variable

### Soon (Phase 2.5 — after Butterchurn is stable)
- [ ] **Audio output device selector** — enumerate cpal devices, let user pick (default = system default). Requires restarting capture thread on change.
- [ ] **FFT detail level** — 64 / 256 / 512 band toggle. Changes what the companion emits + which topic clients subscribe to.
- [ ] **Smoothing amount** — exposes the IIR alpha for fast-attack / slow-release on the client analyzer.
- [ ] **Auto-cycle preset interval** — seconds between preset swaps in Visualizer tab (Butterchurn default is 30s).
- [ ] **Preset blend time** — 0–5s transition between presets.

### Later (Phase 3+ — infrastructure-heavy)
- [ ] **Audio routing** — route just one app's audio (e.g. Spotify) through VB-Cable so the viz reacts to music but not voice. Requires Windows audio session APIs.
- [ ] **Silence detection** — mute viz when silence > N seconds (saves GPU during AFK).
- [ ] **OBS scene auto-switch** — trigger scene change on silence / beat / game events. Requires obs-websocket round-trip.
- [ ] **Beat detection sensitivity** — threshold for the `audio/beat` topic once it's implemented.
- [ ] **Update channel** — stable / beta, for when auto-update ships.

### Advanced (edit config.toml directly for now)
- [ ] **Port** — change the WS listener port.
- [ ] **Allowed origins** — add/remove entries for non-Tracklist sites that want to consume the FFT.
- [ ] **Log verbosity** — quiet / normal / debug. Affects console + the future "Logs" pane.

### Eventually (if there's demand)
- [ ] **Hotkeys** — global shortcut to pause / resume / cycle preset / open window (requires `tauri-plugin-global-shortcut`).
- [ ] **Discord Rich Presence** — show "listening to <track>" with preset name. Third-party lib + opt-in.
- [ ] **WebSocket client allowlist** — restrict by fingerprint beyond just origin + token.
- [ ] **Export / import settings** — dump config to JSON, load on another machine.
- [ ] **Multiple profiles** — gaming vs music-only vs podcast, switchable from tray.

## Settings UI patterns

- **Groups:** "General", "Audio", "Visualizer", "Advanced". One page, collapsible sections.
- **Pill row:** binary settings show on a single row with label + description + toggle.
- **Dropdown row:** multi-choice settings (audio device, theme) show current value + button to open picker.
- **Slider row:** numeric ranges (smoothing, interval).
- **Button row:** actions (regenerate, reset, open folder).
- **Destructive actions** always confirm.
- **Save** is implicit — every change persists immediately. No global Save button.

## Implementation notes

- Keep the config schema additive. Never rename a field; only add new ones with sensible defaults. Migrate via `#[serde(default)]`.
- Tauri IPC commands: one `get_settings()` returning the full view, one `update_setting(key, value)` that dispatches to the right setter. Avoids shipping 50 commands.
- Frontend uses a single `useSettings()` hook backed by a cache-invalidated React Query-ish pattern. No full reload on each change.
- Audio restart (on device change) is the tricky one: gracefully drain the current capture thread, swap to the new device, re-emit status via Tauri event.
