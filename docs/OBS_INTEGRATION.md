# OBS Integration

Two surfaces make their way into OBS today:

1. **Now-playing overlay** — a transparent card at `music.blackpearl.gg/<user>/overlay?...` (shipped since v0.1).
2. **Fullscreen MilkDrop visualizer** — new in v0.5, lives at `music.blackpearl.gg/visualizer?token=...` and renders a full-bleed canvas driven by the paired companion's FFT + beat stream.

Both are **Browser Sources**. No Window Capture, no Display Capture, no second monitor. The companion's Visualizer tab has an **Add to OBS** button that assembles the URL for you.

## What ships in v0.5

- **`/visualizer` page** on the website: React-only, WebGL (Butterchurn), ~1 MB lazy-loaded chunk. Connects to the companion via WS using a token in the URL, exactly like the overlay. Auto-cycles presets every 30s. Beat-reactive gain boost on kicks.
- **Companion → "Add to OBS" modal**: one click produces `https://music.blackpearl.gg/visualizer?token=<your-token>`. Copy button writes to the system clipboard; Preview button opens the URL in the default browser so the streamer can sanity-check before pasting into OBS.
- **URL params** for per-scene tuning:
  - `token` — required; companion token.
  - `port` — companion WS port (default 38475).
  - `preset` — start on a named preset. Default: random.
  - `cycle` — auto-cycle interval in seconds (5-600). Default 30.
  - `accent` — HUD accent hex. Default `#a855f7`.
- **Transparent background**: the viz page overrides the site's background gradient with solid black. OBS Browser Source with "background transparent" support still works if a future preset's frame buffer has alpha — current behavior is solid black fill, which is what most streamers want for a viz scene.

## Three-step user flow

1. Install + pair the companion (existing flow).
2. Open Visualizer tab → click **Add to OBS** → **Copy**.
3. In OBS: Sources → + → **Browser**. Paste URL. Width 1920, height 1080. OK.

That's it. The viz is live. Beat pulses on kicks, presets cycle.

## What's next (not shipped yet)

### Phase A — obs-websocket auto-install

Today's flow is paste-the-URL. Tomorrow's is click-the-button.

**OBS WebSocket v5** ships bundled with OBS 28+ and enables remote control over `ws://localhost:4455`. When enabled by the streamer, Tracklist Link can:

1. Open a WS connection to `ws://localhost:4455` with their password (handshake: server sends Hello with challenge + salt, client sends Identify with auth hash).
2. Send a `CreateInput` request for a `browser_source` input pre-filled with the visualizer URL, width, height, and "shutdown when not visible" flag.
3. Optionally send `CreateSceneItem` to place it in the currently active scene.

UI surface:

- Companion Visualizer tab → "Add to OBS" modal grows a second tab: **Automatic**.
- Streamer enters the OBS WebSocket password (or leaves blank if disabled). Checkbox "Remember for this computer" → stored in config (not cloud).
- Click "Install into current scene" — modal shows progress (connecting → authed → created → placed) + success / error.
- Errors map to actionable messages: "OBS isn't running", "WebSocket Server not enabled (Tools → WebSocket Server Settings → check Enable)", "password wrong".

Config changes:
- `obs_ws_password: Option<String>` (encrypted at rest? Out of scope — localhost-only; Windows user profile is the trust boundary).
- `obs_ws_port: u16` (default 4455).
- `obs_ws_enabled: bool` (just whether the streamer has enabled the feature).

Dependencies:
- `tokio-tungstenite` — already in the project.
- No new Rust crates required; we already have everything.

Estimated work: **4-6 hours** one-session ship.

### Phase B — Multi-scene install

Let the streamer pre-configure named scenes ("Main," "Music-only," "Intermission") and the button installs the viz into all of them at once.

### Phase C — Preset pin per scene

Extension of Phase B: each scene can specify a pinned preset so "Intermission" always shows the chill ambient preset, "Main" cycles through kicks-heavy presets.

### Phase D — MilkDrop 3 fullscreen mode

When the projectM sidecar lands (see `PROJECTM_MILKDROP3.md`), the "Add to OBS" modal grows a third option: **Native (MilkDrop 3)**. Launches the projectM sidecar's OpenGL window; companion walks the user through "OBS → Window Capture → select Tracklist Visualizer." Higher fidelity than Butterchurn, needs projectM installed.

## Non-goals

- **Not a full OBS remote control.** Setting up the Browser Source is all we do. Changing scenes, starting/stopping the stream, mic mute, etc. belong in dedicated OBS remote apps.
- **Not a video filter plugin.** We don't ship a native OBS plugin; too much build + signing overhead for marginal value over Browser Source.
- **Not a streaming service integration.** Browser Source is OBS-only by convention; Streamlabs / Twitch Studio support the same format so it works everywhere, but we don't test there.

## Security posture

- The URL contains the companion token. Same as the overlay pairing flow — blast radius limited to the streamer's own machine because:
  - The companion only accepts connections from `127.0.0.1`.
  - The companion validates Origin against a tight allowlist (`music.blackpearl.gg` + localhost dev).
  - The companion validates the token via constant-time compare.
- When obs-websocket auto-install ships, we persist the OBS password to the companion's local config. Encrypted-at-rest isn't planned initially — the Windows user profile is already the trust boundary for the companion token + Spotify cookies. Revisit if we ever support a multi-user kiosk scenario.

## Open questions

1. Should the viz page support background transparency so presets with alpha show OBS's underlying scene through them? Currently hard black fill.
2. Worth exposing preset allow-list / block-list via URL params for streamers who want specific packs only?
3. Auto-cycle default — 30s is a MilkDrop convention; some streamers may prefer longer for a more meditative vibe. Per-URL override works; a companion default maybe lives in the Tune panel.
