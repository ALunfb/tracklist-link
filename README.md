# Tracklist Link

Local audio companion for [Tracklist](https://music.blackpearl.gg). Captures the
default system audio output on the streamer's machine, computes real-time FFT
spectra + amplitude levels, and serves them over a localhost WebSocket to
audio-reactive overlays, visualizers, and future Tracklist integrations.

**Status:** M1 shipped. Windows audio capture, 64-band FFT, RMS/peak levels,
token + origin auth, tray UI. See [`ROADMAP.md`](./ROADMAP.md) for later
milestones (MilkDrop, beat detection, CS2 GSI) and [`SECURITY.md`](./SECURITY.md)
for the threat model.

## Install (Windows)

1. Grab the latest `tracklist-link.exe` from [Releases](https://github.com/ALunfb/tracklist-link/releases).
2. Double-click to run. A tray icon appears in your notification area.
3. Right-click tray → **Copy token**.
4. Open your Tracklist dashboard → "Reactive analyzer" section → paste
   the token → **Save &amp; test**. The peak meter should light up as
   soon as audio plays on your PC.

The companion writes its config to
`%APPDATA%\blackpearl\tracklist-link\config\config.toml` on first run and
generates a per-install 32-byte secret. Keep the file private; the tray
menu exposes a **Regenerate token** option if it ever leaks.

## Why

Browser-only overlays cannot access a user's system audio inside OBS. The web
platform's sandbox blocks every direct path:

- `getDisplayMedia({audio: true})` — requires a per-session user gesture OBS
  Browser Source can't grant.
- `getUserMedia` with a virtual audio cable works but saddles streamers with
  a second app install, audio-routing config, and a setup guide.
- OBS WebSocket meter events expose *amplitude* only — not a frequency
  spectrum, and suffers mixed-content blocks from HTTPS pages.

Tracklist Link is a small Rust binary that runs on the streamer's machine,
reads audio natively via WASAPI loopback (Windows), and exposes a clean pub/sub
protocol over a localhost WebSocket. Any client — our overlay, a third-party
overlay, a Stream Deck plugin, an OBS plugin — can subscribe to the topics it
needs.

## Design principles

1. **Localhost-only.** The server binds exclusively to `127.0.0.1`. It is
   unreachable from outside the machine by construction.
2. **Rust memory safety.** The entire companion is Rust. No C/C++ audio
   plugin, no buffer-overflow CVE class, no UAFs.
3. **Origin + token auth.** Every WS connection validates `Origin` against a
   strict allowlist *and* presents a per-install token. Both must be valid.
4. **Open source.** MIT-licensed. Streamers can audit the source, build from
   it, and verify signed releases match the code.
5. **Output capture only.** Default config taps the default audio OUTPUT
   device — the speakers. Mic, camera, and screen are never accessed. A future
   voice-activity-detection feature would require a separate explicit consent
   prompt.
6. **No outbound network.** The companion only makes outbound calls for
   auto-update checks against GitHub Releases. Everything else is localhost.
7. **Composable pub/sub protocol.** Each feature becomes a topic. Clients
   subscribe to what they need. Never-breaking additive evolution.
8. **One-time setup.** Download → install → pair with the Tracklist dashboard
   once. Autostart on login. Streamer never thinks about it again.

## What this unlocks

- **Audio-reactive overlays** — real FFT bands drive spectrum bars, radial
  visualizers, particle effects. Compatible with [Butterchurn](https://github.com/jberg/butterchurn)
  for MilkDrop 2 presets in-browser.
- **MilkDrop 3 visualizers** — future milestone: companion launches a
  native [ProjectM](https://github.com/projectM-visualizer/projectm) window
  that streamers capture as an OBS Window Source. Full `.milk3` preset
  support with GPU acceleration.
- **Beat-synced effects** across any overlay.
- **Voice ducking** — auto-dip music when the streamer talks.
- **Accurate playback position** — reads the actual audio position, not
  Tracklist's poll-derived estimate.
- **Banger-clip detection** — real sustained loudness, not a popularity proxy.
- **OBS scene automation** — silence-triggered scene changes, beat-triggered
  transitions.

## Build from source

```bash
# Requires: Rust 1.75+, Windows 10/11 for the tray + WASAPI path.
cargo build --release
./target/release/tracklist-link.exe
```

### Smoke test a running companion

```bash
cargo run --release --example smoke
```

Reads the config, connects with a valid Origin header + token, subscribes to
`audio/fft/64` + `audio/level`, prints the first few frames, then exits. Use
it any time you change the audio pipeline or protocol to confirm the whole
stack still round-trips. Prereq: the `tracklist-link` binary must already be
running in another process.

## Verified hardware / environments

The MVP has been smoke-tested on:

- Windows 11 · default `Speakers (High Definition Audio Device)` output
- 48 kHz sample rate, f32 samples

Reports welcome for other sample-rate / device combos.

## Protocol

See [`PROTOCOL.md`](./PROTOCOL.md). The short version:

```
client  ───── Subscribe { topics: [audio/fft/64] } ────▶  companion
client  ◀──── Hello { v: 1, app_version, sample_rate } ──  companion
client  ◀──── Fft { seq, t_ms, bands: [f32; 64] } ──────  (~60 Hz)
client  ◀──── Fft { seq, t_ms, bands: [f32; 64] } ──────  ...
```

## Security

See [`SECURITY.md`](./SECURITY.md) for the full threat model.

Summary:
- Binds `127.0.0.1` only
- Origin allowlist
- Per-install secret, constant-time compared
- No outbound network beyond a single GitHub Releases update check
- Mic/camera/screen never accessed by default
- Open-source + reproducible builds

## License

MIT — see [`LICENSE`](./LICENSE).
