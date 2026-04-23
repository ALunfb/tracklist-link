# Roadmap

Not a commitment, a direction. Each milestone is independently shippable —
we can stop after any of them and still have a useful product.

## M1 — Windows audio core (this milestone)

- [x] Workspace scaffold with `tracklist-link` binary + `tracklist-link-proto` shared types
- [x] Protocol types (`Topic`, `ClientMessage`, `ServerMessage`) with `v: 1`
- [x] README, SECURITY, PROTOCOL, ROADMAP
- [ ] Audio capture via WASAPI loopback (cpal)
- [ ] FFT pipeline (realfft, 2048-sample hop, 64-band + 512-band post-binning)
- [ ] Broadcast channel to fan out frames to subscribers
- [ ] WebSocket server on `127.0.0.1:38475` with origin allowlist + token auth
- [ ] Config file + first-run token generation
- [ ] Tray icon with status pane + revoke button
- [ ] Unsigned Windows binary + GitHub Releases

**Exit criteria:** a streamer can download the binary, run it, paste their
pair token into the Tracklist dashboard, and see real FFT bars in the OBS
overlay. No certs, no installers beyond a plain zip.

## M2 — Site integration

- [ ] Dashboard "Tracklist Link" tile with connection status + pair button
- [ ] Overlay analyzer mode `fft` that connects to companion
- [ ] Butterchurn-powered MilkDrop 2 visualizer mode using companion FFT as
      input — thousands of existing `.milk` / `.milk2` presets work
      immediately
- [ ] Preset picker in the dashboard (random / user-selected / upload custom)
- [ ] Remove the broken OBS WebSocket analyzer path from the overlay config

**Exit criteria:** streamer installs companion + picks a preset in dashboard
+ their OBS overlay shows reactive MilkDrop visuals, zero manual audio
routing.

## M3 — MilkDrop 3 via native ProjectM window

`.milk3` presets require shader features butterchurn doesn't implement. The
realistic path is a native renderer:

- [ ] Companion links against [ProjectM](https://github.com/projectM-visualizer/projectm)
      (C++ library with OpenGL renderer) via FFI.
- [ ] Companion opens a dedicated visualizer window that renders MilkDrop
      presets at full GPU acceleration.
- [ ] Streamer adds the window as an OBS "Window Capture" source — one-time
      setup, zero streaming overhead, zero encoding cost.
- [ ] Dashboard drives the visualizer: preset switching, beat-synced preset
      cycling, track-change triggers a transition.
- [ ] `.milk3` preset library browsing + upload.

**Why native?** `.milk3` uses shader features (specifically MilkDrop 3's
rewritten compositing pipeline) that haven't been ported to WebGL. ProjectM
4.x has partial `.milk3` support already; we inherit their progress.

**Why a window instead of streaming pixels?** An OBS Window Capture source
reads the window's pixels directly with zero encoder overhead. Streaming
video frames over WebSocket would waste CPU + add latency for no benefit
when the streamer is already running OBS.

**Exit criteria:** streamer picks a `.milk3` preset in the dashboard, a
visualizer window appears, OBS Window Capture grabs it, and it reacts to
music in real time.

## M4 — Game-state integration

Tracklist Link becomes a hub for both **audio** and **game** events on the
streamer's machine. Overlays can react to either.

### CS2 (Counter-Strike 2) via GSI

CS2's Game State Integration pushes JSON POST updates to a local HTTP
endpoint configured in a `gamestate_integration_<name>.cfg` file.

- [ ] Companion hosts an additional HTTP listener on `127.0.0.1:<port>/gsi`
- [ ] Dashboard generates a `gamestate_integration_tracklist.cfg` the
      streamer drops into `<CS2>/csgo/cfg/` (one-time setup)
- [ ] Config embeds the per-install auth token so only our companion
      accepts posts from this particular CS2 install
- [ ] Companion parses GSI JSON, emits pub/sub events:
    - `game/cs2/round-start`
    - `game/cs2/round-end` (with win/loss)
    - `game/cs2/player-death`
    - `game/cs2/bomb-planted` / `bomb-defused`
    - `game/cs2/kill-streak` (derived from death events)
    - `game/cs2/mvp`
    - `game/cs2/match-end`
- [ ] Overlays can subscribe and trigger visual + audio effects:
    - Ducking music on player death
    - Tempo swell on round start
    - Preset switch on bomb plant (tension preset)
    - Kill-streak beat-drop sync
    - Victory / defeat jingles

### Other supported games (later)

- **Dota 2** — also has GSI, same protocol pattern
- **Apex Legends** — log-file tailing for match events
- **League of Legends** — LCU API (requires local auth token parse)

### Why this is the-first-of-its-kind

Tools that react to game state exist (StreamerSongList has manual triggers,
Lightpack reacts to game colors, etc.) but none tie **audio reactivity**,
**music metadata**, and **game events** into a single platform with a clean
pub/sub protocol. Tracklist Link's value isn't "I added GSI to audio
reactive" — it's "I made it so any overlay can compose the three without
the streamer writing glue code."

**Exit criteria:** streamer plays CS2, gets a bomb-plant moment, their
music overlay automatically switches to a tension preset + ducks the music
+ fires a visual accent. Zero config beyond dropping a cfg file once.

## M5 — Beat / BPM / onset detection

- [ ] Onset detector (spectral flux + median thresholding)
- [ ] BPM estimator (autocorrelation over onset train)
- [ ] Per-instrument onset (kick / snare via bandpass-filtered onsets)
- [ ] Beat-synced preset cycling for MilkDrop
- [ ] Voice-activity detection (mic input, requires separate consent prompt
      per SECURITY.md)
- [ ] Auto-ducking integration (companion → OBS WebSocket → adjust audio
      filter)

## M6 — Cross-platform

- [ ] macOS support (Core Audio loopback via BlackHole as a prereq, or
      native via ScreenCaptureKit on recent macOS)
- [ ] Linux support (PipeWire monitor source capture)
- [ ] Universal installer / auto-update infrastructure

## M7 — Extended integrations

Specific downstream integrations. Each is a new `Topic` and a few hundred
lines of glue:

- [ ] OBS plugin that republishes companion events inside OBS (scene
      triggers, filter control)
- [ ] Stream Deck plugin
- [ ] Twitch ChatBot bridge (post to chat on track change, detect
      hype-moment via sustained loudness)
- [ ] Local audio recording (companion writes session audio to disk for
      editor post-processing)

## Out of scope

- **Streaming video anywhere off-machine.** No screen-sharing, no audio
  upload. Everything stays local unless a future feature is explicitly
  opt-in with a separate consent prompt.
- **Closed-source modules.** Everything in this repo stays MIT. If a
  feature requires a proprietary library (e.g. a music-recognition SDK),
  it's a separate package the streamer decides to install.
- **Non-streamer use cases.** The protocol is general enough that anyone
  could use it, but the install flow, docs, and UI are designed for Twitch
  streamers.
